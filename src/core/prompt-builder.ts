import { formatScope } from "./prompt-scope-label";
import { PromptScope } from "./types/prompt-scope.type";
import type { BuildPromptInput } from "./types/build-prompt-input.type";
import type { SkillItem } from "./types/skill-item.type";

export function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function formatSkillsBlock(skills: SkillItem[]): string {
	const visible = skills.filter((s) => !s.disableModelInvocation);
	if (visible.length === 0) return "";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of visible) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

export function buildSystemPrompt(input: BuildPromptInput): string {
	const chunks: string[] = [];

	if (input.customPrompts && input.customPrompts.length > 0) {
		for (const chunk of input.customPrompts) {
			const trimmed = chunk.content.trim();
			if (trimmed.length > 0) {
				const header = chunk.name
					? `### [${formatScope(chunk.scope ?? PromptScope.GlobalOmp)}] ${chunk.name}\n\n`
					: "";
				chunks.push(`${header}${trimmed}`);
			}
		}
	} else if (input.customPrompt && input.customPrompt.trim().length > 0) {
		chunks.push(input.customPrompt.trim());
	}

	if (chunks.length === 0) {
		return input.basePrompt;
	}

	const assembledCustom = chunks.join("\n\n---\n\n");

	if (input.mode === "append") {
		return `${input.basePrompt}\n\n---\n\n## Custom system prompt\n\n${assembledCustom}`;
	}

	// replace mode
	const tools = input.tools ?? {};
	const toolEntries = Object.entries(tools);
	const toolsSection =
		toolEntries.length > 0
			? "\n\n## Available tools\n\n" +
				"The following tools are available in this environment. " +
				"Use them as described below instead of the tools mentioned in the system prompt above.\n\n" +
				toolEntries.map(([name, desc]) => `- ${name}: ${desc}`).join("\n")
			: "";

	const appendSection = input.appendSystemPrompt?.trim()
		? `\n\n${input.appendSystemPrompt.trim()}`
		: "";

	const contextFiles = input.contextFiles ?? [];
	const contextSection =
		contextFiles.length > 0
			? "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n" +
				contextFiles
					.map(
						(f) =>
							`<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>\n\n`,
					)
					.join("") +
				"</project_context>\n"
			: "";

	const skills = input.skills ?? [];
	const skillsSection = formatSkillsBlock(skills);

	const now = input.now ?? new Date();
	const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const cwd = input.cwd ?? "unknown";

	return (
		assembledCustom +
		toolsSection +
		appendSection +
		contextSection +
		skillsSection +
		`\nCurrent date: ${dateStr}` +
		`\nCurrent working directory: ${cwd}`
	);
}
