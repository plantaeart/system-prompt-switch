/**
 * Terminal text helpers the pickers need: width, truncation, wrapping, escape stripping.
 * Local on purpose: omp 19 refuses extensions that import pi-tui, and pi-tui's helpers are not importable there.
 * shortcut: width follows Unicode East Asian Wide ranges and emoji presentation, not each terminal's own tables;
 * upgrade if a terminal draws some character at another width and rows come out a column off.
 */

// CSI (ESC [ ... final), OSC (ESC ] ... BEL or ESC \) and two-character escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/;
const ANSI_ALL = new RegExp(ANSI.source, "g");
const ANSI_SPLIT = new RegExp(`(${ANSI.source})`);
const SEGMENTER = new Intl.Segmenter();
const RESET = "\x1b[0m";

const ZERO_WIDTH = /^[\p{M}\p{Cf}]+$/u;
const EMOJI = /\p{Emoji_Presentation}|\uFE0F/u;

/** Characters the terminal draws in two columns (East Asian Wide and Fullwidth blocks). */
function isWide(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	);
}

function graphemeWidth(grapheme: string): number {
	const cp = grapheme.codePointAt(0) ?? 0;
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	if (ZERO_WIDTH.test(grapheme)) return 0;
	return isWide(cp) || EMOJI.test(grapheme) ? 2 : 1;
}

export function stripTerminalSequences(text: string): string {
	return text.replace(ANSI_ALL, "");
}

export function visibleWidth(text: string): number {
	let width = 0;
	for (const { segment } of SEGMENTER.segment(stripTerminalSequences(text))) width += graphemeWidth(segment);
	return width;
}

/** Cuts `text` to `maxWidth` columns. Escape sequences take no columns; styling still open at the cut is reset. */
export function truncateToWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	let out = "";
	let used = 0;
	let sawEscape = false;
	const parts = text.split(ANSI_SPLIT);
	for (let i = 0; i < parts.length; i++) {
		if (i % 2 === 1) {
			out += parts[i];
			sawEscape = true;
			continue;
		}
		for (const { segment } of SEGMENTER.segment(parts[i]!)) {
			const width = graphemeWidth(segment);
			if (used + width > maxWidth) return sawEscape ? out + RESET : out;
			out += segment;
			used += width;
		}
	}
	return out;
}

/**
 * Splits `cells` (graphemes) into rows of at most `limit` columns, as [start, end) ranges that cover every cell once:
 * a row ends after the last space that fits (the space stays at the end of its row), else inside the word.
 * Editors need the ranges to map screen rows back to text positions; `wrapText` uses the same split for display.
 */
export function wrapRanges(
	cells: readonly string[],
	limit: number,
	widthOf: (grapheme: string) => number = graphemeWidth,
): Array<[number, number]> {
	if (cells.length === 0) return [[0, 0]];
	const ranges: Array<[number, number]> = [];
	let start = 0;
	while (start < cells.length) {
		let used = 0;
		let i = start;
		let lastSpace = -1;
		while (i < cells.length && used + widthOf(cells[i]!) <= limit) {
			if (cells[i] === " ") lastSpace = i;
			used += widthOf(cells[i]!);
			i++;
		}
		if (i >= cells.length) {
			ranges.push([start, cells.length]);
			break;
		}
		if (cells[i] === " ") {
			ranges.push([start, i + 1]); // the space that would overflow hangs at the end of this row
			start = i + 1;
		} else if (lastSpace > start) {
			ranges.push([start, lastSpace + 1]);
			start = lastSpace + 1;
		} else {
			if (i === start) i++; // one character wider than the whole row: give it its own row
			ranges.push([start, i]);
			start = i;
		}
	}
	return ranges;
}

/** Wraps one line of plain text (no escape sequences) to `width` columns: at spaces, hard-split inside longer words. */
export function wrapText(text: string, width: number): string[] {
	const cells = [...SEGMENTER.segment(text)].map(({ segment }) => segment);
	return wrapRanges(cells, Math.max(1, width)).map(([start, end], i, ranges) => {
		const row = cells.slice(start, end);
		if (i < ranges.length - 1 && row.at(-1) === " ") row.pop(); // the break space is not drawn
		return row.join("");
	});
}
