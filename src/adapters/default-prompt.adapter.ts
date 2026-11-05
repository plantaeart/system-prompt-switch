import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHostPaths } from "../core/paths";
import type { ActivePromptRef } from "../core/types/active-prompt-ref.type";
import type { DefaultPromptPort } from "../ports/default-prompt.port";

type DefaultsFile = Record<string, ActivePromptRef | null>;

/** Stores one default per project (keyed by absolute cwd) in defaults.json beside the session state. */
export class DefaultPromptAdapter implements DefaultPromptPort {
	private readonly filePath: string;
	private key = "";

	constructor(customFilePath?: string) {
		this.filePath =
			customFilePath ?? path.join(path.dirname(resolveHostPaths().statePath), "defaults.json");
	}

	setCwd(cwd: string): void {
		this.key = path.resolve(cwd);
	}

	private readAll(): DefaultsFile {
		try {
			return JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as DefaultsFile;
		} catch {
			return {};
		}
	}

	async get(): Promise<ActivePromptRef | null | undefined> {
		return this.readAll()[this.key];
	}

	async set(ref: ActivePromptRef | null | undefined): Promise<void> {
		try {
			const all = this.readAll();
			if (ref === undefined) delete all[this.key];
			else all[this.key] = ref;
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
			// Temp file + rename: a crash mid-write never leaves a half-written file.
			const tmp = `${this.filePath}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(all, null, 2), "utf-8");
			fs.renameSync(tmp, this.filePath);
		} catch {
			// best effort persistence, same as session state
		}
	}
}
