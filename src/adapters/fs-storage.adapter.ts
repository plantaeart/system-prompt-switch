import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveHostPaths } from "../core/paths";
import { HostPlatform } from "../core/types/host-platform.type";
import type { PromptFileInfo } from "../core/types/prompt-file-info.type";
import { globalScopeFor, PromptScope } from "../core/types/prompt-scope.type";
import type { StoragePort } from "../ports/storage.port";

export interface FsStorageOptions {
	globalDir?: string;
	ompGlobalDir?: string;
	piGlobalDir?: string;
	localDir?: string;
	cwd?: string;
}

export class FsStorageAdapter implements StoragePort {
	private ompGlobalDir: string;
	private piGlobalDir: string;
	private detectedHost: HostPlatform;
	private localDir: string;

	constructor(options?: FsStorageOptions) {
		const resolved = resolveHostPaths(options?.cwd);
		this.detectedHost = resolved.host;
		this.localDir = options?.localDir ?? resolved.localPromptDir;

		// ponytail: a caller that scopes any directory must never leave the other
		// host resolving to the real ~/.omp or ~/.pi prompt dir — that is how test
		// prompts reached a user's library. Unset hosts get a private temp dir.
		const unset = (host: HostPlatform) =>
			fs.mkdtempSync(path.join(os.tmpdir(), `sps-unset-${host}-`));

		const scoped =
			options?.ompGlobalDir !== undefined ||
			options?.piGlobalDir !== undefined ||
			options?.globalDir !== undefined ||
			options?.localDir !== undefined;

		// Legacy `globalDir` maps onto the detected host only, so the other host
		// stays empty and list() cannot report the same file twice.
		this.ompGlobalDir =
			options?.ompGlobalDir ??
			(options?.globalDir !== undefined && resolved.host === HostPlatform.Omp
				? options.globalDir
				: scoped
					? unset(HostPlatform.Omp)
					: resolved.ompGlobalPromptDir);

		this.piGlobalDir =
			options?.piGlobalDir ??
			(options?.globalDir !== undefined && resolved.host === HostPlatform.Pi
				? options.globalDir
				: scoped
					? unset(HostPlatform.Pi)
					: resolved.piGlobalPromptDir);
	}

	setCwd(cwd: string): void {
		const resolved = resolveHostPaths(cwd);
		this.localDir = resolved.localPromptDir;
	}

	getGlobalDirectory(scope?: PromptScope): string {
		if (scope === PromptScope.GlobalOmp) return this.ompGlobalDir;
		if (scope === PromptScope.GlobalPi) return this.piGlobalDir;
		return globalScopeFor(this.detectedHost) === PromptScope.GlobalOmp
			? this.ompGlobalDir
			: this.piGlobalDir;
	}

	getLocalDirectory(): string {
		return this.localDir;
	}

	private ensureDir(dirPath: string): void {
		if (!fs.existsSync(dirPath)) {
			fs.mkdirSync(dirPath, { recursive: true });
		}
	}

	private migrateLegacyPromptsIfNeeded(): void {
		try {
			const targetDir = this.getGlobalDirectory();
			this.ensureDir(targetDir);
			const current = fs
				.readdirSync(targetDir)
				.filter((f) => f.endsWith(".md"));
			if (current.length > 0) {
				return;
			}

			const legacyDir = path.join(
				os.homedir(),
				".pi",
				"agent",
				"system-prompts",
			);
			if (!fs.existsSync(legacyDir)) {
				return;
			}

			const legacyFiles = fs
				.readdirSync(legacyDir)
				.filter((f) => f.endsWith(".md"));
			for (const file of legacyFiles) {
				const src = path.join(legacyDir, file);
				const dest = path.join(targetDir, file);
				if (!fs.existsSync(dest)) {
					fs.copyFileSync(src, dest);
				}
			}
		} catch {
			// best-effort migration
		}
	}

	private readDirFiles(dirPath: string, scope: PromptScope): PromptFileInfo[] {
		if (!fs.existsSync(dirPath)) return [];
		try {
			const entries = fs.readdirSync(dirPath, { withFileTypes: true });
			const files: PromptFileInfo[] = [];

			for (const entry of entries) {
				if (entry.name.endsWith(".md")) {
					const fullPath = path.join(dirPath, entry.name);
					try {
						const stat = fs.statSync(fullPath);
						if (!stat.isFile()) continue;
						files.push({
							name: entry.name,
							path: fullPath,
							scope,
							sizeChars: stat.size,
							modifiedAt: stat.mtimeMs,
						});
					} catch {
						// ignore unreadable file
					}
				}
			}

			return files.sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return [];
		}
	}

	async list(): Promise<PromptFileInfo[]> {
		this.migrateLegacyPromptsIfNeeded();

		return [
			...this.readDirFiles(this.localDir, PromptScope.Local),
			...this.readDirFiles(this.ompGlobalDir, PromptScope.GlobalOmp),
			...this.readDirFiles(this.piGlobalDir, PromptScope.GlobalPi),
		];
	}

	async read(name: string, scope?: PromptScope): Promise<string | null> {
		const cleanName = path.basename(name);

		if (scope === PromptScope.Local) {
			return this.readFileFrom(path.join(this.localDir, cleanName));
		}
		if (scope === PromptScope.GlobalOmp || scope === PromptScope.GlobalPi) {
			return this.readFileFrom(path.join(this.getGlobalDirectory(scope), cleanName));
		}

		// No scope: local first, then the detected host, then the other host.
		const localContent = this.readFileFrom(path.join(this.localDir, cleanName));
		if (localContent !== null) return localContent;

		return this.readFileFrom(
			path.join(this.getGlobalDirectory(), cleanName),
		);
	}

	private readFileFrom(filePath: string): string | null {
		try {
			if (!fs.existsSync(filePath)) return null;
			return fs.readFileSync(filePath, "utf-8");
		} catch {
			return null;
		}
	}

	async write(
		name: string,
		content: string,
		scope: PromptScope = PromptScope.GlobalOmp,
	): Promise<void> {
		const targetDir =
			scope === PromptScope.Local ? this.localDir : this.getGlobalDirectory(scope);
		this.ensureDir(targetDir);
		const fullPath = path.join(targetDir, path.basename(name));
		fs.writeFileSync(fullPath, content, "utf-8");
	}

	async delete(name: string, scope?: PromptScope): Promise<boolean> {
		const cleanName = path.basename(name);

		if (scope === PromptScope.Local) {
			return this.unlinkFile(path.join(this.localDir, cleanName));
		}
		if (scope === PromptScope.GlobalOmp || scope === PromptScope.GlobalPi) {
			return this.unlinkFile(path.join(this.getGlobalDirectory(scope), cleanName));
		}

		// No scope: local, then the detected host, then the other host.
		if (this.unlinkFile(path.join(this.localDir, cleanName))) return true;
		if (this.unlinkFile(path.join(this.getGlobalDirectory(), cleanName))) {
			return true;
		}
		return this.unlinkFile(
			path.join(
				this.getGlobalDirectory(
					globalScopeFor(this.detectedHost) === PromptScope.GlobalOmp
					? PromptScope.GlobalPi
					: PromptScope.GlobalOmp,
				),
				cleanName,
			),
		);
	}

	private unlinkFile(filePath: string): boolean {
		try {
			if (!fs.existsSync(filePath)) return false;
			fs.unlinkSync(filePath);
			return true;
		} catch {
			return false;
		}
	}
}
