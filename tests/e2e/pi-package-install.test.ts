import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../helpers/sandbox-env";

/**
 * `pi install` of the packed package, as a user gets it: no node_modules next to it, so anything the extension
 * imports must come from the host. The repo's own node_modules (pi-tui as a devDependency) would hide a missing
 * import when running from the checkout, which is why the working tree is packed and unpacked elsewhere.
 *
 * Proof the installed extension loaded, in print mode: `/sps-info` is a command only this extension registers.
 * With it installed the command is handled and nothing asks a model; without it Pi falls through to the model and
 * says "No API key". The same command is run before the install as the control.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NO_MODEL = /No API key|No default model|AWS credentials/;
const LOAD_ERROR = /Failed to load extension|Cannot find (module|package)|SyntaxError|ParseError/;

let tempDir: string;
let home: string;
let project: string;
let packageDir: string;
let skipReason: string | undefined;

beforeAll(() => {
	for (const bin of ["pi", "npm", "tar"]) {
		if (!Bun.which(bin)) {
			skipReason = `${bin} not on PATH`;
			return;
		}
	}
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sps-pi-install-"));
	home = path.join(tempDir, "home");
	project = path.join(tempDir, "project");
	packageDir = path.join(tempDir, "package");
	for (const dir of [home, project, packageDir]) fs.mkdirSync(dir, { recursive: true });

	const pack = Bun.spawnSync(["npm", "pack", "--silent", "--pack-destination", tempDir], { cwd: REPO_ROOT });
	if (pack.exitCode !== 0) throw new Error(`npm pack failed: ${pack.stderr.toString()}`);
	const tarball = path.join(tempDir, pack.stdout.toString().trim().split("\n").pop()!);
	const untar = Bun.spawnSync(["tar", "-xzf", tarball, "-C", packageDir, "--strip-components=1"]);
	if (untar.exitCode !== 0) throw new Error(`tar failed: ${untar.stderr.toString()}`);
});

afterAll(() => {
	if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

async function pi(...args: string[]): Promise<{ output: string; exitCode: number }> {
	const proc = Bun.spawn(["pi", ...args], { cwd: project, env: sandboxEnv(home), stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { output: `${stdout}${stderr}`, exitCode: await proc.exited };
}

describe("pi package install", () => {
	it("installs the packed package and loads its extension from the pi manifest", async () => {
		if (skipReason) {
			console.log(`[skip] ${skipReason}`);
			return;
		}

		const before = await pi("--no-session", "-p", "/sps-info");
		expect(before.output).toMatch(NO_MODEL); // control: without the extension the command reaches the model stage

		const install = await pi("install", packageDir);
		expect(install.exitCode).toBe(0);
		expect(fs.existsSync(path.join(packageDir, "node_modules"))).toBe(false);

		const after = await pi("--no-session", "-p", "/sps-info");
		expect(after.output).not.toMatch(LOAD_ERROR);
		expect(after.output).not.toMatch(NO_MODEL); // the extension handled the command
	}, 120_000);
});
