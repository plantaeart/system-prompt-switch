import { describe, expect, it } from "bun:test";
import { FixturePrompt } from "../fixtures/fixture-prompt.enum";
import {
	buildSystemPrompt,
	escapeXml,
	formatSkillsBlock,
} from "../../src/core/prompt-builder";

describe("prompt-builder", () => {
	it("returns basePrompt when customPrompt is null or whitespace", () => {
		const base = "You are an agent.";
		expect(
			buildSystemPrompt({
				basePrompt: base,
				customPrompt: null,
				mode: "append",
			}),
		).toBe(base);

		expect(
			buildSystemPrompt({
				basePrompt: base,
				customPrompt: "   \n\t  ",
				mode: "replace",
			}),
		).toBe(base);
	});

	it("appends custom prompt in append mode", () => {
		const base = "You are an agent.";
		const custom = "Be brief.";
		const result = buildSystemPrompt({
			basePrompt: base,
			customPrompt: custom,
			mode: "append",
		});

		expect(result).toBe(`${base}\n\n---\n\n## Custom system prompt\n\n${custom}`);
	});

	it("replaces system prompt with tools, skills, and context in replace mode", () => {
		const custom = "Custom pirate persona.";
		const now = new Date(2026, 8, 25); // 2026-09-25
		const result = buildSystemPrompt({
			basePrompt: "ignored base",
			customPrompt: custom,
			mode: "replace",
			tools: {
				read: "Read a file",
				bash: "Execute command",
			},
			appendSystemPrompt: "Extra system instructions.",
			contextFiles: [
				{ path: FixturePrompt.AgentsFile, content: "Always follow agent rules." },
			],
			skills: [
				{
					name: "skill-one",
					description: "First & best skill <test>",
					filePath: "/path/to/SKILL.md",
					disableModelInvocation: false,
				},
				{
					name: "skill-hidden",
					description: "Hidden skill",
					filePath: "/path/to/HIDDEN.md",
					disableModelInvocation: true,
				},
			],
			cwd: "/workspace/project",
			now,
		});

		expect(result).toContain(custom);
		expect(result).toContain("## Available tools");
		expect(result).toContain("- read: Read a file");
		expect(result).toContain("- bash: Execute command");
		expect(result).toContain("Extra system instructions.");
		expect(result).toContain(`<project_instructions path="${FixturePrompt.AgentsFile}">`);
		expect(result).toContain("Always follow agent rules.");
		expect(result).toContain("<available_skills>");
		expect(result).toContain("<name>skill-one</name>");
		expect(result).toContain("<description>First &amp; best skill &lt;test&gt;</description>");
		// Hidden skill should not appear
		expect(result).not.toContain("skill-hidden");
		expect(result).toContain("Current date: 2026-09-25");
		expect(result).toContain("Current working directory: /workspace/project");
	});

	it("escapes XML characters correctly", () => {
		expect(escapeXml('a & b < c > d " e \' f')).toBe(
			"a &amp; b &lt; c &gt; d &quot; e &apos; f",
		);
	});

	it("returns empty string when skills array is empty or all hidden", () => {
		expect(formatSkillsBlock([])).toBe("");
		expect(
			formatSkillsBlock([
				{
					name: "h",
					description: "d",
					filePath: "p",
					disableModelInvocation: true,
				},
			]),
		).toBe("");
	});
});
