import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectHost } from "./paths";
import { HostPlatform } from "./types/host-platform.type";

export function resolveLogPath(
	host?: HostPlatform,
	customPath?: string,
): string {
	if (customPath && customPath.trim().length > 0) {
		return customPath.trim();
	}
	const envPath = process.env.SPS_LOG_PATH?.trim();
	if (envPath && envPath.length > 0) {
		return envPath;
	}

	const activeHost = host ?? detectHost();
	const home = os.homedir();
	return path.join(
		home,
		activeHost === HostPlatform.Omp ? ".omp" : ".pi",
		"agent",
		"logs",
		"system-prompt-switch.log",
	);
}

export class Logger {
	private readonly logPath: string;

	constructor(customPath?: string) {
		this.logPath = resolveLogPath(undefined, customPath);
	}

	getLogPath(): string {
		return this.logPath;
	}

	private ensureDir(): void {
		const dir = path.dirname(this.logPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	write(
		level: "INFO" | "WARN" | "ERROR",
		tag: string,
		message: string,
		meta?: Record<string, unknown>,
	): void {
		try {
			this.ensureDir();
			const timestamp = new Date().toISOString();
			const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
			const line = `[${timestamp}] [${level}] [${tag}] ${message}${metaStr}\n`;
			fs.appendFileSync(this.logPath, line, "utf-8");
		} catch {
			// Best-effort logging: should never crash the extension
		}
	}

	info(tag: string, message: string, meta?: Record<string, unknown>): void {
		this.write("INFO", tag, message, meta);
	}

	warn(tag: string, message: string, meta?: Record<string, unknown>): void {
		this.write("WARN", tag, message, meta);
	}

	error(tag: string, message: string, meta?: Record<string, unknown>): void {
		this.write("ERROR", tag, message, meta);
	}

	getRecent(maxLines = 20): string[] {
		try {
			if (!fs.existsSync(this.logPath)) {
				return [`No log file found at ${this.logPath}`];
			}
			const content = fs.readFileSync(this.logPath, "utf-8");
			const lines = content
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0);
			return lines.slice(-maxLines);
		} catch (err) {
			return [`Failed to read logs: ${String(err)}`];
		}
	}
}

export const logger = new Logger();
