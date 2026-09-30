/**
 * Every prompt file a test writes to disk, in one place.
 *
 * A test registers each of these with `registerTestPrompt()`; the global setup
 * removes the whole registry on exit, pass or fail, and sweeps anything left by
 * an earlier crashed run. A prompt that reaches a real prompt directory without
 * being listed here is a bug: either the test bypassed the registry or an
 * earlier run leaked.
 *
 * Only names a test actually writes to disk belong here. Names used purely as
 * keys in an in-memory mock (MockStorage maps in prompt-service.test.ts) are
 * plain strings and are never at risk of leaking, so they are not listed.
 *
 * Names are deliberately unlikely to collide with a real user prompt, so a
 * leaked file is obvious rather than silently merged.
 */
export enum TestPrompt {
	// --- multi-scope-storage.test.ts (real FsStorageAdapter on temp dirs) ---
	GlobalCoder = "global-coder.md",
	LocalRules = "local-rules.md",
	Shared = "shared.md",
	Duplicate = "duplicate.md",
	OmpOnly = "omp-only.md",
	PiOnly = "pi-only.md",
	Targeted = "targeted.md",
	Dup = "dup.md",
	/** Regression probe proving a scoped adapter never writes to the real home. */
	LeakProbe = "leak-probe.md",

	// --- session-isolation.test.ts (real FsStorageAdapter on temp dirs) ---
	Spr1 = "SPR1.md",
	Spr2 = "SPR2.md",

	// --- extension-lifecycle.test.ts (e2e, temp dir cleared in afterEach) ---
	E2EPrompt = "test-prompt.md",
}
