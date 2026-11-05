#!/usr/bin/env bash
# Branch + commit + push + PR in one go, from the current working-tree changes.
# Run ONLY after the user approved the plan (see SKILL.md "Open a PR").
# Usage: open-pr.sh [--plan] <branch> "<title>" "<why>" "<done 1>" ["<done 2>" ...]
#   --plan  prints what would happen and changes nothing (use it to build the approval question).
set -eu
cd "$(git rev-parse --show-toplevel)"
PLAN=0; [ "${1:-}" = "--plan" ] && { PLAN=1; shift; }
[ $# -ge 4 ] || { echo "usage: open-pr.sh [--plan] <branch> <title> <why> <done>..." >&2; exit 2; }
BRANCH=$1; TITLE=$2; WHY=$3; shift 3

git fetch -q origin
BASE=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true); BASE=${BASE:-master}
[ -n "$(git status --porcelain)" ] || { echo "no changes to commit" >&2; exit 1; }
git rev-parse --verify -q "refs/heads/$BRANCH" >/dev/null && { echo "branch $BRANCH already exists" >&2; exit 1; }
BODY=/tmp/pr-body-${BRANCH//\//-}.md
{ printf '## Why\n%s\n\n## What was done\n' "$WHY"; printf -- '- %s\n' "$@"; } > "$BODY"

echo "base:    origin/$BASE"; echo "branch:  $BRANCH"; echo "commit:  $TITLE"; echo "files:"; git status --short | sed 's/^/  /'
echo "--- PR body ($BODY) ---"; cat "$BODY"
[ $PLAN -eq 1 ] && exit 0

git switch -c "$BRANCH" "origin/$BASE"
git add -A
git commit -q -m "$TITLE"
git push -q -u origin "$BRANCH"
gh pr create --base "$BASE" --head "$BRANCH" --title "$TITLE" --body-file "$BODY"
