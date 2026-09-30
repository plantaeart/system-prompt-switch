import { beforeEach, describe, expect, it } from "bun:test";
import { NONE_OPTION, PromptService } from "../../src/core/prompt-service";
import type { PromptFileInfo } from "../../src/core/types/prompt-file-info.type";
import type { SessionPromptConfig } from "../../src/core/types/session-prompt-config.type";
import type { SessionStatePort } from "../../src/ports/session-state.port";
import type { StoragePort } from "../../src/ports/storage.port";
import { detectHost } from "../../src/core/paths";
import { FixturePrompt } from "../fixtures/fixture-prompt.enum";
import {
	globalScopeFor,
	PromptScope,
} from "../../src/core/types/prompt-scope.type";
import type { UIPort } from "../../src/ports/ui.port";

/**
 * The suite must pass on whichever host the machine resolves to, so the mock
 * treats its two global maps as "the detected host's scope" and "the other
 * host's scope" rather than hard-coding omp and pi.
 */
const HOST_SCOPE = globalScopeFor(detectHost());
const OTHER_SCOPE =
	HOST_SCOPE === PromptScope.GlobalOmp ? PromptScope.GlobalPi : PromptScope.GlobalOmp;
/** The modal label for the detected host, e.g. "omp" or "pi". */
const HOST_LABEL = HOST_SCOPE === PromptScope.GlobalOmp ? "omp" : "pi";

class MockStorage implements StoragePort {
	localFiles = new Map<string, string>();
	/** Backed by the detected host (omp in this repo's dev env). */
	globalFiles = new Map<string, string>();
	piFiles = new Map<string, string>();

	get files(): Map<string, string> {
		return this.globalFiles;
	}

	async list(): Promise<PromptFileInfo[]> {
		const locals = Array.from(this.localFiles.entries()).map(([name, content]) => ({
			name,
			path: `/prompts/local/${name}`,
			scope: PromptScope.Local as PromptScope,
			sizeChars: content.length,
			modifiedAt: 1000,
		}));
		const ompGlobals = Array.from(this.globalFiles.entries()).map(
			([name, content]) => ({
				name,
				path: `/prompts/host-global/${name}`,
				scope: HOST_SCOPE,
				sizeChars: content.length,
				modifiedAt: 1000,
			}),
		);
		const piGlobals = Array.from(this.piFiles.entries()).map(
			([name, content]) => ({
				name,
				path: `/prompts/other-global/${name}`,
				scope: OTHER_SCOPE,
				sizeChars: content.length,
				modifiedAt: 1000,
			}),
		);
		return [...locals, ...ompGlobals, ...piGlobals];
	}

	async read(name: string, scope?: PromptScope): Promise<string | null> {
		if (scope === PromptScope.Local) return this.localFiles.get(name) ?? null;
		if (scope === OTHER_SCOPE) return this.piFiles.get(name) ?? null;
		if (scope === HOST_SCOPE) return this.globalFiles.get(name) ?? null;
		return (
			this.localFiles.get(name) ??
			this.globalFiles.get(name) ??
			this.piFiles.get(name) ??
			null
		);
	}

	async write(
		name: string,
		content: string,
		scope: PromptScope = HOST_SCOPE,
	): Promise<void> {
		if (scope === PromptScope.Local) this.localFiles.set(name, content);
		else if (scope === OTHER_SCOPE) this.piFiles.set(name, content);
		else this.globalFiles.set(name, content);
	}

	async delete(name: string, scope?: PromptScope): Promise<boolean> {
		if (scope === PromptScope.Local) return this.localFiles.delete(name);
		if (scope === OTHER_SCOPE) return this.piFiles.delete(name);
		if (scope === HOST_SCOPE) return this.globalFiles.delete(name);
		return (
			this.localFiles.delete(name) ||
			this.globalFiles.delete(name) ||
			this.piFiles.delete(name)
		);
	}

