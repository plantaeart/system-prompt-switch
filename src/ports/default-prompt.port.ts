import type { ActivePromptRef } from "../core/types/active-prompt-ref.type";

/**
 * The prompt a new session in the current project starts with.
 * `undefined` = never chosen (show the picker), `null` = chose (None).
 */
export interface DefaultPromptPort {
	get(): Promise<ActivePromptRef | null | undefined>;
	/** `undefined` forgets the default. */
	set(ref: ActivePromptRef | null | undefined): Promise<void>;
	/** Scopes the default to a project; called on every host event like StoragePort.setCwd. */
	setCwd(cwd: string): void;
}
