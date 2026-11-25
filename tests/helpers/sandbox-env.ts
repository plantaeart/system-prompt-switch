/**
 * The environment a host CLI is started with in the e2e tests: the real one minus every host config, session and
 * credential variable (so no user plugin, setting or login is touched and no model is called), with HOME pointed at a
 * throwaway directory.
 */
export function sandboxEnv(home: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !/API_KEY|TOKEN|SECRET|AUTH|^(PI|OMP)_/i.test(key)) env[key] = value;
	}
	return { ...env, HOME: home, USERPROFILE: home };
}
