/**
 * Prompt file names used as keys in the in-memory mocks.
 *
 * These never touch disk — they live in MockStorage maps — so they are NOT in
 * `TestPrompt` (the cleanup registry). They are still enumerated so a rename
 * cannot silently desynchronise a fixture from the assertion that reads it.
 *
 * `TestPrompt` in `test-prompt.enum.ts` covers the opposite case: names a test
 * writes to a real directory, which the global setup deletes on exit.
 */
export enum FixturePrompt {
	Coder = "coder.md",
	Reviewer = "reviewer.md",
	SecurityAuditor = "security-auditor.md",
	Auditor = "auditor.md",
	Dev = "dev.md",
	Temp = "temp.md",
	Pirate = "pirate.md",
	Beh = "beh.md",
	Old = "old.md",
	New = "new.md",
	A = "a.md",
	B = "b.md",
	C = "c.md",
	Guideline = "guidelines.md",
	BackendDev = "Backend-Dev.md",
	OkName = "ok-name.md",
	Valid = "valid.md",
	Prompt1 = "prompt1.md",
	Prompt2 = "prompt2.md",
	LocalPrompt = "local-prompt.md",
	HostPrompt = "global-prompt.md",

	/** A project context file (not a prompt) referenced by the builder test. */
	AgentsFile = "AGENTS.md",

	/** In-memory only; mirrors a same-named file on disk. */
	Duplicate = "duplicate.md",
}