	getGlobalDirectory(scope?: PromptScope): string {
		if (scope === PromptScope.Local) return "/prompts/local";
		if (scope === OTHER_SCOPE) return "/prompts/other-global";
		return "/prompts/host-global";
	}

	getLocalDirectory(): string {
		return "/prompts/local";
	}

	setCwd(_cwd: string): void {}
}

class MockSessionState implements SessionStatePort {
	sessions = new Map<string, SessionPromptConfig>();

	async getSessionConfig(sessionId: string): Promise<SessionPromptConfig | null> {
		return this.sessions.get(sessionId) ?? null;
	}

	async setSessionConfig(
		sessionId: string,
		config: SessionPromptConfig,
	): Promise<void> {
		this.sessions.set(sessionId, { ...config });
	}
}

class MockUI implements UIPort {
	selectChoice: string | undefined;
	selectChoices: string[] = [];
	selectCalls = 0;
	offeredOptions: string[][] = [];
	inputValue: string | undefined;
	inputValues: string[] = [];
	editorValue: string | undefined;
	confirmValue = true;
	notifications: Array<{ message: string; type?: string }> = [];
	currentWidget: string[] | undefined;
	widgetHistory: Array<string[] | undefined> = [];
	hasUIValue = true;

	hasUI(): boolean {
		return this.hasUIValue;
	}
	async select(_title?: string, options?: string[]): Promise<string | undefined> {
		this.selectCalls++;
		if (options) this.offeredOptions.push(options);
		return this.selectChoices.shift() ?? this.selectChoice;
	}

	async input(): Promise<string | undefined> {
		if (this.inputValues.length > 0) {
			return this.inputValues.shift();
		}
		return this.inputValue;
	}

	async editor(): Promise<string | undefined> {
		return this.editorValue;
	}

	async confirm(): Promise<boolean> {
		return this.confirmValue;
	}

	notify(message: string, type?: "info" | "warning" | "error"): void {
		this.notifications.push({ message, type });
	}


	setWidget(content: string[] | undefined): void {
		this.currentWidget = content;
		this.widgetHistory.push(content);
	}
}

