import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FsStorageAdapter } from "../../src/adapters/fs-storage.adapter";
import { detectHost } from "../../src/core/paths";
import {
	globalScopeFor,
	PromptScope,
} from "../../src/core/types/prompt-scope.type";
import { TestPrompt } from "../fixtures/test-prompt.enum";
import { registerTestPrompt } from "../helpers/test-prompt-registry";

describe("FsStorageAdapter Multi-Scope", () => {
	let tempDir: string;
	let globalDir: string;
	let localDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sps-storage-test-"));
		globalDir = path.join(tempDir, "global-prompts");
		localDir = path.join(tempDir, "local-repo", ".agents", "system-prompts-switch");

		fs.mkdirSync(globalDir, { recursive: true });
		fs.mkdirSync(localDir, { recursive: true });

		fs.writeFileSync(
			path.join(globalDir, TestPrompt.GlobalCoder),
			"Global coder instructions",
			"utf-8",
		);
		fs.writeFileSync(
			path.join(localDir, TestPrompt.LocalRules),
			"Local repo instructions",
			"utf-8",
		);

		// Register every prompt this suite writes, including the one the adapter
		// would otherwise drop into the real ~/.omp home.
		registerTestPrompt(globalDir, TestPrompt.GlobalCoder);
		registerTestPrompt(localDir, TestPrompt.LocalRules);
		for (const name of [
			TestPrompt.Shared,
			TestPrompt.Duplicate,
			TestPrompt.Targeted,
			TestPrompt.Dup,
			TestPrompt.LeakProbe,
		]) {
			registerTestPrompt(globalDir, name);
		}
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup
		}
	});

	it("never falls back to the real home prompt dir when a directory is scoped", async () => {
		const home = process.env.HOME ?? "";
		const realDirs = [
			path.join(home, ".omp", "agent", "system-prompts-switch"),
			path.join(home, ".pi", "agent", "system-prompts-switch"),
		];

		// Scoping only the legacy globalDir must not let the other host resolve
		// to the user's real library, which is how test prompts leaked there.
		const scoped = new FsStorageAdapter({ globalDir, localDir });
		await scoped.write(TestPrompt.LeakProbe, "must not escape", PromptScope.GlobalOmp);
		await scoped.write(TestPrompt.LeakProbe, "must not escape", PromptScope.GlobalPi);

		for (const dir of realDirs) {
			expect(fs.existsSync(path.join(dir, TestPrompt.LeakProbe))).toBe(false);
		}
	});

	it("lists prompts from both local and global scopes with correct tags", async () => {
		const adapter = new FsStorageAdapter({ globalDir, localDir });
		const files = await adapter.list();

		expect(files.length).toBe(2);

		const localFile = files.find((f) => f.name === TestPrompt.LocalRules);
		expect(localFile).toBeDefined();
		expect(localFile?.scope).toBe(PromptScope.Local);

		const globalFile = files.find((f) => f.name === TestPrompt.GlobalCoder);
		expect(globalFile).toBeDefined();
		// The legacy `globalDir` option maps onto the detected host.
		expect(globalFile?.scope).toBe(globalScopeFor(detectHost()));
	});

	it("reads prompts using scope or auto-lookup", async () => {
		const adapter = new FsStorageAdapter({ globalDir, localDir });
		const globalScope = globalScopeFor(detectHost());

		const localDirect = await adapter.read(TestPrompt.LocalRules, PromptScope.Local);
		expect(localDirect).toBe("Local repo instructions");

		const globalDirect = await adapter.read(TestPrompt.GlobalCoder, globalScope);
		expect(globalDirect).toBe("Global coder instructions");

		const autoLocal = await adapter.read(TestPrompt.LocalRules);
		expect(autoLocal).toBe("Local repo instructions");

		const autoGlobal = await adapter.read(TestPrompt.GlobalCoder);
		expect(autoGlobal).toBe("Global coder instructions");
	});

	it("writes to the targeted scope and isolates them", async () => {
		const adapter = new FsStorageAdapter({ globalDir, localDir });
		const globalScope = globalScopeFor(detectHost());

		await adapter.write(TestPrompt.Shared, "I am in local", PromptScope.Local);
		await adapter.write(TestPrompt.Shared, "I am in global", globalScope);

		const readLocal = await adapter.read(TestPrompt.Shared, PromptScope.Local);
		expect(readLocal).toBe("I am in local");

		const readGlobal = await adapter.read(TestPrompt.Shared, globalScope);
		expect(readGlobal).toBe("I am in global");
	});

	it("deletes from the targeted scope without deleting the other", async () => {
		const adapter = new FsStorageAdapter({ globalDir, localDir });
		const globalScope = globalScopeFor(detectHost());

		await adapter.write(TestPrompt.Duplicate, "Local version", PromptScope.Local);
		await adapter.write(TestPrompt.Duplicate, "Global version", globalScope);

		// Delete only from local
		const deleted = await adapter.delete(TestPrompt.Duplicate, PromptScope.Local);
		expect(deleted).toBe(true);

		// Local should be gone
		expect(await adapter.read(TestPrompt.Duplicate, PromptScope.Local)).toBeNull();
		// Global should still exist
		expect(await adapter.read(TestPrompt.Duplicate, globalScope)).toBe(
			"Global version",
		);
	});

	// --- Bug 2: global splits into explicit global-omp and global-pi ---

	describe("three-scope storage (local / global-omp / global-pi)", () => {
		let ompDir: string;
		let piDir: string;
		let adapter: FsStorageAdapter;

		beforeEach(() => {
			ompDir = path.join(tempDir, "omp-prompts");
			piDir = path.join(tempDir, "pi-prompts");
			fs.mkdirSync(ompDir, { recursive: true });
			fs.mkdirSync(piDir, { recursive: true });
			adapter = new FsStorageAdapter({
				ompGlobalDir: ompDir,
				piGlobalDir: piDir,
				localDir,
			});

			fs.writeFileSync(path.join(ompDir, TestPrompt.OmpOnly), "from omp", "utf-8");
			fs.writeFileSync(path.join(piDir, TestPrompt.PiOnly), "from pi", "utf-8");
		});

		it("writes each global scope to its own host directory", async () => {
			await adapter.write(TestPrompt.Targeted, "written to omp", PromptScope.GlobalOmp);
			await adapter.write(TestPrompt.Targeted, "written to pi", PromptScope.GlobalPi);

			expect(fs.readFileSync(path.join(ompDir, TestPrompt.Targeted), "utf-8")).toBe(
				"written to omp",
			);
			expect(fs.readFileSync(path.join(piDir, TestPrompt.Targeted), "utf-8")).toBe(
				"written to pi",
			);
		});

		it("lists files from all three scopes with correct scope tags", async () => {
			const files = await adapter.list();

			const byName = new Map(files.map((f) => [`${f.scope}:${f.name}`, f]));
			expect(byName.get(`global-omp:${TestPrompt.OmpOnly}`)).toBeDefined();
			expect(byName.get(`global-pi:${TestPrompt.PiOnly}`)).toBeDefined();
			expect(byName.get(`local:${TestPrompt.LocalRules}`)).toBeDefined();
		});

		it("reads each global scope from its own host directory", async () => {
			expect(await adapter.read(TestPrompt.OmpOnly, PromptScope.GlobalOmp)).toBe("from omp");
			expect(await adapter.read(TestPrompt.PiOnly, PromptScope.GlobalPi)).toBe("from pi");
		});

		it("deletes only from the targeted global scope", async () => {
			await adapter.write(TestPrompt.Dup, "omp copy", PromptScope.GlobalOmp);
			await adapter.write(TestPrompt.Dup, "pi copy", PromptScope.GlobalPi);

			expect(await adapter.delete(TestPrompt.Dup, PromptScope.GlobalPi)).toBe(true);
			expect(await adapter.read(TestPrompt.Dup, PromptScope.GlobalPi)).toBeNull();
			expect(await adapter.read(TestPrompt.Dup, PromptScope.GlobalOmp)).toBe("omp copy");
		});

		it("exposes each global directory for display", async () => {
			expect(await adapter.getGlobalDirectory(PromptScope.GlobalOmp)).toBe(ompDir);
			expect(await adapter.getGlobalDirectory(PromptScope.GlobalPi)).toBe(piDir);
			// With no scope, the detected host's directory wins.
			const hostDir =
				globalScopeFor(detectHost()) === PromptScope.GlobalOmp ? ompDir : piDir;
			expect(await adapter.getGlobalDirectory()).toBe(hostDir);
		});
	});
});
