import { describe, expect, it } from "bun:test";
import { ompEditorComponent } from "../../src/adapters/omp-editor.adapter";
import type { ListComponent, ListTui } from "../../src/adapters/pi-ui.adapter";
import type { ExternalEditorOptions, ExternalEditorResult } from "../../src/core/external-editor";
import { stripTerminalSequences, visibleWidth } from "../../src/core/text-width";
import { settle } from "../helpers/settle";

const CTRL_S = ["\x13", "\x1b[115;5u", "\x1b[27;5;115~"];
const CTRL_Q = ["\x11", "\x1b[113;5u", "\x1b[27;5;113~"];
const CTRL_G = ["\x07", "\x1b[103;5u", "\x1b[27;5;103~"];
const CTRL_Z = ["\x1a", "\x1f", "\x1b[122;5u"];
// Esc as a plain byte, Kitty keyboard protocol (what Kitty, WezTerm, Ghostty, foot send; caps lock +64, num lock +128), and modifyOtherKeys.
const ESCAPE = ["\x1b", "\x1b[27u", "\x1b[27;1u", "\x1b[27;1:1u", "\x1b[27;1:2u", "\x1b[27;65u", "\x1b[27;129u", "\x1b[27;1;27~"];
const ENTER = ["\r", "\n", "\x1b[13;2u", "\x1b[27;2;13~"];
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const HOME = "\x1b[H";
const END = "\x1b[F";
const DELETE = "\x1b[3~";
const BACKSPACE = "\x7f";
const REVERSE = "\x1b[7m";

interface Harness {
	comp: ListComponent;
	done: Promise<string | undefined>;
	calls: { suspend: number; renderForced: number };
	press(...keys: string[]): void;
	screen(width?: number): string[];
	raw(width?: number): string[];
}

function open(
	prefill: string | undefined,
	extra: { externalEditor?(options: ExternalEditorOptions): Promise<ExternalEditorResult>; height?: number } = {},
): Harness {
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	const calls = { suspend: 0, renderForced: 0 };
	const tui: ListTui = {
		requestRender(force?: boolean) {
			if (force) calls.renderForced++;
		},
		size: () => ({ width: 80, height: extra.height ?? 24 }),
		async suspend(run) {
			calls.suspend++;
			await run();
		},
	};
	const comp = ompEditorComponent(
		{ title: "Edit: alpha.md", prefill, onDone: resolve, externalEditor: extra.externalEditor },
		tui,
		{},
		{},
	);
	return {
		comp,
		done: promise,
		calls,
		press: (...keys) => {
			for (const key of keys) comp.handleInput?.(key);
		},
		screen: (width = 80) => comp.render(width).map(stripTerminalSequences),
		raw: (width = 80) => comp.render(width),
	};
}

const save = async (h: Harness) => {
	h.press("\x13");
	return h.done;
};

describe("omp editor: rendering", () => {
	it("draws the title, the prefilled text and the key hints", () => {
		const text = open("You are ALPHA.").screen().join("\n");

		expect(text).toContain("Edit: alpha.md");
		expect(text).toContain("You are ALPHA.");
		expect(text).toMatch(/Ctrl\+Q.*Save.*Esc.*Cancel.*Ctrl\+Z.*Ctrl\+G/);
	});

	it("starts with the cursor at the end of the text", async () => {
		const h = open("abc");
		h.press("X");
		expect(await save(h)).toBe("abcX");
	});

	it("draws the cursor on the character without shifting the text beside it", () => {
		const h = open("## Output format");
		h.press(HOME, ...Array(13).fill(RIGHT)); // between "for" and "mat"

		const row = h.raw().find((r) => r.includes(REVERSE))!;

		expect(stripTerminalSequences(row)).toContain("## Output format");
		expect(row).toContain(`${REVERSE}m`); // the reversed cell is the character under the cursor
	});

	it("keeps every row within the terminal width, with wide characters and long lines", () => {
		const h = open(`${"word ".repeat(40)}\n日本語日本語日本語日本語`);
		for (const width of [20, 33, 80]) {
			expect(h.raw(width).every((row) => visibleWidth(row) <= width)).toBe(true);
		}
	});

	it("wraps a long line instead of cutting it", () => {
		const text = open(`start ${"lorem ".repeat(30)}ENDMARK`).screen(30).join("\n");
		expect(text).toContain("ENDMARK");
	});

	it("scrolls so the cursor row is always drawn", () => {
		const lines = Array.from({ length: 80 }, (_, i) => `row${String(i).padStart(2, "0")}`);
		const h = open(lines.join("\n"), { height: 14 });

		expect(h.screen().join("\n")).toContain("row79");
		expect(h.screen().join("\n")).not.toContain("row00");
		h.press(...Array(79).fill(UP));
		expect(h.screen().join("\n")).toContain("row00");
		expect(h.screen().join("\n")).not.toContain("row79");
	});
});

