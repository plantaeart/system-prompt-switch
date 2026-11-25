#!/usr/bin/env bash
# README screenshots of the REAL omp TUI running the working-tree extension, in a sandbox HOME (never touches ~/.omp).
# Usage: shots.sh [--list] [shot-name...]   (default: all shots)   env: SPS_SHOTS_OUT=<dir> (default assets/imgs)
SPS_COLS=110 SPS_ROWS=40
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
OUT="${SPS_SHOTS_OUT:-$REPO/assets/imgs}"
mkdir -p "$OUT"
# snap <name> <wait-regex> <from-regex>: wait for the screen, then render it from the first line matching <from-regex>.
snap() {
	await "$2" || return 1
	sleep 0.5
	local f cur; f="$(mktemp /tmp/sps-shots.XXXXXX)"
	tmux capture-pane -t $T -e -p > "$f"
	cur="$(cursor_arg "$f")"
	if python3 "$HERE/render-ansi.py" "$f" "$OUT/$1.png" --from "$3" --title "omp" ${cur:+--cursor "$cur"}; then
		echo "  wrote $OUT/$1.png"
	else
		echo "  FAIL render: $1"; FAILS=$((FAILS+1))
	fi
	rm -f "$f"
}
FROM_MODAL="Select System Prompt"
FROM_BANNER="Active system prompt"

shot_modal()        { fresh; launch "$S/projA"; snap modal "$FROM_MODAL" "$FROM_MODAL"; }
shot_modal_multi()  { fresh; launch "$S/projA"; tick 2; key Down Down; key Space; snap modal-multi "\[✓\] \[omp\] reviewer" "$FROM_MODAL"; }
shot_preview()      { fresh; launch "$S/projA"; key Down Down Tab; snap preview "Preview: " "Preview: "; }
shot_banner()       { fresh; launch "$S/projA"; pick 2; say "$HELLO"; snap banner "Active Prompt:" "$FROM_BANNER"; }
shot_banner_stack() { fresh; launch "$S/projA"; tick 2; key Down Down; key Space; save; say "$HELLO2"; snap banner-stack "reviewer.md" "$FROM_BANNER"; }
shot_select_names() { fresh; launch "$S/projA"; pick 2; slash "/sps-select beta.md alpha.md"; snap select-names "beta.md \+ \[local\] alpha.md" "$FROM_BANNER"; }
shot_inject()       { fresh; launch "$S/projA"; pick 2; slash "/sps-inject"; key Down Down Down; snap inject "Cumulative Prompt Inject" "Cumulative Prompt Inject"; }
shot_inject_done()  { fresh; launch "$S/projA"; pick 2; slash "/sps-inject"; key Down Down Down; key Enter; snap inject-done "Injected" "$FROM_BANNER"; }
shot_new()          { fresh; launch "$S/projA"; pick 2; slash "/sps-new"; say "friendly-writer.md"; snap new "Enter prompt file name" "Enter prompt file name"; }
shot_new_scope()    { fresh; launch "$S/projA"; pick 2; slash "/sps-new"; say "friendly-writer.md"; key Enter; snap new-scope "Choose destination" "Choose destination"; }
shot_new_editor()   { fresh; launch "$S/projA"; pick 2; slash "/sps-new"; say "friendly-writer.md"; key Enter; key Enter; key C-End; key Enter; key Enter; say "This is my brand new system prompt :D 🚀"; snap new-editor "Create: " "Create: "; }
shot_edit()         { fresh; launch "$S/projA"; pick 2; slash "/sps-edit"; snap edit "Select prompt to edit" "Select prompt to edit"; }
shot_edit_editor()  { fresh; launch "$S/projA"; pick 2; slash "/sps-edit"; key Down; key Enter; key C-End; key Enter; key Enter; say "$HELLO"; snap edit-editor "Edit: beta.md" "Edit: beta.md"; }
shot_empty_save()   { fresh; echo "You are ALPHA." > "$S/projA/.agents/system-prompts-switch/alpha.md"; launch "$S/projA"; pick 2; open_editor; for _ in $(seq 24); do tmux send-keys -t $T BSpace; done; key C-s; snap empty-save "Save empty prompt" "Save empty prompt"; }
shot_delete()       { fresh; launch "$S/projA"; pick 2; slash "/sps-delete"; key Enter; snap delete "Confirm Deletion" "Confirm Deletion"; }
shot_move()         { fresh; launch "$S/projA"; pick 2; slash "/sps-move"; key Enter; snap move "Move \"alpha.md\" to" "Move \"alpha.md\" to"; }
shot_mode()         { fresh; launch "$S/projA"; pick 2; slash "/sps-mode replace"; snap mode "replace" "$FROM_BANNER"; }
shot_info()         { fresh; launch "$S/projA"; pick 2; slash "/sps-info"; snap info "System Prompt Switch" "$FROM_BANNER"; }
shot_path()         { fresh; launch "$S/projA"; pick 2; slash "/sps-path"; snap path "alpha.md" "$FROM_BANNER"; }
shot_logs()         { fresh; launch "$S/projA"; pick 2; slash "/sps-logs 8"; snap logs "log|Log" "$FROM_BANNER"; }
shot_missing_default() { fresh; launch "$S/projA"; pick 2; rm "$S/projA/.agents/system-prompts-switch/alpha.md"; launch "$S/projA"; snap missing-default "no longer exist" "no longer exist|$FROM_MODAL"; }

ALL=$(declare -F | sed -n 's/^declare -f shot_//p')
if [ "${1:-}" = "--list" ]; then echo "$ALL" | tr '_' '-'; exit 0; fi
SHOTS=("$@"); [ ${#SHOTS[@]} -eq 0 ] && SHOTS=($(echo "$ALL" | tr '_' '-'))
for s in "${SHOTS[@]}"; do
	fn="shot_${s//-/_}"
	declare -F "$fn" >/dev/null || { echo "unknown shot: $s (see --list)"; FAILS=$((FAILS+1)); continue; }
	echo "[$s]"; "$fn"
done
tmux kill-session -t $T 2>/dev/null
rm -rf "$S"
[ $FAILS -eq 0 ] && echo "ALL OK" || { echo "$FAILS FAILED"; exit 1; }
