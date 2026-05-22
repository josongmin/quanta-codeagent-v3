# ADR-0092: Run-mode expansion — `ide` + `daemon` (C1)

- **Status**: Accepted (additive; the original 4 modes are byte-identical)
- **Date**: 2026-05-22
- **Related**: RFC may-22-unified-agent-runtime (§4 lever matrix, Phase 0/6), ADR-0080 (IDE context provider seam), ADR-0084 (speculative branch search — default-on in both new modes), ADR-0081 (shell output delta streaming — IDE structured channel consumer).

## Context

The RFC may-22 "Unified Agent Runtime" shipped a 4-mode × 12-lever
discriminated-union `ModePolicy` matrix: `interactive` / `headless` / `batch` /
`ci-bot`. Two production surfaces had no cell of their own and were being forced
onto an ill-fitting mode:

- **Editor-embedded** (VS Code / Tauri) sessions were running as `interactive`,
  but their I/O is a *structured event channel* the editor UI parses — not
  `stdout-chat` — and the reviewer prompt is an IDE modal, not a terminal
  question. They also want `full-trajectory` observation for the timeline view.
- **Long-running scheduled services** (nightly PR review, webhook responder)
  were running as `headless`, but `headless` is one-shot and hermetic: it has no
  cron-to-cron persistent memory, lands git changes wherever it likes, and opens
  the full network. An unattended service needs `branch-only` git, an
  `allowlist` network, a `per-instance` worktree, and `persistent` memory.

## Decision

Add two modes to the closed `AgentMode` union and fill their full 12-lever
column in `MODE_PRESETS` + budget column in `BUDGET_PRESETS`.

| Lever | `ide` | `daemon` |
|---|---|---|
| permission | reviewer-backed (IDE modal) | auto / acceptEdits |
| termination | user-stop | diff-ready |
| sandbox | user-cwd | per-instance (worktree) |
| output | structured | structured |
| externalDeps | host | hermetic-with-overrides |
| toolSurface | full | headless-safe |
| promptPack | assistant | task-runner |
| memory | persistent | persistent |
| observation | full-trajectory | full-trajectory |
| network | open | allowlist |
| gitWrite | free | branch-only |
| secrets | host-env | scoped |

`ide` is human-near (joins `interactive` as the only two `reviewer-backed`
modes) but distinguished by `structured` output + `full-trajectory`. `daemon` is
autonomous (joins `ci-bot` as the only two `branch-only` git modes) but
distinguished from `headless` by `persistent` memory + `per-instance` sandbox +
`allowlist` network.

### Wiring cascade (intended drift signal)

Adding a mode forces edits at every exhaustive seam, each caught by tsc or a
test if missed:

1. `run-mode/types.ts` — `AgentMode` union + `ALL_AGENT_MODES` (6 elements).
2. `run-mode/presets.ts` — `MODE_PRESETS` + `BUDGET_PRESETS` Records (exhaustive
   over `AgentMode`, so a missing key is a compile error).
3. `prompt-rules/index.ts` — `renderPackByMode` switch gains `ide`/`daemon`
   cases; the local 4-mode `AgentMode` was deleted in favour of re-exporting the
   run-mode SSOT so the two enums can never drift again.
4. `apps/agent/cli-args.ts` — `VALID_MODES`.
5. `apps/agent/mode-presets/{ide,daemon}.ts` — new runner files (mirror
   `headless.ts`: `buildXBase` + `assembleAgentConfig` + `resolveRunAgent` +
   `exitCodeForOutcome`), each with `branch_search` default-on (ADR-0084).
6. `anti-regression-invariants.test.ts` — cells 48→72, two "ONLY mode"
   invariants broadened to set-membership (`reviewer-backed` = {ide,interactive};
   `branch-only` = {ci-bot,daemon}).

### branch_search default-on

Both new modes default-enable speculative branch search (ADR-0084) since both
target hard edits with a verifier budget: `ide` N=3 / tsc+lint / 60s, `daemon`
N=3 / tsc+lint+lsp_diag / 90s. The caller can still override via
`req.base.branchSearch`. The original 4 modes are untouched (branch_search stays
default-OFF there), preserving byte-identical legacy behaviour.

## Alternatives rejected

- **Reuse `interactive` for IDE with a flag**: leaks structured-vs-chat output
  into a runtime conditional instead of the lever matrix; defeats the
  compile-time exhaustiveness the RFC bought.
- **Reuse `headless` for daemon**: silently grants a daemon full network + free
  git-write — a real safety regression for an unattended process.
- **A generic `custom` mode with caller-supplied levers**: removes the static
  matrix guarantee; every preset would need runtime validation.

## Consequences

- The matrix is now 6×12 = 72 cells; the drift-detector test pins that count.
- `AgentMode` has a single source of truth (`run-mode/types.ts`); the
  prompt-rules duplicate is gone.
- Editor and scheduler hosts get a first-class cell instead of overloading an
  existing one; their distinct safety posture is enforced by the type system.

## Negative invariants

- `ide`/`daemon` MUST NOT widen the original 4 presets — those columns are
  byte-identical to pre-C1.
- `daemon` MUST stay `branch-only` git + `allowlist` network — no unattended
  push to main, no open egress.
- The two new mode-preset runners MUST NOT import a sibling mode-preset file
  (assembly goes through `../assemble`).
