---
name: unit-test
description: Use when writing or changing a test in this repo - TDD order, port-based mocks, the TestPrompt enum and registry that stop tests leaking prompts into the real library, awaiting async signals instead of sleeping, and enum usage.
---

# unit-test

How to add tests to this repo. Read this before writing or changing a test — the conventions here are specific and several of them prevent real damage to the user's prompt library.

## TDD order (required)

1. Write the failing test first. Run it. Confirm it fails **for the reason you expect**, not a syntax error.
2. Implement the minimum code to pass.
3. Run the whole suite. It must stay green.

Never write the implementation first and back-fill a test.

## Layout

```
tests/
  unit/                 domain tests, no host, no network — milliseconds each
  e2e/                  tests that load the real extension against a mocked ExtensionAPI
  fixtures/
    test-prompt.enum.ts EVERY prompt filename a test writes to disk
  helpers/
    test-prompt-registry.ts  register / cleanup helpers
    global-setup.ts          sweep on start, cleanup on exit
```

Choose by what you are testing:
- Pure functions (`prompt-builder`, `paths`, `logger`) → `tests/unit/`, no mocks needed.
- Anything using `StoragePort` / `SessionStatePort` / `UIPort` → `tests/unit/`, inject the hand-written mocks (below).
- The extension entry point, command registration, lifecycle events → `tests/e2e/`.

## Commands

```bash
bun test                              # everything
bun test tests/unit/prompt-service.test.ts
bun test -t "does not toggle off"     # single test by name
bun run typecheck && bun run lint     # both must be clean
```

## Mocking: inject through the ports

The domain never imports an adapter, so unit tests build their own. There is no mocking library — just small classes implementing the port.

```ts
class MockStorage implements StoragePort {
	localFiles = new Map<string, string>();
	globalFiles = new Map<string, string>();
	piFiles = new Map<string, string>();

	async list(): Promise<PromptFileInfo[]> { /* build from the maps */ }
	async read(name: string, scope?: PromptScope): Promise<string | null> { /* switch on scope */ }
	async write(name: string, content: string, scope: PromptScope = PromptScope.GlobalOmp): Promise<void> { /* switch on scope */ }
	async delete(name: string, scope?: PromptScope): Promise<boolean> { /* switch on scope */ }
	getGlobalDirectory(scope?: PromptScope): string { /* per scope */ }
	getLocalDirectory(): string { return "/prompts/local"; }
	setCwd(): void {}
}
```

`MockSessionState` and `MockUI` follow the same shape. For `UIPort`, count calls and queue answers so a test can assert *how many times* the UI was touched:

```ts
selectCalls = 0;
selectChoices: string[] = [];   // queue: one entry per expected call

async select(_title?: string, options?: string[]): Promise<string | undefined> {
	this.selectCalls++;
	if (options) this.offeredOptions.push(options);
	return this.selectChoices.shift() ?? this.selectChoice;
}
```

## Prompt files: always the enum + the registry

**Any test that writes a prompt file to disk must use `TestPrompt` from `tests/fixtures/test-prompt.enum.ts`.** Never invent a filename inline. Names used only as keys in an in-memory mock are plain strings and do not belong in the enum.

```ts
import { TestPrompt } from "../fixtures/test-prompt.enum";
import { registerTestPrompt } from "../helpers/test-prompt-registry";

beforeEach(() => {
	fs.writeFileSync(path.join(promptsDir, TestPrompt.Spr1), "…", "utf-8");
	registerTestPrompt(promptsDir, TestPrompt.Spr1);
});
```

Adding a new prompt name means adding a member to the `TestPrompt` enum, grouped under a comment naming the test file that uses it.

Why this matters: `tests/helpers/global-setup.ts` runs on every suite (via `bunfig.toml` preload) and **deletes any registered prompt on exit, pass or fail**, plus sweeps leftovers from a crashed run. A file created outside the registry survives and pollutes `~/.omp/agent/system-prompts-switch/`.

## When you need the real filesystem

Use `FsStorageAdapter` with **every** directory you care about pointed at a temp dir:

