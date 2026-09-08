# R14 receipt — G-F9

Status: **implemented**. I-stage **applied** (`src/apps/cli/index.ts`). Not W7 `verified`.

Lane: W3-A. Implemented on local `main` (single writer; worktrees `sep8-w3-r14` were clean HEAD clones). NO COMMIT.

## Findings

### G-F9 — empty Docker/Lima seam

- G-F9.1: `buildCliRemoteSeams` resolves Docker/Lima argv process + Lima VM name. PATH `which` only; no docker/lima exec at selection.
- G-F9.2: I injected seams into CLI `selectRemoteRunner`. `unconfiguredReason` → `remote-not-configured` / `remote-misconfigured` / `remote-unavailable`. Argv only.
- G-F9.3: fake Docker process reaches `runRemoteCmd`. unset / missing binary / unknown name covered.
- G-F9.4: production CLI no longer passes `{}`. **Live Docker/Lima daemon is not claimed.**

## Tests

`bun test tests/unit/sep8-remediation/r14` — 7 pass.

## Out of scope

- Real `docker`/`limactl` runtime, image pull, VM boot.
