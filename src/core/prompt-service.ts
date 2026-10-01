import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";
import { detectHost } from "./paths";
import { buildSystemPrompt } from "./prompt-builder";
import { formatScope, resolveScope, SCOPE_BY_LABEL } from "./prompt-scope-label";
import type { ActivePromptRef } from "./types/active-prompt-ref.type";
import type { HostPlatform } from "./types/host-platform.type";
import type {
	BuildPromptInput,
	CustomPromptChunk,
} from "./types/build-prompt-input.type";
import type { MergeMode } from "./types/merge-mode.type";
import { globalScopeFor, PromptScope } from "./types/prompt-scope.type";
import type { SessionPromptConfig } from "./types/session-prompt-config.type";
import type { SessionStatePort } from "../ports/session-state.port";
import type { StoragePort } from "../ports/storage.port";
import type { UIPort } from "../ports/ui.port";

export const NONE_OPTION = "(None / Default)";
export const CREATE_NEW_OPTION = "+ Create new prompt...";
export const CREATE_NEW_OMP_OPTION = "+ Create new [omp] prompt (~/.omp/agent/...)";
export const CREATE_NEW_PI_OPTION = "+ Create new [pi] prompt (~/.pi/agent/...)";
export const CREATE_NEW_LOCAL_OPTION = "+ Create new [local] prompt (.agents/...)";

/**
 * The three scope destinations shown by every "where should this go?" picker.
 * Shared by /sps-new and /sps-move so both name a scope the same way. Exported
 * so tests pick the exact label the picker offers instead of guessing one.
 */
export const SCOPE_DESTINATIONS: ReadonlyArray<{
	label: string;
	scope: PromptScope;
}> = [
	{ label: "[omp] User home (~/.omp/agent/system-prompts-switch/)", scope: PromptScope.GlobalOmp },
	{ label: "[pi] User home (~/.pi/agent/system-prompts-switch/)", scope: PromptScope.GlobalPi },
	{ label: "[local] Current repo (.agents/system-prompts-switch/)", scope: PromptScope.Local },
];

/** Short labels shown in the modals. */
export { SCOPE_BY_LABEL, formatScope, resolveScope } from "./prompt-scope-label";

// ponytail: the host's editor footer advertises Ctrl+Enter submit + Ctrl+G external editor,
// which we cannot suppress from extension code. Show our own banner above the editor instead.
// ponytail: emojis count as 2 cells in terminals but the box-drawing corners count as 1,
// breaking right-edge alignment; we use plain text markers and equalize char counts so
// every line is exactly 37 chars wide (╭─ X ─╮ style; 4 lines, same width).
const EDITOR_SHORTCUT_BANNER: string[] = [
    "╭─ Editor shortcuts ────────────────╮",
	"│ Submit: Ctrl+Q                    │",
	"│ Cancel: Esc                       │",
	"╰─ Ctrl+Enter / Ctrl+G ignored ─────╯",
];

// ponytail: the agent-context chunk is loaded from a markdown template so it can
// be edited without touching code. Path is resolved relative to the source file
// so the bundle works whether the package is run from source, from a tgz, or
// from a symlinked node_modules tree.
const EXTENSION_CONTEXT_TEMPLATE_PATH = fileURLToPath(
	new URL("../../assets/templates/extension-context.md", import.meta.url),
);

function loadExtensionContextTemplate(): string {
	try {
		return fs.readFileSync(EXTENSION_CONTEXT_TEMPLATE_PATH, "utf-8");
	} catch (err) {
		logger.warn(
			"EXTENSION_CONTEXT_LOAD_FAILED",
			"Could not load extension-context template; falling back to minimal stub",
			{
				path: EXTENSION_CONTEXT_TEMPLATE_PATH,
				error: err instanceof Error ? err.message : String(err),
			},
		);
		return [
			"# System Prompt Switch",
			"",
			"- Active prompt(s): {activePrompts}",
			"- Mode: {mode}",
			"- Active prompt chunk follows.",
		].join("\n");
	}
}

