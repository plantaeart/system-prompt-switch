/**
 * OMP's prompt editor. OMP 19 refuses extensions that import pi-tui, so pi-tui's `Editor` is out; this is a small
 * multi-line editor drawn as a rows object in `ctx.ui.custom`, with the same keys as the Pi editor: Ctrl+Q / Ctrl+S
 * save, Esc cancels, Ctrl+Z undoes (never past the prefilled text), Ctrl+G opens `$VISUAL` / `$EDITOR`, Enter adds a line.
 * The cursor is drawn in reverse video on the character under it, so it never shifts the text.
 * shortcut: no selection, word motions, kill ring or mouse; upgrade if users ask for them.
 * shortcut: undo keeps whole-text snapshots (200 at most) and every key re-wraps the whole text; fine for prompt-sized
 * text (a few KB). Measured: a 100,000-character paste redraws in about 180 ms. Upgrade (diff-based undo, cached layout)
 * before editing files over ~100 KB.
 */
import { editInExternalEditor, type ExternalEditorResult } from "../core/external-editor";
import { plainKey } from "../core/keys";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapRanges } from "../core/text-width";
import {
	bold,
	type EditorComponentFactory,
	fg,
	isCtrlKey,
	isEscape,
	type ListComponent,
	terminalHeight,
} from "./pi-ui.adapter";

