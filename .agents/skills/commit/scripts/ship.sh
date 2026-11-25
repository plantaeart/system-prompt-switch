#!/usr/bin/env bash
# Print (never run) the git/gh commands that ship this change. One subcommand per step of the commit skill:
#   info "<msg>"                       message, version move and tag, branch, base
#   commit "<msg>"                     add + commit on the current branch (+ tag only when that branch is the base branch)
#   push                               push the current branch (to its configured push remote, e.g. a PR author's fork) and tags at HEAD; warns about local tags origin lacks
#   suggest-branch "<msg>"             release/vX.Y.Z when the version moved, else <type>/<short-slug>
#   branch <name> "<msg>"              switch -c + add + commit (no tag: the tag comes after the merge)
#   pr <branch> "<title>" <body-file|-> [--draft]    push + gh pr create (body from a file, or stdin with -)
#   tag-after-merge                    switch to base, pull, tag the new version, push the tag
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.."

die() { echo "FAIL: $*" >&2; exit 2; }
# Single quotes survive any text ($, backticks, double quotes); an inner ' becomes '\''.
quote() { printf "'%s'" "${1//\'/\'\\\'\'}"; }
one_line() { [ -n "${1:-}" ] || die "$2"; case "$1" in *$'\n'*) die "the message/title must be one line" ;; esac; }

now=$(node -p "require('./package.json').version")
before=$(git show HEAD:package.json 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version" 2>/dev/null || true)
bumped=0
[ -n "$before" ] && [ "$before" != "$now" ] && bumped=1
branch=$(git branch --show-current)
base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | cut -d/ -f2- || true)
base=${base:-master}

# This repo's history writes the version at the end of the message: "feat: <summary> (vX.Y.Z)".
warn_release() {
  [ "$bumped" = 1 ] || return 0
  case "$1" in *"(v$now)") ;; *) echo "WARN: version $before -> $now: end the message with \"(v$now)\"" >&2 ;; esac
}

suggest_branch() {
  if [ "$bumped" = 1 ]; then echo "release/v$now"; return; fi
  local type=${1%%:*} slug
  case "$type" in feat | fix | chore | docs | refactor | test) ;; *) type=change ;; esac
  slug=$(printf %s "${1#*: }" | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9' '-' | cut -c1-40)
  slug=${slug#-}; slug=${slug%-}
  echo "$type/${slug:-change}"
}

case "${1:-}" in
  info)
    one_line "${2:-}" 'usage: ship.sh info "<message>"'
    echo "message: $2"
    if [ "$bumped" = 1 ]; then echo "version: $before -> $now (tag v$now, after the merge)"; else echo "version: $now (no bump, no tag)"; fi
    echo "branch:  ${branch:-detached}"
    echo "base:    $base"
    ;;
  commit)
    one_line "${2:-}" 'usage: ship.sh commit "<message>"'
    warn_release "$2"
    cmd="git add -A && git commit -m $(quote "$2")"
    # Rebase-merging a PR rewrites its commits, so a tag made on a PR branch would point at a commit that no longer exists:
    # tag here only when committing straight on the base branch; otherwise use `tag-after-merge`.
    if [ "$bumped" = 1 ] && [ "$branch" = "$base" ]; then
      if git rev-parse -q --verify "refs/tags/v$now" >/dev/null; then
        echo "NOTE: tag v$now already exists, not adding it" >&2
      else
        cmd="$cmd && git tag v$now"
      fi
    fi
    echo "$cmd"
    ;;
  suggest-branch)
    one_line "${2:-}" 'usage: ship.sh suggest-branch "<message>"'
    suggest_branch "$2"
    ;;
  branch)
    [ -n "${2:-}" ] || die 'usage: ship.sh branch <name> "<message>"'
    one_line "${3:-}" 'usage: ship.sh branch <name> "<message>"'
    git check-ref-format --branch "$2" >/dev/null 2>&1 || die "not a valid branch name: $2"
    ! git rev-parse -q --verify "refs/heads/$2" >/dev/null || die "branch $2 already exists"
    warn_release "$3"
    echo "git switch -c $(quote "$2") && git add -A && git commit -m $(quote "$3")"
    ;;
  pr)
    [ -n "${2:-}" ] || die 'usage: ship.sh pr <branch> "<title>" <body-file|-> [--draft]'
    one_line "${3:-}" 'usage: ship.sh pr <branch> "<title>" <body-file|-> [--draft]'
    [ -n "${4:-}" ] || die 'a PR body file (or - for stdin) is required'
    if [ "$4" = - ]; then body=$(cat); else body=$(cat "$4"); fi
    [ -n "$body" ] || die "the PR body is empty"
    ! printf '%s\n' "$body" | grep -qx SPS_PR_BODY || die "the body must not contain a line SPS_PR_BODY"
    draft=""
    [ "${5:-}" = --draft ] && draft=" --draft"
    printf '%s\n' "git push -u origin $(quote "$2") && gh pr create --base $(quote "$base") --head $(quote "$2") --title $(quote "$3")$draft --body \"\$(cat <<'SPS_PR_BODY'" "$body" "SPS_PR_BODY" ")\""
    ;;
  push)
    [ -n "$branch" ] || die "detached HEAD: switch to a branch first"
    # A branch checked out from someone's PR (`gh pr checkout`) carries its own push remote (their fork): plain `git push` honours it,
    # while `git push origin <branch>` would create a stray branch here instead of updating the PR.
    if git config --get "branch.$branch.pushremote" >/dev/null || git config --get "branch.$branch.remote" >/dev/null; then
      cmd="git push"
    else
      cmd="git push -u origin $(quote "$branch")"
    fi
    tags=$(git tag --points-at HEAD --list 'v*')
    for t in $tags; do cmd="$cmd && git push origin $(quote "$t")"; done
    if remote=$(git ls-remote --tags --refs origin 2>/dev/null); then
      missing=$(comm -23 <(git tag | sort) <(printf '%s\n' "$remote" | sed 's#.*refs/tags/##' | sort))
      for t in $tags; do missing=$(printf '%s\n' "$missing" | grep -vxF "$t" || true); done
      [ -z "$missing" ] || echo "WARN: local tags origin lacks (not pushed): $(echo $missing)" >&2
    else
      echo "WARN: could not read origin's tags, orphan-tag check skipped" >&2
    fi
    echo "$cmd"
    ;;
  tag-after-merge)
    # On the PR branch the bump is already committed (HEAD == package.json): only the tag decides.
    ! git rev-parse -q --verify "refs/tags/v$now" >/dev/null || die "tag v$now already exists: this change has no new version to tag"
    echo "git switch $(quote "$base") && git pull --ff-only && git tag v$now && git push origin v$now"
    ;;
  *) die "usage: ship.sh <info|commit|push|suggest-branch|branch|pr|tag-after-merge> ..." ;;
esac
