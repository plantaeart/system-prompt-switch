#!/usr/bin/env bash
# Opens a REAL omp against the working-tree extension in a throwaway HOME + project.
# Everything lives in a mktemp dir under /tmp, kept across omp restarts and deleted on quit (any way out).
# Never touches ~/.omp. Usage: manual-session.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
command -v omp >/dev/null || { echo "need omp on PATH"; exit 2; }

S="$(mktemp -d /tmp/sps-manual.XXXXXX)"
trap 'rm -rf "$S"; echo "sandbox removed: $S"' EXIT
trap exit HUP TERM # closing the terminal still runs the EXIT cleanup

mkdir -p "$S/home/.omp/agent" "$S/proj/.agents/system-prompts-switch"
echo "setupVersion: 3" > "$S/home/.omp/agent/config.yml" # skips the first-run wizard
echo "You are ALPHA." > "$S/proj/.agents/system-prompts-switch/alpha.md"
echo "You are BETA."  > "$S/proj/.agents/system-prompts-switch/beta.md"

echo "sandbox: $S (deleted when you quit). defaults.json lands under $S/home/.omp/agent/"
cd "$S/proj" || exit 1

# The sandbox survives omp restarts, so persistence (defaults, -c, -r) can be tested; only [q] deletes it.
mode=""
while true; do
	HOME="$S/home" omp $mode -e "$REPO/extensions/index.ts"
	read -r -n1 -p $'\nomp exited. [Enter] new session  [c] omp -c  [r] omp -r  [q] quit and delete sandbox: ' key || break
	echo
	case "$key" in c) mode=-c ;; r) mode=-r ;; q | Q) break ;; *) mode="" ;; esac
done