describe("omp editor: editing", () => {
	it("inserts in the middle of a word", async () => {
		const h = open("format");
		h.press(HOME, RIGHT, RIGHT, RIGHT, "X");
		expect(await save(h)).toBe("forXmat");
	});

	it.each(ENTER)("Enter sent as %j adds a line and does not submit", async (key) => {
		let finished = false;
		const h = open("First");
		void h.done.then(() => {
			finished = true;
		});

		h.press(key, "Second");
		await settle();

		expect(finished).toBe(false);
		expect(await save(h)).toBe("First\nSecond");
	});

	it("Backspace and Delete remove one character and join lines at the edges", async () => {
		const h = open("ab\ncd");
		h.press(HOME, BACKSPACE); // start of "cd" joins it onto "ab", cursor between b and c
		h.press(RIGHT, DELETE); // after "c", deletes "d"
		expect(await save(h)).toBe("abc");
	});

	it("Left and Right cross line boundaries", async () => {
		const h = open("ab\ncd");
		h.press(HOME, LEFT, "!"); // end of the first line
		expect(await save(h)).toBe("ab!\ncd");
	});

	it("Backspace removes a whole emoji or accented letter, not half of it", async () => {
		const h = open("a😀e\u0301");
		h.press(BACKSPACE, BACKSPACE);
		expect(await save(h)).toBe("a");
	});

	it("Up and Down clamp to shorter lines", async () => {
		const h = open("abcdef\nxy\nghijkl");
		h.press(UP, "1"); // end of the last line is column 6: "xy" clamps to its end
		h.press(DOWN, "2"); // column 3 of "ghijkl"
		expect(await save(h)).toBe("abcdef\nxy1\nghi2jkl");
	});

	it("Up and Down remember the wanted column across a short line", async () => {
		const h = open("abcdef\nxy\nghijkl");
		h.press(UP, UP, DOWN, DOWN, "!");
		expect(await save(h)).toBe("abcdef\nxy\nghijkl!");
	});

	it("Home and End jump to the line edges", async () => {
		const h = open("one\ntwo");
		h.press(HOME, "<", END, ">");
		expect(await save(h)).toBe("one\n<two>");
	});

	it("moves across a wrapped long line row by row", async () => {
		const h = open("abcd ".repeat(10).trim());
		h.screen(20); // the editor wraps at the width it was last drawn with
		h.press(UP, UP, "#");
		const out = (await save(h))!;
		expect(out.replace("#", "")).toBe("abcd ".repeat(10).trim());
		expect(out.indexOf("#")).toBeLessThan(out.length - 15);
	});

	it("inserts pasted text as typed, normalising line endings", async () => {
		const h = open("");
		h.press("\x1b[200~line one\r\nline two\rline three\x1b[201~");
		expect(await save(h)).toBe("line one\nline two\nline three");
	});

	it("drops escape sequences and control characters from pasted text", async () => {
		const h = open("");
		h.press("\x1b[200~safe\x1b[2Jtext\x07\x08 ok\x1b[201~");
		const out = (await save(h))!;
		expect(out).not.toContain("\x1b");
		// eslint-disable-next-line no-control-regex
		expect(out).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
		expect(out).toContain("safe");
		expect(out).toContain("ok");
	});

	it("ignores keys it does not know instead of typing them", async () => {
		const h = open("abc");
		h.press("\x1b[1;5C", "\x1b[15~", "\x1bOP");
		expect(await save(h)).toBe("abc");
	});

	it("Esc drops a paste whose end marker never arrived, and typing works again", async () => {
		const h = open("");
		h.press("\x1b[200~half a paste", "\x1b");
		h.press("ok");
		expect(await save(h)).toBe("ok");
	});
});