function renderExtensionContext(
	template: string,
	activePrompts: ActivePromptRef[],
	mode: MergeMode,
): string {
	const activeLine =
		activePrompts.length > 0
			? activePrompts.map((p) => `[${formatScope(p.scope)}] ${p.name}`).join(", ")
			: "(none)";
	return template
		.replaceAll("{activePrompts}", activeLine)
		.replaceAll("{mode}", mode);
}

export interface ResolvedSessionPromptConfig extends SessionPromptConfig {
	activePrompts: ActivePromptRef[];
}

export class PromptService {
	private readonly host: HostPlatform;

	constructor(
		private readonly storage: StoragePort,
		private readonly sessionState: SessionStatePort,
		private readonly ui: UIPort,
	) {
		this.host = detectHost();
	}

	async getCurrentConfig(sessionId: string): Promise<ResolvedSessionPromptConfig> {
		const existing = await this.sessionState.getSessionConfig(sessionId);
		if (existing) {
			// Scopes are already host-explicit: SessionStateAdapter migrates any
			// legacy bare "global" on read, so nothing to resolve here.
			const activePrompts: ActivePromptRef[] =
				existing.activePrompts && existing.activePrompts.length > 0
					? existing.activePrompts
					: existing.file
						? [
								{
									name: existing.file,
									scope: existing.scope ?? globalScopeFor(this.host),
								},
							]
						: [];
			return { ...existing, activePrompts };
		}
		const fallback: ResolvedSessionPromptConfig = {
			file: null,
			scope: undefined,
			activePrompts: [],
			mode: "append",
			enabled: true,
		};
		await this.sessionState.setSessionConfig(sessionId, fallback);
		return fallback;
	}

	async updateStatus(sessionId: string): Promise<void> {
		if (!this.ui.hasUI()) return;
		const config = await this.getCurrentConfig(sessionId);

		if (!config.enabled) {
			this.ui.setWidget([
				`╭─ 🎯 Active Prompt: (disabled) (${config.mode} mode) ─╮`,
			]);
			return;
		}

		const activeList = config.activePrompts;
		const primary = activeList[0];
		const label = primary
			? `[${formatScope(primary.scope)}] ${primary.name}`
			: "(none)";

		this.ui.setWidget([
			`╭─ 🎯 Active Prompt: ${label} (${config.mode} mode) ─╮`,
		]);
	}

	private async runEditorWithHint(
		title: string,
		prefill: string,
		sessionId?: string,
	): Promise<string | undefined> {
		this.ui.setWidget(EDITOR_SHORTCUT_BANNER);
		try {
			return await this.ui.editor(title, prefill);
		} finally {
			if (sessionId) {
				await this.updateStatus(sessionId);
			} else {
				this.ui.setWidget(undefined);
			}
		}
	}


	private parseOption(option: string): { name: string; scope?: PromptScope } {
		const clean = option.replace(/\s+✓$/, "").trim();
		if (
			clean === NONE_OPTION ||
			clean === CREATE_NEW_OPTION ||
			clean === CREATE_NEW_OMP_OPTION ||
			clean === CREATE_NEW_PI_OPTION ||
			clean === CREATE_NEW_LOCAL_OPTION
		) {
			return { name: clean };
		}
		const match = clean.match(/^\[(local|omp|pi)\]\s+(.+)$/);
		if (match) {
			return {
				name: match[2].trim(),
				scope: SCOPE_BY_LABEL[match[1] as keyof typeof SCOPE_BY_LABEL],
			};
		}
		return { name: clean };
	}

