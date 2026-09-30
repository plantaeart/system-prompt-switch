#!/usr/bin/env bash
# Compare the host CLI versions pinned in CI against what is published,
# and against what is installed locally.
#
# CI installs the hosts at exact versions so a green badge means something.
# This script answers two questions:
#   1. Has a newer release been published than the pin?
#   2. Does my local machine run the same versions CI does?
#
# Exits 0 when the pin matches the latest release, 1 when a newer release
# exists. A stale pin is not a failure of the code, so the message says so.
#
# Usage: bash .agents/skills/host-version/scripts/check-host-versions.sh
set -uo pipefail

# scripts/ -> host-version/ -> skills/ -> .agents/ -> repo root
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
WORKFLOW="${ROOT_DIR}/.github/workflows/ci.yml"

# The two packages CI installs, and the newest tag on npm.
declare -a PACKAGES=(
	"@earendil-works/pi-coding-agent"
	"@oh-my-pi/pi-coding-agent"
)

pinned_version() {
	# Strip up to the last "@": the package name itself starts with "@".
	grep -o "${1}@[0-9][0-9.]*" "${WORKFLOW}" | head -n 1 | sed 's/.*@//'
}

local_version() {
	command -v "$1" >/dev/null 2>&1 || return 1
	"$1" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1
}

status=0
printf '%-34s %-10s %-10s %s\n' "PACKAGE" "PINNED" "LATEST" "STATE"
printf '%s\n' "----------------------------------------------------------------------"

for pkg in "${PACKAGES[@]}"; do
	pinned="$(pinned_version "${pkg}" || echo '?')"
	latest="$(npm view "${pkg}" version 2>/dev/null || echo '?')"

	if [ "${pinned}" = "${latest}" ]; then
		state="up to date"
	elif [ "${pinned}" = "?" ]; then
		state="NOT PINNED"
		status=1
	else
		state="OUTDATED -> ${latest}"
		status=1
	fi

	printf '%-34s %-10s %-10s %s\n' "${pkg}" "${pinned}" "${latest}" "${state}"
done

printf '%s\n' ""
echo "Local installs (CI uses the pinned values above):"
for bin in pi omp; do
	if local="$(local_version "${bin}")"; then
		printf '  %-4s %s\n' "${bin}" "${local}"
	else
		printf '  %-4s %s\n' "${bin}" "not installed"
	fi
done

if [ "${status}" -ne 0 ]; then
	echo ""
	echo "A pin is behind the latest release. This is not a code failure."
	echo "To refresh, install the newer version, update the two @version pins in"
	echo "${WORKFLOW#"${ROOT_DIR}"/}, and commit."
fi

exit "${status}"
