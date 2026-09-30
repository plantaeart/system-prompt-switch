---
name: host-version
description: Use when checking whether the Pi and OMP CLI versions pinned in CI still match the latest published release, or when a new host release should be adopted. Runs a comparison of pin, latest, and your local install, then walks through the refresh.
---

# host-version

CI installs the host CLIs at **exact** versions, never `@latest`. A floating tag means a green badge says nothing about tomorrow: the run passes or fails based on whatever npm served that morning. Pinning makes the result reproducible.

## Check the pins

```bash
bash .agents/skills/host-version/scripts/check-host-versions.sh
```

It prints three things and exits `0` when the pins are current, `1` when one is behind:

```
PACKAGE                            PINNED     LATEST     STATE
----------------------------------------------------------------------
@earendil-works/pi-coding-agent    0.99.1     0.99.1     up to date
@oh-my-pi/pi-coding-agent          18.4.5     18.4.5     up to date

Local installs (CI uses the pinned values above):
  pi   0.99.1
  omp  18.4.5
```

Read the **LOCAL** block as a second signal. If your machine is behind the pin, a failure you see locally may not reproduce in CI, and vice versa.

**Exit `1` is not a code failure.** It means a newer host release exists. Nothing in this repo is wrong until you decide to adopt it.

## Where the pins live

Both are on one line in `.github/workflows/ci.yml`:

```yaml
- name: Install Pi and OMP CLIs
  run: npm install -g @earendil-works/pi-coding-agent@0.99.1 @oh-my-pi/pi-coding-agent@18.4.5
```

The script parses that line; it does not keep its own copy. Change the workflow and the script follows.

## Adopting a new host release

1. **Check the release notes** for breaking extension-API changes. The `ExtensionContext` surface, `before_agent_start`, `registerCommand`, and the `pi.on` events are what this extension depends on. A major bump deserves a read before you install it.
2. **Install locally** so you can test against the real host:
   ```bash
   npm install -g @oh-my-pi/pi-coding-agent@<new>
   ```
3. **Run the suite on both hosts.** The matrix is the point — a host release can break one leg only:
   ```bash
   OMPCODE=0 bun run ci    # pi leg
   OMPCODE=1 bun run ci    # omp leg
   ```
4. **Smoke-test by hand.** The suite spawns both CLIs but only asserts they load without crashing. Confirm the commands autocomplete and the banner shows the right scope:
   ```bash
   omp -e ./extensions/index.ts
   pi  -e ./extensions/index.ts
   ```
   Type `/sps` and check the list. Expect the banner `Active Prompt: [omp] …` under omp and `[pi] …` under pi.
5. **Update the pins** in `ci.yml` to the new versions.
6. **Re-run the check script** — it should now report `up to date` and exit `0`.
7. **Commit** the workflow change.

## Why both hosts

`detectHost()` picks the global prompt directory from the runtime environment, and the extension stores prompts under host-explicit scopes (`global-omp`, `global-pi`). A bug that only appears on one host is invisible if CI runs a single leg, so `.github/workflows/ci.yml` uses a matrix over `OMPCODE`. Keep both legs green before shipping.

## Adding a third host

The matrix in `ci.yml` lists the `OMPCODE` value per host. A new host needs:
- a matrix entry,
- an install line in the `Install Pi and OMP CLIs` step,
- an entry in `PACKAGES` in the check script,
- a `HostPlatform` member and a `globalScopeFor` branch in `src/core/types/prompt-scope.type.ts`.
