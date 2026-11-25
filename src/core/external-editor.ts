import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExternalEditorOptions {
	content: string;
	command?: string;
}

export interface ExternalEditorResult {
	status: "complete" | "failed";
	content?: string;
	message?: string;
}

export function getDefaultExternalEditorCommand(): string {
	return (
		process.env.VISUAL ||
		process.env.EDITOR ||
		(process.platform === "win32" ? "notepad" : "nano")
	);
}

export function splitCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let inToken = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];

		if (quote === "'") {
			if (char === "'") {
				quote = null;
			} else {
				current += char;
			}
			inToken = true;
			continue;
		}

		if (quote === '"') {
			if (char === '"') {
				quote = null;
			} else if (char === "\\" && i + 1 < command.length) {
				const next = command[i + 1];
				if (next === '"' || next === "\\") {
					current += next;
					i++;
				} else {
					current += char;
				}
			} else {
				current += char;
			}
			inToken = true;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			inToken = true;
			continue;
		}

		if (char === " " || char === "\t") {
			if (inToken) {
				tokens.push(current);
				current = "";
				inToken = false;
			}
			continue;
		}

		if (char === "\\" && i + 1 < command.length) {
			const next = command[i + 1];
			if (next === " " || next === "\t" || next === '"' || next === "'") {
				current += next;
				i++;
				inToken = true;
				continue;
			}
		}

		current += char;
		inToken = true;
	}

	if (inToken) {
		tokens.push(current);
	}

	return tokens;
}

function escapeCmdArg(arg: string): string {
	if (arg.length === 0) return '""';
	if (/[\s"^&|<>]/.test(arg)) {
		return `"${arg.replace(/"/g, '""')}"`;
	}
	return arg;
}

export async function editInExternalEditor(
	options: ExternalEditorOptions,
): Promise<ExternalEditorResult> {
	const command = options.command || getDefaultExternalEditorCommand();
	const trimmedCommand = command.trim();
	if (!trimmedCommand) {
		return {
			status: "failed",
			message: "External editor command is empty",
		};
	}
	const [editor, ...editorArgs] = splitCommand(trimmedCommand);
	if (!editor) {
		return {
			status: "failed",
			message: "External editor command is empty",
		};
	}
	const directory = mkdtempSync(join(tmpdir(), "sps-editor-"));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		const exit = await new Promise<number | string | null>((resolve) => {
			const child =
				process.platform === "win32"
					? spawn([editor, ...editorArgs, filePath].map(escapeCmdArg).join(" "), {
							stdio: "inherit",
							shell: true,
						})
					: spawn(editor, [...editorArgs, filePath], {
							stdio: "inherit",
						});
			child.on("error", () => resolve(null));
			child.on("close", (code, signal) => resolve(code ?? signal));
		});
		if (exit === null) {
			return {
				status: "failed",
				message: `Failed to launch external editor: ${command}`,
			};
		}
		if (exit !== 0) {
			return {
				status: "failed",
				message: `External editor exited with code ${exit}`,
			};
		}
		let updated = readFileSync(filePath, "utf-8");
		if (updated.charCodeAt(0) === 0xfeff) {
			updated = updated.slice(1);
		}
		updated = updated.replace(/\r\n/g, "\n");
		return {
			status: "complete",
			content: updated,
		};
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}