const SEGMENTER = new Intl.Segmenter();
const REVERSE_ON = "\x1b[7m";
const REVERSE_OFF = "\x1b[27m";
const UNDO_LIMIT = 200;
const HINT = "Ctrl+Q / Ctrl+S: Save · Esc: Cancel · Ctrl+Z: Undo · Ctrl+G: External Editor";
// Printable input: no ESC and no control character other than tab and line breaks.
// eslint-disable-next-line no-control-regex
const PRINTABLE = /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x1b]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
// Shift+Enter in the Kitty protocol (with press / repeat) or modifyOtherKeys: a newline like Enter, never a save.
// eslint-disable-next-line no-control-regex
const SHIFT_ENTER = /^\x1b\[(?:13;2(?::[12])?u|27;2;13~)$/;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

type Line = string[];
interface Snapshot {
	lines: Line[];
	row: number;
	col: number;
}
/** A screen row: graphemes [start, end) of logical line `row`. */
interface VisualRow {
	row: number;
	start: number;
	end: number;
	last: boolean;
}

const graphemes = (text: string): Line => [...SEGMENTER.segment(text)].map((s) => s.segment);
const cellWidth = (g: string): number => (g === "\t" ? 4 : g < " " || g === "\x7f" ? 1 : visibleWidth(g));
const cellText = (g: string): string => (g === "\t" ? "    " : g < " " || g === "\x7f" ? "·" : g);

export const ompEditorComponent: EditorComponentFactory = (opts, tui, theme, keybindings): ListComponent => {
	const runExternalEditor = opts.externalEditor ?? editInExternalEditor;
	let lines: Line[] = [[]];
	let row = 0;
	let col = 0;
	let top = 0; // first screen row drawn
	let width = 80; // the width of the last draw: Up/Down and scrolling use the same wrapping the screen shows
	let wantX: number | null = null; // column to return to when moving through shorter rows
	let lastKind: "word" | "other" | "move" = "move";
	let undoStack: Snapshot[] = [];
	let externalActive = false;
	let notice = "";
	let pasteBuffer: string | null = null;

	const getText = () => lines.map((l) => l.join("")).join("\n");
	const sanitize = (text: string) =>
		stripTerminalSequences(text).replace(/\r\n?/g, "\n").replace(CONTROL, (c) => (c === "\n" ? c : ""));

	function setText(text: string): void {
		lines = text.replace(/\r\n?/g, "\n").split("\n").map(graphemes);
		row = lines.length - 1;
		col = lines[row]!.length;
		undoStack = []; // the loaded text is the floor: undo never goes below it
		lastKind = "move";
		wantX = null;
		top = 0;
	}
	setText(opts.prefill ?? "");

	const snapshot = (): Snapshot => ({ lines: lines.map((l) => [...l]), row, col });
	function edit(kind: "word" | "other", change: () => void): void {
		// Typing a run of word characters is one undo step; everything else is a step of its own.
		if (!(kind === "word" && lastKind === "word")) {
			undoStack.push(snapshot());
			if (undoStack.length > UNDO_LIMIT) undoStack.shift();
		}
		change();
		lastKind = kind;
		wantX = null;
	}
	function undo(): void {
		const previous = undoStack.pop();
		if (!previous) return;
		({ row, col } = previous);
		lines = previous.lines;
		lastKind = "move";
		wantX = null;
	}

	function insert(raw: string): void {
		const text = sanitize(raw);
		if (text.length === 0) return;
		const kind = text.length <= 2 && !/\s/.test(text) ? "word" : "other";
		edit(kind, () => {
			const parts = text.split("\n").map(graphemes);
			const tail = lines[row]!.splice(col);
			lines[row]!.push(...parts[0]!);
			if (parts.length === 1) {
				col = lines[row]!.length;
				lines[row]!.push(...tail);
				return;
			}
			const inserted = parts.slice(1);
			const lastPart = inserted[inserted.length - 1]!;
			const endCol = lastPart.length;
			lastPart.push(...tail);
			lines.splice(row + 1, 0, ...inserted);
			row += inserted.length;
			col = endCol;
		});
	}
	function newline(): void {
		edit("other", () => {
			const tail = lines[row]!.splice(col);
			lines.splice(row + 1, 0, tail);
			row++;
			col = 0;
		});
	}
	function backspace(): void {
		if (col === 0 && row === 0) return;
		edit("other", () => {
			if (col > 0) {
				lines[row]!.splice(col - 1, 1);
				col--;
			} else {
				const joinAt = lines[row - 1]!.length;
				lines[row - 1]!.push(...lines[row]!);
				lines.splice(row, 1);
				row--;
				col = joinAt;
			}
		});
	}
	function del(): void {
		if (col >= lines[row]!.length && row === lines.length - 1) return;
		edit("other", () => {
			if (col < lines[row]!.length) lines[row]!.splice(col, 1);
			else {
				lines[row]!.push(...lines[row + 1]!);
				lines.splice(row + 1, 1);
			}
		});
	}

	function layout(): VisualRow[] {
		const limit = Math.max(1, width - 1); // the last column is kept free for the cursor
		return lines.flatMap((line, r) => {
			const ranges = wrapRanges(line, limit, cellWidth);
			return ranges.map(([start, end], i) => ({ row: r, start, end, last: i === ranges.length - 1 }));
		});
	}
	function rowIndexOfCursor(rows: VisualRow[]): number {
		let found = 0;
		rows.forEach((vr, i) => {
			if (vr.row === row && vr.start <= col) found = i;
		});
		return found;
	}
	const maxCol = (vr: VisualRow) => (vr.last ? vr.end : Math.max(vr.start, vr.end - 1));
	const xOf = (vr: VisualRow, c: number) =>
		lines[vr.row]!.slice(vr.start, c).reduce((sum, g) => sum + cellWidth(g), 0);

	function moveVertical(delta: number): void {
		const rows = layout();
		const index = rowIndexOfCursor(rows);
		const target = rows[index + delta];
		if (!target) return;
		wantX ??= xOf(rows[index]!, col);
		let c = target.start;
		let x = 0;
		while (c < maxCol(target) && x + cellWidth(lines[target.row]![c]!) <= wantX) {
			x += cellWidth(lines[target.row]![c]!);
			c++;
		}
		row = target.row;
		col = c;
		lastKind = "move";
	}
	function moveHorizontal(delta: number): void {
		if (delta < 0) {
			if (col > 0) col--;
			else if (row > 0) {
				row--;
				col = lines[row]!.length;
			}
		} else if (col < lines[row]!.length) col++;
		else if (row < lines.length - 1) {
			row++;
			col = 0;
		}
		lastKind = "move";
		wantX = null;
	}
	function moveToEdge(end: boolean): void {
		const rows = layout();
		const vr = rows[rowIndexOfCursor(rows)]!;
		col = end ? maxCol(vr) : vr.start;
		lastKind = "move";
		wantX = null;
	}
	const viewportRows = () => Math.max(3, Math.min(30, terminalHeight(tui) - 6));

	async function openExternalEditor(): Promise<void> {
		externalActive = true;
		try {
			let result: ExternalEditorResult | undefined;
			const run = async () => {
				result = await runExternalEditor({ content: getText() });
			};
			if (tui.suspend) await tui.suspend(run);
			else {
				tui.stop?.();
				try {
					await run();
				} finally {
					tui.start?.();
				}
			}
			if (result?.status === "complete" && result.content !== undefined) setText(result.content);
			else if (result?.status === "failed") notice = result.message ?? "External editor failed";
		} catch (error) {
			notice = error instanceof Error ? error.message : String(error); // never let a rejection escape into the host
		} finally {
			externalActive = false;
			tui.requestRender(true);
		}
	}

	function handlePasteChunk(data: string): void {
		let chunk = data;
		if (pasteBuffer === null) {
			pasteBuffer = "";
			chunk = chunk.slice(PASTE_START.length);
		}
		const end = chunk.indexOf(PASTE_END);
		if (end === -1) {
			pasteBuffer += chunk;
			return;
		}
		const pasted = pasteBuffer + chunk.slice(0, end);
		pasteBuffer = null;
		insert(pasted);
		const rest = chunk.slice(end + PASTE_END.length);
		if (rest.length > 0) handleInput(rest);
	}

	function handleInput(data: string): void {
		if (externalActive) return;
		if (pasteBuffer !== null && isEscape(data, keybindings)) {
			pasteBuffer = null; // the end marker never came: Esc drops the paste and the editor answers again
			tui.requestRender();
			return;
		}
		if (pasteBuffer !== null || data.startsWith(PASTE_START)) {
			handlePasteChunk(data);
			tui.requestRender();
			return;
		}
		notice = "";
		if (isCtrlKey(data, "q") || isCtrlKey(data, "s")) return opts.onDone(getText());
		if (isEscape(data, keybindings)) return opts.onDone(undefined);
		if (isCtrlKey(data, "g")) {
			void openExternalEditor();
			return;
		}
		const key = plainKey(data);
		if (isCtrlKey(data, "z") || data === "\x1f") undo();
		else if (key === "enter" || SHIFT_ENTER.test(data)) newline();
		else if (key === "backspace") backspace();
		else if (key === "delete") del();
		else if (key === "up") moveVertical(-1);
		else if (key === "down") moveVertical(1);
		else if (key === "left") moveHorizontal(-1);
		else if (key === "right") moveHorizontal(1);
		else if (key === "home" || isCtrlKey(data, "a")) moveToEdge(false);
		else if (key === "end" || isCtrlKey(data, "e")) moveToEdge(true);
		else if (key === "pageUp") moveVertical(-viewportRows());
		else if (key === "pageDown") moveVertical(viewportRows());
		else if (key === "tab") insert("\t");
		else if (PRINTABLE.test(data)) insert(data);
		else return; // unknown key: ignored, never typed into the text
		tui.requestRender();
	}

	return {
		render(columns: number): string[] {
			width = Math.max(2, columns);
			const rows = layout();
			const cursorRow = rowIndexOfCursor(rows);
			const height = viewportRows();
			if (cursorRow < top) top = cursorRow;
			if (cursorRow >= top + height) top = cursorRow - height + 1;
			top = Math.max(0, Math.min(top, Math.max(0, rows.length - height)));

			const body = rows.slice(top, top + height).map((vr, i) => {
				const cells = lines[vr.row]!.slice(vr.start, vr.end);
				if (!vr.last && cells.at(-1) === " ") cells.pop(); // the wrap space is not drawn
				if (top + i !== cursorRow) return cells.map(cellText).join("");
				const at = col - vr.start;
				return [
					cells.slice(0, at).map(cellText).join(""),
					REVERSE_ON,
					at < cells.length ? cellText(cells[at]!) : " ",
					REVERSE_OFF,
					cells.slice(at + 1).map(cellText).join(""),
				].join("");
			});
			const separator = fg(theme, "muted", "─".repeat(Math.min(width, 70)));
			const out = [bold(theme, fg(theme, "accent", opts.title)), separator, ...body, separator];
			if (notice) out.push(fg(theme, "warning", notice));
			out.push(fg(theme, "dim", HINT));
			return out.map((line) => truncateToWidth(line, width));
		},
		handleInput,
		invalidate(): void {},
	};
};
