import { logger } from "../core/logger";
import type {
	MultiSelectItem,
	MultiSelectResult,
	SelectPromptToEditResult,
	UIPort,
} from "../ports/ui.port";

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
				tui: any,
				theme: any,
				keybindings: any,
				done: (value: T) => void,
			) => {
				render(width: number): string[];
				handleInput?(data: string): void;
				invalidate?(): void;
				dispose?(): void;
			} | Promise<{
				render(width: number): string[];
				handleInput?(data: string): void;
				invalidate?(): void;
				dispose?(): void;
			}>,
			options?: any,
		): Promise<T>;
	};
}

function getVisibleWidth(str: string): number {
	// eslint-disable-next-line no-control-regex
	const clean = str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	let width = 0;
	for (let i = 0; i < clean.length; i++) {
		const code = clean.charCodeAt(i);
		if (
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe10 && code <= 0xfe19) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6)
		) {
			width += 2;
		} else {
			width += 1;
		}
	}
	return width;
}

function truncateLine(str: string, maxWidth: number): string {
	if (getVisibleWidth(str) <= maxWidth) return str;
	// eslint-disable-next-line no-control-regex
	const ansiRegex = /\x1b\[[0-9;]*[a-zA-Z]/g;
	let visible = 0;
	let result = "";
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = ansiRegex.exec(str)) !== null) {
		const textChunk = str.slice(lastIndex, match.index);
		for (const ch of textChunk) {
			const w = getVisibleWidth(ch);
			if (visible + w > maxWidth) {
				return `${result}\x1b[0m`;
			}
			visible += w;
			result += ch;
		}
		result += match[0];
		lastIndex = ansiRegex.lastIndex;
	}

	const remaining = str.slice(lastIndex);
	for (const ch of remaining) {
		const w = getVisibleWidth(ch);
		if (visible + w > maxWidth) {
			return `${result}\x1b[0m`;
		}
		visible += w;
		result += ch;
	}

	return result;
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
		if (typeof this.host.ui.custom !== "function") {
			return undefined;
		}

		const cloneItems: MultiSelectItem[] = items.map((it) => ({ ...it }));
		let selectedIndex = 0;

		return this.host.ui.custom<MultiSelectResult | undefined>(
			(tui, theme, keybindings, done) => {
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;

				const invalidate = () => {
					cachedWidth = undefined;
					cachedLines = undefined;
				};

				const collectResult = (): MultiSelectResult => {
					const selectedIds = cloneItems
						.filter((it) => !it.isSpecial && it.selected)
						.map((it) => it.id);
					return { selectedIds };
				};

				return {
					render(width: number): string[] {
						if (cachedLines && cachedWidth === width) return cachedLines;
						cachedWidth = width;

						const lines: string[] = [];
						const header = theme?.bold
							? theme.bold(theme.fg ? theme.fg("accent", title) : title)
							: title;
						lines.push(truncateLine(header, width));

						const sep = theme?.fg
							? theme.fg("muted", "─".repeat(Math.min(width, 70)))
							: "─".repeat(Math.min(width, 70));
						lines.push(truncateLine(sep, width));

						const maxVisible = Math.max(5, Math.min(14, (tui?.height ?? 24) - 6));
						let scrollOffset = 0;
						if (selectedIndex >= maxVisible) {
							scrollOffset = selectedIndex - maxVisible + 1;
						}
						const end = Math.min(cloneItems.length, scrollOffset + maxVisible);

						if (scrollOffset > 0) {
							const upNotice = theme?.fg ? theme.fg("dim", "  ▲ ...") : "  ▲ ...";
							lines.push(truncateLine(upNotice, width));
						}

						for (let i = scrollOffset; i < end; i++) {
							const it = cloneItems[i];
							const isCursor = i === selectedIndex;
							const cursorPrefix = isCursor ? "> " : "  ";
							let itemText = "";

							if (it.isSpecial === "save") {
								itemText = "[✔ Done / Save Selection (Ctrl+S)]";
							} else if (it.isSpecial === "none") {
								itemText = "(None / Clear all)";
							} else if (it.isSpecial?.startsWith("create-")) {
								itemText = it.label;
							} else {
								const checkMark = it.selected ? "[✓] " : "[ ] ";
								itemText = `${checkMark}${it.label}`;
							}

							let renderedLine = `${cursorPrefix}${itemText}`;
							if (isCursor) {
								if (theme?.bold && theme?.fg) {
									renderedLine = theme.bold(theme.fg("accent", renderedLine));
								}
							} else if (it.selected && theme?.fg) {
								renderedLine = theme.fg("success", renderedLine);
							} else if (it.isSpecial && theme?.fg) {
								renderedLine = theme.fg("dim", renderedLine);
							}

							lines.push(truncateLine(renderedLine, width));
						}

						if (end < cloneItems.length) {
							const downNotice = theme?.fg ? theme.fg("dim", "  ▼ ...") : "  ▼ ...";
							lines.push(truncateLine(downNotice, width));
						}

						lines.push(truncateLine(sep, width));
						const hint = "↑/↓: Move · Space/Enter: Toggle · Ctrl+S: Save · Esc: Cancel";
						const styledHint = theme?.fg ? theme.fg("dim", hint) : hint;
						lines.push(truncateLine(styledHint, width));

						cachedLines = lines;
						return lines;
					},

					handleInput(data: string): void {
						// 1. Ctrl+S 保存 (ASCII 19 / 0x13 / matches 'save')
						if (
							data === "\x13" ||
							data.charCodeAt(0) === 19 ||
							keybindings?.matches(data, "save")
						) {
							done(collectResult());
							return;
						}

						// 2. Escape 取消
						if (data === "\x1b" || keybindings?.matches(data, "tui.select.cancel")) {
							done({ cancelled: true, selectedIds: [] });
							return;
						}

						// 3. 上移
						if (
							data === "\x1b[A" ||
							data === "\x1bOA" ||
							data === "k" ||
							keybindings?.matches(data, "tui.select.up")
						) {
							selectedIndex = (selectedIndex - 1 + cloneItems.length) % cloneItems.length;
							invalidate();
							tui?.requestRender();
							return;
						}

						// 4. 下移
						if (
							data === "\x1b[B" ||
							data === "\x1bOB" ||
							data === "j" ||
							keybindings?.matches(data, "tui.select.down")
						) {
							selectedIndex = (selectedIndex + 1) % cloneItems.length;
							invalidate();
							tui?.requestRender();
							return;
						}

						// 5. Space / Enter 触发
						const isEnter =
							data === "\r" ||
							data === "\n" ||
							data === "\r\n" ||
							keybindings?.matches(data, "tui.select.confirm");
						const isSpace = data === " ";

						if (isSpace || isEnter) {
							const cur = cloneItems[selectedIndex];
							if (!cur) return;

							if (cur.isSpecial === "save") {
								done(collectResult());
								return;
							}

							if (cur.isSpecial === "none") {
								for (const it of cloneItems) {
									if (!it.isSpecial) it.selected = false;
								}
								invalidate();
								tui?.requestRender();
								return;
							}

							if (cur.isSpecial?.startsWith("create-")) {
								done({
									selectedIds: collectResult().selectedIds,
									action: cur.isSpecial as "create-omp" | "create-pi" | "create-local",
								});
								return;
							}

							// 普通提示词项：Toggle 勾选状态，不移动光标，不退出
							cur.selected = !cur.selected;
							invalidate();
							tui?.requestRender();
							return;
						}
					},

					invalidate,
				};
			},
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
		if (typeof this.host.ui.custom !== "function") {
			return undefined;
		}

		let selectedIndex = Math.max(0, Math.min(options.length - 1, initialIndex));

		return this.host.ui.custom<SelectPromptToEditResult | undefined>(
			(tui, theme, keybindings, done) => {
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;

				const invalidate = () => {
					cachedWidth = undefined;
					cachedLines = undefined;
				};

				return {
					render(width: number): string[] {
						if (cachedLines && cachedWidth === width) return cachedLines;
						cachedWidth = width;

						const lines: string[] = [];
						const header = theme?.bold
							? theme.bold(theme.fg ? theme.fg("accent", title) : title)
							: title;
						lines.push(truncateLine(header, width));

						const sep = theme?.fg
							? theme.fg("muted", "─".repeat(Math.min(width, 70)))
							: "─".repeat(Math.min(width, 70));
						lines.push(truncateLine(sep, width));

						const maxVisible = Math.max(5, Math.min(14, (tui?.height ?? 24) - 6));
						let scrollOffset = 0;
						if (selectedIndex >= maxVisible) {
							scrollOffset = selectedIndex - maxVisible + 1;
						}
						const end = Math.min(options.length, scrollOffset + maxVisible);

						if (scrollOffset > 0) {
							const upNotice = theme?.fg ? theme.fg("dim", "  ▲ ...") : "  ▲ ...";
							lines.push(truncateLine(upNotice, width));
						}

						for (let i = scrollOffset; i < end; i++) {
							const opt = options[i];
							const isCursor = i === selectedIndex;
							const cursorPrefix = isCursor ? "> " : "  ";
							let renderedLine = `${cursorPrefix}${opt}`;
							if (isCursor) {
								if (theme?.bold && theme?.fg) {
									renderedLine = theme.bold(theme.fg("accent", renderedLine));
								}
							}
							lines.push(truncateLine(renderedLine, width));
						}

						if (end < options.length) {
							const downNotice = theme?.fg ? theme.fg("dim", "  ▼ ...") : "  ▼ ...";
							lines.push(truncateLine(downNotice, width));
						}

						lines.push(truncateLine(sep, width));
						const hint = "↑/↓: Move · Enter: Edit · Ctrl+N: Rename · Esc: Cancel";
						const styledHint = theme?.fg ? theme.fg("dim", hint) : hint;
						lines.push(truncateLine(styledHint, width));

						cachedLines = lines;
						return lines;
					},

					handleInput(data: string): void {
						// 1. Ctrl+N (ASCII 14 / 0x0E) -> Rename
						if (
							data === "\x0e" ||
							data.charCodeAt(0) === 14 ||
							keybindings?.matches(data, "rename")
						) {
							done({ action: "rename", choice: options[selectedIndex] });
							return;
						}

						// 2. Escape -> Cancel
						if (data === "\x1b" || keybindings?.matches(data, "tui.select.cancel")) {
							done({ cancelled: true });
							return;
						}

						// 3. Up
						if (
							data === "\x1b[A" ||
							data === "\x1bOA" ||
							data === "k" ||
							keybindings?.matches(data, "tui.select.up")
						) {
							selectedIndex = (selectedIndex - 1 + options.length) % options.length;
							invalidate();
							tui?.requestRender();
							return;
						}

						// 4. Down
						if (
							data === "\x1b[B" ||
							data === "\x1bOB" ||
							data === "j" ||
							keybindings?.matches(data, "tui.select.down")
						) {
							selectedIndex = (selectedIndex + 1) % options.length;
							invalidate();
							tui?.requestRender();
							return;
						}

						// 5. Enter -> Edit
						const isEnter =
							data === "\r" ||
							data === "\n" ||
							data === "\r\n" ||
							keybindings?.matches(data, "tui.select.confirm");

						if (isEnter) {
							done({ action: "edit", choice: options[selectedIndex] });
							return;
						}
					},

					invalidate,
				};
			},
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
