---
name: ci-check
description: Use when you need to confirm the whole pipeline is green before pushing or before handing work over - runs lint, typecheck, the test suite, and skill validation, which is exactly what .github/workflows/ci.yml runs. Also use when a change touches a SKILL.md and you need the frontmatter contract.
---

# ci-check

One command that mirrors CI locally: `bun run ci`.

## One source of truth

CI and local runs execute the **same script**: `.agents/skills/ci-check/scripts/validate-skills.sh`.

The `lint-skills` job in `.github/workflows/ci.yml` installs the tools and then calls it, so the validation rules cannot drift between CI and a contributor's machine. If you change what is validated, change that script — never the workflow.

The script is **strict when `CI` is set** (GitHub Actions exports it): a missing `skills-ref` or `npx` is a hard failure there. Locally a missing tool is reported and skipped, so nobody without `uv` or Node is blocked. This stops CI from silently passing a validator that never ran.

```bash
bash .agents/skills/ci-check/scripts/validate-skills.sh          # lenient
CI=true bash .agents/skills/ci-check/scripts/validate-skills.sh  # strict
```

## What CI runs, and what `bun run ci` runs

`.github/workflows/ci.yml` has two jobs. `bun run ci` reproduces both, in the same order.

| CI job | Steps | Local equivalent |
|---|---|---|
| `test` | install, lint, typecheck, test | `bun install --frozen-lockfile`, `bun run lint`, `bun run typecheck`, `bun test` |
| `lint-skills` | install tools, then run the shared script | `bun run validate:skills` |

```bash
bun run ci            # everything
bun run lint          # oxlint
bun run typecheck     # tsc --noEmit
bun test              # unit + e2e
bun run validate:skills   # skills only
```

**Run `bun run ci` before you say work is done.** A green test suite is not the same as a green pipeline: `bun test` does not typecheck, and neither step validates the skills.

## Skill frontmatter contract

Both validators enforce this, and it is the failure CI hits most often — a `SKILL.md` with no frontmatter fails every one of them.

```markdown
---
name: <directory name>
description: Use when … <what the agent should match this skill to>
---

# Title
```

- `name` and `description` are **required**.
- `name` must equal the skill's directory name.
- Only `allowed-tools`, `compatibility`, `description`, `license`, `metadata`, `name` are permitted. Anything else, `version` included, is rejected.
- `description` should lead with "Use when" so the agent can match the skill to user intent.
- The file must end with exactly one newline.

## Installing the validators

`validate:skills` skips whichever tool is missing and says so, so you are never blocked by a missing dependency. CI installs both itself.

```bash
# skills-ref (CI pins a commit; use the same one to reproduce results exactly)
uv tool install "git+https://github.com/agentskills/agentskills.git@69ef37e9424c0a7ea9dd2293b559e43ec8176379#subdirectory=skills-ref"

# skill-check (CI pins 1.2.0)
npx -y skill-check@1.2.0 check --no-security-scan .agents/skills
```

`scripts/validate-skills.sh` runs `skills-ref` from `PATH` and `skill-check` through `npx`, so the pinned `skill-check` version lives in the script, matching CI.

## Reading a failure

| Message | Cause | Fix |
|---|---|---|
| `must start with YAML frontmatter` | No `---` block | Add the frontmatter above |
| `Missing required field: name` | No `name` | Add it, matching the directory |
| `Unexpected fields in frontmatter` | Stray key such as `version` | Remove it; only the six allowed keys are accepted |
| `description.use_when_phrase` | Description does not lead with "Use when" | Rewrite it to state when the skill applies |
| `file.trailing_newline_single` | Missing or doubled final newline | Ensure exactly one |

## Skill descriptions in the get-context output

`skills/get-context/scripts/get-context.sh` prints each skill's description. It reads the `description:` field from the frontmatter and falls back to the first prose line for any skill that predates frontmatter. If you add a skill and it shows "No description", the frontmatter is malformed — `validate:skills` will say why.

## Two things this does not check

- **Bun version.** CI pins Bun 1.4.4 (OMP 18.14+ refuses older Bun when `CI` is set); a local run on another version can pass while CI fails. If CI fails on something `bun run ci` calls green locally, check the Bun version first.
- **Package contents.** `npm pack --dry-run` is not in CI. Run it yourself before `npm publish` — see the `release` skill.
