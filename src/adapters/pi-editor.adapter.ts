/**
 * Pi's prompt editor: pi-tui's `Editor` in a modal. Pi-only on purpose, because OMP 19 refuses any extension that
 * imports pi-tui; only `extensions/pi.ts` loads this file. OMP uses `omp-editor.adapter.ts`.
 */
import { Editor, type EditorTheme, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { editInExternalEditor } from "../core/external-editor";
import {
	bold,
	type EditorComponentOptions,
	fg,
	isCtrlKey,
	isEnter,
	type ListComponent,
	type ListKeybindings,
	type ListTheme,
	type ListTui,
} from "./pi-ui.adapter";

export function editorComponent(
	opts: EditorComponentOptions,
	tui: ListTui,
	theme: ListTheme,
	keybindings: ListKeybindings,
): ListComponent {
	const runExternalEditor = opts.externalEditor ?? editInExternalEditor;
	let isExternalEditorActive = false;
	const safeTui = {
		terminal: { rows: 24, columns: 80 },
		...tui,
	};
	const safeTheme = {
		borderColor: (s: string) => fg(theme, "muted", s),
		selectActiveRow: (s: string) => s,
		selectInactiveRow: (s: string) => s,
		...theme,
	};
	const editor = new Editor(safeTui as unknown as TUI, safeTheme as unknown as EditorTheme, {
		paddingX: 1,
	});
	editor.focused = true;
	if (opts.prefill !== undefined) {
		editor.setText(opts.prefill);
		// ponytail: setText pushes an initial empty-string snapshot onto undoStack.
		// Clearing undoStack ensures repeated Ctrl+Z cannot undo past the prefilled content,
		// preventing accidental deletion/clearing of prompt files when fixing typos.
		(editor as unknown as { undoStack?: { clear(): void } }).undoStack?.clear();
	}
	(editor as unknown as { disableSubmit?: boolean }).disableSubmit = true;

	return {
		render(width: number): string[] {
			const lines = [
				bold(theme, fg(theme, "accent", opts.title)),
				...editor.render(width),
				fg(
					theme,
					"dim",
					"Ctrl+Q / Ctrl+S: Save · Esc: Cancel · Ctrl+Z: Undo · Ctrl+G: External Editor",
				),
			];
			return lines.map((line) => truncateToWidth(line, width, ""));
		},
		handleInput(data: string): void {
			if (isExternalEditorActive) return;
			if (isCtrlKey(data, "q") || isCtrlKey(data, "s")) {
				opts.onDone(editor.getText());
				return;
			}
			if (data === "\x1b" || Boolean(keybindings.matches?.(data, "tui.select.cancel"))) {
				opts.onDone(undefined);
				return;
			}
			if (isCtrlKey(data, "z") || Boolean(keybindings.matches?.(data, "tui.editor.undo"))) {
				(editor as unknown as { undo?(): void }).undo?.();
				tui.requestRender();
				return;
			}
			if (
				isEnter(data, keybindings) ||
				Boolean(keybindings.matches?.(data, "tui.input.submit"))
			) {
				const ed = editor as unknown as {
					addNewLine?(): void;
					insertTextAtCursor?(t: string): void;
				};
				if (typeof ed.addNewLine === "function") {
					ed.addNewLine();
				} else if (typeof ed.insertTextAtCursor === "function") {
					ed.insertTextAtCursor("\n");
				}
				tui.requestRender();
				return;
			}
			if (isCtrlKey(data, "g") || Boolean(keybindings.matches?.(data, "app.editor.external"))) {
				isExternalEditorActive = true;
				void (async () => {
					tui.stop?.();
					try {
						const res = await runExternalEditor({ content: editor.getText() });
						if (res.status === "complete" && res.content !== undefined) {
							editor.setText(res.content);
							(editor as unknown as { undoStack?: { clear(): void } }).undoStack?.clear();
						}
					} catch {
						// A failed launch keeps the text as it is; a rejection here would otherwise reach the host unhandled.
					} finally {
						isExternalEditorActive = false;
						tui.start?.();
						tui.requestRender(true);
					}
				})();
				return;
			}
			editor.handleInput(data);
		},
		invalidate(): void {
			editor.invalidate?.();
		},
	};
}