	async selectPrompt(sessionId: string): Promise<string | null | undefined> {
		const config = await this.getCurrentConfig(sessionId);
		const files = await this.storage.list();

		const options: string[] = [
			config.file === null && config.activePrompts.length === 0
				? `${NONE_OPTION}  ✓`
				: NONE_OPTION,
			CREATE_NEW_OMP_OPTION,
			CREATE_NEW_PI_OPTION,
			CREATE_NEW_LOCAL_OPTION,
		];
		for (const file of files) {
			const formatted = `[${formatScope(file.scope)}] ${file.name}`;
			const isSelected =
				file.name === config.file && (!config.scope || config.scope === file.scope);
			options.push(isSelected ? `${formatted}  ✓` : formatted);
		}

		const choice = await this.ui.select(
			"Select System Prompt (Session Scoped)",
			options,
		);
		if (!choice) return undefined;

		const cleanChoice = choice.replace(/\s+✓$/, "").trim();
		if (cleanChoice === CREATE_NEW_OMP_OPTION || cleanChoice === CREATE_NEW_OPTION) {
			return this.createNewPrompt(sessionId, PromptScope.GlobalOmp);
		}
		if (cleanChoice === CREATE_NEW_PI_OPTION) {
			return this.createNewPrompt(sessionId, PromptScope.GlobalPi);
		}
		if (cleanChoice === CREATE_NEW_LOCAL_OPTION) {
			return this.createNewPrompt(sessionId, PromptScope.Local);
		}

		const parsed = this.parseOption(choice);
		if (parsed.name === NONE_OPTION) {
			config.file = null;
			config.scope = undefined;
			config.activePrompts = [];
			config.decided = true;
			await this.sessionState.setSessionConfig(sessionId, config);
			await this.updateStatus(sessionId);
			logger.info("PROMPT_CLEAR", "Prompt cleared for session", { sessionId });
			this.ui.notify(
				"System prompt cleared. Takes effect on your next message.",
				"info",
			);
			return null;
		}

		const selectedScope = resolveScope(parsed.scope, this.host);
		config.file = parsed.name;
		config.scope = selectedScope;
		config.activePrompts = [{ name: parsed.name, scope: selectedScope }];
		config.enabled = true;
		config.decided = true;
		await this.sessionState.setSessionConfig(sessionId, config);
		await this.updateStatus(sessionId);
		logger.info("PROMPT_SELECT", `Selected ${parsed.name}`, {
			sessionId,
			scope: parsed.scope,
		});
		const scopeLabel = config.scope ? `[${config.scope}] ` : "";
		this.ui.notify(
			`System prompt ${scopeLabel}"${config.file}" activated. Takes effect on your next message.`,
			"info",
		);
		return parsed.name;
	}

	async injectPrompt(sessionId: string): Promise<void> {
		const config = await this.getCurrentConfig(sessionId);
		const files = await this.storage.list();
		if (files.length === 0) {
			this.ui.notify("No prompts available to inject.", "warning");
			return;
		}

		const isPromptActive = (name: string, scope: PromptScope) =>
			config.activePrompts.some((p) => p.name === name && p.scope === scope);
		const isPrimary = (name: string, scope: PromptScope) =>
			config.file === name && config.scope === scope;

		const options: string[] = [
			"(Clear all injected prompts / Reset to Default)",
			"(Done)",
		];

		for (const file of files) {
			let tag = "";
			if (isPrimary(file.name, file.scope)) {
				tag = " [SELECTED] ✓";
			} else if (isPromptActive(file.name, file.scope)) {
				tag = " [INJECTED] ✓";
			}
			options.push(`[${formatScope(file.scope)}] ${file.name}${tag}`);
		}

		const choice = await this.ui.select(
			"Cumulative Prompt Inject (Toggle prompts to stack)",
			options,
		);
		if (!choice || choice === "(Done)") {
			return;
		}

		if (choice.startsWith("(Clear all")) {
			config.file = null;
			config.scope = undefined;
			config.activePrompts = [];
			config.decided = true;
			await this.sessionState.setSessionConfig(sessionId, config);
			await this.updateStatus(sessionId);
			logger.info("PROMPT_INJECT_CLEAR_ALL", "Cleared all injected prompts", {
				sessionId,
			});
			this.ui.notify(
				"All injected prompts cleared. Takes effect on your next message.",
				"info",
			);
			return;
		}

		const parsed = this.parseOption(
			choice.replace(/\s+\[(INJECTED|SELECTED)\]\s+✓$/, ""),
		);
		const targetName = parsed.name;
		const targetScope = resolveScope(parsed.scope, this.host);

		const existingIndex = config.activePrompts.findIndex(
			(p) => p.name === targetName && p.scope === targetScope,
		);

		if (existingIndex >= 0) {
			// Toggle off
			// ponytail: refuse to toggle off the active primary; /sps-inject is for
			// stacking extras, /sps-select is for changing the primary. Toggling the
			// primary here would silently flip the user's selection to a non-primary
			// or to none, which surprised users.
			if (config.file === targetName && config.scope === targetScope) {
				this.ui.notify(
					`[${formatScope(targetScope)}] "${targetName}" is your active primary. Use /sps-select to change it.`,
					"info",
				);
				return;
			}
			config.activePrompts.splice(existingIndex, 1);
			await this.sessionState.setSessionConfig(sessionId, config);
			await this.updateStatus(sessionId);
			logger.info("PROMPT_INJECT_REMOVE", `Removed ${targetName}`, {
				sessionId,
				targetScope,
			});
			this.ui.notify(
				`Removed [${formatScope(targetScope)}] "${targetName}". Total active: ${config.activePrompts.length}. Takes effect on your next message.`,
				"info",
			);
		} else {
			// Toggle on
			config.activePrompts.push({
				name: targetName,
				scope: targetScope,
				injected: true,
			});
			config.file = config.activePrompts[0].name;
			config.scope = config.activePrompts[0].scope;
			config.enabled = true;
			await this.sessionState.setSessionConfig(sessionId, config);
			await this.updateStatus(sessionId);
			logger.info("PROMPT_INJECT_ADD", `Injected ${targetName}`, {
				sessionId,
				targetScope,
				total: config.activePrompts.length,
			});
			this.ui.notify(
				`Injected [${targetScope}] "${targetName}". Total active: ${config.activePrompts.length}. Takes effect on your next message.`,
				"info",
			);
		}
	}

