import * as os from "node:os";
import * as path from "node:path";
import type { HostPaths } from "./types/host-paths.type";
import { HostPlatform } from "./types/host-platform.type";

export function detectHost(
	env: Record<string, string | undefined> = process.env,
	argv: string[] = process.argv,
): HostPlatform {
	// Explicit override wins over every heuristic, so a misdetected host is
	// always recoverable without editing code.
	const forced = env.SPS_HOST?.trim().toLowerCase();
	if (forced === HostPlatform.Omp || forced === HostPlatform.Pi) {
		return forced;
	}
	if (env.OMPCODE === "1") {
		return HostPlatform.Omp;
	}
	const hasOmpInArgv = argv.some((arg) => {
		const base = path.basename(arg);
		return base === HostPlatform.Omp || base.startsWith("omp-");
	});
	if (hasOmpInArgv) {
		return HostPlatform.Omp;
	}
	return HostPlatform.Pi;
}

export function resolveHostPaths(
	cwd: string = process.cwd(),
	env: Record<string, string | undefined> = process.env,
	argv: string[] = process.argv,
): HostPaths {
	const host = detectHost(env, argv);
	const home = os.homedir();

	const envGlobalDir = env.SPS_PROMPT_DIR?.trim() || env.SYSTEM_PROMPT_DIR?.trim();
	// ponytail: both host dirs are always resolved. A shared SPS_PROMPT_DIR
	// override applies to the detected host only, so the other host keeps its
	// own real location instead of silently sharing one.
	const ompGlobalPromptDir =
		host === HostPlatform.Omp && envGlobalDir
			? envGlobalDir
			: path.join(home, ".omp", "agent", "system-prompts-switch");
	const piGlobalPromptDir =
		host === HostPlatform.Pi && envGlobalDir
			? envGlobalDir
			: path.join(home, ".pi", "agent", "system-prompts-switch");
	const globalPromptDir = host === HostPlatform.Omp ? ompGlobalPromptDir : piGlobalPromptDir;

	const envLocalDir = env.SPS_LOCAL_PROMPT_DIR?.trim();
	const localPromptDir =
		envLocalDir && envLocalDir.length > 0
			? envLocalDir
			: path.join(cwd, ".agents", "system-prompts-switch");

	const envStatePath =
		env.SPS_STATE_PATH?.trim() || env.PI_SYSTEM_PROMPT_STATE_PATH?.trim();
	const statePath =
		envStatePath && envStatePath.length > 0
			? envStatePath
			: path.join(
					home,
					host === HostPlatform.Omp ? ".omp" : ".pi",
					"agent",
					"state",
					"system-prompt-switch",
					"sessions.json",
				);

	return {
		host,
		globalPromptDir,
		ompGlobalPromptDir,
		piGlobalPromptDir,
		localPromptDir,
		statePath,
	};
}
