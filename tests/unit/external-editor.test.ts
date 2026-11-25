import { describe, expect, it } from "bun:test";
import { editInExternalEditor, splitCommand } from "../../src/core/external-editor";

describe("editInExternalEditor", () => {
	it("handles file update, strips BOM and normalizes CRLF", async () => {
		const result = await editInExternalEditor({
			content: "Initial text",
			command: 'bun -e "const fs=require(\'fs\');fs.writeFileSync(process.argv[1],\'\\uFEFFupdated text\\r\\nsecond line\');"',
		});

		expect(result.status).toBe("complete");
		expect(result.content).toBe("updated text\nsecond line");
	});

	it("returns failure when command exits non-zero", async () => {
		const result = await editInExternalEditor({
			content: "Initial text",
			command: 'bun -e "process.exit(1)"',
		});

		expect(result.status).toBe("failed");
	});

	it("returns failure when command does not exist", async () => {
		const result = await editInExternalEditor({
			content: "Initial text",
			command: "non_existent_editor_command_xyz123",
		});

		expect(result.status).toBe("failed");
	});
});

describe("splitCommand", () => {
	it("parses single command without arguments", () => {
		expect(splitCommand("nano")).toEqual(["nano"]);
	});

	it("splits space-delimited command and arguments", () => {
		expect(splitCommand("code --wait")).toEqual(["code", "--wait"]);
	});

	it("collapses multiple spaces, tabs, and trims surrounding whitespace", () => {
		expect(splitCommand("  code \t  --wait   ")).toEqual(["code", "--wait"]);
	});

	it("preserves spaces inside double quotes and strips the quotes", () => {
		expect(splitCommand('bun -e "console.log(1 2 3)"')).toEqual([
			"bun",
			"-e",
			"console.log(1 2 3)",
		]);
	});

	it("preserves spaces inside single quotes and strips the quotes", () => {
		expect(splitCommand("bun -e 'process.exit(1)'")).toEqual([
			"bun",
			"-e",
			"process.exit(1)",
		]);
	});

	it("handles nested quotes properly", () => {
		expect(splitCommand('bun -e "const a = \'hello world\';"')).toEqual([
			"bun",
			"-e",
			"const a = 'hello world';",
		]);
		expect(splitCommand("bun -e 'const a = \"hello world\";'")).toEqual([
			"bun",
			"-e",
			'const a = "hello world";',
		]);
	});

	it("handles escaped quotes inside quotes", () => {
		expect(splitCommand('echo "hello \\"world\\""')).toEqual([
			"echo",
			'hello "world"',
		]);
	});

	it("preserves Windows style paths with spaces and backslashes inside quotes", () => {
		expect(
			splitCommand('"C:\\Program Files\\Notepad++\\notepad++.exe" -multiInst'),
		).toEqual(["C:\\Program Files\\Notepad++\\notepad++.exe", "-multiInst"]);
	});

	it("returns empty array for empty or whitespace-only strings", () => {
		expect(splitCommand("")).toEqual([]);
		expect(splitCommand("   \t  ")).toEqual([]);
	});

	it("preserves empty quoted tokens", () => {
		expect(splitCommand('code ""')).toEqual(["code", ""]);
	});
});
