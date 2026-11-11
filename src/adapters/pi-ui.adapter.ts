import { truncateToWidth } from "@earendil-works/pi-tui";
import { logger } from "../core/logger";
import type {
	MultiSelectItem,
	MultiSelectResult,
	SelectPromptToEditResult,
	UIPort,
} from "../ports/ui.port";

/** The slice of the host's TUI objects the pickers use. */
export interface ListTui {
	height?: number;
	requestRender(): void;
}
export interface ListTheme {
	fg?(color: string, text: string): string;
	bold?(text: string): string;
}
export interface ListKeybindings {
	matches?(data: string, id: string): boolean;
}
export interface ListComponent {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate?(): void;
	dispose?(): void;
}

export interface PiUIHost {
	hasUI: boolean;
	ui: {
		select(title: string, options: string[]): Promise<string | undefined>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		editor(title: string, prefill?: string): Promise<string | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
		notify(message: string, type?: "info" | "warning" | "error"): void;

		setWidget?(
			key: string,
			content: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor"; priority?: number },
		): void;

		custom?<T>(
			factory: (
				tui: ListTui,
				theme: ListTheme,
				keybindings: ListKeybindings,
				done: (value: T) => void,
			) => ListComponent | Promise<ListComponent>,
			options?: unknown,
		): Promise<T>;
	};
}

/**
 * True when `data` is Ctrl+<letter> in any encoding a terminal may use:
 * - legacy control byte (Ctrl+S = 0x13), what most terminals and tmux send;
 * - Kitty keyboard protocol CSI-u, `ESC [ code[:alt] ; mods[:event] u` (Kitty, WezTerm, Ghostty, foot...);
 * - xterm modifyOtherKeys, `ESC [ 27 ; mods ; code ~`.
 * shortcut: plain Ctrl only (lock bits tolerated), no host keybinding lookup; upgrade if omp exposes a key matcher to extensions.
 */
