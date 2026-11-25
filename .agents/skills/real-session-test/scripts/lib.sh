#!/usr/bin/env bash
# Sandbox + tmux helpers shared by real-session.sh and the screenshots skill. Source it, do not run it.
# The caller sets REPO, S (sandbox, under /tmp), HOST, ENTRY and T (tmux session name) first.
# SPS_COLS / SPS_ROWS size the tmux window (default 160x45).
reset_sandbox() {
	tmux kill-session -t $T 2>/dev/null
	rm -rf "$S"
	mkdir -p "$S/home/.omp/agent" "$S/projA/.agents/system-prompts-switch" "$S/projB"
	echo "setupVersion: 3" > "$S/home/.omp/agent/config.yml" # skips the first-run wizard
	echo "You are ALPHA." > "$S/projA/.agents/system-prompts-switch/alpha.md"
	echo "You are BETA."  > "$S/projA/.agents/system-prompts-switch/beta.md"
	printf '#!/bin/sh\necho "EXT-EDITED" >> "$1"\n' > "$S/ed.sh"; chmod +x "$S/ed.sh"
}
# launch <cwd>: starts the host, waits until the screen shows the modal or the banner. PI_*/OMP_* are removed so a run from
# inside an agent session cannot leak its session into the host; VISUAL/EDITOR point at a script that appends EXT-EDITED.
launch() {
	tmux kill-session -t $T 2>/dev/null
	local unset_env; unset_env=$(env | grep -oE '^(PI|OMP)_[A-Za-z0-9_]*' | sed 's/^/-u /' | tr '\n' ' ')
	tmux new-session -d -s $T -x "${SPS_COLS:-160}" -y "${SPS_ROWS:-45}" -c "$1" "env $unset_env HOME=$S/home VISUAL=$S/ed.sh EDITOR=$S/ed.sh $HOST -e $REPO/$ENTRY"
	for _ in $(seq 40); do sleep 0.5; screen | grep -qE "Select System Prompt|Active Prompt:" && return 0; done
	echo "timeout waiting for startup"; screen; return 1
}
screen() { tmux capture-pane -t $T -p; }
settle() { sleep 1.5; }
# Startup modal / /sps-select list rows: Done(0), None(1), prompts (alpha=2, beta=3), 3x create.
# tick <n>: move n rows down from the top and tick that row. save: Ctrl+S. pick <n>: tick row n and save.
tick() { for _ in $(seq "$1"); do tmux send-keys -t $T Down; done; tmux send-keys -t $T Space; }
save() { tmux send-keys -t $T C-s; settle; }
pick() { tick "$1"; save; }
slash() { tmux send-keys -t $T "$1" Enter; settle; }
MODAL="Select System Prompt"
# Esc as the Kitty keyboard protocol sends it (CSI 27 u); the _caps form carries caps lock (modifier 65).
kitty_esc() { tmux send-keys -t $T -H 1b 5b 32 37 75; settle; }
kitty_esc_caps() { tmux send-keys -t $T -H 1b 5b 32 37 3b 36 35 75; settle; }
# /sps-edit on alpha (first row), waits for the editor.
open_editor() { slash "/sps-edit"; tmux send-keys -t $T Enter; settle; }
