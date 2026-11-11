import type { PromptFileInfo } from "../core/types/prompt-file-info.type";
import type { PromptScope } from "../core/types/prompt-scope.type";

export interface StoragePort {
	list(): Promise<PromptFileInfo[]>;
	read(name: string, scope?: PromptScope): Promise<string | null>;
	write(name: string, content: string, scope?: PromptScope): Promise<void>;
	rename?(oldName: string, newName: string, scope?: PromptScope): Promise<boolean>;
	delete(name: string, scope?: PromptScope): Promise<boolean>;
	/** Global dir for a host scope; defaults to the detected host's dir. */
	getGlobalDirectory(scope?: PromptScope): string;
	getLocalDirectory(): string;
	setCwd(cwd: string): void;
}
