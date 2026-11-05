---
name: real-session-test
description: Use when a feature touches session start, the startup modal, slash commands, banner/widget output or persisted state - drives a real omp TUI in tmux against the working-tree extension inside a sandbox HOME, so unit/e2e mocks are not the only proof. Run it before declaring such a feature done.
---

# real-session-test

Mocked tests prove logic; this proves the extension works inside the real host. Run it for any change visible at session start or in a slash command.

## Run

```bash
bash .agents/skills/real-session-test/scripts/real-session.sh                 # all scenarios
bash .agents/skills/real-session-test/scripts/real-session.sh s_none_is_default  # one
```

Needs `tmux` and `omp` on PATH. No model, login or network is required: the TUI starts with "No default model", and `session_start`, the modal, slash commands and the banner all work.

## How it is sandboxed

- `HOME=/tmp/sps-sandbox/home` (override with `SPS_SANDBOX`): sessions, `config.yml` and `defaults.json` never touch `~/.omp`. `setupVersion: 2` in the sandbox `config.yml` skips the first-run wizard.
- Two projects, `projA` (local prompts `alpha.md`, `beta.md`) and `projB` (none), to test per-project behaviour.
- `omp -e <repo>/extensions/index.ts` loads the working tree, not an installed copy.
- A "new session" is a fresh `omp` launch: the host does not deliver `session_start` for `/new` (see `SessionStartReason.New`).

## Writing a scenario

Add a function `s_<name>` to `scripts/real-session.sh` and list it in `SCENARIOS`. Helpers: `reset_sandbox`, `launch <cwd>`, `pick <n>` (n Downs + Enter in the modal: None=0, alpha=4, beta=5), `slash "<cmd>"`, `check <desc> present|absent <regex>`. `check` dumps the screen on failure.

## Rules

- Prove the test can fail: break the feature once (e.g. comment out the call under test), see the scenario go red, restore.
- Read the screen with `tmux capture-pane -t sps-real -p` when debugging; never add or delete anything in the real `~/.omp`.
- The script is deterministic: `launch` waits for the modal or banner, and `check` retries for up to 5 seconds before failing.
- `SPS_SANDBOX` must be under `/tmp`: the script refuses anything else, because it runs `rm -rf` on it.