	private async promptForPromptName(): Promise<string | null> {
		while (true) {
			const rawName = await this.ui.input(
				"Enter prompt file name (e.g. backend-dev.md):",
			);
			if (rawName === undefined) {
				this.ui.notify("Prompt creation cancelled.", "info");
				return null;
			}
			const trimmed = rawName.trim();
			if (trimmed.length === 0) {
				this.ui.notify(
					"Invalid prompt name: cannot be empty.",
					"warning",
				);
				continue;
			}
			if (trimmed.startsWith(".")) {
				this.ui.notify(
					`Invalid prompt name "${trimmed}": cannot start with a dot (would create a hidden file).`,
					"warning",
				);
				continue;
			}
			if (
				// eslint-disable-next-line no-control-regex -- intentional NUL guard
				/[\s/\\\u0000]/.test(trimmed)
			) {
				this.ui.notify(
					`Invalid prompt name "${trimmed}": cannot contain whitespace, /, \\, or NUL. Use letters, digits, dashes, underscores, dots.`,
					"warning",
				);
				continue;
			}
			// ponytail: path.basename guards against relative-path tricks like
			// "..", "../foo", "a/b"; anything that survives is filename-safe.
			const basename = path.basename(trimmed);
			if (basename !== trimmed) {
				this.ui.notify(
					`Invalid prompt name "${trimmed}": resolves to "${basename}", which is not what you typed.`,
					"warning",
				);
				continue;
			}
			return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
		}
	}

