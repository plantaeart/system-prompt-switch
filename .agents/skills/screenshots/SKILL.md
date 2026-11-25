---
name: screenshots
description: Use when the README screenshots or demo GIFs are out of date or a change touches what the user sees (startup modal, banner, editor, slash command output) - shots.sh drives a real omp TUI in tmux inside a sandbox HOME and renders each screen to a PNG in assets/imgs; gifs.sh records scripted scenes to GIFs in assets/gifs. omp only; run real-session-test for behaviour, this skill for pictures.
---

# screenshots

Takes README screenshots of the real omp TUI running the working-tree extension. Fake sandbox data only, so no personal paths or prompts end up in a picture. No model, login or network is needed.

## Run

```bash
bash .agents/skills/screenshots/scripts/shots.sh --list              # shot names
bash .agents/skills/screenshots/scripts/shots.sh                     # all shots -> assets/imgs/<name>.png
bash .agents/skills/screenshots/scripts/shots.sh banner modal        # only these
SPS_SHOTS_OUT=/tmp/try bash .agents/skills/screenshots/scripts/shots.sh banner   # other output dir
```

Needs `tmux`, `omp` and `python3` with Pillow on PATH. Inside `nix develop`/direnv Pillow is there; for an editor language server (basedpyright) or plain Python create the venv that `pyrightconfig.json` points at: `uv venv .venv && uv pip install --python .venv/bin/python pillow` (gitignored). Fonts (Fira Code, Symbols Nerd Font, Noto Sans Mono, Symbola) and the Twemoji bitmap font are read from `/usr/share/fonts`; Pillow cannot draw the COLRv1 Noto Color Emoji, hence Twemoji.

**Always open every PNG afterwards** and look for clipped text, missing glyphs, personal paths and wrong state. A shot that did not reach its screen fails with the last lines of the pane.

## How it works

1. `fresh` resets the sandbox (`/tmp/sps-shots`, refuses any other prefix: it runs `rm -rf`) and seeds `projA` with the rich `alpha.md` and short `beta.md` from `real-session-test/scripts/seed/`, plus a global `reviewer.md`.
2. `shot_<name>` starts omp (`launch`, same helpers as `real-session-test/scripts/lib.sh`) and drives the keys.
3. Where the input area is visible, the shot types a friendly line with emoji (`$HELLO`, `$HELLO2`) without pressing Enter, so nothing goes to a model.
4. `snap <name> <wait-regex> <from-regex>` waits for the screen, captures `tmux capture-pane -e`, and `render-ansi.py` draws it (SGR colours, wide glyphs, emoji, cursor, window chrome). `<from-regex>` hides the omp splash above the first matching line.

## Add or change a shot

Add `shot_<name>() { fresh; launch "$S/projA"; <keys>; snap <name> "<wait>" "<from>"; }` to `scripts/shots.sh` (underscores in the function are dashes in the file and on the command line). Key helpers: `tick n`, `save`, `pick n`, `slash "<cmd>"`, `open_editor`, `say "<text>"`, `key <tmux keys>`. Modal rows: Done=0, None=1, `alpha`=2, `beta`=3, `reviewer`=4, then the three "Create new" rows.

## Shots

| Name | Shows |
|---|---|
| `modal` | startup modal |
| `modal-multi` | two prompts ticked |
| `preview` | Tab preview of `alpha.md` |
| `banner` | active prompt above the input, friendly text typed |
| `banner-stack` | local + global prompt stacked |
| `select-names` | `/sps-select beta.md alpha.md` |
| `inject` | `/sps-inject` list |
| `inject-done` | `/sps-inject` result message |
| `new` | `/sps-new` file name, friendly name typed |
| `new-scope` | `/sps-new` destination choice |
| `new-editor` | `/sps-new` editor with typed text |
| `edit` | `/sps-edit` picker |
| `edit-editor` | `/sps-edit` editor with key hints and typed text |
| `empty-save` | "Save empty prompt" confirmation |
| `delete` | `/sps-delete` |
| `move` | `/sps-move` |
| `mode` | `/sps-mode replace` |
| `info` | `/sps-info` |
| `path` | `/sps-path` |
| `logs` | `/sps-logs 8` |
| `missing-default` | modal again after the default file was deleted |

## Demo GIFs: `gifs.sh`

```bash
bash .agents/skills/screenshots/scripts/gifs.sh --list            # gif names (same as the README file names)
bash .agents/skills/screenshots/scripts/gifs.sh                   # all -> assets/gifs/<name>.gif
bash .agents/skills/screenshots/scripts/gifs.sh delete-sys-prompt # only this one
SPS_GIFS_OUT=/tmp/try SPS_GIF_WIDTH=720 bash .agents/skills/screenshots/scripts/gifs.sh get-info
```

Also needs `ffmpeg`. Not a screen recorder: a scene types the keys, and `frame <seconds>` grabs the pane after each step (the same `tmux capture-pane -e`). Afterwards each capture is rendered by `render-ansi.py --fixed 100x30` (whole pane, same size every frame, square corners) and `ffmpeg` joins them with the given hold times into a palette GIF (12 fps, 900 px wide). Because frames are explicit, the GIF is deterministic and its pace is chosen by the scene, not by how fast the host redraws.

Add a scene: `gif_<name>() { fresh; launch "$S/projA"; pick 2; rec_start; frame 1; ...; rec_end <name>; }` to `scripts/gifs.sh`. Helpers on top of the shot ones: `typed "<text>"` (one frame per character), `slash_typed "/sps-x"` (types, Enter), `press <keys>` (send + frame, `HOLD=<s>` to hold longer), `frame <s>`, `await "<regex>"` before a frame that needs a state. Scenes: `select-create-sys-prompt`, `update-created-sys-prompt`, `inject-prompts`, `get-info`, `delete-sys-prompt`. Look at several frames of each GIF afterwards: `ffmpeg -i x.gif -vf "fps=1/2,scale=450:-1,tile=3x3" -frames:v 1 sheet.png`.

## Rules

- Output goes to `assets/imgs/` (PNG) and `assets/gifs/` (GIF) by default: that overwrites the committed files, so review them before committing.
- Never point it at the real `~/.omp`; the sandbox sets its own `HOME` and `setupVersion: 3` (see `real-session-test`).
- The renderer is a Pillow script, not a terminal: if omp starts drawing a new glyph, add it to `render-ansi.py` rather than editing a PNG by hand.
