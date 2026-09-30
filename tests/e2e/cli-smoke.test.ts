import { describe, expect, it } from "bun:test";

/**
 * Loads the extension through a real host CLI.
 *
 * CI installs both Pi and OMP, so both are exercised here. Locally only one is
 * usually present; a missing binary is reported and skipped rather than failed,
 * so a contributor without a host installed is not blocked.
 */
const HOSTS = [
	{ name: "pi", bin: "pi" },
	{ name: "omp", bin: "omp" },
] as const;

describe("CLI Smoke Test", () => {
	for (const host of HOSTS) {
		it(`loads extension cleanly via the ${host.name} CLI`, async () => {
			const resolved = Bun.which(host.bin);
			if (!resolved) {
				console.log(`[skip] ${host.bin} not on PATH`);
				return;
			}

			const proc = Bun.spawn(
				[host.bin, "-e", "./extensions/index.ts", "--help"],
				{
					stdout: "pipe",
					stderr: "pipe",
					env: { ...process.env },
				},
			);

			const stderr = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;

			expect(exitCode).toBe(0);
			// stderr should not contain fatal extension crash logs
			expect(stderr).not.toContain("Error: Cannot find module");
			expect(stderr).not.toContain("SyntaxError");
		});
	}
});