	async createNewPrompt(
		sessionId?: string,
		preselectedScope?: PromptScope,
	): Promise<string | null> {
		const cleanName = await this.promptForPromptName();
		if (cleanName === null) {
			return null;
		}

		// Determine target scope
		let targetScope: PromptScope = preselectedScope ?? globalScopeFor(this.host);
		if (!preselectedScope && this.ui.hasUI()) {
			const scopeChoice = await this.ui.select(
				"Choose destination for new prompt:",
				SCOPE_DESTINATIONS.map((d) => d.label),
			);
			targetScope =
				SCOPE_DESTINATIONS.find((d) => d.label === scopeChoice)?.scope ??
				PromptScope.GlobalOmp;
		}

		// Collision check within target scope
		const existing = await this.storage.read(cleanName, targetScope);
		if (existing !== null) {
			this.ui.notify(
				`Prompt "${cleanName}" already exists in ${formatScope(targetScope)} scope!`,
				"error",
			);
			return null;
		}

		const initialStub = `# ${cleanName.replace(/\.md$/, "")}\n\n`;

		// Open native editor directly with clean title
		const updated = await this.runEditorWithHint(
			`Create: [${targetScope}] ${cleanName}`,
			initialStub,
			sessionId,
		);
		if (updated === undefined || updated.trim().length === 0) {
			this.ui.notify("Prompt creation cancelled (empty or cancelled).", "info");
			return null;
		}

		await this.storage.write(cleanName, updated, targetScope);

		const targetDir =
			targetScope === PromptScope.Local
				? this.storage.getLocalDirectory()
				: this.storage.getGlobalDirectory();
		const fullPath = path.join(targetDir, cleanName);

		logger.info("PROMPT_CREATE", `Created prompt ${cleanName}`, {
			targetScope,
			fullPath,
		});

		if (sessionId) {
			const config = await this.getCurrentConfig(sessionId);
			config.file = cleanName;
			config.scope = targetScope;
			config.activePrompts = [{ name: cleanName, scope: targetScope }];
			config.enabled = true;
			config.decided = true;
			await this.sessionState.setSessionConfig(sessionId, config);
			await this.updateStatus(sessionId);
			this.ui.notify(
				`Saved and activated [${targetScope}] "${cleanName}".\nPath: ${fullPath}`,
				"info",
			);
		} else {
			this.ui.notify(
				`Saved prompt: [${targetScope}] ${cleanName}\nPath: ${fullPath}`,
				"info",
			);
		}

		return cleanName;
	}

	async editPrompt(sessionId: string): Promise<boolean> {
		const files = await this.storage.list();
		if (files.length === 0) {
			this.ui.notify("No prompt files found. Creating a new one...", "info");
			const created = await this.createNewPrompt(sessionId);
			return created !== null;
		}

		const config = await this.getCurrentConfig(sessionId);
		let targetFile: string | undefined = config.file ?? undefined;
		// getCurrentConfig already normalises any legacy bare "global" to the
		// detected host's explicit scope, so no legacy union is needed here.
		let targetScope: PromptScope | undefined = config.scope;

		if (!targetFile || !files.some((f) => f.name === targetFile)) {
			const choice = await this.ui.select(
				"Select prompt to edit",
				files.map((f) => `[${formatScope(f.scope)}] ${f.name}`),
			);
			if (!choice) return false;
			const parsed = this.parseOption(choice);
			targetFile = parsed.name;
			targetScope = parsed.scope;
		}

		const resolvedTargetScope = resolveScope(targetScope, this.host);
		const content = await this.storage.read(targetFile, resolvedTargetScope);
		if (content === null) {
			this.ui.notify(`Could not read ${targetFile}`, "error");
			return false;
		}

		// Open native editor directly with clean title
		const updated = await this.runEditorWithHint(
			`Edit: ${targetFile}`,
			content,
			sessionId,
		);
		if (updated === undefined) {
			this.ui.notify("Edit cancelled.", "info");
			return false;
		}

		const editScope = resolvedTargetScope;
		await this.storage.write(targetFile, updated, editScope);
		await this.updateStatus(sessionId);

		const targetDir =
			editScope === PromptScope.Local
				? this.storage.getLocalDirectory()
				: this.storage.getGlobalDirectory(editScope);
		const fullPath = path.join(targetDir, targetFile);

		logger.info("PROMPT_EDIT", `Edited ${targetFile}`, { fullPath });
		this.ui.notify(
			`Updated prompt "${targetFile}".\nPath: ${fullPath}`,
			"info",
		);
		return true;
	}

