import { describe, expect, it } from "bun:test";
import {
	editorComponent,
	editInExternalEditor,
	PiUIAdapter,
	type PiUIHost,
} from "../../src/adapters/pi-ui.adapter";

type Component = { handleInput?(data: string): void; render(width: number): string[] };

/** Host whose ui.custom hands the component back so a test can type into it. */
function hostWithComponent(): {
	host: PiUIHost;
	component: () => Component;
	tuiCalls: { stop: number; start: number; requestRender: number };
} {
	let component: Component | undefined;
	const tuiCalls = { stop: 0, start: 0, requestRender: 0 };
	const host = {
		hasUI: true,
		ui: {
			custom: <T>(
				factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => Component,
			) => {
				const { promise, resolve } = Promise.withResolvers<T>();
				component = factory(
					{
						requestRender() {
							tuiCalls.requestRender++;
						},
						stop() {
							tuiCalls.stop++;
						},
						start() {
							tuiCalls.start++;
						},
					},
					{},
					{},
					resolve,
				);
				return promise;
			},
		},
	} as unknown as PiUIHost;
	return { host, component: () => component!, tuiCalls };
}

// Encodings by terminal family: legacy control byte (xterm, GNOME, Windows Terminal, tmux, ...),
// Kitty keyboard protocol CSI-u (Kitty, WezTerm, Ghostty, foot, ...; caps lock adds 64), and
// xterm modifyOtherKeys CSI 27 ; mods ; code ~.
const CTRL_S = ["\x13", "\x1b[115;5u", "\x1b[115;69u", "\x1b[115;5:1u", "\x1b[115:83;5u", "\x1b[27;5;115~"];
const CTRL_N = ["\x0e", "\x1b[110;5u", "\x1b[110;69u", "\x1b[110;5:1u", "\x1b[110:78;5u", "\x1b[27;5;110~"];
const CTRL_G = ["\x07", "\x1b[103;5u", "\x1b[103;69u", "\x1b[103;5:1u", "\x1b[103:71;5u", "\x1b[27;5;103~"];

describe("PiUIAdapter keyboard input", () => {
	it.each(CTRL_S)("multiSelect saves on Ctrl+S sent as %j", async (keys) => {
		const { host, component } = hostWithComponent();
		const ui = new PiUIAdapter();
		ui.setHost(host);
		const items = [{ id: "[local] a.md", label: "[local] a.md", selected: true }];

		const result = ui.multiSelect("t", items);
		component().handleInput?.(keys);

		expect(await result).toEqual({ selectedIds: ["[local] a.md"] });
	});

	it.each(CTRL_N)("selectPromptToEdit renames on Ctrl+N sent as %j", async (keys) => {
		const { host, component } = hostWithComponent();
		const ui = new PiUIAdapter();
		ui.setHost(host);

		const result = ui.selectPromptToEdit("t", ["[local] a.md", "[local] b.md"], 1);
		component().handleInput?.(keys);

		expect(await result).toEqual({ action: "rename", choice: "[local] b.md" });
	});

	it("multiSelect ignores Ctrl+Shift+S", async () => {
		const { host, component } = hostWithComponent();
		const ui = new PiUIAdapter();
		ui.setHost(host);

		const result = ui.multiSelect("t", [{ id: "x", label: "x", selected: false }]);
		component().handleInput?.("\x1b[115;6u"); // not a save
		component().handleInput?.("\x13");

		expect(await result).toEqual({ selectedIds: [] });
	});
});