function isCtrlKey(data: string, letter: string): boolean {
	const code = letter.charCodeAt(0);
	if (data === String.fromCharCode(code - 96)) return true;
	// eslint-disable-next-line no-control-regex
	const kitty = /^\x1b\[(\d+)(?::\d+)*;(\d+)(?::(\d+))?u$/.exec(data);
	// eslint-disable-next-line no-control-regex
	const mok = /^\x1b\[27;(\d+);(\d+)~$/.exec(data);
	const [key, mods, event] = kitty ? [kitty[1], kitty[2], kitty[3]] : mok ? [mok[2], mok[1], undefined] : [];
	if (key === undefined || event === "3") return false; // not CSI, or a key-release event
	// bit 4 = ctrl; 64/128 = caps/num lock. Any other modifier (shift, alt, super) is a different chord.
	const bits = Number(mods) - 1;
	return Number(key) === code && (bits & 4) !== 0 && (bits & ~(4 | 64 | 128)) === 0;
}

const fg = (theme: ListTheme, color: string, text: string): string =>
	theme.fg ? theme.fg(color, text) : text;
const bold = (theme: ListTheme, text: string): string => (theme.bold ? theme.bold(text) : text);

function isEnter(data: string, keybindings: ListKeybindings): boolean {
	return (
		data === "\r" ||
		data === "\n" ||
		data === "\r\n" ||
		Boolean(keybindings.matches?.(data, "tui.select.confirm"))
	);
}

function isTab(data: string): boolean {
	if (data === "\t") return true;
	// eslint-disable-next-line no-control-regex
	if (/^\x1b\[9(?::\d+)*(?:;\d+)*u$/.test(data)) return true;
	// eslint-disable-next-line no-control-regex
	if (/^\x1b\[27;\d+;9~$/.test(data)) return true;
	return false;
}

interface ListOptions {
	title: string;
	hint: string;
	count: number;
	initialIndex?: number;
	renderRow(index: number, isCursor: boolean): string;
	renderCustomView?(width: number): string[] | undefined;
	/** Keys the list does not own (Ctrl+S, Enter, ...). Return true when handled; call `redraw` after changing state. */
	onKey(data: string, index: number, redraw: () => void): boolean;
	onCancel(): void;
}

/** A scrolling cursor list: title, rows, hint. Move/cancel keys live here; everything else goes to `onKey`. */
function listComponent(
	opts: ListOptions,
	tui: ListTui,
	theme: ListTheme,
	keybindings: ListKeybindings,
): ListComponent {
	let index = Math.max(0, Math.min(opts.count - 1, opts.initialIndex ?? 0));
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	const matches = (data: string, id: string) => Boolean(keybindings.matches?.(data, id));
	const invalidate = () => {
		cachedWidth = undefined;
		cachedLines = undefined;
	};
	const redraw = () => {
		invalidate();
		tui.requestRender();
	};
	const move = (step: number) => {
		index = (index + step + opts.count) % opts.count;
		redraw();
	};

	return {
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			if (opts.renderCustomView) {
				const custom = opts.renderCustomView(width);
				if (custom) {
					cachedWidth = width;
					cachedLines = custom.map((line) => truncateToWidth(line, width, ""));
					return cachedLines;
				}
			}
			const sep = fg(theme, "muted", "─".repeat(Math.min(width, 70)));
			const maxVisible = Math.max(5, Math.min(14, (tui.height ?? 24) - 6));
			const start = index >= maxVisible ? index - maxVisible + 1 : 0;
			const end = Math.min(opts.count, start + maxVisible);

			const lines = [bold(theme, fg(theme, "accent", opts.title)), sep];
			if (start > 0) lines.push(fg(theme, "dim", "  ▲ ..."));
			for (let i = start; i < end; i++) lines.push(opts.renderRow(i, i === index));
			if (end < opts.count) lines.push(fg(theme, "dim", "  ▼ ..."));
			lines.push(sep, fg(theme, "dim", opts.hint));

			cachedWidth = width;
			cachedLines = lines.map((line) => truncateToWidth(line, width, ""));
			return cachedLines;
		},

		handleInput(data: string): void {
			if (opts.onKey(data, index, redraw)) return;
			if (data === "\x1b" || matches(data, "tui.select.cancel")) return opts.onCancel();
			if (opts.count === 0) return;
			if (data === "\x1b[A" || data === "\x1bOA" || data === "k" || matches(data, "tui.select.up")) move(-1);
			else if (data === "\x1b[B" || data === "\x1bOB" || data === "j" || matches(data, "tui.select.down")) move(1);
		},

		invalidate,
	};
}

export class PiUIAdapter implements UIPort {
	private host: PiUIHost | null = null;
	private readonly widgetKey = "system-prompt-switch";

	setHost(host: PiUIHost | null): void {
		this.host = host;
	}

	hasUI(): boolean {
		return Boolean(this.host?.hasUI);
	}

	async select(title: string, options: string[]): Promise<string | undefined> {
		// ponytail: log only the anomalies. The happy path is already covered by
		// MODAL_OPEN / MODAL_ANSWER in the service, and a per-call log here would
		// duplicate it for every dialog the extension opens.
		if (!this.host?.hasUI) {
			logger.warn("UI_UNAVAILABLE", "dialog requested with no UI host", {
				title,
			});
			return undefined;
		}
		try {
			return await this.host.ui.select(title, options);
		} catch (err) {
			logger.error(
				"UI_DIALOG_THREW",
				"host ui.select threw",
				{ title, error: err instanceof Error ? err.message : String(err) },
			);
			throw err;
		}
	}

	async multiSelect(
		title: string,
		items: MultiSelectItem[],
	): Promise<MultiSelectResult | undefined> {
		if (!this.host?.hasUI) {
			logger.warn("UI_UNAVAILABLE", "multiSelect requested with no UI host", { title });
			return undefined;
		}
		if (typeof this.host.ui.custom !== "function") return undefined;

		const rows: MultiSelectItem[] = items.map((it) => ({ ...it }));
		const selectedIds = () => rows.filter((it) => !it.isSpecial && it.selected).map((it) => it.id);

		let previewItem: MultiSelectItem | undefined;
		let previewContent: string | undefined;
		let previewScroll = 0;

		return this.host.ui.custom<MultiSelectResult | undefined>((tui, theme, keybindings, done) =>
			listComponent(
				{
					title,
					hint: "↑/↓: Move · Space/Enter: Toggle · Tab: Preview · Ctrl+S: Save · Esc: Cancel",
					count: rows.length,
					renderCustomView(width) {
						if (!previewItem) return undefined;
						const sep = fg(theme, "muted", "─".repeat(Math.min(width, 70)));
						const maxVisible = Math.max(5, Math.min(16, (tui.height ?? 24) - 6));
						const previewTitle = `Preview: ${previewItem.label}`;
						const lines = [bold(theme, fg(theme, "accent", previewTitle)), sep];

						if (previewContent === undefined) {
							lines.push(fg(theme, "dim", "  Loading prompt content..."));
						} else {
							const rawLines =
								previewContent.length === 0 ? ["(empty prompt)"] : previewContent.split(/\r?\n/);
							const start = Math.max(0, Math.min(rawLines.length - 1, previewScroll));
							const end = Math.min(rawLines.length, start + maxVisible);

							if (start > 0) lines.push(fg(theme, "dim", "  ▲ ..."));
							for (let i = start; i < end; i++) {
								lines.push(`  ${rawLines[i]}`);
							}
							if (end < rawLines.length) lines.push(fg(theme, "dim", "  ▼ ..."));
						}

						lines.push(sep, fg(theme, "dim", "↑/↓: Scroll · Tab/Esc: Back to list"));
						return lines;
					},
					renderRow(i, isCursor) {
						const it = rows[i];
						const text =
							it.isSpecial === "save"
								? "[✔ Done / Save Selection (Ctrl+S)]"
								: it.isSpecial === "none"
									? "(None / Clear all)"
									: it.isSpecial
										? it.label
										: `${it.selected ? "[✓] " : "[ ] "}${it.label}`;
						const line = `${isCursor ? "> " : "  "}${text}`;
						if (isCursor) return bold(theme, fg(theme, "accent", line));
						if (it.selected) return fg(theme, "success", line);
						return it.isSpecial ? fg(theme, "dim", line) : line;
					},
					onKey(data, index, redraw) {
						if (previewItem !== undefined) {
							if (
								isTab(data) ||
								data === "\x1b" ||
								Boolean(keybindings.matches?.(data, "tui.select.cancel"))
							) {
								previewItem = undefined;
								previewContent = undefined;
								previewScroll = 0;
								redraw();
								return true;
							}
							const rawLines = (previewContent ?? "").split(/\r?\n/);
							const maxVisible = Math.max(5, Math.min(16, (tui.height ?? 24) - 6));
							const maxScroll = Math.max(0, rawLines.length - maxVisible);

							if (
								data === "\x1b[A" ||
								data === "\x1bOA" ||
								data === "k" ||
								Boolean(keybindings.matches?.(data, "tui.select.up"))
							) {
								if (previewScroll > 0) {
									previewScroll = Math.max(0, previewScroll - 1);
									redraw();
								}
								return true;
							}
							if (
								data === "\x1b[B" ||
								data === "\x1bOB" ||
								data === "j" ||
								Boolean(keybindings.matches?.(data, "tui.select.down"))
							) {
								if (previewScroll < maxScroll) {
									previewScroll = Math.min(maxScroll, previewScroll + 1);
									redraw();
								}
								return true;
							}
							if (data === "\x1b[5~") {
								previewScroll = Math.max(0, previewScroll - maxVisible);
								redraw();
								return true;
							}
							if (data === "\x1b[6~") {
								previewScroll = Math.min(maxScroll, previewScroll + maxVisible);
								redraw();
								return true;
							}
							return true;
						}

						if (isTab(data)) {
							const cur = rows[index];
							if (!cur.isSpecial) {
								previewItem = cur;
								previewScroll = 0;
								if (cur.content !== undefined) {
									previewContent = cur.content;
									redraw();
								} else if (typeof cur.loadContent === "function") {
									previewContent = undefined;
									redraw();
									Promise.resolve(cur.loadContent())
										.then((loaded) => {
											if (previewItem === cur) {
												cur.content = loaded ?? "";
												previewContent = cur.content;
												redraw();
											}
										})
										.catch((err) => {
											if (previewItem === cur) {
												previewContent = `(Error loading prompt: ${err instanceof Error ? err.message : String(err)})`;
												redraw();
											}
										});
								} else {
									previewContent = "(no content available)";
									redraw();
								}
								return true;
							}
							return false;
						}

						if (isCtrlKey(data, "s")) {
							done({ selectedIds: selectedIds() });
							return true;
						}
						if (data !== " " && !isEnter(data, keybindings)) return false;
						const cur = rows[index];
						if (cur.isSpecial === "save") {
							done({ selectedIds: selectedIds() });
						} else if (cur.isSpecial === "none") {
							for (const it of rows) if (!it.isSpecial) it.selected = false;
							redraw();
						} else if (cur.isSpecial) {
							done({ selectedIds: selectedIds(), action: cur.isSpecial });
						} else {
							cur.selected = !cur.selected; // toggles in place: the cursor stays and the list stays open
							redraw();
						}
						return true;
					},
					onCancel: () => done({ cancelled: true, selectedIds: [] }),
				},
				tui,
				theme,
				keybindings,
			),
		);
	}

	async selectPromptToEdit(
		title: string,
		options: string[],
		initialIndex = 0,
	): Promise<SelectPromptToEditResult | undefined> {
		if (!this.host?.hasUI) {
			logger.warn("UI_UNAVAILABLE", "selectPromptToEdit requested with no UI host", { title });
			return undefined;
		}
		if (typeof this.host.ui.custom !== "function") return undefined;

		return this.host.ui.custom<SelectPromptToEditResult | undefined>((tui, theme, keybindings, done) =>
			listComponent(
				{
					title,
					hint: "↑/↓: Move · Enter: Edit · Ctrl+N: Rename · Esc: Cancel",
					count: options.length,
					initialIndex,
					renderRow(i, isCursor) {
						const line = `${isCursor ? "> " : "  "}${options[i]}`;
						return isCursor ? bold(theme, fg(theme, "accent", line)) : line;
					},
					onKey(data, index) {
						if (isCtrlKey(data, "n")) {
							done({ action: "rename", choice: options[index] });
							return true;
						}
						if (!isEnter(data, keybindings)) return false;
						done({ action: "edit", choice: options[index] });
						return true;
					},
					onCancel: () => done({ cancelled: true }),
				},
				tui,
				theme,
				keybindings,
			),
		);
	}

	async input(title: string, placeholder?: string): Promise<string | undefined> {
		if (!this.host?.hasUI) return undefined;
		return this.host.ui.input(title, placeholder);
	}

	async editor(title: string, prefill?: string): Promise<string | undefined> {
		if (!this.host?.hasUI) return undefined;
		return this.host.ui.editor(title, prefill);
	}

	async confirm(title: string, message: string): Promise<boolean> {
		if (!this.host?.hasUI) return false;
		return this.host.ui.confirm(title, message);
	}

	notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		if (this.host?.hasUI) {
			this.host.ui.notify(message, type);
		}
	}



	setWidget(content: string[] | undefined): void {
		if (this.host?.hasUI && typeof this.host.ui.setWidget === "function") {
			this.host.ui.setWidget(this.widgetKey, content, {
				placement: "aboveEditor",
			});
		}
	}
}