describe("PromptService", () => {
	let storage: MockStorage;
	let sessionState: MockSessionState;
	let ui: MockUI;
	let service: PromptService;

	beforeEach(() => {
		storage = new MockStorage();
		sessionState = new MockSessionState();
		ui = new MockUI();
		service = new PromptService(storage, sessionState, ui);
	});

	it("returns default config when session has no prior config", async () => {
		const config = await service.getCurrentConfig("sess-1");
		expect(config.file).toBeNull();
		expect(config.mode).toBe("append");
		expect(config.enabled).toBe(true);
	});

	it("clears prompt when NONE_OPTION is chosen in selectPrompt", async () => {
		await sessionState.setSessionConfig("sess-1", {
			file: FixturePrompt.Coder,
			mode: "append",
			enabled: true,
		});
		ui.selectChoice = NONE_OPTION;

		const result = await service.selectPrompt("sess-1");
		expect(result).toBeNull();

		const updated = await service.getCurrentConfig("sess-1");
		expect(updated.file).toBeNull();
		expect(ui.currentWidget?.[0]).toContain("Active Prompt: (none) (append mode)");
	});

	it("selects a file when chosen in selectPrompt", async () => {
		storage.files.set(FixturePrompt.Reviewer, "You are a reviewer.");
		ui.selectChoice = `[${HOST_LABEL}] reviewer.md`;

		const result = await service.selectPrompt("sess-1");
		expect(result).toBe(FixturePrompt.Reviewer);

		const updated = await service.getCurrentConfig("sess-1");
		expect(updated.file).toBe(FixturePrompt.Reviewer);
		expect(ui.currentWidget?.[0]).toContain(`[${HOST_LABEL}] reviewer.md (append mode)`);
	});

	it("creates a new prompt and can activate it for session", async () => {
		ui.inputValue = "security-auditor";
		ui.selectChoices = [`[${HOST_LABEL}] User home (~/.omp or ~/.pi)`];
		ui.editorValue = "Audit for vulnerabilities.";
		const result = await service.createNewPrompt("sess-1");
		expect(result).toBe(FixturePrompt.SecurityAuditor);
		expect(storage.files.get(FixturePrompt.SecurityAuditor)).toBe(
			"Audit for vulnerabilities.",
		);

		const updated = await service.getCurrentConfig("sess-1");
		expect(updated.file).toBe(FixturePrompt.SecurityAuditor);
	});

	it("shows the editor-shortcut banner widget while creating a prompt, then restores status", async () => {
		ui.inputValue = FixturePrompt.Auditor;
		ui.editorValue = "Audit body.";

		const beforeHistoryLength = ui.widgetHistory.length;
		await service.createNewPrompt("sess-1");

		const bannerWidget = ui.widgetHistory
			.slice(beforeHistoryLength)
			.find((w) => w?.some((line) => line.includes("Editor shortcuts")));

		expect(bannerWidget).toBeDefined();
		expect(bannerWidget?.some((line) => line.includes("Ctrl+Q"))).toBe(true);
		expect(bannerWidget?.some((line) => line.includes("Esc"))).toBe(true);

		const finalWidget = ui.widgetHistory[ui.widgetHistory.length - 1];
		expect(finalWidget?.[0]).toContain("Active Prompt");
	});

	it("edits an existing prompt", async () => {
		storage.files.set(FixturePrompt.Dev, "Original content");
		await sessionState.setSessionConfig("sess-1", {
			file: FixturePrompt.Dev,
			mode: "append",
			enabled: true,
		});
		ui.selectChoices = [];
		ui.editorValue = "Updated content";

		const success = await service.editPrompt("sess-1");
		expect(success).toBe(true);
		expect(storage.files.get(FixturePrompt.Dev)).toBe("Updated content");
	});

	it("shows the editor-shortcut banner widget while editing a prompt, then restores status", async () => {
		storage.files.set(FixturePrompt.Dev, "Original content");
		await sessionState.setSessionConfig("sess-1", {
			file: FixturePrompt.Dev,
			mode: "append",
			enabled: true,
		});
		ui.selectChoices = [];
		ui.editorValue = "Updated content";

		const beforeHistoryLength = ui.widgetHistory.length;
		await service.editPrompt("sess-1");

		const bannerWidget = ui.widgetHistory
			.slice(beforeHistoryLength)
			.find((w) => w?.some((line) => line.includes("Editor shortcuts")));

		expect(bannerWidget).toBeDefined();
		expect(bannerWidget?.some((line) => line.includes("Ctrl+Q"))).toBe(true);
		expect(bannerWidget?.some((line) => line.includes("Esc"))).toBe(true);

		// ponytail: regression guard — every banner line must be the same
		// character width so the box-drawing corners align in the terminal.
		const widths = (bannerWidget ?? []).map((line) => [...line].length);
		expect(new Set(widths).size).toBe(1);

		const finalWidget = ui.widgetHistory[ui.widgetHistory.length - 1];
		expect(finalWidget?.[0]).toContain("Active Prompt");
	});

	it("deletes a prompt and resets current session if it was active", async () => {
		storage.files.set(FixturePrompt.Temp, "temp content");
		await sessionState.setSessionConfig("sess-1", {
			file: FixturePrompt.Temp,
			mode: "append",
			enabled: true,
		});
		ui.selectChoice = `[${HOST_LABEL}] temp.md`;
		ui.confirmValue = true;

		const success = await service.deletePrompt("sess-1");
		expect(success).toBe(true);
		expect(storage.files.has(FixturePrompt.Temp)).toBe(false);

		const updated = await service.getCurrentConfig("sess-1");
		expect(updated.file).toBeNull();
		expect(ui.currentWidget?.[0]).toContain("Active Prompt: (none) (append mode)");
	});

	it("toggles mode between append and replace", async () => {
		const m1 = await service.toggleMode("sess-1");
		expect(m1).toBe("replace");

		const m2 = await service.toggleMode("sess-1");
		expect(m2).toBe("append");

		const m3 = await service.toggleMode("sess-1", "replace");
		expect(m3).toBe("replace");
	});

	it("resolves prompt for turn with custom content", async () => {
		storage.files.set(FixturePrompt.Pirate, "Speak like a pirate captain.");
		await sessionState.setSessionConfig("sess-1", {
			file: FixturePrompt.Pirate,
			mode: "append",
			enabled: true,
		});

		const result = await service.resolvePromptForTurn("sess-1", {
			basePrompt: "Base prompt",
		});
		expect(result).toContain("Base prompt");
		expect(result).toContain("System Prompt Switch (extension context)");
		expect(result).toContain(`### [${HOST_LABEL}] pirate.md`);
		expect(result).toContain("Speak like a pirate captain.");
	});

	it("cumulatively injects multiple prompts", async () => {
		storage.files.set(FixturePrompt.Prompt1, "Prompt 1 content");
		storage.files.set(FixturePrompt.Prompt2, "Prompt 2 content");

		// Inject first prompt
		ui.selectChoices = [`[${HOST_LABEL}] prompt1.md`];
		await service.injectPrompt("sess-1");

		let config = await service.getCurrentConfig("sess-1");
		expect(config.activePrompts.length).toBe(1);

		// Inject second prompt
		ui.selectChoices = [`[${HOST_LABEL}] prompt2.md`];
		await service.injectPrompt("sess-1");

		config = await service.getCurrentConfig("sess-1");
		expect(config.activePrompts.length).toBe(2);
		expect(ui.currentWidget?.[0]).toContain(`Active Prompt: [${HOST_LABEL}] prompt1.md (append mode)`);

		// Resolves turn with both prompts combined
		const result = await service.resolvePromptForTurn("sess-1", {
			basePrompt: "Base instructions",
		});
		expect(result).toContain("Prompt 1 content");
		expect(result).toContain("Prompt 2 content");
	});

	it("keeps primary stable when injecting a same-named prompt from another scope", async () => {
		storage.globalFiles.set(FixturePrompt.B, "Global B");
		storage.localFiles.set(FixturePrompt.B, "Local B");
		await sessionState.setSessionConfig("sess-1", {
			file: FixturePrompt.B,
			scope: PromptScope.Local,
			activePrompts: [{ name: FixturePrompt.B, scope: PromptScope.Local }],
			mode: "append",
			enabled: true,
		});

		ui.selectChoices = [`[${HOST_LABEL}] b.md`];
		await service.injectPrompt("sess-1");

		const config = await service.getCurrentConfig("sess-1");
		expect(config.activePrompts).toEqual([
			{ name: FixturePrompt.B, scope: PromptScope.Local },
			{ name: FixturePrompt.B, scope: HOST_SCOPE, injected: true },
		]);
		expect(config.file).toBe(FixturePrompt.B);
		expect(config.scope).toBe(PromptScope.Local);
	});

	it("does not toggle off the primary in inject modal", async () => {
		await sessionState.setSessionConfig("sess-1", {
			file: FixturePrompt.B,
			scope: PromptScope.Local,
			activePrompts: [{ name: FixturePrompt.B, scope: PromptScope.Local }],
			mode: "append",
			enabled: true,
		});
		storage.localFiles.set(FixturePrompt.B, "Local B");

		ui.selectChoices = ["[local] b.md [SELECTED] ✓"];
		await service.injectPrompt("sess-1");

		const config = await service.getCurrentConfig("sess-1");
		expect(config.activePrompts).toEqual([
			{ name: FixturePrompt.B, scope: PromptScope.Local },
		]);
		expect(config.file).toBe(FixturePrompt.B);
		expect(config.scope).toBe(PromptScope.Local);
		expect(
			ui.notifications.some((n) =>
				n.message.toLowerCase().includes("primary"),
			),
		).toBe(true);
	});

	it("toggles off a non-primary injection without touching the primary", async () => {
		storage.globalFiles.set(FixturePrompt.A, "A");
		storage.localFiles.set(FixturePrompt.B, "Local B");
		await sessionState.setSessionConfig("sess-1", {
			file: FixturePrompt.B,
			scope: PromptScope.Local,
			activePrompts: [
				{ name: FixturePrompt.B, scope: PromptScope.Local },
				{ name: FixturePrompt.A, scope: HOST_SCOPE },
			],
			mode: "append",
			enabled: true,
		});

		ui.selectChoices = [`[${HOST_LABEL}] a.md [INJECTED] ✓`];
		await service.injectPrompt("sess-1");

		const config = await service.getCurrentConfig("sess-1");
		expect(config.activePrompts).toEqual([
			{ name: FixturePrompt.B, scope: PromptScope.Local },
		]);
		expect(config.file).toBe(FixturePrompt.B);
		expect(config.scope).toBe(PromptScope.Local);
	});

	it("does not change primary when injecting on a stack that already has one", async () => {
		storage.globalFiles.set(FixturePrompt.A, "A");
		storage.localFiles.set(FixturePrompt.B, "Local B");
		await sessionState.setSessionConfig("sess-1", {
			file: FixturePrompt.B,
			scope: PromptScope.Local,
			activePrompts: [{ name: FixturePrompt.B, scope: PromptScope.Local }],
			mode: "append",
			enabled: true,
		});

		ui.selectChoices = [`[${HOST_LABEL}] a.md`];
		await service.injectPrompt("sess-1");

		const config = await service.getCurrentConfig("sess-1");
		expect(config.activePrompts).toEqual([
			{ name: FixturePrompt.B, scope: PromptScope.Local },
			{ name: FixturePrompt.A, scope: HOST_SCOPE, injected: true },
		]);
		expect(config.file).toBe(FixturePrompt.B);
		expect(config.scope).toBe(PromptScope.Local);
	});

	it("marks entries pushed by injectPrompt with injected: true", async () => {
		storage.files.set(FixturePrompt.A, "A primary");
		storage.files.set(FixturePrompt.B, "B extra");
		await sessionState.setSessionConfig("sess-1", {
			file: FixturePrompt.A,
			scope: HOST_SCOPE,
			activePrompts: [{ name: FixturePrompt.A, scope: HOST_SCOPE }],
			mode: "append",
			enabled: true,
		});

		ui.selectChoices = [`[${HOST_LABEL}] b.md`];
		await service.injectPrompt("sess-1");

		const config = await service.getCurrentConfig("sess-1");
		const ref = config.activePrompts.find(
			(p) => p.name === FixturePrompt.B && p.scope === HOST_SCOPE,
		);
		expect(ref?.injected).toBe(true);
	});

	it("does not mark the primary as injected when selectPrompt sets it", async () => {
		storage.files.set(FixturePrompt.A, "A");
		ui.selectChoice = `[${HOST_LABEL}] a.md`;

		await service.selectPrompt("sess-sel");

		const config = await service.getCurrentConfig("sess-sel");
		expect(config.activePrompts).toEqual([
			{ name: FixturePrompt.A, scope: HOST_SCOPE },
		]);
		expect(config.activePrompts[0].injected).toBeUndefined();
	});

	it("resolvePromptForTurn strips injected entries and keeps the primary", async () => {
		storage.files.set(FixturePrompt.B, "B content");
		storage.files.set(FixturePrompt.C, "C content");
		await sessionState.setSessionConfig("sess-resolve", {
			file: FixturePrompt.B,
			scope: HOST_SCOPE,
			activePrompts: [
				{ name: FixturePrompt.B, scope: HOST_SCOPE },
				{ name: FixturePrompt.C, scope: HOST_SCOPE, injected: true },
			],
			mode: "append",
			enabled: true,
		});

		const result = await service.resolvePromptForTurn("sess-resolve", {
			basePrompt: "Base",
		});
		expect(result).toContain("B content");
		expect(result).toContain("C content");

		const config = await service.getCurrentConfig("sess-resolve");
		expect(config.activePrompts).toEqual([
			{ name: FixturePrompt.B, scope: HOST_SCOPE },
		]);

		const nextResult = await service.resolvePromptForTurn("sess-resolve", {
			basePrompt: "Base",
		});
		expect(nextResult).toContain("B content");
		expect(nextResult).not.toContain("C content");
	});

	it("widget shows only the primary even when an injection is pending", async () => {
		storage.files.set(FixturePrompt.B, "B content");
		storage.files.set(FixturePrompt.C, "C content");
		await sessionState.setSessionConfig("sess-widget", {
			file: FixturePrompt.B,
			scope: HOST_SCOPE,
			activePrompts: [
				{ name: FixturePrompt.B, scope: HOST_SCOPE },
				{ name: FixturePrompt.C, scope: HOST_SCOPE, injected: true },
			],
			mode: "append",
			enabled: true,
		});

		await service.updateStatus("sess-widget");

		expect(ui.currentWidget?.[0]).toContain(
			`Active Prompt: [${HOST_LABEL}] b.md (append mode)`,
		);
		expect(ui.currentWidget?.[0]).not.toContain(FixturePrompt.C);
		expect(ui.currentWidget?.[0]).not.toContain("extra");
	});

	it("resolvePromptForTurn injects an extension-context block even when no user prompt is active", async () => {
		await sessionState.setSessionConfig("sess-ctx-empty", {
			file: null,
			scope: undefined,
			activePrompts: [],
			mode: "append",
			enabled: true,
		});

		const result = await service.resolvePromptForTurn("sess-ctx-empty", {
			basePrompt: "Base prompt.",
		});

		expect(result).toContain("Base prompt.");
		expect(result).toContain("System Prompt Switch");
		expect(result).toContain("~/.omp/agent/system-prompts-switch");
	});

	it("resolvePromptForTurn lists active prompts in the extension-context block", async () => {
		storage.files.set(FixturePrompt.Beh, "BEH content");
		await sessionState.setSessionConfig("sess-ctx-active", {
			file: FixturePrompt.Beh,
			scope: HOST_SCOPE,
			activePrompts: [{ name: FixturePrompt.Beh, scope: HOST_SCOPE }],
			mode: "append",
			enabled: true,
		});

		const result = await service.resolvePromptForTurn("sess-ctx-active", {
			basePrompt: "Base prompt.",
		});

		expect(result).toContain("Base prompt.");
		expect(result).toContain("System Prompt Switch");
		expect(result).toContain(`[${HOST_LABEL}] beh.md`);
		expect(result).toContain("BEH content");
	});

	it("pre-ticks nothing in the startup modal on a fresh session", async () => {
		storage.files.set(FixturePrompt.Beh, "BEH content");
		ui.selectChoices = [];

		await service.promptNewSessionModal("sess-fresh-modal");

		const offered = ui.offeredOptions.at(-1) ?? [];
		// No entry may arrive pre-selected: the user has not chosen yet, and a
		// tick on (None / Default) made the modal answer itself.
		expect(offered.length).toBeGreaterThan(0);
		expect(offered.some((o) => o.includes("✓"))).toBe(false);
	});

	it("defaults to None and clears widget when startup modal is dismissed", async () => {
		ui.selectChoice = undefined; // user pressed Esc or cancelled
		await service.promptNewSessionModal("sess-dismiss");

		const config = await service.getCurrentConfig("sess-dismiss");
		expect(config.file).toBeNull();
		expect(config.activePrompts.length).toBe(0);
		expect(ui.currentWidget?.[0]).toContain("Active Prompt: (none) (append mode)");
	});

	// --- Bug 1: resuming a session where the user already chose (None) must not re-ask ---

	it("BUG 1: does not re-open the modal when the session already decided (None)", async () => {
		await sessionState.setSessionConfig("sess-decided-none", {
			file: null,
			scope: undefined,
			activePrompts: [],
			mode: "append",
			enabled: true,
			decided: true,
		});

		await service.promptNewSessionModal("sess-decided-none");

		expect(ui.selectCalls).toBe(0);
		expect(ui.currentWidget?.[0]).toContain("Active Prompt: (none) (append mode)");
	});

	it("BUG 1: records decided=true after the modal is dismissed", async () => {
		ui.selectChoices = [];
		await service.promptNewSessionModal("sess-dismiss-marks");

		const config = await service.getCurrentConfig("sess-dismiss-marks");
		expect(config.decided).toBe(true);
		expect(ui.selectCalls).toBe(1);

		// A later resume must stay silent.
		await service.promptNewSessionModal("sess-dismiss-marks");
		expect(ui.selectCalls).toBe(1);
	});

	it("BUG 1: records decided=true after picking a prompt from the modal", async () => {
		storage.files.set(FixturePrompt.Beh, "BEH content");
		ui.selectChoices = [`[${HOST_LABEL}] beh.md`];

		await service.promptNewSessionModal("sess-dismiss-pick");

		const config = await service.getCurrentConfig("sess-dismiss-pick");
		expect(config.decided).toBe(true);
		expect(config.activePrompts).toEqual([
			{ name: FixturePrompt.Beh, scope: HOST_SCOPE },
		]);
	});

	it("BUG 1: does not re-open the modal when a decided session has a prompt selected", async () => {
		storage.files.set(FixturePrompt.Beh, "BEH content");
		await sessionState.setSessionConfig("sess-decided-prompt", {
			file: FixturePrompt.Beh,
			scope: HOST_SCOPE,
			activePrompts: [{ name: FixturePrompt.Beh, scope: HOST_SCOPE }],
			mode: "append",
			enabled: true,
			decided: true,
		});

		await service.promptNewSessionModal("sess-decided-prompt");

		expect(ui.selectCalls).toBe(0);
		expect(ui.currentWidget?.[0]).toContain(
			`Active Prompt: [${HOST_LABEL}] beh.md (append mode)`,
		);
	});

	it("allows creating a local prompt with the same name as an existing global prompt", async () => {
		storage.globalFiles.set(FixturePrompt.Guideline, "Global guidelines");

		ui.inputValue = "guidelines";
		ui.selectChoices = ["1. Built-in terminal editor"];
		ui.editorValue = "Local specific guidelines";

		const result = await service.createNewPrompt("sess-col-1", PromptScope.Local);
		expect(result).toBe(FixturePrompt.Guideline);
		expect(storage.localFiles.get(FixturePrompt.Guideline)).toBe("Local specific guidelines");
		expect(storage.globalFiles.get(FixturePrompt.Guideline)).toBe("Global guidelines");
	});

	it("rejects creating a local prompt when same name exists in local scope", async () => {
		storage.localFiles.set(FixturePrompt.Duplicate, "Existing local content");

		ui.inputValue = "duplicate";
		const result = await service.createNewPrompt("sess-col-2", PromptScope.Local);
		expect(result).toBeNull();
		const lastNotification = ui.notifications[ui.notifications.length - 1];
		expect(lastNotification.message).toContain("already exists in local scope");
	});

	it("rejects creating a global prompt when same name exists in global scope", async () => {
		storage.globalFiles.set(FixturePrompt.Duplicate, "Existing global content");

		ui.inputValue = "duplicate";
		const result = await service.createNewPrompt("sess-col-3", HOST_SCOPE);
		expect(result).toBeNull();
		const lastNotification = ui.notifications[ui.notifications.length - 1];
		expect(lastNotification.message).toContain(`already exists in ${HOST_LABEL} scope`);
	});

	it("accepts a hyphenated name and auto-appends .md", async () => {
		ui.inputValue = "Backend-Dev";
		ui.selectChoices = ["1. Built-in terminal editor"];
		ui.editorValue = "body";

		const result = await service.createNewPrompt("sess-name-1", HOST_SCOPE);
		expect(result).toBe(FixturePrompt.BackendDev);
		expect(storage.globalFiles.get(FixturePrompt.BackendDev)).toBe("body");
	});

	it("rejects a name containing whitespace, then accepts a valid retry", async () => {
		ui.inputValues = ["Test test", "Backend-Dev"];
		ui.selectChoices = ["1. Built-in terminal editor"];
		ui.editorValue = "body";

		const result = await service.createNewPrompt("sess-name-1b", HOST_SCOPE);
		expect(result).toBe(FixturePrompt.BackendDev);
		expect(storage.globalFiles.get(FixturePrompt.BackendDev)).toBe("body");
		expect(storage.globalFiles.has("Test test.md")).toBe(false);

		const errorNotice = ui.notifications.find((n) =>
			n.message.toLowerCase().includes("whitespace"),
		);
		expect(errorNotice).toBeDefined();
	});

	it("rejects a name containing a slash, then accepts a valid retry", async () => {
		ui.inputValues = ["foo/bar", "ok-name"];
		ui.selectChoices = ["1. Built-in terminal editor"];
		ui.editorValue = "body";

		const result = await service.createNewPrompt("sess-name-2", HOST_SCOPE);
		expect(result).toBe(FixturePrompt.OkName);
		expect(storage.globalFiles.get(FixturePrompt.OkName)).toBe("body");

		const errorNotice = ui.notifications.find((n) =>
			n.message.toLowerCase().includes("invalid"),
		);
		expect(errorNotice).toBeDefined();
	});

	it("rejects an empty name, then accepts a valid retry", async () => {
		ui.inputValues = ["   ", "valid"];
		ui.selectChoices = ["1. Built-in terminal editor"];
		ui.editorValue = "body";

		const result = await service.createNewPrompt("sess-name-3", HOST_SCOPE);
		expect(result).toBe(FixturePrompt.Valid);
		expect(storage.globalFiles.get(FixturePrompt.Valid)).toBe("body");

		const errorNotice = ui.notifications.find((n) =>
			n.message.toLowerCase().includes("empty"),
		);
		expect(errorNotice).toBeDefined();
	});

	it("returns formatted paths summary including active prompt and directories", async () => {
		storage.localFiles.set(FixturePrompt.LocalPrompt, "local");
		storage.globalFiles.set(FixturePrompt.HostPrompt, "global");

		await sessionState.setSessionConfig("sess-paths", {
			file: FixturePrompt.LocalPrompt,
			scope: PromptScope.Local,
			activePrompts: [{ name: FixturePrompt.LocalPrompt, scope: PromptScope.Local }],
			mode: "append",
			enabled: true,
		});

		const summary = await service.getPathsSummary("sess-paths");
		const text = summary.join("\n");
		expect(text).toContain("=== System Prompt Switch — Paths ===");
		expect(text).toContain("Active Prompt:");
		expect(text).toContain("[local] /prompts/local/local-prompt.md");
		expect(text).toContain("Directories:");
		expect(text).toContain("Local: /prompts/local");
		expect(text).toContain(
			`OMP:   ${HOST_SCOPE === PromptScope.GlobalOmp ? "/prompts/host-global" : "/prompts/other-global"}`,
		);
		expect(text).toContain(
			`PI:    ${HOST_SCOPE === PromptScope.GlobalPi ? "/prompts/host-global" : "/prompts/other-global"}`,
		);
		expect(text).toContain("All Available Prompts:");
		expect(text).toContain("/prompts/local/local-prompt.md");
		expect(text).toContain("/prompts/host-global/global-prompt.md");
	});
});