describe("PiUIAdapter list rendering and navigation", () => {
	const items = [
		{ id: "[local] a.md", label: "[local] a.md", selected: false },
		{ id: "[local] b.md", label: "[local] b.md", selected: false },
	];
	function open() {
		const { host, component } = hostWithComponent();
		const ui = new PiUIAdapter();
		ui.setHost(host);
		return { ui, component };
	}

	it("draws title, cursor row and key hint, cut to the terminal width", async () => {
		const { ui, component } = open();
		void ui.multiSelect("Pick prompts", items);

		const lines = component().render(80);

		expect(lines[0]).toBe("Pick prompts");
		expect(lines).toContain("> [ ] [local] a.md");
		expect(lines).toContain("  [ ] [local] b.md");
		expect(lines.at(-1)).toContain("Ctrl+S");
		// Visible width: truncation appends a colour reset that takes no columns.
		// eslint-disable-next-line no-control-regex
		expect(component().render(30).every((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length <= 30)).toBe(true);
	});

	it("moves the cursor with the arrow keys and wraps around", async () => {
		const { ui, component } = open();
		void ui.multiSelect("t", items);

		component().handleInput?.("\x1b[B");
		expect(component().render(80)).toContain("> [ ] [local] b.md");

		component().handleInput?.("\x1b[B");
		expect(component().render(80)).toContain("> [ ] [local] a.md");

		component().handleInput?.("\x1b[A");
		expect(component().render(80)).toContain("> [ ] [local] b.md");
	});

	it("Space ticks a row without closing the list; Ctrl+S then returns the ticked rows", async () => {
		const { ui, component } = open();
		const result = ui.multiSelect("t", items);

		component().handleInput?.(" ");
		expect(component().render(80)).toContain("> [✓] [local] a.md");
		component().handleInput?.("\x13");

		expect(await result).toEqual({ selectedIds: ["[local] a.md"] });
	});

	it("Escape closes the list as cancelled", async () => {
		const { ui, component } = open();
		const result = ui.multiSelect("t", items);

		component().handleInput?.("\x1b");

		expect(await result).toEqual({ cancelled: true, selectedIds: [] });
	});

	it("Enter on a row of the edit picker edits it, starting on the preselected row", async () => {
		const { ui, component } = open();
		const result = ui.selectPromptToEdit("t", ["[local] a.md", "[local] b.md"], 1);

		component().handleInput?.("\r");

		expect(await result).toEqual({ action: "edit", choice: "[local] b.md" });
	});

	it("scrolls long lists and marks hidden rows", async () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, label: `p${i}`, selected: false }));
		const { ui, component } = open();
		void ui.multiSelect("t", many);

		expect(component().render(80).join("\n")).toContain("▼ ...");
		for (let i = 0; i < 20; i++) component().handleInput?.("\x1b[B");
		const view = component().render(80).join("\n");
		expect(view).toContain("▲ ...");
		expect(view).toContain("> [ ] p20");
	});

	it("presses Tab to preview a prompt, scrolls with arrows, and returns to list on Tab or Esc without losing state", async () => {
		const promptItems = [
			{
				id: "[local] a.md",
				label: "[local] a.md",
				selected: true,
				content: Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of prompt a`).join("\n"),
			},
			{
				id: "[local] b.md",
				label: "[local] b.md",
				selected: false,
				content: "Simple content of b",
			},
		];
		const { ui, component } = open();
		const result = ui.multiSelect("Select Prompts", promptItems);

		// Initially in list mode
		expect(component().render(80)).toContain("> [✓] [local] a.md");
		expect(component().render(80).at(-1)).toContain("Tab: Preview");

		// Press Tab on item 0 (a.md) -> enters preview mode
		component().handleInput?.("\t");
		let previewLines = component().render(80);
		expect(previewLines[0]).toContain("Preview: [local] a.md");
		expect(previewLines).toContain("  Line 1 of prompt a");
		expect(previewLines.at(-1)).toContain("Tab/Esc: Back to list");
		expect(previewLines.join("\n")).toContain("▼ ...");

		// Scroll down in preview mode
		component().handleInput?.("\x1b[B");
		previewLines = component().render(80);
		expect(previewLines.join("\n")).toContain("▲ ...");

		// Press Tab to exit preview mode -> back to list mode with cursor and selection intact
		component().handleInput?.("\t");
		let listLines = component().render(80);
		expect(listLines).toContain("> [✓] [local] a.md");
		expect(listLines).toContain("  [ ] [local] b.md");

		// Move to b.md and press Tab
		component().handleInput?.("\x1b[B");
		expect(component().render(80)).toContain("> [ ] [local] b.md");
		component().handleInput?.("\t");
		expect(component().render(80)[0]).toContain("Preview: [local] b.md");
		expect(component().render(80)).toContain("  Simple content of b");

		// Press Esc to exit preview mode -> back to list mode (does NOT cancel the dialog)
		component().handleInput?.("\x1b");
		listLines = component().render(80);
		expect(listLines).toContain("> [ ] [local] b.md");

		// Save selection with Ctrl+S
		component().handleInput?.("\x13");
		expect(await result).toEqual({ selectedIds: ["[local] a.md"] });
	});

	it("loads content dynamically via loadContent when Tab is pressed", async () => {
		let loaded = false;
		const dynamicItems = [
			{
				id: "[local] dynamic.md",
				label: "[local] dynamic.md",
				selected: false,
				loadContent: async () => {
					loaded = true;
					return "Fetched dynamic content";
				},
			},
		];
		const { ui, component } = open();
		void ui.multiSelect("t", dynamicItems);

		// Press Tab
		component().handleInput?.("\t");
		expect(loaded).toBe(true);

		// Allow promise to resolve
		await new Promise((r) => setTimeout(r, 10));

		const previewLines = component().render(80);
		expect(previewLines[0]).toContain("Preview: [local] dynamic.md");
		expect(previewLines).toContain("  Fetched dynamic content");
	});

	describe("preview of long content", () => {
		const visible = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex
		const openPreview = (content: string) => {
			const { ui, component } = open();
			void ui.multiSelect("t", [{ id: "x", label: "[local] x.md", selected: false, content }]);
			component().handleInput?.("\t");
			return component;
		};
		const words = (n: number) => Array.from({ length: n }, (_, i) => `w${String(i).padStart(3, "0")}`).join(" ");

		it("wraps a line wider than the terminal instead of cutting it", () => {
			const component = openPreview("start lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ENDMARK");

			const lines = component().render(30);

			expect(lines.join("\n")).toContain("ENDMARK");
			expect(lines.every((l) => visible(l).length <= 30)).toBe(true);
		});

		it("scrolls through every wrapped line, not only the raw lines", () => {
			const component = openPreview(words(160)); // one raw line, about 30 lines at width 30

			expect(component().render(30).join("\n")).not.toContain("w159");
			for (let i = 0; i < 60; i++) component().handleInput?.("\x1b[B");

			const view = component().render(30).join("\n");
			expect(view).toContain("w159");
			expect(view).toContain("▲ ...");
			expect(view).not.toContain("▼ ...");
		});

		it("PageDown and PageUp move by a page of wrapped lines", () => {
			const component = openPreview(words(160));
			component().render(30); // the host draws after every key; scrolling limits come from that draw

			component().handleInput?.("\x1b[6~");
			const afterPageDown = component().render(30).join("\n");
			expect(afterPageDown).not.toContain("w000");
			expect(afterPageDown).toContain("▲ ...");

			component().handleInput?.("\x1b[5~");
			expect(component().render(30).join("\n")).toContain("w000");
		});

		it("wraps again when the terminal width changes", () => {
			const component = openPreview(`${words(20)} ENDMARK`);

			const wide = component().render(120);
			const narrow = component().render(30);

			expect(wide.join("\n")).toContain("ENDMARK");
			expect(narrow.join("\n")).toContain("ENDMARK");
			expect(narrow.length).toBeGreaterThan(wide.length);
		});

		it("never draws terminal escape sequences found in a prompt file", () => {
			const component = openPreview("safe\x1b[2Jtext \x1b]0;hacked\x07 end");

			const text = component().render(80).join("\n");

			expect(text).not.toContain("\x1b[2J");
			expect(text).not.toContain("hacked\x07");
			expect(text).toContain("safe");
			expect(text).toContain("end");
		});

		it("never draws control characters that move the cursor or overwrite text", () => {
			const component = openPreview("abc\b\bXY\fform\vvert\0nul\x07bell\ttab\nnext");

			const text = component().render(80).join("\n");

			// eslint-disable-next-line no-control-regex
			expect(text).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/);
			expect(text).toContain("abcXY");
			expect(text).toContain("next");
		});

		it("PageDown scrolls by exactly the number of lines that are drawn", () => {
			const component = openPreview(Array.from({ length: 100 }, (_, i) => `row${String(i).padStart(3, "0")}`).join("\n"));
			const drawn = (): string[] => component().render(80).filter((l) => /^ {2}row\d{3}$/.test(l));
			const first = drawn();

			component().handleInput?.("\x1b[6~");
			const second = drawn();

			// The second page starts right after the first one: no row skipped, none repeated.
			expect(second[0]).toBe(`  row${String(first.length).padStart(3, "0")}`);
		});
	});
});

describe("PiUIAdapter custom editor undo behavior", () => {
	function openEditor(title: string, prefill?: string) {
		const { host, component } = hostWithComponent();
		const ui = new PiUIAdapter();
		ui.setHost(host);
		const promise = ui.editor(title, prefill);
		return { ui, component, promise };
	}

	it("clears undo stack on prefill so repeated Ctrl+Z never clears initial content to empty", async () => {
		const initialContent = "# Initial prompt content\nLine 2";
		const { component, promise } = openEditor("Edit prompt", initialContent);

		// Verify initial render contains title and content
		const lines = component().render(80);
		expect(lines[0]).toContain("Edit prompt");
		expect(lines.join("\n")).toContain("Initial prompt content");

		// Type something extra with a whitespace to form an undo unit
		component().handleInput?.("x");
		component().handleInput?.(" ");
		component().handleInput?.("y");
		expect(component().render(80).join("\n")).toContain("x y");

		// Undo: reverts the extra typing step by step
		component().handleInput?.("\x1a"); // Ctrl+Z
		component().handleInput?.("\x1a"); // Ctrl+Z
		const restoredText = component().render(80).join("\n");
		expect(restoredText).toContain("Initial prompt content");
		expect(restoredText).toContain("Line 2");
		expect(restoredText).not.toContain("x y");

		// Repeated Ctrl+Z (10 times) must NOT clear the prefilled content to blank!
		for (let i = 0; i < 10; i++) {
			component().handleInput?.("\x1a");
		}
		const textAfterManyUndos = component().render(80).join("\n");
		expect(textAfterManyUndos).toContain("Initial prompt content");
		expect(textAfterManyUndos).toContain("Line 2");

		// Save with Ctrl+Q
		component().handleInput?.("\x11");
		expect(await promise).toBe(initialContent);
	});

	it("cancels editor with Esc returning undefined", async () => {
		const { component, promise } = openEditor("Edit prompt", "Some content");
		component().handleInput?.("\x1b");
		expect(await promise).toBeUndefined();
	});

	it("saves editor with Ctrl+S", async () => {
		const { component, promise } = openEditor("Edit prompt", "Some content");
		component().handleInput?.("\x13"); // Ctrl+S
		expect(await promise).toBe("Some content");
	});

	it("inserts newline on Enter instead of submitting or exiting", async () => {
		let isDone = false;
		const { component, promise } = openEditor("Edit prompt", "FirstLine");
		void promise.then(() => {
			isDone = true;
		});

		// Press Enter (\r)
		component().handleInput?.("\r");

		// Await microtasks to confirm promise has not resolved
		await new Promise((r) => setTimeout(r, 10));
		expect(isDone).toBe(false);

		// Type second line
		component().handleInput?.("SecondLine");

		// Now save with Ctrl+S
		component().handleInput?.("\x13");
		const result = await promise;
		expect(result).toBe("FirstLine\nSecondLine");
	});

	it("falls back to host.ui.editor when host.ui.custom is not available", async () => {
		let fallbackCalled = false;
		const fallbackHost = {
			hasUI: true,
			ui: {
				editor: async (title: string, prefill?: string) => {
					fallbackCalled = true;
					return `${title}:${prefill}`;
				},
			},
		} as unknown as PiUIHost;

		const ui = new PiUIAdapter();
		ui.setHost(fallbackHost);

		const result = await ui.editor("Fallback title", "Fallback prefill");
		expect(fallbackCalled).toBe(true);
		expect(result).toBe("Fallback title:Fallback prefill");
	});

	it("renders bottom shortcut line containing Ctrl+G: External Editor", () => {
		const { component } = openEditor("Edit prompt", "Initial text");
		const text = component().render(80).join("\n");
		expect(text).toContain("Ctrl+Q / Ctrl+S: Save · Esc: Cancel · Ctrl+Z: Undo · Ctrl+G: External Editor");
	});

	it.each(CTRL_G)("launches external editor on Ctrl+G sent as %j and updates content", async (keys) => {
		let externalEditorCallCount = 0;
		let receivedContent = "";
		const tuiCalls = {
			stop: 0,
			start: 0,
			requestRender: 0,
			requestRenderArgs: [] as (boolean | undefined)[],
		};

		let comp: { handleInput?(data: string): void; render(width: number): string[] } | undefined;
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		comp = editorComponent(
			{
				title: "External editor test",
				prefill: "Old content",
				onDone: resolve,
				async externalEditor(opts) {
					externalEditorCallCount++;
					receivedContent = opts.content;
					return { status: "complete", content: "New content from notepad" };
				},
			},
			{
				requestRender(force?: boolean) {
					tuiCalls.requestRender++;
					tuiCalls.requestRenderArgs.push(force);
				},
				stop() {
					tuiCalls.stop++;
				},
				start() {
					tuiCalls.start++;
				},
			},
			{},
			{},
		);

		// Trigger external editor with Ctrl+G
		comp.handleInput?.(keys);

		// Await pending async microtasks
		await new Promise((r) => setTimeout(r, 10));

		expect(externalEditorCallCount).toBe(1);
		expect(receivedContent).toBe("Old content");
		expect(tuiCalls.stop).toBe(1);
		expect(tuiCalls.start).toBe(1);
		expect(tuiCalls.requestRenderArgs).toContain(true);

		// Render should show updated content
		const rendered = comp.render(80).join("\n");
		expect(rendered).toContain("New content from notepad");

		// Repeated Ctrl+Z must not clear the new content
		for (let i = 0; i < 5; i++) {
			comp.handleInput?.("\x1a");
		}
		expect(comp.render(80).join("\n")).toContain("New content from notepad");

		// Save with Ctrl+S
		comp.handleInput?.("\x13");
		expect(await promise).toBe("New content from notepad");
	});

	it("ignores concurrent key input while external editor is active", async () => {
		let externalEditorCalls = 0;
		const { promise: editorPromise, resolve: resolveEditor } = Promise.withResolvers<void>();

		const comp = editorComponent(
			{
				title: "Concurrency test",
				prefill: "Original",
				onDone() {},
				async externalEditor() {
					externalEditorCalls++;
					await editorPromise;
					return { status: "complete", content: "Updated after wait" };
				},
			},
			{ requestRender() {} },
			{},
			{},
		);

		// Start external editor
		comp.handleInput?.("\x07"); // Ctrl+G
		expect(externalEditorCalls).toBe(1);

		// Press Ctrl+G again while waiting — should be ignored
		comp.handleInput?.("\x07");
		// Type characters while waiting — should be ignored
		comp.handleInput?.("x");
		expect(externalEditorCalls).toBe(1);

		// Complete external editor
		resolveEditor();
		await new Promise((r) => setTimeout(r, 10));

		expect(comp.render(80).join("\n")).toContain("Updated after wait");
	});

	it("editInExternalEditor handles file update, strips BOM and normalizes CRLF", async () => {
		const result = await editInExternalEditor({
			content: "Initial text",
			command: 'bun -e "const fs=require(\'fs\');fs.writeFileSync(process.argv[1],\'\\uFEFFupdated text\\r\\nsecond line\');"',
		});

		expect(result.status).toBe("complete");
		expect(result.content).toBe("updated text\nsecond line");
	});

	it("editInExternalEditor returns failure when command exits non-zero", async () => {
		const result = await editInExternalEditor({
			content: "Initial text",
			command: 'bun -e "process.exit(1)"',
		});

		expect(result.status).toBe("failed");
	});

	it("editInExternalEditor returns failure when command does not exist", async () => {
		const result = await editInExternalEditor({
			content: "Initial text",
			command: "non_existent_editor_command_xyz123",
		});

		expect(result.status).toBe("failed");
	});
});
