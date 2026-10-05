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
- [x] T2 `package.json`: add `author`, `repository`, `homepage`, `bugs` for `javgsil/opencode-agent-fallback` (inline,
      mechanical). Unscoped name `opencode-agent-fallback` is free on npm; kept unless the user wants a scope. Commit
      `a3851b7`.
- [x] T3 T4-F4: test the production `defaultSleep` directly (inline, test-first). `defaultSleep` is now exported; four
      direct tests (plain delay, pre-aborted signal arms no timer, abort clears the pending timer, listener detached after
      firing); the deadline-release test uses the production function instead of a copy. RED: the missing export failed the suite; GREEN: 26/26; mutation (drop `clearTimeout`) fails the clear test. Commit `21000e5`.
- [x] T4 Packaging (delegated, isolated). `npm pack --dry-run`: 12 files, 25.0 kB, no warnings (13 files / 26.6 kB
      with README). Published only to a localhost verdaccio with temp XDG dirs; opencode 1.18.34 installed it with npm
      into `$XDG_CACHE_HOME/opencode/packages/opencode-agent-fallback@0.2.0/` and loaded the TS source (the plugin's
      own invalid-config log line appeared; negative control without the env var showed none). The optional peer
      `@opencode-ai/plugin` is not installed there. No package.json change needed.
- [x] T5 Dependency-install failure (delegated, read-only). Does not occur on this machine (0 log hits). opencode runs
      npm in `~/.config/opencode`, whose `package.json` and `package-lock.json` are out of sync; a dry-run install on a
      copy resolves cleanly today. Plugin installs use a separate npm project per plugin in the cache dir, so this
      failure does not block installing the package.
- [x] T6 Live validation (delegated) via `opencode serve` + HTTP from a temp project loading the plugin from
      `.opencode/plugins/`. A local stub provider returning 403 "not available in your region" drove the failure: log
      `falling back for session ...: opencode/mimo-v2.6-flash-free`, final assistant text `PONG` from the fallback model,
      agent stayed `build`. A second session skipped the cooling pool and went straight to the fallback. Phantom
      Task-cancel recovery was not exercised. Note: this machine has no `opencode-go` region error to reproduce, so the
      real opencode-go path is still unobserved here.
- [x] T7 README with install and config docs (inline). Commit `09909e7`.
- [x] T8 Fix F1 (user-authorized, delegated writer, test-first). Commit `959940c`. A genuine `chat.message` seeds the
      identity from the resolved model; the pending resend's echo seeds the resend target; a `session.error` reading
      `Model not found: <provider>/<model>.` for the live model bypasses the pending-resend guard and twin suppression.
      RED 3 failing tests, GREEN 170/170. Live (`opencode serve`): an unknown `opencode-go` model fell back to
      `opencode/mimo-v2.6-flash-free` (answer `PONG`, agent `build`); a double rejection (`opencode-go/nope-1`,
      `anthropic/nope-2`) advanced twice to the same answer. Residual: after exhausting the chain by rejections,
      `pendingResend` stays set until the next user message.
- [ ] T9 Package name: unscoped `opencode-model-fallback` is taken on npm (likas21, v1.0.6, no repository). Scoped
      `@javgsil/opencode-model-fallback` and GitHub `javgsil/opencode-model-fallback` are free. Pending user choice.

## Findings for the user

- F1 (gap, not fixed): when opencode itself rejects the model (`ProviderModelNotFoundError`, e.g. a model id missing
  from its registry), only `session.error` fires, before `chat.params`, so the plugin has no identity and silently
  skips fallback (`src/runtime/hooks.ts` identity guard). Provider-returned "model not found" errors do fall back.
  Fixing it means deriving identity from the user message; a product decision, left for the user.
- F2 (false alarm): opencode calls every exported function of a plugin module, but 1.18.34 dedupes identical function
  references (`packages/opencode/src/plugin/index.ts`, `seen` set), and `src/index.ts` exports the same reference as
  named and default, so it registers once. Only a wrapper exporting two distinct functions would double-register.
- F3 (optional): bound the peer range, e.g. `>=1.18.34 <2`.

## Blocked on the user

- Publishing: npm is not logged in on this machine, and publishing is the user's call (public npm vs GitHub Packages).
- Per-machine install: editing `~/.config/opencode/opencode.json` and removing the local loader needs consent.

## Progress / evidence

- Checks: `bun run check` exit 0 (165 tests, tsc, prettier, eslint) after T3 and T7.
- RDD: assess over `922a129..21000e5` = medium, `review_due: false` (`under_budget`). After `959940c`: medium, 488
  lines, `review_due: true` (`slice_budget_reached`); consent pending (lineage `review-091ec510165b2d21`).

- T1: `git log --all --format='%ae%n%ce' | sort | uniq -c` -> `16 javiergonzalezsilva@gmail.com`.
