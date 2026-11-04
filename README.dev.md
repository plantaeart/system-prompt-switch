# system-prompt-switch — Dev Guide

Hexagonal (Ports & Adapters) Pi/OMP extension written in TypeScript, ESM, bundled by Bun.

---

## Requirements

- Bun ≥ 1.3
- Node ≥ 22 (for `npm` tooling during publish)
- Pi or OMP installed and on `PATH` (for the CLI smoke test)

### Nix / direnv (optional, recommended)

`flake.nix` provides two shells. The default (used by direnv) has bun 1.4.4, Node 26 and `uv`. The `e2e` shell adds the exact `pi` / `omp` versions CI pins (installed on first entry into `.direnv/host-cli`); CI uses it, so local and CI toolchains match. Run the e2e tests with `nix develop .#e2e -c bun test`.

```bash
direnv allow          # once; needs nix + direnv + nix-direnv
bun install
bun run ci            # same as CI

nix develop           # no direnv: enter the light shell by hand
nix develop .#e2e     # shell with pinned pi / omp for the e2e tests
nix-direnv-reload     # after deleting .direnv/ or editing flake.nix by hand
```

- Bump a host CLI: edit `hostCLIs` in `flake.nix` (see the `host-version` skill).
- Bump bun: edit `bunVersion` and `bunHashes` in `flake.nix` (`nix store prefetch-file <url>` gives each hash). nixpkgs lags bun releases, hence the override.
- Without Nix, install the requirements above by hand; nothing else depends on it.

---

## Layout

```
extensions/
  index.ts                # Entry point registered with Pi/OMP (`package.json` -> `main` / `extensions`)
src/
  ports/                  # Inbound/outbound interfaces (UIPort, StoragePort, SessionStatePort)
  adapters/               # Concrete impls: PiUIAdapter, FsStorageAdapter, SessionStateAdapter
  core/                   # Domain logic: PromptService, prompt-builder, logger, paths
  core/types/             # Shared domain types
tests/
  unit/                   # Domain tests with mock ports (no host required)
  e2e/                    # Lifecycle tests + CLI smoke (requires host binary on PATH)
.agents/
  skills/                 # Project-local omp skills (not shipped to npm; see `.npmignore`)
    get-context/
  skills/bump-version/    # `bun pm version` + `git tag v<ver>` (no commit)
```

The domain never imports from `adapters/` or `extensions/`; tests inject mock implementations through the ports.

---

## Scripts

```bash
bun test                  # Run all 43 unit + e2e tests
bun run typecheck         # tsc --noEmit
bun run lint              # oxlint
```

The CLI smoke test auto-discovers the host binary — it spawns `pi` if available, otherwise `omp`. Both expose `-e <extension-path>`.

---

## Testing locally in OMP / Pi

```bash
# Isolated profile
omp --no-extensions --profile test -e ./extensions/index.ts

# Or link permanently
omp plugin link .
pi install ./              # for Pi
```

### Deleting a profile

A profile is a self-contained directory under `~/.omp/profiles/<name>/` holding that profile's `agent/` (sessions + state), `cache/`, `logs/`, and `run/`. There is no `omp --delete-profile` flag; remove the directory.

```bash
# List profiles
ls ~/.omp/profiles/

# Inspect before deleting
du -sh ~/.omp/profiles/test
ls ~/.omp/profiles/test

# Delete
rm -rf ~/.omp/profiles/test
```

This only touches `~/.omp/profiles/<name>/`. Your default profile (top-level `~/.omp/agent/`, `plugins/`, `cache/`, `logs/`) is separate and is **not** affected, so installed plugins and real sessions survive.

If you created a shell shortcut with `omp --profile <name> --alias <cmd>`, that alias points at the profile too — remove it from `~/.local/bin/` and any rc file that references it.

---

## Editor shortcut caveat

`host.ui.editor(title, prefill)` from `@earendil-works/pi-coding-agent` renders a hardcoded footer (`Ctrl+Q/Ctrl+Enter submit / Esc cancel / Ctrl+G external editor`). The host API takes no footer-template option, and the keypress stream is owned by the host, so we **cannot** suppress or intercept it from extension code.

Workaround shipped in this repo: `PromptService.runEditorWithHint()` swaps the above-editor widget to a boxed banner that shows the real shortcuts, and restores the status widget in `finally`.

---

## Versioning

Bump with the bundled skill:

```bash
bash .agents/skills/bump-version/scripts/bump-version.sh --patch   # 0.6.0 -> 0.6.1
bash .agents/skills/bump-version/scripts/bump-version.sh --minor   # 0.6.0 -> 0.7.0
bash .agents/skills/bump-version/scripts/bump-version.sh --major
bash .agents/skills/bump-version/scripts/bump-version.sh           # status only
```

The skill uses `bun pm version <flag>` (which requires a clean tree) then creates an annotated `git tag v<ver>`. It does **not** create a commit — commit the change first.

---

## Publish to npm (becomes available on pi.dev/packages automatically)

Prereqs:
1. `npm login`
2. `peerDependencies["@earendil-works/pi-coding-agent"]` is `"*"` (host packages must be `*` per Pi docs).
3. `package.json` declares `"keywords": ["pi-package"]`.

Flow:

```bash
# after committing all changes
bash .agents/skills/bump-version/scripts/bump-version.sh --minor
npm publish --access public
```

Smoke test the install:

```bash
pi install npm:system-prompt-switch@<version>
pi list
```

The `.npmignore` keeps the tarball lean (no `.agents/`, no lockfiles, no VCS, no IDE noise). `tests/` is shipped so downstream contributors can run `bun test` immediately.

---

## Architecture notes

- **Ports**: `src/ports/*.port.ts` define `UIPort`, `StoragePort`, `SessionStatePort`.
- **Adapters**: `src/adapters/*.adapter.ts` implement those ports against Pi/OMP (`pi-ui.adapter.ts`), the filesystem (`fs-storage.adapter.ts`), and the session JSONL store (`session-state.adapter.ts`).
- **Core**: `src/core/prompt-service.ts` is the only orchestrator. It owns prompt selection, mutation, mode, and the editor banner lifecycle.
- **Why hexagonal**: keeps the domain unit-testable without spawning a host (the 42 unit tests run in <100ms; only the 2 e2e tests touch the host).

---

## Contributing

PRs welcome. Keep tests green; add a unit test for any new domain logic; an e2e test only when exercising a host integration.

## License

[MIT](./LICENSE)