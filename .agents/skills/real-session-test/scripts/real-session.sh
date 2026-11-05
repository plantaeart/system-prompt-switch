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
	echo "setupVersion: 2" > "$S/home/.omp/agent/config.yml" # skips the first-run wizard
	echo "You are ALPHA." > "$S/projA/.agents/system-prompts-switch/alpha.md"
	echo "You are BETA."  > "$S/projA/.agents/system-prompts-switch/beta.md"
}
# launch <cwd>: starts omp, waits until the screen shows the modal or the banner.
launch() {
	tmux kill-session -t $T 2>/dev/null
	tmux new-session -d -s $T -x 160 -y 45 -c "$1" "env HOME=$S/home omp -e $REPO/extensions/index.ts"
	for _ in $(seq 40); do sleep 0.5; screen | grep -qE "System Prompt for this Session|Active Prompt:" && return 0; done
	echo "timeout waiting for startup"; screen; return 1
}
screen() { tmux capture-pane -t $T -p; }
settle() { sleep 1.5; }
# pick <n>: n Downs then Enter in the startup modal. Rows: None, 3x create, then prompts (alpha=4, beta=5).
pick() { for _ in $(seq "$1"); do tmux send-keys -t $T Down; done; tmux send-keys -t $T Enter; settle; }
slash() { tmux send-keys -t $T "$1" Enter; settle; }
check() { # check <desc> <present|absent> <regex>; retries up to 5s so a slow redraw is not a false failure
	for _ in $(seq 10); do
		if screen | grep -qE "$3"; then got=present; else got=absent; fi
		[ "$got" = "$2" ] && break
		sleep 0.5
	done
	if [ "$got" = "$2" ]; then echo "  ok   $1"; else echo "  FAIL $1 (expected $2: $3)"; FAILS=$((FAILS+1)); screen | grep -v '^\s*$' | tail -12; fi
}
MODAL="System Prompt for this Session"

s_default_applies() {
	echo "[default applies on next session, last choice wins, per project]"
	reset_sandbox
	launch "$S/projA"; check "first session shows modal" present "$MODAL"
	pick 4;            check "alpha activated" present "Active Prompt: \[local\] alpha.md"
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
	launch "$S/projA"; pick 0; check "none chosen" present "Active Prompt: \(none\)"
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
	launch "$S/projA"; pick 4
	rm "$S/projA/.agents/system-prompts-switch/alpha.md"
	launch "$S/projA"; check "modal shown" present "$MODAL"
	check "warns" present "no longer exists"
}

SCENARIOS=("$@"); [ ${#SCENARIOS[@]} -eq 0 ] && SCENARIOS=(s_default_applies s_none_is_default s_dismiss_no_default s_missing_file)
for sc in "${SCENARIOS[@]}"; do "$sc"; done
tmux kill-session -t $T 2>/dev/null
[ $FAILS -eq 0 ] && echo "ALL OK" || { echo "$FAILS FAILED"; exit 1; }
