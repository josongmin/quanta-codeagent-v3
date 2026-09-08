# R14 receipt — G-F9

Status: **implemented**. I-stage **applied** (`src/apps/cli/index.ts`). G-F9.4 live rail installed. Not W7 `verified`.

Lane: W3-A. Closed on local `main` as part of W3 closeout.

## Findings

### G-F9 — empty Docker/Lima seam

- G-F9.1: `buildCliRemoteSeams` resolves Docker/Lima argv process + Lima VM name. PATH `which` only; no docker/lima exec at selection.
- G-F9.2: I injected seams into CLI `selectRemoteRunner`. `unconfiguredReason` → `remote-not-configured` / `remote-misconfigured` / `remote-unavailable`. Argv only.
- G-F9.3: fake Docker process reaches `runRemoteCmd`. unset / missing binary / unknown name covered.
- G-F9.4: production CLI no longer passes `{}`. Live runtime is a contract rail split from install-time PATH lookup: `tests/contract/remote-cli-docker.test.ts` (`requireContract` + `test.skipIf`, SUT = `buildCliRemoteSeams` + `createArgvCliProcess` + `selectRemoteRunner`).
  - This machine: **Docker live spawn/status/cancel executed** (local image, no pull). **Lima skipped** (`limactl` not on PATH). Skip is “rail installed, live not run here”, not “seam absent”.

## Tests

`bun test tests/unit/sep8-remediation/r14` — owner GREEN.

`bun test tests/contract/remote-cli-docker.test.ts` — Docker live pass; Lima skip.

## Out of scope

- apple-vz `reason: ready` + empty seams (Skybridge stub; not G-F9.1 Docker/Lima).
- Image pull as the default live path.
- G-F5.4 EC2.
