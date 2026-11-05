#!/usr/bin/env bash
# Prints the release procedure (command-only template) filled with real values.
# Runs nothing destructive: it only reads git/package.json and prints commands.
# Usage: release-plan.sh ["commit message"]   (branch = current branch)
set -eu
cd "$(git rev-parse --show-toplevel)"

PKG=$(sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' package.json | head -1)
VER=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)
BRANCH=$(git branch --show-current)
BASE=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)
BASE=${BASE:-master}
MSG=${1:-"chore: release v$VER"}

if [ "$BRANCH" = "$BASE" ]; then echo "You are on $BASE; create a feature branch first." >&2; exit 1; fi

cat <<PLAN
# Release $PKG v$VER  (branch $BRANCH -> $BASE)

# 1. Commit and publish the branch
git status --short
git add -A
git commit -m "$MSG"
git push -u origin $BRANCH

# 2. Open the PR, wait for CI + review, then "Rebase and merge"
gh pr create --base $BASE --head $BRANCH --title "$MSG" --fill
gh pr checks --watch
gh pr merge --rebase

# 3. Back to $BASE and pull (rebase-merge rewrites hashes: drop the old local branch)
git checkout $BASE
git pull --ff-only origin $BASE
git branch -D $BRANCH

# 4. Tag the merged commit and push the tag
bash .agents/skills/bump-version/scripts/bump-version.sh --tag
git push origin v$VER

# 5. npm: login, dry-run, publish
npm whoami || npm login
npm publish --dry-run --access public
npm publish --access public

# 6. Verify
npm view $PKG version
npm view $PKG dist.tarball
PLAN
