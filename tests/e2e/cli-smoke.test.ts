import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sandboxEnv } from "../helpers/sandbox-env";

/**
 * Loads the extension through a real host CLI.
 *
 * CI installs both Pi and OMP, so both are exercised here. Locally only one is
 * usually present; a missing binary is reported and skipped rather than failed,
 * so a contributor without a host installed is not blocked.
 *
 * `--help` is not enough: omp prints help without loading extensions, and Pi
 * loads them but exits 0 on a load error. `-p` loads the extension and then
 * stops at "no model / no API key", so it runs in an empty HOME with every
 * credential variable removed: no user plugin, setting or login is touched and
 * no model is ever called.
 */
// omp 19 answers from a built-in keyless model when none is configured, so it is pointed at a model that does not
// exist: it stops right after the extensions load, before any request.
// Each host loads its own entry: OMP 19 rejects the pi-tui import that Pi's editor needs (package.json omp / pi manifests).
const HOSTS = [
	{ name: "pi", bin: "pi", entry: "extensions/pi.ts", args: [] },
	{ name: "omp", bin: "omp", entry: "extensions/index.ts", args: ["--model", "nope/none"] },
] as const;

const LOAD_ERROR = /Failed to load extension|Cannot find module|SyntaxError|ParseError/;
// What both hosts print once the extension has loaded and they reach "no model / no key" (seen in real runs). A host that
// rejects a flag prints neither this nor a load error, so a run without it proves nothing was loaded.
const REACHED_MODEL_STAGE = /No default model|No API key|AWS credentials|Model "nope\/none" not found/;
// The first omp launch in an empty HOME unpacks about 120 MB of native libraries into ~/.omp/natives: 1.8 s here
// against 0.5 s afterwards. A slow disk or a virus scanner (Windows) multiplies that, and Bun's 5 s default timeout fails.
const COLD_START_MS = 30_000;

let home: string;
let brokenExtension: string;

beforeAll(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "sps-smoke-"));
	fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
	// Marks first-run setup done (same value as the omp plugin-install test), otherwise omp opens its setup wizard.
	fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), "setupVersion: 3\n");
	brokenExtension = path.join(home, "broken-extension.ts");
	fs.writeFileSync(brokenExtension, "export default function( { this is not valid\n");
});

afterAll(() => {
	if (home) fs.rmSync(home, { recursive: true, force: true });
});


async function runHost(bin: string, extension: string, args: readonly string[]): Promise<{ stderr: string; ms: number }> {
	const started = performance.now();
	const proc = Bun.spawn([bin, "--no-session", "-e", extension, ...args, "-p", "hi"], {
		cwd: home,
		stdout: "pipe",
		stderr: "pipe",
		env: sandboxEnv(home),
	});
	const [stderr] = await Promise.all([new Response(proc.stderr).text(), new Response(proc.stdout).text()]);
	await proc.exited;
	return { stderr, ms: Math.round(performance.now() - started) };
}

describe("CLI Smoke Test", () => {
	for (const host of HOSTS) {
		const installed = Boolean(Bun.which(host.bin));

		it(`loads extension cleanly via the ${host.name} CLI`, async () => {
			if (!installed) {
				console.log(`[skip] ${host.bin} not on PATH`);
				return;
			}

			const { stderr, ms } = await runHost(host.bin, path.resolve(host.entry), host.args);

			console.log(`[smoke] ${host.name} started in ${ms} ms`);
			expect(stderr).not.toMatch(LOAD_ERROR);
			// Without this a host that rejects a flag (and loads nothing) would pass: it prints neither a load error nor this.
			expect(stderr).toMatch(REACHED_MODEL_STAGE);
		}, COLD_START_MS);

		it(`reports a broken extension via the ${host.name} CLI (so the check above can fail)`, async () => {
			if (!installed) {
				console.log(`[skip] ${host.bin} not on PATH`);
				return;
			}

			const { stderr } = await runHost(host.bin, brokenExtension, host.args);

			expect(stderr).toMatch(LOAD_ERROR);
		}, COLD_START_MS);
	}
});

describe("smoke test sandbox", () => {
	it("passes none of the host's own config, session or key variables on to the host", () => {
		const saved = { ...process.env };
		process.env.PI_CODING_AGENT_DIR = "/real/agent/dir";
		process.env.OMP_WORKTREE_DIR = "/real/worktree";
		process.env.ANTHROPIC_API_KEY = "sk-real";
		process.env.OMPCODE = "1";
		try {
			const env = sandboxEnv(home);
			expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
			expect(env.OMP_WORKTREE_DIR).toBeUndefined();
			expect(env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(env.OMPCODE).toBe("1"); // the CI matrix variable must survive
			expect(env.HOME).toBe(home);
		} finally {
			process.env = saved;
		}
	});
});
