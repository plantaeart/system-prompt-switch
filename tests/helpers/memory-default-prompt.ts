import type { ActivePromptRef } from "../../src/core/types/active-prompt-ref.type";
import type { DefaultPromptPort } from "../../src/ports/default-prompt.port";

export class MemoryDefaultPrompt implements DefaultPromptPort {
	value: ActivePromptRef | null | undefined;
	async get() {
		return this.value;
	}
	async set(ref: ActivePromptRef | null) {
		this.value = ref;
	}
	setCwd(): void {}
}
