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
			"Select active system prompt for this session (or None / Default)",
		usage: "/sps-select",
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
		description: "Edit an existing system prompt markdown file",
		usage: "/sps-edit",
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
