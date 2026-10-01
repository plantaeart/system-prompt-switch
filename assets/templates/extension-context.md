# System Prompt Switch (extension context)

This extension manages per-session system prompt overrides. When the user asks about their system prompt, custom prompts, or where a prompt file lives, look here first.

- **Active prompt(s):** {activePrompts}
- **Mode:** {mode} (`append` keeps the base instructions, `replace` uses the prompt as the base)
- **Prompt file locations** (scopes shown in the modals and the above-editor banner):
  - `[local]` — this repo: `.agents/system-prompts-switch/*.md`
  - `[omp]` — this machine's omp home: `~/.omp/agent/system-prompts-switch/*.md`
  - `[pi]` — this machine's pi home: `~/.pi/agent/system-prompts-switch/*.md`
- **Commands:** `/sps-select` (pick the active prompt), `/sps-inject` (add prompts for the next message only), `/sps-new`, `/sps-edit`, `/sps-delete`, `/sps-move` (move a prompt file to another scope), `/sps-mode [append|replace]`, `/sps-info`, `/sps-path` (print absolute file paths), `/sps-logs [lines]`
- The user's active prompt is included below as a `### [scope] name` chunk. Read that chunk first when the user asks "what's my prompt" or "tail the append system prompt".
