import { describe, expect, it } from "bun:test";
import { PiUIAdapter, type PiUIHost } from "../../src/adapters/pi-ui.adapter";
import { editorComponent } from "../../src/adapters/pi-editor.adapter";
import { settle } from "../helpers/settle";

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

const CTRL_G = ["\x07", "\x1b[103;5u", "\x1b[103;69u", "\x1b[103;5:1u", "\x1b[103:71;5u", "\x1b[27;5;103~"];

describe("PiUIAdapter custom editor undo behavior", () => {
	function openEditor(title: string, prefill?: string) {
		const { host, component } = hostWithComponent();
		const ui = new PiUIAdapter({ editorComponent });
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
		await settle();
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

		const ui = new PiUIAdapter({ editorComponent });
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
		await settle();

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
		await settle();

		expect(comp.render(80).join("\n")).toContain("Updated after wait");
	});

	it("survives an external editor that throws: input comes back and nothing is left unhandled", async () => {
		const unhandled: unknown[] = [];
		const record = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", record);
		try {
			let started = 0;
			const { promise, resolve } = Promise.withResolvers<string | undefined>();
			const comp = editorComponent(
				{
					title: "Throwing editor",
					prefill: "Keep",
					onDone: resolve,
					async externalEditor() {
						throw new Error("ENOSPC: no space left on device");
					},
				},
				{
					requestRender() {},
					start() {
						started++;
					},
				},
				{},
				{},
			);

			comp.handleInput?.("\x07");
			await settle();
			await new Promise<void>((resolve) => setImmediate(resolve)); // unhandled rejections are reported after the microtask queue drains

			expect(unhandled).toEqual([]);
			expect(started).toBe(1);
			comp.handleInput?.("!");
			comp.handleInput?.("\x13");
			expect(await promise).toBe("Keep!");
		} finally {
			process.off("unhandledRejection", record);
		}
	});
});
