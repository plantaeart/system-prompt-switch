import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FsStorageAdapter } from "../../src/adapters/fs-storage.adapter";
import { TestPrompt } from "../fixtures/test-prompt.enum";
import { registerTestPrompt } from "../helpers/test-prompt-registry";
import { SessionStateAdapter } from "../../src/adapters/session-state.adapter";
import { PromptService } from "../../src/core/prompt-service";
import type { UIPort } from "../../src/ports/ui.port";

class DummyUI implements UIPort {
	hasUI(): boolean {
		return false;
	}
	async select(): Promise<string | undefined> {
		return undefined;
	}
	async input(): Promise<string | undefined> {
		return undefined;
	}
	async editor(): Promise<string | undefined> {
		return undefined;
	}
	async confirm(): Promise<boolean> {
		return false;
	}
	notify(): void {}
	setWidget(): void {}
}

describe("Session Isolation", () => {
	let tempDir: string;
	let statePath: string;
	let promptsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sps-test-"));
		promptsDir = path.join(tempDir, "prompts");
		statePath = path.join(tempDir, "state", "sessions.json");

		fs.mkdirSync(promptsDir, { recursive: true });
		fs.writeFileSync(
			path.join(promptsDir, TestPrompt.Spr1),
			"You are Persona 1.",
			"utf-8",
		);
		fs.writeFileSync(
			path.join(promptsDir, TestPrompt.Spr2),
			"You are Persona 2.",
			"utf-8",
		);

		registerTestPrompt(promptsDir, TestPrompt.Spr1);
		registerTestPrompt(promptsDir, TestPrompt.Spr2);
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	it("preserves separate prompt configs across different sessions", async () => {
		const storage = new FsStorageAdapter({ globalDir: promptsDir });
		const sessionState = new SessionStateAdapter(statePath);
		const ui = new DummyUI();
		const service = new PromptService(storage, sessionState, ui);

		// Session 1 selects SPR1
		await sessionState.setSessionConfig("session-1", {
			file: TestPrompt.Spr1,
			mode: "append",
			enabled: true,
		});

		// Session 2 selects SPR2
		await sessionState.setSessionConfig("session-2", {
			file: TestPrompt.Spr2,
			mode: "replace",
			enabled: true,
		});

		// Verify Session 1 still has SPR1
		const s1Config = await service.getCurrentConfig("session-1");
		expect(s1Config.file).toBe(TestPrompt.Spr1);
		expect(s1Config.mode).toBe("append");

		// Verify Session 2 has SPR2
		const s2Config = await service.getCurrentConfig("session-2");
		expect(s2Config.file).toBe(TestPrompt.Spr2);
		expect(s2Config.mode).toBe("replace");

		// Verify resolution differs for each session
		const s1Turn = await service.resolvePromptForTurn("session-1", {
			basePrompt: "Base",
		});
		expect(s1Turn).toContain("You are Persona 1.");
		expect(s1Turn).not.toContain("You are Persona 2.");

		const s2Turn = await service.resolvePromptForTurn("session-2", {
			basePrompt: "Base",
		});
		expect(s2Turn).toContain("You are Persona 2.");
		expect(s2Turn).not.toContain("You are Persona 1.");
	});

	it("restores Session 1 prompt after simulated process restart", async () => {
		// First run: save configurations
		{
			const sessionState = new SessionStateAdapter(statePath);
			await sessionState.setSessionConfig("session-1", {
				file: TestPrompt.Spr1,
				mode: "append",
				enabled: true,
			});
			await sessionState.setSessionConfig("session-2", {
				file: TestPrompt.Spr2,
				mode: "replace",
				enabled: true,
			});
		}

		// Second run (simulating stopping and reopening session 1):
		{
			const freshStorage = new FsStorageAdapter({ globalDir: promptsDir });
			const freshSessionState = new SessionStateAdapter(statePath);
			const freshService = new PromptService(
				freshStorage,
				freshSessionState,
				new DummyUI(),
			);

			// Session 1 is reopened: it must restore SPR1, NOT SPR2
			const restoredS1 = await freshService.getCurrentConfig("session-1");
			expect(restoredS1.file).toBe(TestPrompt.Spr1);
			expect(restoredS1.mode).toBe("append");

			const restoredS2 = await freshService.getCurrentConfig("session-2");
			expect(restoredS2.file).toBe(TestPrompt.Spr2);
			expect(restoredS2.mode).toBe("replace");
		}
	});
});
