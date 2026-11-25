#!/usr/bin/env bash
# Drives a REAL Pi or OMP TUI (tmux) against the working-tree extension, in a sandbox HOME.
# Never touches ~/.omp or ~/.pi. Usage: [SPS_HOST=omp|pi] real-session.sh [scenario-name...]  (default host omp, all scenarios)
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
S="${SPS_SANDBOX:-/tmp/sps-sandbox}"
HOST="${SPS_HOST:-omp}"
case "$HOST" in omp) ENTRY=extensions/index.ts ;; pi) ENTRY=extensions/pi.ts ;; *) echo "SPS_HOST must be omp or pi (got: $HOST)"; exit 2 ;; esac
T=sps-real
FAILS=0
command -v tmux >/dev/null && command -v "$HOST" >/dev/null || { echo "need tmux + $HOST on PATH"; exit 2; }
# reset_sandbox runs rm -rf on $S: never accept a path outside /tmp.
case "$S" in /tmp/?*) ;; *) echo "SPS_SANDBOX must be a directory under /tmp (got: $S)"; exit 2 ;; esac

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
	tmux new-session -d -s $T -x 160 -y 45 -c "$1" "env $unset_env HOME=$S/home VISUAL=$S/ed.sh EDITOR=$S/ed.sh $HOST -e $REPO/$ENTRY"
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
check() { # check <desc> <present|absent> <regex>; retries up to 5s so a slow redraw is not a false failure
	for _ in $(seq 10); do
		if screen | grep -qE "$3"; then got=present; else got=absent; fi
		[ "$got" = "$2" ] && break
		sleep 0.5
	done
	if [ "$got" = "$2" ]; then echo "  ok   $1"; else echo "  FAIL $1 (expected $2: $3)"; FAILS=$((FAILS+1)); screen | grep -v '^\s*$' | tail -12; fi
}
MODAL="Select System Prompt"
# Esc as the Kitty keyboard protocol sends it (CSI 27 u); the _caps form carries caps lock (modifier 65).
kitty_esc() { tmux send-keys -t $T -H 1b 5b 32 37 75; settle; }
kitty_esc_caps() { tmux send-keys -t $T -H 1b 5b 32 37 3b 36 35 75; settle; }
# /sps-edit on alpha (first row), waits for the editor.
open_editor() { slash "/sps-edit"; tmux send-keys -t $T Enter; settle; }
file_has() { # file_has <desc> <file> <regex>
	if grep -qE "$3" "$2"; then echo "  ok   $1"; else echo "  FAIL $1 ($3 not in $2)"; FAILS=$((FAILS+1)); cat -A "$2" | head -5; fi
}

s_default_applies() {
	echo "[default applies on next session, last choice wins, per project]"
	reset_sandbox
	launch "$S/projA"; check "first session shows modal" present "$MODAL"
	pick 2;            check "alpha activated" present "Active Prompt: \[local\] alpha.md"
	launch "$S/projA"; check "2nd session: no modal" absent "$MODAL"
	check "2nd session: alpha applied" present "Active Prompt: \[local\] alpha.md"
	slash "/sps-select beta.md"; check "select beta" present "Active Prompt: \[local\] beta.md"
	launch "$S/projA"; check "3rd session: beta (last wins)" present "Active Prompt: \[local\] beta.md"
	check "3rd session: no modal" absent "$MODAL"
	launch "$S/projB"; check "other project still asks" present "$MODAL"
}
s_none_is_default() {
	echo "[(None) becomes the default]"
	reset_sandbox
	launch "$S/projA"; save; check "none chosen" present "Active Prompt: \(none\)"
	launch "$S/projA"; check "next session silent" absent "$MODAL"
	check "next session: no prompt" present "Active Prompt: \(none\)"
}
s_dismiss_no_default() {
	echo "[dismissed modal sets no default]"
	reset_sandbox
	launch "$S/projA"; tmux send-keys -t $T Escape; settle
	launch "$S/projA"; check "modal again" present "$MODAL"
}
s_missing_file() {
	echo "[deleted default file -> warning + modal]"
	reset_sandbox
	launch "$S/projA"; pick 2
	rm "$S/projA/.agents/system-prompts-switch/alpha.md"
	launch "$S/projA"; check "modal shown" present "$MODAL"
	check "warns" present "no longer exist"
}
s_multi_default() {
	echo "[several ticked prompts: banner, default, /sps-select names]"
	reset_sandbox
	launch "$S/projA"; tick 2; tmux send-keys -t $T Down; tmux send-keys -t $T Space; save
	check "both active" present "Active Prompt: \[local\] alpha.md \+ \[local\] beta.md"
	launch "$S/projA"; check "2nd session: no modal" absent "$MODAL"
	check "2nd session: both applied" present "Active Prompt: \[local\] alpha.md \+ \[local\] beta.md"
	slash "/sps-select none"; check "none clears" present "Active Prompt: \(none\)"
	slash "/sps-select beta.md alpha.md"; check "names select several, in order" present "Active Prompt: \[local\] beta.md \+ \[local\] alpha.md"
	slash "/sps-select beta.md nope.md"; check "unknown name changes nothing" present "No system prompt named"
	check "banner unchanged" present "Active Prompt: \[local\] beta.md \+ \[local\] alpha.md"
}
s_inject_one_turn() {
	echo "[/sps-inject is not saved as the project default]"
	reset_sandbox
	launch "$S/projA"; pick 2
	slash "/sps-inject"; for _ in 1 2 3; do tmux send-keys -t $T Down; done; tmux send-keys -t $T Enter; settle
	launch "$S/projA"; check "next session: default is still alpha only" present "Active Prompt: \[local\] alpha.md \(append"
}
s_rename_active() {
	echo "[Ctrl+N rename keeps the active prompt and the default in sync]"
	reset_sandbox
	launch "$S/projA"; pick 2
	slash "/sps-edit"; tmux send-keys -t $T C-n; sleep 1; tmux send-keys -t $T "gamma" Enter; settle
	tmux send-keys -t $T Escape; settle
	check "banner follows the rename" present "Active Prompt: \[local\] gamma.md"
	check "file renamed on disk" present "Renamed prompt"
	[ -f "$S/projA/.agents/system-prompts-switch/gamma.md" ] || { echo "  FAIL gamma.md missing on disk"; FAILS=$((FAILS+1)); }
	launch "$S/projA"; check "next session applies the new name" present "Active Prompt: \[local\] gamma.md"
}

