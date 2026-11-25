---
name: real-session-test
description: Use when a feature touches session start, the startup modal, slash commands, banner/widget output or persisted state - drives a real omp TUI in tmux against the working-tree extension inside a sandbox HOME, so unit/e2e mocks are not the only proof. Run it before declaring such a feature done.
---

# real-session-test

Mocked tests prove logic; this proves the extension works inside the real host. Run it for any change visible at session start or in a slash command.

## Run

```bash
bash .agents/skills/real-session-test/scripts/real-session.sh                 # all scenarios on omp
bash .agents/skills/real-session-test/scripts/real-session.sh s_none_is_default  # one
SPS_HOST=pi bash .agents/skills/real-session-test/scripts/real-session.sh        # the same scenarios on Pi (entry extensions/pi.ts)
```

Needs `tmux` and `omp` on PATH. No model, login or network is required: the TUI starts with "No default model", and `session_start`, the modal, slash commands and the banner all work.

## How it is sandboxed

- `HOME=/tmp/sps-sandbox/home` (override with `SPS_SANDBOX`): sessions, `config.yml` and `defaults.json` never touch `~/.omp`. `setupVersion: 3` in the sandbox `config.yml` skips the first-run wizard on omp 18.18.x. With a lower number omp opens a "Setup step" wizard and every scenario times out; a newer host that adds a setup step needs a higher number, so copy it from a real `~/.omp/agent/config.yml`. `manual-session.sh` and `tests/e2e/omp-plugin-install.test.ts` carry the same number: change all three together.
- Two projects, `projA` (local prompts `alpha.md`, `beta.md`) and `projB` (none), to test per-project behaviour.
- `omp -e <repo>/extensions/index.ts` loads the working tree, not an installed copy.
- A "new session" is a fresh `omp` launch: the host does not deliver `session_start` for `/new` (see `SessionStartReason.New`).

## Writing a scenario

Add a function `s_<name>` to `scripts/real-session.sh` and list it in `SCENARIOS`. Helpers:

| Helper | Does |
|---|---|
| `reset_sandbox` | Wipes and recreates the sandbox |
| `launch <cwd>` | Starts the host in `<cwd>` (PI_*/OMP_* removed from the environment; `VISUAL`/`EDITOR` set to `$S/ed.sh`, which appends `EXT-EDITED`), waits for the modal or the banner |
| `tick <n>` | In the startup modal or `/sps-select` list: `n` Downs from the top, then Space. Rows: Done=0, None=1, `alpha`=2, `beta`=3, then three "Create new" rows. Call it repeatedly to tick several rows (`tick 2; tmux send-keys -t $T Down; tmux send-keys -t $T Space`) |
| `save` | Ctrl+S. With nothing ticked it saves None |
| `pick <n>` | `tick <n>` then `save` |
| `slash "<cmd>"` | Types the command and Enter |
| `check <desc> present\|absent <regex>` | Retries up to 5 s; dumps the screen on failure |
| `open_editor` | `/sps-edit`, Enter on `alpha`, so the editor is open |
| `kitty_esc` / `kitty_esc_caps` | Send Esc as the Kitty keyboard protocol does (`CSI 27 u`, and `CSI 27;65 u` with caps lock) |
| `file_has <desc> <file> <regex>` | Asserts on a prompt file on disk |

Current scenarios (all run on both hosts): `s_default_applies`, `s_none_is_default`, `s_dismiss_no_default`, `s_missing_file`, `s_multi_default` (several ticked prompts, `/sps-select a b`, `none`, unknown name), `s_inject_one_turn` (`/sps-inject` never becomes the project default), `s_rename_active` (Ctrl+N in `/sps-edit` keeps banner and default in sync), `s_preview_keys` (Tab preview, Esc leaves it, plain and Kitty-encoded), `s_editor_edit_undo_save` (mid-word typing, undo never passes the prefill, Ctrl+S writes the file), `s_editor_escape_cancels` (Esc closes the picker and the editor as a plain byte, Kitty CSI-u and Kitty with caps lock; file unchanged), `s_editor_external` (Ctrl+G through `$VISUAL`), `s_editor_empty_save_guard` (emptying a prompt asks before saving).

## Trying a branch by hand: `manual-session.sh`

```bash
bash .agents/skills/real-session-test/scripts/manual-session.sh
```

Opens a real omp on the working-tree extension in a throwaway `mktemp -d /tmp/sps-manual.XXXXXX` (own `HOME`, `setupVersion: 3`, project with `alpha.md` and `beta.md`). Never touches `~/.omp`; needs only `omp` on PATH.

- When omp exits it asks: `[Enter]` new session, `[c]` `omp -c`, `[r]` `omp -r`, `[q]` quit. The sandbox survives restarts, so persistence (project default, resume) can be tested in one sitting.
- Quitting with `q`, Ctrl+C, closing the terminal or a failed start deletes the sandbox (`rm -rf` of that one directory). A `kill -9` cannot clean up: remove `/tmp/sps-manual.*` yourself.
- The sandbox path is printed at startup; `defaults.json` lands under `<sandbox>/home/.omp/agent/`.
- Terminals differ in how they send Ctrl+S / Ctrl+N (legacy byte, Kitty protocol, `modifyOtherKeys`); the extension accepts all three, but a terminal that keeps XON/XOFF flow control on swallows Ctrl+S before omp sees it. The "Done / Save" row with Enter always works.

## Rules

- Prove the test can fail: break the feature once (e.g. comment out the call under test), see the scenario go red, restore.
- Read the screen with `tmux capture-pane -t sps-real -p` when debugging; never add or delete anything in the real `~/.omp`.
- The script is deterministic: `launch` waits for the modal or banner, and `check` retries for up to 5 seconds before failing.
- `SPS_SANDBOX` must be under `/tmp`: the script refuses anything else, because it runs `rm -rf` on it.
