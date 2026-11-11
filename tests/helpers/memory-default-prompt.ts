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
			this.value = Array.isArray(refs) ? refs : [refs];
		}
	}
	setCwd(): void {}
}
