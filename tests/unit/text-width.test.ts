import { describe, expect, it } from "bun:test";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapRanges, wrapText } from "../../src/core/text-width";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

describe("stripTerminalSequences", () => {
	it("removes colour, cursor and screen sequences", () => {
		expect(stripTerminalSequences(`${RED}red${RESET} a\x1b[2Jb\x1b[3;4Hc`)).toBe("red abc");
	});

	it("removes OSC sequences ended by BEL or ST, keeping the visible link text", () => {
		expect(stripTerminalSequences("a\x1b]0;title\x07b\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\c")).toBe("ablinkc");
	});

	it("leaves plain text and newlines alone", () => {
		expect(stripTerminalSequences("line one\nline two")).toBe("line one\nline two");
	});
});

describe("visibleWidth", () => {
	it("ignores escape sequences", () => {
		expect(visibleWidth(`${RED}abc${RESET}`)).toBe(3);
	});

	it("counts wide characters and emoji as two columns", () => {
		expect(visibleWidth("日本")).toBe(4);
		expect(visibleWidth("a😀b")).toBe(4);
	});

	it("counts combining marks and zero-width joiners as zero", () => {
		expect(visibleWidth("e\u0301")).toBe(1);
		expect(visibleWidth("a\u200Bb")).toBe(2);
	});
});

describe("truncateToWidth", () => {
	it("returns a line that already fits unchanged", () => {
		expect(truncateToWidth(`${RED}abc${RESET}`, 3)).toBe(`${RED}abc${RESET}`);
	});

	it("cuts to the width without counting escape sequences and closes open styling", () => {
		const out = truncateToWidth(`${RED}abcdef${RESET}`, 4);
		expect(visibleWidth(out)).toBe(4);
		expect(stripTerminalSequences(out)).toBe("abcd");
		expect(out.endsWith(RESET)).toBe(true);
	});

	it("never splits a wide character across the limit", () => {
		const out = truncateToWidth("a日本", 2);
		expect(stripTerminalSequences(out)).toBe("a");
		expect(visibleWidth(out)).toBeLessThanOrEqual(2);
	});

	it("returns an empty string for a zero width", () => {
		expect(truncateToWidth("abc", 0)).toBe("");
	});
});

describe("wrapText", () => {
	it("breaks at spaces so no row exceeds the width", () => {
		const rows = wrapText("lorem ipsum dolor sit amet", 11);
		expect(rows).toEqual(["lorem ipsum", "dolor sit", "amet"]);
	});

	it("hard-splits a word longer than the width", () => {
		const rows = wrapText("abcdefghij", 4);
		expect(rows).toEqual(["abcd", "efgh", "ij"]);
	});

	it("keeps wide characters within the width", () => {
		const rows = wrapText("日本語日本語", 5);
		expect(rows.every((row) => visibleWidth(row) <= 5)).toBe(true);
		expect(rows.join("")).toBe("日本語日本語");
	});

	it("returns one empty row for an empty line", () => {
		expect(wrapText("", 10)).toEqual([""]);
	});
});

describe("wrapRanges", () => {
	const cells = (text: string) => [...new Intl.Segmenter().segment(text)].map((s) => s.segment);

	it("covers every character exactly once, so an editor can map rows back to positions", () => {
		const line = cells("lorem ipsum dolor sit amet");
		const ranges = wrapRanges(line, 11);

		expect(ranges[0]![0]).toBe(0);
		expect(ranges.at(-1)![1]).toBe(line.length);
		ranges.forEach((range, i) => i > 0 && expect(range[0]).toBe(ranges[i - 1]![1]));
	});

	it("keeps the break space at the end of its row", () => {
		const line = cells("lorem ipsum dolor sit amet");
		const rows = wrapRanges(line, 11).map(([a, b]) => line.slice(a, b).join(""));
		expect(rows).toEqual(["lorem ipsum ", "dolor sit ", "amet"]);
	});

	it("returns one empty range for an empty line", () => {
		expect(wrapRanges([], 10)).toEqual([[0, 0]]);
	});

	it("uses the width function it is given", () => {
		const ranges = wrapRanges(cells("a\tb"), 4, (g) => (g === "\t" ? 4 : 1));
		expect(ranges).toEqual([[0, 1], [1, 2], [2, 3]]);
	});
});
