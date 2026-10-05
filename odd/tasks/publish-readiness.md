# Feature: publish-readiness

## Objective

Finish the pending work from the handoff brief: clean commit identity, prepare the package for publishing and per-machine
install, close the T4-F4 advisory follow-up, and document install/config.

## Problem / why

The repository moved to the personal account (`javgsil`). Commits still carried the company email, the package lacked
repository metadata, nobody had verified that opencode loads the TS-source package from its plugin cache, and the
fallback answer had not been observed live.

## Constraints

- Do not publish, and do not change anything under `~/.config/opencode`, without explicit user consent.
- Test-first for behavior changes; keep `bun run check` green. Conventional Commits, no AI attribution.
- Artifacts in English.

## Delivery

- Branch: `chore/publish-readiness` (from `main` at `922a129`). Strategy: `ask-on-risk`; forecast well under 400 lines,
  single PR.

## Tasks

- [x] T1 Rewrite commit identity to the personal account (inline). All 8 commits now use
      `javiergonzalezsilva@gmail.com`; `main` and `feat/pool-cooldown` force-pushed to `922a129`. Backup bundle:
      `~/dev/backups/opencode-agent-fallback-pre-rewrite.bundle`. No `alegra` reference remains in files or messages.
- [ ] T2 `package.json`: add `repository`, `homepage`, `bugs` for `javgsil/opencode-agent-fallback` (inline,
      mechanical). Unscoped name `opencode-agent-fallback` is free on npm; keep it unless the user wants a scope.
- [ ] T3 T4-F4: test the production `defaultSleep` (resolve + abort/clearTimeout path) directly (test-first).
- [ ] T4 Packaging: `npm pack --dry-run`; verify opencode 1.18.34 loads the packed package as an npm plugin in an
      isolated environment (temp XDG dirs, no `~/.config/opencode` changes) (delegated).
- [ ] T5 Investigate "background dependency install failed ... unable to resolve dependency tree" in
      `~/.config/opencode` (read-only) (delegated).
- [ ] T6 Live validation through `opencode serve` + SDK: an opencode-go model must end with an answer from the fallback
      model (delegated).
- [ ] T7 README with install and config docs.

## Blocked on the user

- Publishing: npm is not logged in on this machine, and publishing is the user's call (public npm vs GitHub Packages).
- Per-machine install: editing `~/.config/opencode/opencode.json` and removing the local loader needs consent.

## Progress / evidence

- T1: `git log --all --format='%ae%n%ce' | sort | uniq -c` -> `16 javiergonzalezsilva@gmail.com`.