describe("omp editor: save, cancel and undo", () => {
	it.each([...CTRL_S, ...CTRL_Q])("saves on %j", async (key) => {
		const h = open("Some content");
		h.press(key);
		expect(await h.done).toBe("Some content");
	});

	it.each(ESCAPE)("cancels on Esc sent as %j", async (key) => {
		const h = open("Some content");
		h.press(key);
		expect(await h.done).toBeUndefined();
	});

	it.each(CTRL_Z)("undo sent as %j reverts typing step by step", async (key) => {
		const h = open("base");
		h.press(" ", "x", "y"); // typing a word is one undo unit
		h.press(key);
		expect(h.screen().join("\n")).not.toContain("xy");
		expect(await save(h)).toBe("base ");
	});

	it("repeated undo never goes past the prefilled text", async () => {
		const h = open("# Initial prompt\nLine 2");
		h.press("x", " ", "y");
		for (let i = 0; i < 20; i++) h.press("\x1a");

		expect(h.screen().join("\n")).toContain("Initial prompt");
		expect(await save(h)).toBe("# Initial prompt\nLine 2");
	});

	it("undo restores a joined line", async () => {
		const h = open("ab\ncd");
		h.press(HOME, BACKSPACE);
		h.press("\x1a");
		expect(await save(h)).toBe("ab\ncd");
	});
});

describe("omp editor: external editor (Ctrl+G)", () => {
	it.each(CTRL_G)("Ctrl+G sent as %j hands the text over and takes the edited text back", async (key) => {
		let received = "";
		const h = open("Old content", {
			async externalEditor(opts) {
				received = opts.content;
				return { status: "complete", content: "New content" };
			},
		});

		h.press(key);
		await settle();

		expect(received).toBe("Old content");
		expect(h.calls.suspend).toBe(1);
		expect(h.calls.renderForced).toBeGreaterThan(0);
		expect(h.screen().join("\n")).toContain("New content");
		h.press(...Array(5).fill("\x1a")); // the swapped-in text is the new floor
		expect(await save(h)).toBe("New content");
	});

	it("ignores keys while the external editor is open", async () => {
		const gate = Promise.withResolvers<void>();
		let launches = 0;
		const h = open("Original", {
			async externalEditor() {
				launches++;
				await gate.promise;
				return { status: "complete", content: "Updated" };
			},
		});

		h.press("\x07");
		h.press("\x07", "x", "\x13");
		gate.resolve();
		await settle();

		expect(launches).toBe(1);
		expect(await save(h)).toBe("Updated");
	});

	it("keeps the text and shows the reason when the editor fails", async () => {
		const h = open("Keep me", {
			async externalEditor() {
				return { status: "failed", message: "Failed to launch external editor: nano" };
			},
		});

		h.press("\x07");
		await settle();

		expect(h.screen().join("\n")).toContain("Failed to launch external editor: nano");
		expect(await save(h)).toBe("Keep me");
	});

	it("shows the reason instead of crashing when the external editor throws", async () => {
		const unhandled: unknown[] = [];
		const record = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", record);
		try {
			const h = open("Keep me", {
				async externalEditor() {
					throw new Error("ENOSPC: no space left on device");
				},
			});

			h.press("\x07");
			await settle();
			await new Promise<void>((resolve) => setImmediate(resolve)); // unhandled rejections are reported after the microtask queue drains

			expect(unhandled).toEqual([]);
			expect(h.screen().join("\n")).toContain("ENOSPC");
			h.press("!"); // the editor is usable again
			expect(await save(h)).toBe("Keep me!");
		} finally {
			process.off("unhandledRejection", record);
		}
	});
});

