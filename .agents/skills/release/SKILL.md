---
name: release
description: Use when you are ready to ship a version - pre-flight checks, bump, commit, tag, push, publish to npm, and verify on the registry and the Pi gallery. Manual checklist only; no script is shipped and nothing runs unless you type it.
---

# release

Step-by-step release playbook for the `system-prompt-switch` package: bump the version, tag the commit, publish to npm, verify on https://pi.dev/packages. No script is shipped — this skill is the manual checklist. Every command is shown so the human stays in control; nothing runs unless typed.

## When to use

Run this skill when you're ready to ship a new version. It walks through:
1. Pre-flight checks (on `master`, npm logged in).
2. Bump `package.json` (the `bump-version` skill edits the file; you commit).
3. Tag the commit (the `bump-version` skill's `--tag` flag).
4. Push the commit + tag to GitHub.
5. Publish to npm.
6. Verify on the registry and the Pi gallery.

## Pre-flight (run all of these before doing anything destructive)

```bash
# Working tree: the bump step tolerates dirty trees; the tag step does not.
# Confirm the state matches your expectation.
git status --short

# Confirm we are on master (or whatever the canonical branch is).
git branch --show-current
# Expected: master

# Confirm npm is logged in. If `npm whoami` errors, run `npm login`.
npm whoami
# Expected: <your-npm-username>

# Confirm the package name on the registry matches what we publish as.
npm view system-prompt-switch version
# Expected: a 0.x version older than what you're about to ship.

# Optional: re-run the local test suite + typecheck + lint one last time.
bun run ci            # full pipeline, mirrors CI
# Or individually:
bun test
bun run typecheck
bun run lint
```

If any check fails, stop and fix it before continuing.

## Bump version (you commit, you push)

The `bump-version` skill edits `package.json` in place but does **not** commit or tag — that's the human's job. Pick the right flag for the change since the last release:

```bash
# Read the current version before bumping.
bash .agents/skills/bump-version/scripts/bump-version.sh

# Pick a flag:
bash .agents/skills/bump-version/scripts/bump-version.sh --patch   # 0.9.0 -> 0.9.1
bash .agents/skills/bump-version/scripts/bump-version.sh --minor   # 0.9.0 -> 0.10.0
bash .agents/skills/bump-version/scripts/bump-version.sh --major   # 0.9.0 -> 1.0.0

# Confirm the new state.
bash .agents/skills/bump-version/scripts/bump-version.sh
```

Pick `--patch` for bug fixes and small tweaks, `--minor` for new features or behavior changes, `--major` for breaking changes.

The skill edits `package.json` and stops. You review the diff and commit yourself:

```bash
git diff package.json
git add package.json
git commit -m "chore: bump version to <X.Y.Z>"
```

## Tag the commit (also via bump-version)

Once the bump commit is on the branch:

```bash
# Tree must be clean for --tag.
bash .agents/skills/bump-version/scripts/bump-version.sh --tag
```

This creates an annotated git tag `v<version>` at the current HEAD (where `<version>` comes from `package.json`). The skill refuses to overwrite an existing tag.

## Push the commit and the tag

```bash
git push origin master
git push --tags
```

Or `git push origin master v0.9.1` to push only one specific tag. Pushing the tag is what makes GitHub Releases, Surfaces, and any third-party tooling see the new version.

## Publish to npm

```bash
# Final pre-flight: confirm the version about to be published isn't already on the registry.
npm view system-prompt-switch versions --json | grep "$(grep '"version"' package.json | cut -d'"' -f4)"
# Expected: empty (no match). If it matches, the version is already published — pick a new bump.

# Publish.
npm publish --access public
```

`--access public` is required for unscoped packages under older npm versions; it's a no-op on modern npm defaults but harmless to keep. For scoped packages (e.g. `@plantaeart/system-prompt-switch`) this flag is still required to publish outside the private scope.

The publish output should end with `+ system-prompt-switch@<version>`. Anything else — permission errors, network errors, EEXIST — means the publish did not succeed.

## Verify on the registry

```bash
# Confirm the package metadata is what we expect.
npm view system-prompt-switch
# Expected fields: name, version, keywords (must include 'pi-package'), pi.extensions, pi.image,
# license, peerDependencies (must include @earendil-works/pi-coding-agent).

# Confirm the tarball resolves.
npm view system-prompt-switch dist.tarball
# Expected: a registry.npmjs.org URL ending in system-prompt-switch-<version>.tgz
```

## Verify on the Pi gallery

The Pi gallery at https://pi.dev/packages polls npm for packages tagged with the `pi-package` keyword. Direct package URL:

```
https://pi.dev/packages/system-prompt-switch
```

The package page should render:
- Hero image from `pi.image` (raw.githubusercontent.com URL)
- README content with inline demo GIFs
- All 10 commands (`/sps-select`, `/sps-inject`, `/sps-new`, `/sps-edit`, `/sps-delete`, `/sps-move`, `/sps-mode`, `/sps-info`, `/sps-path`, `/sps-logs`)

The gallery index page (https://pi.dev/packages) is regenerated periodically by the pi-mono maintainers; it may take 1–24 hours for a brand-new package (or new version) to appear there. The direct link works immediately.

## Smoke-test the installed package

```bash
# For omp users:
omp plugin install npm:system-prompt-switch --force
omp

# For pi users:
pi install npm:system-prompt-switch
pi
```

Note: `omp plugin upgrade` is **only for marketplace** plugins (`name@marketplace`). For npm-installed plugins like ours, omp's own help message confirms: "For an npm-installed plugin, upgrade with: `omp plugin install <name> --force`". So `--force` on install IS the official update path.

In some omp versions, `--force` resolves to an **older cached version** instead of the current `latest` tag on npm (e.g. the command says "Installed @0.8.0" while npm has 0.9.2). If that happens, fall back to a full uninstall + reinstall, which is reliable:

```bash
omp plugin uninstall system-prompt-switch
rm -rf ~/.omp/plugins/node_modules/system-prompt-switch
omp plugin install npm:system-prompt-switch
# Verify the freshly installed copy is the version you expect:
grep '"version"' ~/.omp/plugins/node_modules/system-prompt-switch/package.json
```

In a fresh session, type `/sps` and confirm all 9 commands appear in the autocompletion. Run `/sps-info` to see the host, active prompts, mode, session ID.

## Common failure modes

- **`npm publish` says `EPUBLISHCONFLICT`**: the version is already on the registry. Bump again.
- **`npm publish` says `ENEEDAUTH`**: run `npm login`.
- **`bump-version.sh --tag` says "Tag v<X.Y.Z> already exists"**: someone (you, earlier) already tagged this version. Bump again or `git tag -d v<X.Y.Z>` to delete the local tag (only if it was never pushed).
- **Push rejected (non-fast-forward)**: someone else pushed commits you don't have. `git pull --rebase` then push again.
- **omp / pi install doesn't show the extension**: check that `pi.extensions` (or `omp.extensions`) is set in `package.json`. The top-level `extensions` field is **not** read by omp's loader — only the manifest under `pi` or `omp`.

## Rollback a published version

NPM does not allow deleting a version that has been live for more than 72 hours, and unpublishing a published version is destructive for any downstream user that already installed it. The right "rollback" is to publish a new patch version that fixes the regression.

If the version was published within the last 72 hours and **no one has installed it**, you can unpublish:

```bash
npm unpublish system-prompt-switch@<version>
```

Only do this if you are sure no one depends on it. For most cases, ship a patch.

## Notes

- The `bump-version` skill handles only the version edit + tag creation. Commits, pushes, and publishes are the human's job.
- The agent never commits, pushes, or publishes autonomously in this repo. Every destructive step above is something you run.
- Forgetting `git push --tags` is the most common cause of "the release looks fine on npm but GitHub still shows the old version". Run it explicitly.