```ts
tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sps-test-"));
ompDir = path.join(tempDir, "omp-prompts");
piDir = path.join(tempDir, "pi-prompts");
fs.mkdirSync(ompDir, { recursive: true });
fs.mkdirSync(piDir, { recursive: true });

const adapter = new FsStorageAdapter({ ompGlobalDir: ompDir, piGlobalDir: piDir, localDir });
```

**Scope every directory you use.** The adapter will not fall back to the real `~/.omp` or `~/.pi` directory once any directory is scoped, but a partially-scoped adapter is still a trap — `globalDir` maps onto the detected host only, so the other host becomes a throwaway temp dir and `list()` results can surprise you.

Prefer naming both hosts explicitly:

```ts
const adapter = new FsStorageAdapter({
	ompGlobalDir: ompDir,
	piGlobalDir: piDir,
	localDir,
});
```

Use the legacy `{ globalDir, localDir }` shape only when a test genuinely targets just the detected host. `tests/unit/multi-scope-storage.test.ts` has a regression test, `never falls back to the real home prompt dir when a directory is scoped`, that pins this.

`afterEach` removes the whole temp tree:

```ts
afterEach(() => {
	try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
```

## Async: await the signal, never a timer

The extension detaches work (`void service.promptNewSessionModal(...)`), so a test must wait for the thing it actually produced — not sleep.

```ts
// wrong
await new Promise((r) => setTimeout(r, 10));

// right: wait for the real signal
const asked = Promise.withResolvers<void>();
// ... inside the mock: asked.resolve() when select() fires
await asked.promise;
```

Use `Promise.withResolvers()`, never `new Promise((resolve) => …)` with nested callbacks. If you genuinely need a delay, it belongs in an e2e test against a real host, and it needs a comment saying why deterministic control will not work.

## Enums, not string literals

`PromptScope`, `HostPlatform`, `SessionStartReason`, `ExtensionEventType` and `ExtensionCommand` are enums. Use the members, not the raw strings:

```ts
scope: PromptScope.GlobalOmp    // not "global-omp"
```

A raw string still compiles in a test fixture, which is exactly how a legacy `"global"` value survived for so long. When a test needs a value that is *deliberately* off-type — persisted JSON from an older version — cast it explicitly and say why in a comment.

## Assertions

- Assert the behaviour a user or caller depends on, not the implementation. `expect(ui.selectCalls).toBe(0)` beats asserting on a private field.
- Prefer `toContain` for assembled strings. Reserve `toBe` for an exact whole-value contract.
- Negative assertions matter: `expect(result).not.toContain("Ctrl+Enter")` is what actually pins a bug fix.
- One behaviour per `it`. The name states the behaviour, not the method: `"does not re-open the modal when the session already decided"`, not `"testModal"`.
- When you fix a bug, add the regression test **and** verify it fails without the fix (revert the source change, watch it fail, restore). A test that never went red proves nothing.

## Typecheck and lint are part of the test

`bun test` does not typecheck. A test with a signature mismatch against a port passes at runtime and breaks the build:

```ts
bun run typecheck   # must be clean
bun run lint        # must be clean
```

Run `bun run ci` before declaring work done — it is the full pipeline, including skill validation. See the `ci-check` skill.

## Debugging a flaky or unclear failure

Read the real log before theorising. Tests write to `~/.omp/agent/logs/system-prompt-switch.log`; filter out the fixture session ids to see only real runs:

```bash
grep -E "SESSION_START|MODAL_" ~/.omp/agent/logs/system-prompt-switch.log | grep -v '"sessionId":"sess-' | tail -20
```

`SESSION_START` logs `reason`, `hasUI` and `mode`. `MODAL_OPEN` logs the exact options offered and `MODAL_ANSWER` what came back — that pair is how you tell "the modal never opened" apart from "the host answered it by itself".

## Do not

- Do not use a real host clock or timers to make an async test pass.
- Do not create a prompt file outside `TestPrompt` and the registry.
- Do not point a test at `~/.omp` or `~/.pi`.
- Do not delete a test to make a suite green. If a test encodes wrong behaviour, fix the behaviour and say so.
- Do not weaken an assertion just to pass. Change the assertion only when the requirement genuinely changed.

## Real session check

Mocks are not enough for anything visible at session start or in a slash command. Also run the `real-session-test` skill (a real omp TUI in a sandbox HOME) and add a scenario for the new behaviour.
