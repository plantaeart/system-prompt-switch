import { describe, expect, it } from "bun:test";
import { type PlainKey, plainKey } from "../../src/core/keys";

/**
 * Every encoding a terminal may use for an unmodified navigation / editing key: legacy bytes, xterm application mode
 * (ESC O x), the Kitty keyboard protocol (`CSI code ; mods : event`, mods 1 = none, event 1 press / 2 repeat / 3 release,
 * lock bits 64 caps + 128 num added to mods) and modifyOtherKeys (`CSI 27 ; mods ; code ~`).
 */
const TABLE: Record<string, string[]> = {
	escape: ["\x1b", "\x1b[27u", "\x1b[27;1u", "\x1b[27;1:1u", "\x1b[27;1:2u", "\x1b[27;65u", "\x1b[27;129u", "\x1b[27;193u", "\x1b[27;1;27~"],
	enter: ["\r", "\n", "\r\n", "\x1b[13u", "\x1b[13;1u", "\x1b[13;1:1u", "\x1b[13;65u", "\x1b[27;1;13~"],
	backspace: ["\x7f", "\b", "\x1b[127u", "\x1b[127;1u", "\x1b[127;1:1u", "\x1b[127;1:2u", "\x1b[127;65u"],
	tab: ["\t", "\x1b[9u", "\x1b[9;1u", "\x1b[9;1:1u"],
	delete: ["\x1b[3~", "\x1b[3;1~", "\x1b[3;1:1~", "\x1b[3;1:2~", "\x1b[3;65~"],
	up: ["\x1b[A", "\x1bOA", "\x1b[1;1A", "\x1b[1;1:1A", "\x1b[1;1:2A", "\x1b[1;65A"],
	down: ["\x1b[B", "\x1bOB", "\x1b[1;1B", "\x1b[1;1:1B"],
	right: ["\x1b[C", "\x1bOC", "\x1b[1;1C", "\x1b[1;1:1C"],
	left: ["\x1b[D", "\x1bOD", "\x1b[1;1D", "\x1b[1;1:1D"],
	home: ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~", "\x1b[1;1H", "\x1b[1;1:1H", "\x1b[1;1:2~"],
	end: ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~", "\x1b[1;1F", "\x1b[1;1:1F"],
	pageUp: ["\x1b[5~", "\x1b[5;1~", "\x1b[5;1:1~"],
	pageDown: ["\x1b[6~", "\x1b[6;1~", "\x1b[6;1:1~"],
};

describe("plainKey", () => {
	for (const [name, encodings] of Object.entries(TABLE) as Array<[PlainKey, string[]]>) {
		it.each(encodings)(`names ${name} for %j`, (data) => {
			expect(plainKey(data)).toBe(name);
		});
	}

	it.each(["\x1b[27;1:3u", "\x1b[13;1:3u", "\x1b[127;1:3u", "\x1b[1;1:3A", "\x1b[3;1:3~", "\x1b[5;1:3~"])(
		"ignores the key release %j",
		(data) => {
			expect(plainKey(data)).toBeUndefined();
		},
	);

	it.each(["\x1b[27;2u", "\x1b[27;3u", "\x1b[27;5u", "\x1b[1;2A", "\x1b[1;5C", "\x1b[3;5~", "\x1b[127;5u", "\x1b[13;2u", "\x1b[27;2;27~"])(
		"leaves the chord %j (shift, alt or ctrl held) to its own handler",
		(data) => {
			expect(plainKey(data)).toBeUndefined();
		},
	);

	it.each(["a", "k", " ", "é", "日本", "", "\x01", "\x13", "\x1b[200~", "\x1b[15~", "\x1bOP", "\x1b[1;1:1Z", "\x1b[2J", "\x1b]0;x\x07"])(
		"does not name %j",
		(data) => {
			expect(plainKey(data)).toBeUndefined();
		},
	);
});
