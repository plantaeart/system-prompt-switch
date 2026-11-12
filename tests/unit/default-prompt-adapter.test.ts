import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DefaultPromptAdapter } from "../../src/adapters/default-prompt.adapter";
import { PromptScope } from "../../src/core/types/prompt-scope.type";

describe("DefaultPromptAdapter", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "sps-default-"));
		file = path.join(dir, "defaults.json");
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	function adapterFor(cwd: string): DefaultPromptAdapter {
		const a = new DefaultPromptAdapter(file);
		a.setCwd(cwd);
		return a;
	}

	it("keeps never-chosen, chose-None and a prompt distinct, across instances", async () => {
		const a = adapterFor("/proj/a");
		expect(await a.get()).toBeUndefined();

		await a.set([{ name: "x.md", scope: PromptScope.Local }]);
		expect(await adapterFor("/proj/a").get()).toEqual([{ name: "x.md", scope: PromptScope.Local }]);

		await a.set([
			{ name: "x.md", scope: PromptScope.Local },
			{ name: "y.md", scope: PromptScope.GlobalPi },
		]);
		expect(await adapterFor("/proj/a").get()).toEqual([
			{ name: "x.md", scope: PromptScope.Local },
			{ name: "y.md", scope: PromptScope.GlobalPi },
		]);

		await a.set(null);
		expect(await adapterFor("/proj/a").get()).toBeNull();
	});

	it("forgets a default set to undefined, leaving other projects intact", async () => {
		await adapterFor("/proj/a").set({ name: "x.md", scope: PromptScope.Local });
		await adapterFor("/proj/b").set(null);
		await adapterFor("/proj/a").set(undefined);

		expect(await adapterFor("/proj/a").get()).toBeUndefined();
		expect(await adapterFor("/proj/b").get()).toBeNull();
	});

	it("scopes the default per project", async () => {
		await adapterFor("/proj/a").set({ name: "x.md", scope: PromptScope.Local });
		expect(await adapterFor("/proj/b").get()).toBeUndefined();
	});

	it("reads a corrupt file as never-chosen", async () => {
		fs.writeFileSync(file, "{not json");
		expect(await adapterFor("/proj/a").get()).toBeUndefined();
	});
});
