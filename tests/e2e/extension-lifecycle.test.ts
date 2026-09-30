import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ExtensionEventType } from "../../src/core/types/extension-event-type.type";
import { SessionStartReason } from "../../src/core/types/session-start-reason.type";
import { detectHost } from "../../src/core/paths";
import { ExtensionCommand } from "../../src/core/types/extension-command.type";
import { TestPrompt } from "../fixtures/test-prompt.enum";
import {
	globalScopeFor,
	PromptScope,
} from "../../src/core/types/prompt-scope.type";

/** The detected host, so the suite passes whichever binary the machine runs. */
const HOST_SCOPE = globalScopeFor(detectHost());
const HOST_LABEL = HOST_SCOPE === PromptScope.GlobalOmp ? "omp" : "pi";
import systemPromptSwitchExtension from "../../extensions/index";

describe("Extension Lifecycle E2E", () => {
	let tempDir: string;
	let promptsDir: string;
	let stateDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sps-e2e-"));
		promptsDir = path.join(tempDir, "prompts");
		stateDir = path.join(tempDir, "state");

		fs.mkdirSync(promptsDir, { recursive: true });
		fs.mkdirSync(stateDir, { recursive: true });
		process.env.SPS_PROMPT_DIR = promptsDir;
		process.env.SPS_STATE_PATH = path.join(stateDir, "sessions.json");

		fs.writeFileSync(
			path.join(promptsDir, TestPrompt.E2EPrompt),
			"You are an E2E test assistant.",
			"utf-8",
		);
	});

	afterEach(() => {
		delete process.env.SPS_PROMPT_DIR;
		delete process.env.SPS_STATE_PATH;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup
		}
	});

	it("registers commands and handles lifecycle events", async () => {
		const registeredCommands = new Map<string, unknown>();
		const registeredShortcuts = new Map<string, unknown>();
		type HandlerFn = (event: unknown, ctx: unknown) => unknown;
		const eventHandlers = new Map<string, HandlerFn[]>();
		const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
		const mockPi = {
			registerCommand(name: string, options: unknown) {
				registeredCommands.set(name, options);
			},
			on(event: string, handler: HandlerFn) {
				const existing = eventHandlers.get(event) ?? [];
				existing.push(handler);
				eventHandlers.set(event, existing);
			},
			appendEntry(customType: string, data?: unknown) {
				appendedEntries.push({ customType, data });
			},
			registerShortcut(shortcut: string, options: unknown) {
				registeredShortcuts.set(shortcut, options);
			},
		} as unknown as ExtensionAPI;

		// Load extension
		systemPromptSwitchExtension(mockPi);

		// Assert all required commands are registered
		expect(registeredCommands.has(ExtensionCommand.SELECT)).toBe(true);
		expect(registeredCommands.has(ExtensionCommand.INJECT)).toBe(true);
		expect(registeredCommands.has(ExtensionCommand.NEW)).toBe(true);
		expect(registeredCommands.has(ExtensionCommand.EDIT)).toBe(true);
		expect(registeredCommands.has(ExtensionCommand.DELETE)).toBe(true);
		expect(registeredCommands.has(ExtensionCommand.MODE)).toBe(true);
		expect(registeredCommands.has(ExtensionCommand.INFO)).toBe(true);
		expect(registeredCommands.has(ExtensionCommand.PATH)).toBe(true);
		expect(registeredCommands.has(ExtensionCommand.LOGS)).toBe(true);
		// Assert event handlers registered
		expect(eventHandlers.has("session_start")).toBe(true);
		expect(eventHandlers.has("before_agent_start")).toBe(true);
		expect(eventHandlers.has("session_shutdown")).toBe(true);

		// Mock context
		let selectTriggered = false;
		let currentWidget: string[] | undefined;
		const { promise: selectDone, resolve: resolveSelect } = Promise.withResolvers<void>();
		const mockCtx = {
			hasUI: true,
			cwd: tempDir,
			sessionManager: {
				getSessionId: () => "sess-e2e-1",
				getEntries: () => [],
			},
			ui: {
				select: async (_title: string, _options: string[]) => {
					selectTriggered = true;
					return `[${HOST_LABEL}] ${TestPrompt.E2EPrompt}`;
				},
				notify: () => {},
				setWidget: (_key: string, content: string[] | undefined) => {
					currentWidget = content;
					if (content) {
						resolveSelect();
					}
				},
			},
		} as unknown as ExtensionContext;

		// 1. Trigger session_start (reason: "new")
		const sessionStartHandlers = eventHandlers.get("session_start")!;
		for (const h of sessionStartHandlers) {
			await h({ type: "session_start", reason: "new" }, mockCtx);
		}
		await selectDone;

		expect(selectTriggered).toBe(true);
		expect(currentWidget?.[0]).toContain(`[${HOST_LABEL}] ${TestPrompt.E2EPrompt} (append mode)`);

		// 2. Trigger before_agent_start
		const beforeAgentHandlers = eventHandlers.get("before_agent_start")!;
		let result: { systemPrompt?: string } | undefined;
		for (const h of beforeAgentHandlers) {
			const res = (await h(
				{
					type: "before_agent_start",
					prompt: "hello",
					systemPrompt: "Default Pi System Prompt",
				},
				mockCtx,
			)) as { systemPrompt?: string } | undefined;
			if (res) result = res;
		}

		expect(result).toBeDefined();
		expect(result?.systemPrompt).toContain("Default Pi System Prompt");
		expect(result?.systemPrompt).toContain("You are an E2E test assistant.");

		// 3. Trigger session_shutdown
		const shutdownHandlers = eventHandlers.get("session_shutdown")!;
		for (const h of shutdownHandlers) {
			await h({ type: "session_shutdown" }, mockCtx);
		}
		expect(currentWidget).toBeUndefined();
	});

	it("does not re-ask the prompt modal when session_start reason is resume", async () => {
		const eventHandlers = new Map<string, ((e: unknown, c: unknown) => unknown)[]>();
		const mockPi = {
			registerCommand() {},
			registerShortcut() {},
			on(event: string, handler: (e: unknown, c: unknown) => unknown) {
				const list = eventHandlers.get(event) ?? [];
				list.push(handler);
				eventHandlers.set(event, list);
			},
			appendEntry() {},
		} as unknown as ExtensionAPI;

		systemPromptSwitchExtension(mockPi);

		let selectCalls = 0;
		let currentWidget: string[] | undefined;
		// updateStatus is fired detached from the session_start handler, so wait
		// for the widget write itself instead of guessing a duration.
		let widgetWritten = Promise.withResolvers<void>();
		const mockCtx = {
			hasUI: true,
			cwd: tempDir,
			sessionManager: {
				getSessionId: () => "sess-resume",
				getEntries: () => [],
			},
			ui: {
				select: async () => {
					selectCalls++;
					return undefined;
				},
				notify: () => {},
				setWidget: (_key: string, content: string[] | undefined) => {
					currentWidget = content;
					if (content) widgetWritten.resolve();
				},
			},
		} as unknown as ExtensionContext;

		const sessionStartHandlers = eventHandlers.get("session_start")!;

		// A resume must never open the modal.
		for (const h of sessionStartHandlers) {
			await h({ type: "session_start", reason: "resume" }, mockCtx);
		}
		await widgetWritten.promise;
		expect(selectCalls).toBe(0);
		expect(currentWidget?.[0]).toContain("Active Prompt");

		// Neither must a reload or a fork.
		for (const reason of [
			SessionStartReason.Reload,
			SessionStartReason.Fork,
		] as const) {
			widgetWritten = Promise.withResolvers<void>();
			for (const h of sessionStartHandlers) {
				await h({ type: ExtensionEventType.SessionStart, reason }, mockCtx);
			}
			await widgetWritten.promise;
		}
		expect(selectCalls).toBe(0);
	});

	it("asks when session_start carries no reason, as a plain omp launch does", async () => {
		const eventHandlers = new Map<string, ((e: unknown, c: unknown) => unknown)[]>();
		const mockPi = {
			registerCommand() {},
			registerShortcut() {},
			on(event: string, handler: (e: unknown, c: unknown) => unknown) {
				const list = eventHandlers.get(event) ?? [];
				list.push(handler);
				eventHandlers.set(event, list);
			},
			appendEntry() {},
		} as unknown as ExtensionAPI;

		systemPromptSwitchExtension(mockPi);

		let selectCalls = 0;
		// The handler detaches the modal, so wait for the select it triggers
		// rather than guessing a duration.
		const asked = Promise.withResolvers<void>();
		const mockCtx = {
			hasUI: true,
			cwd: tempDir,
			sessionManager: {
				getSessionId: () => "sess-fresh-user",
				getEntries: () => [],
			},
			ui: {
				select: async () => {
					selectCalls++;
					asked.resolve();
					return `[${HOST_LABEL}] ${TestPrompt.E2EPrompt}`;
				},
				notify: () => {},
				setWidget: () => {},
			},
		} as unknown as ExtensionContext;

		// A brand new user launching omp: the host has been observed sending
		// session_start with no reason at all.
		for (const h of eventHandlers.get(ExtensionEventType.SessionStart)!) {
			await h({ type: ExtensionEventType.SessionStart }, mockCtx);
		}

		await asked.promise;
		expect(selectCalls).toBe(1);
	});

	it("does not ask on a startup reason either", async () => {
		const eventHandlers = new Map<string, ((e: unknown, c: unknown) => unknown)[]>();
		const mockPi = {
			registerCommand() {},
			registerShortcut() {},
			on(event: string, handler: (e: unknown, c: unknown) => unknown) {
				const list = eventHandlers.get(event) ?? [];
				list.push(handler);
				eventHandlers.set(event, list);
			},
			appendEntry() {},
		} as unknown as ExtensionAPI;

		systemPromptSwitchExtension(mockPi);

		let selectCalls = 0;
		const asked = Promise.withResolvers<void>();
		const mockCtx = {
			hasUI: true,
			cwd: tempDir,
			sessionManager: {
				getSessionId: () => "sess-startup",
				getEntries: () => [],
			},
			ui: {
				select: async () => {
					selectCalls++;
					asked.resolve();
					return undefined;
				},
				notify: () => {},
				setWidget: () => {},
			},
		} as unknown as ExtensionContext;

		for (const h of eventHandlers.get(ExtensionEventType.SessionStart)!) {
			await h(
				{ type: ExtensionEventType.SessionStart, reason: SessionStartReason.Startup },
				mockCtx,
			);
		}

		await asked.promise;
		expect(selectCalls).toBe(1);
	});

});
