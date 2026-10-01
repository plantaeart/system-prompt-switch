import { describe, expect, it } from "bun:test";
import {
	ExtensionCommand,
	EXTENSION_COMMAND_CATALOG,
} from "../../src/core/types/extension-command.type";

describe("ExtensionCommand Enum", () => {
	it("contains all expected extension slash commands", () => {
		expect(String(ExtensionCommand.SELECT)).toBe("sps-select");
		expect(String(ExtensionCommand.INJECT)).toBe("sps-inject");
		expect(String(ExtensionCommand.NEW)).toBe("sps-new");
		expect(String(ExtensionCommand.EDIT)).toBe("sps-edit");
		expect(String(ExtensionCommand.DELETE)).toBe("sps-delete");
		expect(String(ExtensionCommand.MOVE)).toBe("sps-move");
		expect(String(ExtensionCommand.MODE)).toBe("sps-mode");
		expect(String(ExtensionCommand.INFO)).toBe("sps-info");
		expect(String(ExtensionCommand.PATH)).toBe("sps-path");
		expect(String(ExtensionCommand.LOGS)).toBe("sps-logs");
	});

	it("ensures all commands start with sps- prefix", () => {
		const commands = Object.values(ExtensionCommand);
		for (const cmd of commands) {
			expect(cmd.startsWith("sps-")).toBe(true);
		}
	});

	it("has unique values across all commands", () => {
		const commands = Object.values(ExtensionCommand);
		const unique = new Set(commands);
		expect(unique.size).toBe(commands.length);
	});

	it("has complete catalog entry for every command", () => {
		const commands = Object.values(ExtensionCommand);
		for (const cmd of commands) {
			const meta = EXTENSION_COMMAND_CATALOG[cmd];
			expect(meta).toBeDefined();
			expect(meta.command).toBe(cmd);
			expect(meta.description.length).toBeGreaterThan(5);
			expect(meta.usage.startsWith("/sps-")).toBe(true);
		}
	});
});