/**
 * The same key reaches the editor in different encodings depending on the terminal and on what OMP asked it for:
 * legacy bytes, xterm application mode, the Kitty keyboard protocol (modifier field `;1`, event type `:1` press / `:2`
 * repeat / `:3` release) and modifyOtherKeys. Every encoding of a key must do the key's job, and a key release must do nothing.
 */
describe("omp editor: key encodings", () => {
	const cases: Array<{ name: string; keys: string[]; start: string; press: string[]; expected: string }> = [
		{ name: "Backspace", keys: ["\x7f", "\b", "\x1b[127u", "\x1b[127;1u", "\x1b[127;1:1u", "\x1b[127;1:2u"], start: "abc", press: [], expected: "ab" },
		{ name: "Delete", keys: ["\x1b[3~", "\x1b[3;1~", "\x1b[3;1:1~", "\x1b[3;1:2~"], start: "abc", press: ["\x1b[H"], expected: "bc" },
		{ name: "Enter", keys: ["\r", "\n", "\x1b[13u", "\x1b[13;1u", "\x1b[13;1:1u", "\x1b[13;2u", "\x1b[27;2;13~"], start: "ab", press: [], expected: "ab\n" },
		{ name: "Left", keys: ["\x1b[D", "\x1bOD", "\x1b[1;1D", "\x1b[1;1:1D", "\x1b[1;1:2D"], start: "ab", press: [], expected: "a!b" },
		{ name: "Right", keys: ["\x1b[C", "\x1bOC", "\x1b[1;1C", "\x1b[1;1:1C"], start: "ab", press: ["\x1b[H"], expected: "a!b" },
		{ name: "Up", keys: ["\x1b[A", "\x1bOA", "\x1b[1;1A", "\x1b[1;1:1A"], start: "ab\ncd", press: [], expected: "ab!\ncd" },
		{ name: "Down", keys: ["\x1b[B", "\x1bOB", "\x1b[1;1B", "\x1b[1;1:1B"], start: "ab\ncd", press: ["\x1b[A"], expected: "ab\ncd!" },
		{ name: "Home", keys: ["\x1b[H", "\x1b[1~", "\x1b[7~", "\x1bOH", "\x1b[1;1H", "\x1b[1;1:1H", "\x01"], start: "abc", press: [], expected: "!abc" },
		{ name: "End", keys: ["\x1b[F", "\x1b[4~", "\x1b[8~", "\x1bOF", "\x1b[1;1F", "\x1b[1;1:1F", "\x05"], start: "abc", press: ["\x1b[H"], expected: "abc!" },
	];

	for (const { name, keys, start, press, expected } of cases) {
		it.each(keys)(`${name} sent as %j`, async (key) => {
			const h = open(start);
			h.press(...press, key);
			// Backspace/Delete/Enter change the text by themselves; the movement keys are proven by typing a marker after them.
			const edits = name === "Backspace" || name === "Delete" || name === "Enter";
			if (!edits) h.press("!");
			expect(await save(h)).toBe(expected);
		});
	}

	it.each(["\x1b[27;1:3u", "\x1b[13;1:3u", "\x1b[127;1:3u", "\x1b[1;1:3A", "\x1b[1;1:3D", "\x1b[3;1:3~", "\x1b[113;5:3u", "\x1b[122;5:3u", "\x1b[103;5:3u"])(
		"does nothing on the key release %j",
		async (key) => {
			let launched = false;
			let finished = false;
			const h = open("ab\ncd", {
				async externalEditor() {
					launched = true;
					return { status: "failed", message: "" };
				},
			});
			void h.done.then(() => {
				finished = true;
			});

			h.press(key);
			await settle();

			expect(finished).toBe(false); // a release of Esc or Ctrl+Q must not close the editor
			expect(launched).toBe(false);
			expect(await save(h)).toBe("ab\ncd");
		},
	);

	it("types text that arrives as one multi-character chunk, such as a fast IME or xdotool burst", async () => {
		const h = open("");
		h.press("héllo wörld 日本");
		expect(await save(h)).toBe("héllo wörld 日本");
	});
});
