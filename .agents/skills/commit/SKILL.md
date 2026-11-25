---
name: commit
description: "Use when the user asks for a commit message, a commit, a PR or to ship the change, and only then: never on your own when work or a review is done (finish with a hand-over and let the user verify and ask). Reads all current changes (staged, unstaged, untracked), writes one line in this repo's `type: summary (vX.Y.Z)` style, gets the commit, push, branch/PR and tag commands from its script, and asks the user, for each, whether to run it or hand it over to copy."
---

# One-line commit message

## 1. Read the whole change

Read everything, not just the staged part. The message describes what the next commit will contain.

```bash
git status --short          # what changed, staged (left column) vs unstaged (right), ?? = untracked
git diff HEAD --stat        # size per tracked file
git diff HEAD               # the content; skip lockfile hunks (bun.lock, package-lock.json), read package.json instead
git log --oneline -10       # house style
```

Read untracked files (`??`) in full: `git diff` does not show them. If the staged and unstaged sets differ, say which set the message covers. `ship.sh` uses `git add -A`: if unrelated files are in the tree (scratch files, skills added for another purpose), stash or revert them first, or tell the user.

## 2. Find the one idea

Group the changes by why they were made, not by file. Docs, tests, lockfiles, scripts and config that follow from the main change are part of it. They do not get their own clause. List clauses only for changes that are truly separate, main one first.

## 3. Write the line

`<type>: <summary>` and, when the version moved, ` (vX.Y.Z)` at the end, as in `feat: per-project default system prompt applied to new sessions (v0.13.2)`.

| Type       | When                                                      |
| ---------- | --------------------------------------------------------- |
| `feat`     | new capability a user or contributor can use              |
| `fix`      | bug fix                                                   |
| `chore`    | tooling, dependencies, CI, host version pins, scripts     |
| `docs`     | README, docs or skills only                               |
| `refactor` | same behavior, different code                             |
| `test`     | tests only                                                |

Rules:

- One line, no body, no trailing period. Aim for 100 characters or less; go longer only when several separate changes need a clause each, as `feat: a, b and c`.
- Imperative, lowercase after the colon: `add`, `run`, `fix`, not `added` / `adds`.
- Name the concrete thing: the command, key or feature (`/sps-select`, `Ctrl+N`, `omp -c`). Do not write `update files`, `improvements`, `misc`.
- Say what changes and, when it fits, why or where.
- No file lists, no ticket refs (GitHub adds `(#N)` when the PR is merged), no emoji.

## 4. Ship it: a decision tree, one question per step

Never type a git/gh command by hand: every command comes from `scripts/ship.sh` (it quotes safely and checks branch, tag and body). It prints, never runs. Every question goes through the question tool (`ask`) and **shows its inputs in the question text** (the message, the version and tag, the branch, the PR title and body, the exact printed command). No question tool: print the commands only. Never `git push` or run anything without an answer. The agent never commits on its own (see the user's rules): the user asked for it in this conversation, or stop at the message.

```bash
S=.agents/skills/commit/scripts/ship.sh
bash $S info "<message>"      # message, version -> new version (tag vX.Y.Z) or "no bump, no tag", branch, base
```

**Q0. Version level.** Before `info`, unless the user already said it in this conversation (or `package.json` already moved for this change): if the level is unclear, ask `major` / `minor` / `patch` / `no bump` (recommended first), then run the `bump-version` skill: `bash .agents/skills/bump-version/scripts/bump-version.sh --<level>` (it only edits `package.json`) and end the message with ` (vX.Y.Z)`.

**Q1. How to ship?** Show the `info` output. Options, recommended first: `Commit on <current branch>` when a PR already exists for it, else `Branch + PR`; also `I copy the message only` (stop).

**Commit on the current branch** (`bash $S commit "<message>"`): show the printed line. On a PR branch it never adds the tag (rebase-merge rewrites the commit; the tag comes after the merge). **Q: run it or copy it?** (`I copy it myself`, `Run it for me`). Then **Q: push it?** Show `bash $S push`: plain `git push` when the branch carries its own push remote (a branch checked out with `gh pr checkout` pushes to the PR author's fork and needs "Allow edits from maintainers"), else `git push -u origin <branch>`. Same two answers. Its stderr warns about older local tags origin lacks; show that warning, never push them unasked.

**Branch + PR**, in this order (the branch exists before the commit, or the commit lands on the base branch):

1. **Q2. Branch name.** Suggest `bash $S suggest-branch "<message>"` (`release/vX.Y.Z` when the version moved, else `<type>/<short-slug>`); the user can type another (the script refuses an invalid or existing name). Then `bash $S branch <name> "<message>"` prints `git switch -c … && git add -A && git commit -m …` (no tag yet). **Q: run it or copy it?**
2. **Q3. PR details.** Write the title (= the commit message) and the body, then show both in full with the base branch and draft or ready. Body: short, two sections (what the `release` skill's `open-pr.sh` also writes):

   ```markdown
   ## Why

   One or two sentences: the feature or bug, in plain words.

   ## What was done

   - 3 to 6 concrete bullets (what the user sees, not file lists).
   ```

   Write the body to a temp file, then `bash $S pr <branch> "<title>" <body-file> [--draft]` prints `git push -u origin … && gh pr create …`. **Q4. Push and open the PR: run it or copy it?** (this is the only step that pushes).

3. **After the merge, when the version moved:** the human merges (Rebase and merge, see the `release` skill). Offer the tag when they come back: `bash $S tag-after-merge` prints `git switch <base> && git pull --ff-only && git tag vX.Y.Z && git push origin vX.Y.Z`. **Q: run it or copy it?** The script refuses when the tag already exists. Publishing to npm (`npm whoami`, `npm publish --dry-run`, `npm publish`) stays with the human: `bash .agents/skills/release/scripts/release-plan.sh …` prints that procedure.

Run it for me = run exactly the printed line, then show `git log -1 --oneline` (and `gh pr view --json url -q .url` after a PR). Never edit a printed line.
