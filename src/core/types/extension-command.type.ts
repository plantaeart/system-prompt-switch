export enum ExtensionCommand {
	SELECT = "sps-select",
	INJECT = "sps-inject",
	NEW = "sps-new",
	EDIT = "sps-edit",
	DELETE = "sps-delete",
	MOVE = "sps-move",
	MODE = "sps-mode",
	INFO = "sps-info",
	PATH = "sps-path",
	LOGS = "sps-logs",
}

export interface ExtensionCommandMetadata {
	command: ExtensionCommand;
	description: string;
	usage: string;
}

export const EXTENSION_COMMAND_CATALOG: Record<
	ExtensionCommand,
	ExtensionCommandMetadata
> = {
	[ExtensionCommand.SELECT]: {
		command: ExtensionCommand.SELECT,
		description:
			"[sps name 1] [sps name 2] [sps name N] - Select the active system prompt(s) for this session, or none; names skip the picker",
		usage: "/sps-select [none | [sps name 1] [sps name 2] [sps name N]]",
	},
	[ExtensionCommand.INJECT]: {
		command: ExtensionCommand.INJECT,
		description:
			"Cumulatively inject/stack multiple system prompts for this session",
		usage: "/sps-inject",
	},
	[ExtensionCommand.NEW]: {
		command: ExtensionCommand.NEW,
		description: "Create a new system prompt markdown file (local or global)",
		usage: "/sps-new",
	},
	[ExtensionCommand.EDIT]: {
		command: ExtensionCommand.EDIT,
		description: "[sps name] - Edit an existing system prompt markdown file; a name skips the picker",
		usage: "/sps-edit [sps name]",
	},
	[ExtensionCommand.DELETE]: {
		command: ExtensionCommand.DELETE,
		description: "Delete an existing system prompt file",
		usage: "/sps-delete",
	},
	[ExtensionCommand.MOVE]: {
		command: ExtensionCommand.MOVE,
		description:
			"Move an existing system prompt file to another scope (local, global pi, global omp)",
		usage: "/sps-move",
	},
	[ExtensionCommand.MODE]: {
		command: ExtensionCommand.MODE,
		description:
			"Toggle or set injection mode (append | replace) for this session",
		usage: "/sps-mode [append|replace]",
	},
	[ExtensionCommand.INFO]: {
		command: ExtensionCommand.INFO,
		description:
			"Show current session prompt, mode, session ID, and directories",
		usage: "/sps-info",
	},
	[ExtensionCommand.PATH]: {
		command: ExtensionCommand.PATH,
		description:
			"Display absolute local and global file paths for system prompts",
		usage: "/sps-path",
	},
	[ExtensionCommand.LOGS]: {
		command: ExtensionCommand.LOGS,
		description:
			"Show recent session logs and live tail command for system-prompt-switch",
		usage: "/sps-logs [lines]",
	},
};