s_preview_keys() {
	echo "[Tab previews a prompt, Esc (plain and Kitty encoded) leaves the preview, a second Esc dismisses the modal]"
	reset_sandbox
	launch "$S/projA"; tmux send-keys -t $T Down Down Tab; settle
	check "preview opens" present "Preview: \[local\] alpha.md"
	check "preview shows the prompt body" present "You are ALPHA"
	tmux send-keys -t $T Escape; settle
	check "plain Esc returns to the list" absent "Preview: "
	check "modal still open" present "$MODAL"
	tmux send-keys -t $T Tab; settle; check "preview opens again" present "Preview: \[local\] alpha.md"
	kitty_esc; check "Kitty Esc returns to the list" absent "Preview: "
	kitty_esc; settle; check "Kitty Esc dismisses the modal" absent "$MODAL"
}
s_editor_edit_undo_save() {
	echo "[/sps-edit editor: type mid-word, undo never passes the prefill, Ctrl+S writes the file]"
	reset_sandbox
	launch "$S/projA"; pick 2
	open_editor
	check "editor shows the key hints" present "Ctrl\+Q / Ctrl\+S: Save"
	check "editor shows the prompt" present "You are ALPHA\."
	tmux send-keys -t $T Up End Left Left X; settle
	check "text typed in the middle of a word" present "You are ALPHXA\."
	for _ in $(seq 12); do tmux send-keys -t $T C-z; sleep 0.2; done; settle
	check "undo removed the typing" present "You are ALPHA\."
	check "repeated undo never empties the prefill" absent "ALPHXA"
	tmux send-keys -t $T Up End Left Left Y; settle; tmux send-keys -t $T C-s; settle
	check "saved" present "Updated prompt"
	file_has "file holds the edit" "$S/projA/.agents/system-prompts-switch/alpha.md" "ALPHYA\."
	file_has "file kept the rest" "$S/projA/.agents/system-prompts-switch/alpha.md" "^You are "
}
s_editor_escape_cancels() {
	echo "[Esc cancels the picker and the editor: plain byte, Kitty CSI-u, Kitty with caps lock; file unchanged]"
	reset_sandbox
	launch "$S/projA"; pick 2
	slash "/sps-edit"; check "edit picker opens" present "Select prompt to edit"
	tmux send-keys -t $T Escape; settle; check "plain Esc closes the picker" absent "Select prompt to edit"
	slash "/sps-edit"; kitty_esc; check "Kitty Esc closes the picker" absent "Select prompt to edit"
	for esc in plain kitty kitty_caps; do
		open_editor; tmux send-keys -t $T Up End X; settle
		check "editor open ($esc)" present "Edit: alpha.md"
		case $esc in plain) tmux send-keys -t $T Escape ;; kitty) kitty_esc ;; kitty_caps) kitty_esc_caps ;; esac
		check "$esc Esc closes the editor" absent "Edit: alpha.md"
		check "$esc Esc reports the cancel" present "Edit cancelled"
	done
	file_has "file unchanged by cancelled edits" "$S/projA/.agents/system-prompts-switch/alpha.md" "^You are ALPHA\.$"
}
s_editor_external() {
	echo "[Ctrl+G hands the text to \$VISUAL and takes the result back]"
	reset_sandbox
	launch "$S/projA"; pick 2
	open_editor; tmux send-keys -t $T C-g; sleep 4
	check "external editor result is in the editor" present "EXT-EDITED"
	check "editor is back and usable" present "Ctrl\+Q / Ctrl\+S: Save"
	tmux send-keys -t $T C-s; settle
	file_has "file holds the external edit" "$S/projA/.agents/system-prompts-switch/alpha.md" "EXT-EDITED"
}
s_editor_empty_save_guard() {
	echo "[emptying a prompt asks before saving; declining keeps the file]"
	reset_sandbox
	launch "$S/projA"; pick 2
	open_editor; for _ in $(seq 24); do tmux send-keys -t $T BSpace; done; settle
	check "editor is empty" absent "You are ALPHA"
	tmux send-keys -t $T C-s; settle
	check "asks before saving an empty prompt" present "Save empty prompt"
	tmux send-keys -t $T Escape; settle
	check "declined: file unchanged" present "the file is unchanged"
	file_has "file still has its text" "$S/projA/.agents/system-prompts-switch/alpha.md" "^You are ALPHA\.$"
}

SCENARIOS=("$@"); [ ${#SCENARIOS[@]} -eq 0 ] && SCENARIOS=(s_default_applies s_none_is_default s_dismiss_no_default s_missing_file s_multi_default s_inject_one_turn s_rename_active s_preview_keys s_editor_edit_undo_save s_editor_escape_cancels s_editor_external s_editor_empty_save_guard)
for sc in "${SCENARIOS[@]}"; do "$sc"; done
tmux kill-session -t $T 2>/dev/null
[ $FAILS -eq 0 ] && echo "ALL OK" || { echo "$FAILS FAILED"; exit 1; }