	async deletePrompt(sessionId: string): Promise<boolean> {
		const files = await this.storage.list();
		if (files.length === 0) {
			this.ui.notify("No prompt files to delete.", "warning");
			return false;
		}

		const choice = await this.ui.select(
			"Select prompt to delete",
			files.map((f) => `[${formatScope(f.scope)}] ${f.name}`),
		);
		if (!choice) return false;

		const parsed = this.parseOption(choice);
		const target = parsed.name;
		const targetScope = parsed.scope;

		const confirmed = await this.ui.confirm(
			"Confirm Deletion",
			`Are you sure you want to permanently delete "${target}" (${targetScope ?? "all scopes"})?`,
		);
		if (!confirmed) {
			this.ui.notify("Deletion cancelled.", "info");
			return false;
		}

		const deleted = await this.storage.delete(target, targetScope);
		if (!deleted) {
			this.ui.notify(`Failed to delete "${target}".`, "error");
			return false;
		}

		const config = await this.getCurrentConfig(sessionId);
		config.activePrompts = config.activePrompts.filter(
			(p) => !(p.name === target && (!targetScope || p.scope === targetScope)),
		);

		if (config.file === target) {
			config.file = config.activePrompts[0]?.name ?? null;
			config.scope = config.activePrompts[0]?.scope;
		}

		await this.sessionState.setSessionConfig(sessionId, config);
		await this.updateStatus(sessionId);
		logger.info("PROMPT_DELETE", `Deleted ${target}`, { targetScope });
		this.ui.notify(
			`Deleted "${target}". Takes effect on your next message.`,
			"info",
		);
		return true;
	}

	/**
	 * Move a prompt file from one scope to another. The scope it already lives
	 * in is never offered as a destination, so the picker only shows a real
	 * move. An existing file at the destination is an overwrite, and cancelling
	 * that confirm returns to the destination picker rather than abandoning the
	 * move halfway through.
	 */
	async movePrompt(sessionId: string): Promise<boolean> {
		const files = await this.storage.list();
		if (files.length === 0) {
			this.ui.notify("No prompt files to move.", "warning");
			return false;
		}

		const choice = await this.ui.select(
			"Select prompt to move",
			files.map((f) => `[${formatScope(f.scope)}] ${f.name}`),
		);
		if (!choice) return false;

		const parsed = this.parseOption(choice);
		const sourceScope = resolveScope(parsed.scope, this.host);
		const targets = SCOPE_DESTINATIONS.filter((d) => d.scope !== sourceScope);

		while (true) {
			const targetChoice = await this.ui.select(
				`Move "${parsed.name}" to:`,
				targets.map((d) => d.label),
			);
			const target = targets.find((d) => d.label === targetChoice);
			if (!target) {
				this.ui.notify("Move cancelled.", "info");
				return false;
			}
			const destScope = target.scope;

			const content = await this.storage.read(parsed.name, sourceScope);
			if (content === null) {
				this.ui.notify(`Could not read "${parsed.name}".`, "error");
				return false;
			}

			const existing = await this.storage.read(parsed.name, destScope);
			if (existing !== null) {
				const overwrite = await this.ui.confirm(
					"Confirm Overwrite",
					`"${parsed.name}" already exists in ${formatScope(destScope)} scope. Overwrite it?`,
				);
				if (!overwrite) continue;
			}

			// Write first: a failed write must leave the source intact, never a
			// prompt deleted from both scopes.
			await this.storage.write(parsed.name, content, destScope);
			const deleted = await this.storage.delete(parsed.name, sourceScope);
			if (!deleted) {
				await this.storage.delete(parsed.name, destScope);
				this.ui.notify(
					`Could not remove "${parsed.name}" from ${formatScope(sourceScope)} scope. Move cancelled.`,
					"error",
				);
				return false;
			}

			const config = await this.getCurrentConfig(sessionId);
			// A ref for the destination already active means the same file name
			// is loaded twice after the move; keep the existing one and drop the
			// moved ref rather than injecting the prompt twice.
			const destAlreadyActive = config.activePrompts.some(
				(p) => p.name === parsed.name && p.scope === destScope,
			);
			const movedRefs = config.activePrompts.filter(
				(p) => p.name === parsed.name && p.scope === sourceScope,
			);
			if (movedRefs.length > 0) {
				config.activePrompts = destAlreadyActive
					? config.activePrompts.filter((p) => !movedRefs.includes(p))
					: config.activePrompts.map((p) =>
							movedRefs.includes(p) ? { ...p, scope: destScope } : p,
						);
				config.file = config.activePrompts[0]?.name ?? null;
				config.scope = config.activePrompts[0]?.scope;
				await this.sessionState.setSessionConfig(sessionId, config);
				await this.updateStatus(sessionId);
			}

			const destDir =
				destScope === PromptScope.Local
					? this.storage.getLocalDirectory()
					: this.storage.getGlobalDirectory(destScope);
			logger.info("PROMPT_MOVE", `Moved ${parsed.name}`, {
				sourceScope,
				destScope,
				fullPath: path.join(destDir, parsed.name),
			});
			this.ui.notify(
				`Moved [${formatScope(sourceScope)}] "${parsed.name}" to [${formatScope(destScope)}].\nPath: ${path.join(destDir, parsed.name)}`,
				"info",
			);
			return true;
		}
	}

