import { describe, expect, it } from "bun:test";
import { PiUIAdapter, type PiUIHost } from "../../src/adapters/pi-ui.adapter";

type Component = { handleInput?(data: string): void; render(width: number): string[] };

/** Host whose ui.custom hands the component back so a test can type into it. */
function hostWithComponent(): { host: PiUIHost; component: () => Component } {
	let component: Component | undefined;
	const host = {
		hasUI: true,
		ui: {
			custom: <T>(
				factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => Component,
			) => {
				const { promise, resolve } = Promise.withResolvers<T>();
				component = factory({ requestRender() {} }, {}, {}, resolve);
				return promise;
			},
		},
	} as unknown as PiUIHost;
	return { host, component: () => component! };
}

// Encodings by terminal family: legacy control byte (xterm, GNOME, Windows Terminal, tmux, ...),
// Kitty keyboard protocol CSI-u (Kitty, WezTerm, Ghostty, foot, ...; caps lock adds 64), and
// xterm modifyOtherKeys CSI 27 ; mods ; code ~.
const CTRL_S = ["\x13", "\x1b[115;5u", "\x1b[115;69u", "\x1b[115;5:1u", "\x1b[115:83;5u", "\x1b[27;5;115~"];
const CTRL_N = ["\x0e", "\x1b[110;5u", "\x1b[110;69u", "\x1b[110;5:1u", "\x1b[110:78;5u", "\x1b[27;5;110~"];

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
});
