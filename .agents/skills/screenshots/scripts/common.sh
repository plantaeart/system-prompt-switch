#!/usr/bin/env bash
# Shared by shots.sh and gifs.sh (source it): real omp in tmux inside a sandbox HOME, never touches ~/.omp.
# The caller exports SPS_COLS / SPS_ROWS (pane size) before sourcing.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$REPO/.agents/skills/real-session-test/scripts"
S="${SPS_SANDBOX:-/tmp/sps-shots}"
HOST=omp ENTRY=extensions/index.ts T=sps-shots
export SPS_COLS SPS_ROWS
FAILS=0
# Ctrl+C or a crash must not leave the tmux session or a half-written frame directory behind (W is set by gifs.sh).
trap 'tmux kill-session -t $T 2>/dev/null; [ -n "${W:-}" ] && rm -rf "$W"' EXIT
# reset_sandbox runs rm -rf on $S: never accept a path outside /tmp.
case "$S" in /tmp/?*) ;; *) echo "SPS_SANDBOX must be a directory under /tmp (got: $S)"; exit 2 ;; esac
. "$LIB/lib.sh"

# Friendly text typed into the visible input area, as in the old screenshots.
HELLO="Nice, I can manage my system prompts now ! 🎉"
HELLO2="And it is per session too ! :) ✨"

command -v tmux >/dev/null && command -v omp >/dev/null && python3 -c "import PIL" 2>/dev/null || { echo "need tmux, omp and python3 Pillow"; exit 2; }

# fresh: clean sandbox with the rich seed prompts: alpha (long, markdown) + beta local, reviewer global.
fresh() {
	reset_sandbox
	cp "$LIB/seed/alpha.md" "$LIB/seed/beta.md" "$S/projA/.agents/system-prompts-switch/"
	mkdir -p "$S/home/.omp/agent/system-prompts-switch"
	printf '# Friendly Reviewer\n\nYou review code kindly and precisely.\n' > "$S/home/.omp/agent/system-prompts-switch/reviewer.md"
}
await() { # await <regex>: wait up to 10s for the screen to match
	for _ in $(seq 20); do screen | grep -qE "$1" && return 0; sleep 0.5; done
	echo "  FAIL waiting for: $1"; screen | grep -v '^\s*$' | tail -15; FAILS=$((FAILS+1)); return 1
}
say() { tmux send-keys -t $T -l "$1"; sleep 0.5; }
key() { tmux send-keys -t $T "$@"; sleep 0.4; }
# cursor_arg <ansi-file>: prints "x,y" when the real cursor sits on omp's input line, nothing otherwise.
# omp parks the real cursor in odd places while a modal/editor is open: only the input line (starts with ╰─, no ╯:
# a boxed dialog also ends with ╰─) is trustworthy.
cursor_arg() {
	local cx cy; read -r cx cy <<< "$(tmux display -p -t $T '#{cursor_x} #{cursor_y}')"
	sed -n "$((cy+1))p" "$1" | sed 's/\x1b\[[0-9;]*m//g' | grep '^╰─' | grep -vq '╯' && echo "$cx,$cy"
}