	async toggleMode(sessionId: string, targetMode?: MergeMode): Promise<MergeMode> {
		const config = await this.getCurrentConfig(sessionId);
		if (targetMode) {
			config.mode = targetMode;
		} else {
			config.mode = config.mode === "replace" ? "append" : "replace";
		}
		await this.sessionState.setSessionConfig(sessionId, config);
		await this.updateStatus(sessionId);
		logger.info("MODE_TOGGLE", `Mode set to ${config.mode}`, { sessionId });
		this.ui.notify(
			`Session prompt mode set to: ${config.mode}. Takes effect on your next message.`,
			"info",
		);
		return config.mode;
	}

	async promptNewSessionModal(sessionId: string): Promise<void> {
		if (!this.ui.hasUI()) return;
		const existing = await this.sessionState.getSessionConfig(sessionId);
		// ponytail: only skip when the user has actually answered. Checking
		// activePrompts.length instead re-asks forever after choosing (None),
		// because "chose None" and "never asked" look identical.
		if (existing?.decided === true) {
			await this.updateStatus(sessionId);
			return;
		}

		const files = await this.storage.list();
		// ponytail: never pre-tick an option. A tick on (None / Default) made the
		// picker answer itself on a fresh session, so the user got a prompt they
		// had not chosen — and a second default alongside their selection.
		const options: string[] = [
			NONE_OPTION,
			CREATE_NEW_OMP_OPTION,
			CREATE_NEW_PI_OPTION,
			CREATE_NEW_LOCAL_OPTION,
			...files.map((f) => `[${formatScope(f.scope)}] ${f.name}`),
		];

		// ponytail: one log for the whole interaction. The outcome branches below
		// already record what was chosen, so this only needs to say the dialog ran.
		logger.info("MODAL_OPEN", "startup prompt modal opened", {
			sessionId,
			optionCount: options.length,
		});

		const choice = await this.ui.select(
			"System Prompt for this Session",
			options,
		);
		if (!choice) {
			const config: SessionPromptConfig = {
				file: null,
				scope: undefined,
				activePrompts: [],
				mode: "append",
				enabled: true,
				decided: true,
			};
			await this.sessionState.setSessionConfig(sessionId, config);
			await this.updateStatus(sessionId);
			logger.info("MODAL_DEFAULT_NONE", "Dismissed modal -> default None", {
				sessionId,
			});
			this.ui.notify(
				"Using default system prompt (none). Takes effect on your next message.",
				"info",
			);
			return;
		}

		const clean = choice.replace(/\s+✓$/, "").trim();
		if (clean === CREATE_NEW_OMP_OPTION || clean === CREATE_NEW_OPTION) {
			await this.createNewPrompt(sessionId, PromptScope.GlobalOmp);
			return;
		}
		if (clean === CREATE_NEW_PI_OPTION) {
			await this.createNewPrompt(sessionId, PromptScope.GlobalPi);
			return;
		}
		if (clean === CREATE_NEW_LOCAL_OPTION) {
			await this.createNewPrompt(sessionId, PromptScope.Local);
			return;
		}

		const parsed = this.parseOption(choice);
		const file = parsed.name === NONE_OPTION ? null : parsed.name;
		const chosenScope = resolveScope(parsed.scope, this.host);
		const activePrompts: ActivePromptRef[] = file
			? [{ name: file, scope: chosenScope }]
			: [];

		const config: SessionPromptConfig = {
			file,
			scope: parsed.scope,
			activePrompts,
			mode: "append",
			enabled: true,
			decided: true,
		};

		await this.sessionState.setSessionConfig(sessionId, config);
		await this.updateStatus(sessionId);
		logger.info("MODAL_SELECT", `Modal selected ${file ?? "none"}`, {
			sessionId,
			scope: parsed.scope,
		});
		if (file) {
			const scopeLabel = parsed.scope ? `[${parsed.scope}] ` : "";
			this.ui.notify(
				`System prompt ${scopeLabel}"${file}" activated. Takes effect on your next message.`,
				"info",
			);
		}
	}

