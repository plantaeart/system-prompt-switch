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
import type { PromptFileInfo } from "./types/prompt-file-info.type";
import { globalScopeFor, PromptScope } from "./types/prompt-scope.type";
import type { SessionPromptConfig } from "./types/session-prompt-config.type";
import type { DefaultPromptPort } from "../ports/default-prompt.port";
import type { SessionStatePort } from "../ports/session-state.port";
import type { StoragePort } from "../ports/storage.port";
import type { UIPort, MultiSelectItem, SelectPromptToEditResult } from "../ports/ui.port";

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

const CREATE_ACTION_SCOPE = {
	"create-local": PromptScope.Local,
	"create-omp": PromptScope.GlobalOmp,
	"create-pi": PromptScope.GlobalPi,
} as const;

export class PromptService {
	private readonly host: HostPlatform;

	constructor(
		private readonly storage: StoragePort,
		private readonly sessionState: SessionStatePort,
		private readonly ui: UIPort,
		private readonly defaultPrompt: DefaultPromptPort,
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

		// Injections last one turn, so the banner hides them; the primary (index 0) is always shown.
		const activeList = config.activePrompts.filter((p, i) => !p.injected || i === 0);
		const label =
			activeList.length > 0
				? activeList
						.map((p) => `[${formatScope(p.scope)}] ${p.name}`)
						.join(" + ")
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

	private pickPrompt(
		config: ResolvedSessionPromptConfig,
		files: PromptFileInfo[],
	): Promise<string | undefined> {
		const isPromptActive = (name: string, scope: PromptScope) =>
			config.activePrompts.some((p) => p.name === name && p.scope === scope);

		const options: string[] = [
			"(Done)",
			config.file === null && config.activePrompts.length === 0
				? `${NONE_OPTION}  ✓`
				: NONE_OPTION,
			CREATE_NEW_OMP_OPTION,
			CREATE_NEW_PI_OPTION,
			CREATE_NEW_LOCAL_OPTION,
		];
		for (const file of files) {
			const formatted = `[${formatScope(file.scope)}] ${file.name}`;
			const isSelected = isPromptActive(file.name, file.scope);
			options.push(isSelected ? `${formatted}  ✓` : formatted);
		}
		return this.ui.select("Select System Prompt(s) (Session Scoped)", options);
	}

	/** Maps a `/sps-select` argument to the picker option it stands for; warns and returns undefined when none or several match. */
	private resolveSelectArg(arg: string, files: PromptFileInfo[]): string | undefined {
		if (arg.toLowerCase() === "none") return NONE_OPTION;
		const { name, scope } = this.parseOption(arg);
		const matches = files.filter((f) => f.name === name && (!scope || f.scope === scope));
		if (matches.length === 1) return `[${formatScope(matches[0].scope)}] ${matches[0].name}`;
		this.ui.notify(
			matches.length
				? `"${name}" exists in several scopes; use [local|omp|pi] ${name}.`
				: `No system prompt named "${arg}".`,
			"warning",
		);
		return undefined;
	}

	/** Parses `/sps-select` arguments: null = `none`, undefined = a name did not resolve (already warned). */
	private resolveSelectArgs(
		arg: string,
		files: PromptFileInfo[],
	): ActivePromptRef[] | null | undefined {
		if (arg.toLowerCase() === "none") return null;
		// A `[scope]` token belongs to the name after it; names never contain whitespace.
		const tokens = arg.split(/\s+/);
		const refs: ActivePromptRef[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const scoped = /^\[(local|omp|pi)\]$/.test(tokens[i]) && i + 1 < tokens.length;
			const choice = this.resolveSelectArg(scoped ? `${tokens[i]} ${tokens[++i]}` : tokens[i], files);
			if (!choice) return undefined;
			if (choice === NONE_OPTION) {
				this.ui.notify('"none" cannot be combined with other names.', "warning");
				return undefined;
			}
			const parsed = this.parseOption(choice);
			const ref = { name: parsed.name, scope: resolveScope(parsed.scope, this.host) };
			if (!refs.some((r) => r.name === ref.name && r.scope === ref.scope)) refs.push(ref);
		}
		return refs;
	}

	/** Argument completions for `/sps-select` and `/sps-edit`: names not typed yet; `value` replaces the whole argument text. */
	async completePromptArgs(
		prefix: string,
	): Promise<Array<{ value: string; label: string; description: string }> | null> {
		const files = await this.storage.list();
		const typed = prefix.split(/\s+/);
		const partial = typed.pop() ?? "";
		const head = typed.length > 0 ? `${typed.join(" ")} ` : "";
		const items = files
			.filter((f) => f.name.startsWith(partial) && !typed.includes(f.name))
			.map((f) => {
				const ambiguous = files.some((g) => g.name === f.name && g.scope !== f.scope);
				const token = ambiguous ? `[${formatScope(f.scope)}] ${f.name}` : f.name;
				return { value: `${head}${token}`, label: f.name, description: formatScope(f.scope) };
			});
		return items.length > 0 ? items : null;
	}

	private buildMultiSelectItems(
		files: PromptFileInfo[],
		activePrompts: ActivePromptRef[] = [],
	): MultiSelectItem[] {
		const isPromptActive = (name: string, scope: PromptScope) =>
			activePrompts.some((p) => !p.injected && p.name === name && p.scope === scope);

		const items: MultiSelectItem[] = [
			{
				id: "__save__",
				label: "Done / Save Selection (Ctrl+S)",
				selected: false,
				isSpecial: "save",
			},
			{
				id: "__none__",
				label: "None / Clear all",
				selected: false,
				isSpecial: "none",
			},
		];

		for (const file of files) {
			const label = `[${formatScope(file.scope)}] ${file.name}`;
			items.push({
				id: label,
				label,
				selected: isPromptActive(file.name, file.scope),
				name: file.name,
				scope: file.scope,
			});
		}

		items.push(
			{
				id: "__create_local__",
				label: CREATE_NEW_LOCAL_OPTION,
				selected: false,
				isSpecial: "create-local",
			},
			{
				id: "__create_omp__",
				label: CREATE_NEW_OMP_OPTION,
				selected: false,
				isSpecial: "create-omp",
			},
			{
				id: "__create_pi__",
				label: CREATE_NEW_PI_OPTION,
				selected: false,
				isSpecial: "create-pi",
			},
		);

		return items;
	}

	/**
	 * Saves `refs` as the session's selection and the project default (empty = None), then redraws the banner.
	 * Pending injections stay in the session but never reach the default.
	 */
	private async applySelection(sessionId: string, refs: ActivePromptRef[]): Promise<void> {
		const config = await this.getCurrentConfig(sessionId);
		config.activePrompts = refs;
		config.file = refs[0]?.name ?? null;
		config.scope = refs[0]?.scope;
		config.enabled = true;
		config.decided = true;
		await this.sessionState.setSessionConfig(sessionId, config);
		const persisted = refs.filter((p) => !p.injected);
		await this.defaultPrompt.set(persisted.length > 0 ? persisted : null);
		await this.updateStatus(sessionId);
		logger.info(refs.length > 0 ? "PROMPT_SELECT" : "PROMPT_CLEAR", `Selection now has ${refs.length} prompt(s)`, {
			sessionId,
			prompts: refs,
		});
	}

	private announceSelection(refs: ActivePromptRef[]): void {
		const label = refs.map((p) => `[${formatScope(p.scope)}] "${p.name}"`).join(" + ");
		this.ui.notify(
			refs.length > 0
				? `Active system prompt(s): ${label}. Takes effect on your next message.`
				: "System prompt cleared. Takes effect on your next message.",
			"info",
		);
	}

	/** applySelection + the confirmation message; returns the primary prompt's name (null when cleared). */
	private async finishSelection(sessionId: string, refs: ActivePromptRef[]): Promise<string | null> {
		await this.applySelection(sessionId, refs);
		this.announceSelection(refs);
		return refs[0]?.name ?? null;
	}

	private refsFromIds(ids: string[]): ActivePromptRef[] {
		return ids.map((id) => {
			const parsed = this.parseOption(id);
			return { name: parsed.name, scope: resolveScope(parsed.scope, this.host) };
		});
	}

	/**
	 * `arg` selects without the picker: `none`, or one or more names, each `<name>` or
	 * `[local|omp|pi] <name>` (the picker's own labels), so a client without a terminal can switch prompts.
	 */
	async selectPrompt(sessionId: string, arg = ""): Promise<string | null | undefined> {
		if (arg.trim()) {
			const refs = this.resolveSelectArgs(arg.trim(), await this.storage.list());
			if (refs === undefined) return undefined;
			return this.finishSelection(sessionId, refs ?? []);
		}

		if (this.ui.hasUI() && typeof this.ui.multiSelect === "function") {
			const config = await this.getCurrentConfig(sessionId);
			const files = await this.storage.list();
			const items = this.buildMultiSelectItems(files, config.activePrompts);

			const result = await this.ui.multiSelect(
				"Select System Prompt(s) (Session Scoped)",
				items,
			);
			if (result !== undefined) {
				if (result.cancelled) return config.file;
				const ticked = this.refsFromIds(result.selectedIds);
				if (result.action) {
					return this.createNewPrompt(sessionId, CREATE_ACTION_SCOPE[result.action], ticked);
				}
				return this.finishSelection(sessionId, ticked);
			}
		}

		// No checkbox list on this host: the single-select picker toggles one prompt per pick until (Done).
		let changed = false;
		let lastHandledChoice: string | undefined;
		while (true) {
			const config = await this.getCurrentConfig(sessionId);
			const files = await this.storage.list();
			const choice = await this.pickPrompt(config, files);
			if (!choice || choice === "(Done)" || choice === lastHandledChoice) break;
			lastHandledChoice = choice;

			const cleanChoice = choice.replace(/\s+✓$/, "").trim();
			const createScope =
				cleanChoice === CREATE_NEW_OMP_OPTION || cleanChoice === CREATE_NEW_OPTION
					? PromptScope.GlobalOmp
					: cleanChoice === CREATE_NEW_PI_OPTION
						? PromptScope.GlobalPi
						: cleanChoice === CREATE_NEW_LOCAL_OPTION
							? PromptScope.Local
							: undefined;
			if (createScope) {
				return this.createNewPrompt(sessionId, createScope, config.activePrompts.filter((p) => !p.injected));
			}

			const parsed = this.parseOption(cleanChoice);
			if (parsed.name === NONE_OPTION) return this.finishSelection(sessionId, []);

			const scope = resolveScope(parsed.scope, this.host);
			const isActive = (p: ActivePromptRef) => p.name === parsed.name && p.scope === scope;
			await this.applySelection(
				sessionId,
				config.activePrompts.some(isActive)
					? config.activePrompts.filter((p) => !isActive(p))
					: [...config.activePrompts, { name: parsed.name, scope }],
			);
			changed = true;
		}

		if (!changed) return undefined;
		const finalConfig = await this.getCurrentConfig(sessionId);
		this.announceSelection(finalConfig.activePrompts);
		return finalConfig.file;
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

	private async promptForPromptName(
		title = "Enter prompt file name (e.g. backend-dev.md):",
		placeholder?: string,
	): Promise<string | null> {
		while (true) {
			const rawName = await this.ui.input(title, placeholder);
			if (rawName === undefined) {
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
		keep: ActivePromptRef[] = [],
	): Promise<string | null> {
		const cleanName = await this.promptForPromptName();
		if (cleanName === null) {
			this.ui.notify("Prompt creation cancelled.", "info");
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
			await this.applySelection(sessionId, [...keep, { name: cleanName, scope: targetScope }]);
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

	async renamePrompt(
		oldName: string,
		scope: PromptScope,
		sessionId?: string,
	): Promise<string | null> {
		const newCleanName = await this.promptForPromptName(
			`Rename prompt "${oldName}":`,
			oldName.replace(/\.md$/, ""),
		);
		if (newCleanName === null) {
			this.ui.notify("Prompt rename cancelled.", "info");
			return null;
		}
		if (newCleanName === oldName) {
			this.ui.notify("Prompt name unchanged.", "info");
			return oldName;
		}

		const resolvedTargetScope = resolveScope(scope, this.host);
		const existing = await this.storage.read(newCleanName, resolvedTargetScope);
		// A case-only rename "finds" the old file on a case-insensitive filesystem; the adapter still refuses to overwrite a different one.
		if (existing !== null && newCleanName.toLowerCase() !== oldName.toLowerCase()) {
			this.ui.notify(
				`Prompt "${newCleanName}" already exists in ${formatScope(resolvedTargetScope)} scope!`,
				"error",
			);
			return null;
		}

		if (typeof this.storage.rename === "function") {
			const success = await this.storage.rename(oldName, newCleanName, resolvedTargetScope);
			if (!success) {
				this.ui.notify(`Failed to rename "${oldName}".`, "error");
				return null;
			}
		} else {
			const content = await this.storage.read(oldName, resolvedTargetScope);
			if (content === null) {
				this.ui.notify(`Could not read "${oldName}" to rename.`, "error");
				return null;
			}
			await this.storage.write(newCleanName, content, resolvedTargetScope);
			await this.storage.delete(oldName, resolvedTargetScope);
		}

		if (sessionId) {
			const config = await this.getCurrentConfig(sessionId);
			let configUpdated = false;
			if (config.file === oldName && config.scope === resolvedTargetScope) {
				config.file = newCleanName;
				configUpdated = true;
			}
			for (const p of config.activePrompts) {
				if (p.name === oldName && p.scope === resolvedTargetScope) {
					p.name = newCleanName;
					configUpdated = true;
				}
			}
			if (configUpdated) {
				await this.sessionState.setSessionConfig(sessionId, config);
				await this.updateStatus(sessionId);
			}

			const defaults = await this.defaultPrompt.get();
			if (defaults && defaults.length > 0) {
				let defUpdated = false;
				for (const d of defaults) {
					if (d.name === oldName && d.scope === resolvedTargetScope) {
						d.name = newCleanName;
						defUpdated = true;
					}
				}
				if (defUpdated) {
					await this.defaultPrompt.set(defaults);
				}
			}
		}

		logger.info("PROMPT_RENAME", `Renamed prompt "${oldName}" to "${newCleanName}"`, {
			scope: resolvedTargetScope,
			oldName,
			newName: newCleanName,
			sessionId,
		});

		this.ui.notify(
			`Renamed prompt [${formatScope(resolvedTargetScope)}] "${oldName}" to "${newCleanName}".`,
			"info",
		);

		return newCleanName;
	}

	async editPrompt(sessionId: string, arg = ""): Promise<boolean> {
		const files = await this.storage.list();
		if (files.length === 0) {
			this.ui.notify("No prompt files found. Creating a new one...", "info");
			const created = await this.createNewPrompt(sessionId);
			return created !== null;
		}

		let targetFile: string | undefined;
		let targetScope: PromptScope | undefined;

		if (arg.trim()) {
			const choice = this.resolveSelectArg(arg.trim(), files);
			if (!choice || choice === NONE_OPTION) return false;
			const parsed = this.parseOption(choice);
			targetFile = parsed.name;
			targetScope = parsed.scope;
		} else {
			let preferredSelection: string | undefined;

			while (true) {
				const currentFiles = await this.storage.list();
				if (currentFiles.length === 0) {
					this.ui.notify("No prompt files found. Creating a new one...", "info");
					const created = await this.createNewPrompt(sessionId);
					return created !== null;
				}

				const options = currentFiles.map((f) => `[${formatScope(f.scope)}] ${f.name}`);
				let initialIndex = 0;
				if (preferredSelection) {
					const idx = options.findIndex((opt) => opt === preferredSelection);
					if (idx >= 0) initialIndex = idx;
				}

				let res: SelectPromptToEditResult | undefined;
				if (typeof this.ui.selectPromptToEdit === "function") {
					res = await this.ui.selectPromptToEdit(
						"Select prompt to edit",
						options,
						initialIndex,
					);
				}
				if (!res) {
					const rawChoice = await this.ui.select("Select prompt to edit", options);
					if (rawChoice) {
						res = { action: "edit", choice: rawChoice };
					} else {
						res = { cancelled: true };
					}
				}

				if (!res || res.cancelled || !res.choice) return false;

				const parsed = this.parseOption(res.choice);
				const selectedScope = resolveScope(parsed.scope, this.host);

				if (res.action === "rename") {
					const renamed = await this.renamePrompt(parsed.name, selectedScope, sessionId);
					if (renamed) {
						preferredSelection = `[${formatScope(selectedScope)}] ${renamed}`;
					} else {
						preferredSelection = res.choice;
					}
					continue;
				}

				targetFile = parsed.name;
				targetScope = selectedScope;
				break;
			}
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

	/** Applies the project's default to a fresh session; false when the picker must show. */
	private async applyDefault(sessionId: string): Promise<boolean> {
		const favs = await this.defaultPrompt.get();
		if (favs === undefined) return false;
		if (favs !== null && favs.length > 0) {
			const files = await this.storage.list();
			const validFavs = favs.filter((fav) =>
				files.some((f) => f.name === fav.name && f.scope === fav.scope),
			);
			if (validFavs.length === 0) {
				await this.defaultPrompt.set(undefined);
				this.ui.notify(
					`Default prompt(s) no longer exist; pick a new one.`,
					"warning",
				);
				return false;
			}
			await this.sessionState.setSessionConfig(sessionId, {
				file: validFavs[0].name,
				scope: validFavs[0].scope,
				activePrompts: validFavs,
				mode: "append",
				enabled: true,
				decided: true,
			});
			await this.updateStatus(sessionId);
			const label = validFavs.map((f) => `[${formatScope(f.scope)}] "${f.name}"`).join(" + ");
			logger.info("DEFAULT_APPLY", `Applied default ${label}`, { sessionId });
			this.ui.notify(`Default system prompt(s) ${label} applied.`, "info");
			return true;
		}

		await this.sessionState.setSessionConfig(sessionId, {
			file: null,
			scope: undefined,
			activePrompts: [],
			mode: "append",
			enabled: true,
			decided: true,
		});
		await this.updateStatus(sessionId);
		logger.info("DEFAULT_APPLY", "Applied default none", { sessionId });
		return true;
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
		if (await this.applyDefault(sessionId)) return;


		const files = await this.storage.list();

		if (typeof this.ui.multiSelect === "function") {
			// ponytail: never pre-tick an option on a fresh session.
			const items = this.buildMultiSelectItems(files, []);

			logger.info("MODAL_OPEN", "startup prompt modal opened", {
				sessionId,
				itemCount: items.length,
			});

			const result = await this.ui.multiSelect(
				"Select System Prompt(s) (Session Scoped)",
				items,
			);
			if (result !== undefined) {
				if (result.cancelled) {
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

				if (result.action) {
					await this.createNewPrompt(
						sessionId,
						CREATE_ACTION_SCOPE[result.action],
						this.refsFromIds(result.selectedIds),
					);
					return;
				}

				// Ticking nothing saves (None) as the project default.
				await this.finishSelection(sessionId, this.refsFromIds(result.selectedIds));
				return;
			}
		}

		// Fallback to single select when multiSelect is not available or returned undefined
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
		await this.defaultPrompt.set(file ? [{ name: file, scope: chosenScope }] : null);
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
