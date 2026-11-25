#!/usr/bin/env bash
# Drives a REAL omp TUI (tmux) against the working-tree extension, in a sandbox HOME.
# Never touches ~/.omp. Usage: real-session.sh [scenario-name...]  (default: all)
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
S="${SPS_SANDBOX:-/tmp/sps-sandbox}"
T=sps-real
FAILS=0
command -v tmux >/dev/null && command -v omp >/dev/null || { echo "need tmux + omp on PATH"; exit 2; }
# reset_sandbox runs rm -rf on $S: never accept a path outside /tmp.
case "$S" in /tmp/?*) ;; *) echo "SPS_SANDBOX must be a directory under /tmp (got: $S)"; exit 2 ;; esac

reset_sandbox() {
	tmux kill-session -t $T 2>/dev/null
	rm -rf "$S"
	mkdir -p "$S/home/.omp/agent" "$S/projA/.agents/system-prompts-switch" "$S/projB"
	echo "setupVersion: 3" > "$S/home/.omp/agent/config.yml" # skips the first-run wizard
	echo "You are ALPHA." > "$S/projA/.agents/system-prompts-switch/alpha.md"
	echo "You are BETA."  > "$S/projA/.agents/system-prompts-switch/beta.md"
}
# launch <cwd>: starts omp, waits until the screen shows the modal or the banner.
launch() {
	tmux kill-session -t $T 2>/dev/null
	tmux new-session -d -s $T -x 160 -y 45 -c "$1" "env HOME=$S/home omp -e $REPO/extensions/index.ts"
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

SCENARIOS=("$@"); [ ${#SCENARIOS[@]} -eq 0 ] && SCENARIOS=(s_default_applies s_none_is_default s_dismiss_no_default s_missing_file s_multi_default s_inject_one_turn s_rename_active)
for sc in "${SCENARIOS[@]}"; do "$sc"; done
tmux kill-session -t $T 2>/dev/null
[ $FAILS -eq 0 ] && echo "ALL OK" || { echo "$FAILS FAILED"; exit 1; }