	async getPathsSummary(sessionId: string): Promise<string[]> {
		const config = await this.getCurrentConfig(sessionId);
		const files = await this.storage.list();

		const lines: string[] = [
			"=== System Prompt Switch — Paths ===",
			"",
			"Active Prompt:",
		];

		const activeList = config.activePrompts;
		if (activeList.length === 0) {
			lines.push("  (None / Default)");
		} else {
			for (const p of activeList) {
				const dir =
					p.scope === PromptScope.Local
						? this.storage.getLocalDirectory()
						: this.storage.getGlobalDirectory(p.scope);
				lines.push(`  • [${formatScope(p.scope)}] ${path.join(dir, p.name)}`);
			}
		}

		lines.push("");
		lines.push("Directories:");
		lines.push(`  Local: ${this.storage.getLocalDirectory()}`);
		lines.push(`  OMP:   ${this.storage.getGlobalDirectory(PromptScope.GlobalOmp)}`);
		lines.push(`  PI:    ${this.storage.getGlobalDirectory(PromptScope.GlobalPi)}`);

		lines.push("");
		lines.push("All Available Prompts:");
		if (files.length === 0) {
			lines.push("  (none)");
		} else {
			for (const f of files) {
				lines.push(`  • [${formatScope(f.scope).padEnd(5)}] ${f.path}`);
			}
		}

		return lines;
	}

	async resolvePromptForTurn(
		sessionId: string,
		input: Omit<BuildPromptInput, "customPrompt" | "mode">,
	): Promise<string> {
		const config = await this.getCurrentConfig(sessionId);
		if (!config.enabled) {
			return input.basePrompt;
		}

		const activeList = config.activePrompts;

		// ponytail: always inject an extension-context chunk first so the agent
		// knows this extension exists, where the user's prompt files live, and
		// how to inspect/change them. The chunk is loaded from
		// assets/templates/extension-context.md and templated with the current
		// session state.
		const extensionContext: CustomPromptChunk = {
			name: "__system-prompt-switch-context__",
			scope: globalScopeFor(this.host),
			content: renderExtensionContext(
				loadExtensionContextTemplate(),
				activeList,
				config.mode,
			),
		};

		const chunks: CustomPromptChunk[] = [extensionContext];
		for (const promptRef of activeList) {
			const content = await this.storage.read(promptRef.name, promptRef.scope);
			if (content && content.trim().length > 0) {
				chunks.push({
					name: promptRef.name,
					scope: promptRef.scope,
					content,
				});
			}
		}

		// ponytail: consume injected entries after one turn. Keep the primary
		// (index 0) even if it somehow carries injected: true; defensive only,
		// the inject modal refuses to toggle-off the primary.
		const beforeCount = activeList.length;
		config.activePrompts = activeList.filter(
			(ref, idx) => !ref.injected || idx === 0,
		);
		if (config.activePrompts.length !== beforeCount) {
			config.file = config.activePrompts[0]?.name ?? null;
			config.scope = config.activePrompts[0]?.scope;
			await this.sessionState.setSessionConfig(sessionId, config);
			await this.updateStatus(sessionId);
		}

		logger.info(
			"PROMPT_TURN_RESOLVE",
			`Injected ${chunks.length} chunk(s) (incl. extension context) in ${config.mode} mode`,
			{
				sessionId,
				chunks: chunks.map((c) => `[${c.scope}] ${c.name}`),
			},
		);

		return buildSystemPrompt({
			...input,
			customPrompts: chunks,
			mode: config.mode,
		});
	}
}
