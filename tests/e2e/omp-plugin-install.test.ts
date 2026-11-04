import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `omp plugin install` loads the freshly installed extension inside the CLI
 * process, outside any session. The host's Settings are not initialised there,
 * so an extension that reads them while loading crashes the install (exit 1)
 * after omp has already written node_modules but before it records the lockfile.
 * `--help` never goes down that path, which is why the smoke test missed it.
 *
 * The working tree is packed and served from a local registry, so the code
 * under test is what gets installed; every other package is proxied to npm.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE = "system-prompt-switch";
// The version in the packed package.json: omp reports and records that one.
const VERSION: string = JSON.parse(
	fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
).version;

let tempDir: string;
let server: ReturnType<typeof Bun.serve> | undefined;
let skipReason: string | undefined;

beforeAll(async () => {
	if (!Bun.which("omp")) {
		skipReason = "omp not on PATH";
		return;
	}
	try {
		const ping = await fetch("https://registry.npmjs.org/semver", {
			signal: AbortSignal.timeout(5000),
		});
		if (!ping.ok) throw new Error(String(ping.status));
	} catch {
		skipReason = "npm registry unreachable (peer dependencies are proxied from it)";
		return;
	}

	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sps-omp-install-"));
	const pack = Bun.spawnSync(["npm", "pack", "--silent", "--pack-destination", tempDir], {
		cwd: REPO_ROOT,
	});
	if (pack.exitCode !== 0) throw new Error(`npm pack failed: ${pack.stderr.toString()}`);
	const tarball = fs.readFileSync(path.join(tempDir, pack.stdout.toString().trim().split("\n").pop()!));
	const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
	const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"));

	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const { pathname } = new URL(req.url);
			if (pathname === `/${PACKAGE}`) {
				return Response.json({
					name: PACKAGE,
					"dist-tags": { latest: VERSION },
					versions: {
						[VERSION]: {
							...manifest,
							version: VERSION,
							dist: { tarball: `http://127.0.0.1:${server!.port}/${PACKAGE}.tgz`, integrity },
						},
					},
				});
			}
			if (pathname === `/${PACKAGE}.tgz`) return new Response(tarball);
			// omp fires many requests at once; the registry resets some connections, so retry.
			let upstream: Response | undefined;
			for (let attempt = 1; !upstream; attempt++) {
				try {
					upstream = await fetch(`https://registry.npmjs.org${pathname}`);
				} catch (error) {
					if (attempt === 5) throw error;
				}
			}
			// Re-wrapped: fetch has already decoded the body, so passing the upstream
			// content-encoding through would make the client gunzip plain bytes.
			return new Response(await upstream.arrayBuffer(), {
				status: upstream.status,
				headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
			});
		},
	});
});

afterAll(() => {
	server?.stop(true);
	if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("omp plugin install", () => {
	it("installs the extension without the host crashing while it loads", async () => {
		if (skipReason) {
			console.log(`[skip] ${skipReason}`);
			return;
		}

		const home = path.join(tempDir, "home");
		fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
		// Marks first-run setup done, otherwise the host opens its sign-in wizard.
		fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), "setupVersion: 2\n");

		const proc = Bun.spawn(["omp", "plugin", "install", `${PACKAGE}@${VERSION}`], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: home,
				BUN_CONFIG_REGISTRY: `http://127.0.0.1:${server!.port}`,
			},
		});
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;

		expect(stderr).not.toContain("Unhandled Rejection");
		expect(stderr).not.toContain("Settings not initialized");
		expect(exitCode).toBe(0);
		expect(stdout).toContain(`Installed ${PACKAGE}@${VERSION}`);

		// The lockfile is what omp writes last; a crash leaves it without the entry.
		const lock = JSON.parse(
			fs.readFileSync(path.join(home, ".omp", "plugins", "omp-plugins.lock.json"), "utf-8"),
		);
		expect(lock.plugins[PACKAGE].version).toBe(VERSION);
	}, 120_000);
});
