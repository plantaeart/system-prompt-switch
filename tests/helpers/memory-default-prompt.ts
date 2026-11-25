import type { ActivePromptRef } from "../../src/core/types/active-prompt-ref.type";
import type { DefaultPromptPort } from "../../src/ports/default-prompt.port";

export class MemoryDefaultPrompt implements DefaultPromptPort {
	value: ActivePromptRef[] | null | undefined;
	async get(): Promise<ActivePromptRef[] | null | undefined> {
		return this.value;
	}
	async set(refs: ActivePromptRef[] | ActivePromptRef | null | undefined): Promise<void> {
		if (refs === undefined || refs === null) {
			this.value = refs;
		} else {
			// A snapshot, like the JSON file the real adapter writes: later edits to the caller's array must not leak in.
			this.value = Array.isArray(refs) ? [...refs] : [refs];
		}
	}
	setCwd(): void {}
}
