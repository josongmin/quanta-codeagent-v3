# ADR-0488: code_mode — JS-runtime tool-calling (QuickJS-WASM cell as a dispatch model)

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - RFC `docs/plans/jun-6-code-mode.md` (Status ✅ Phase 1+2+3 LIVE jun-07) — the design + the brutally-honest §8 cost section + the make-or-break §6 security model.
  - The dispatch seam (`src/agent/dispatch.ts`) — a code cell is, to the permission system, N ordinary `dispatchTool` calls; this ADR adds NO new gate, only a new way to issue the SAME gated calls.
- **참조**:
  - `src/codemode/` — the DUMB QuickJS-WASM sandbox (`types.ts`/`runtime.ts`/`exec-main.ts`/`limits.ts`/`index.ts`). Fence: imports ONLY `node:*` / `quickjs-emscripten` / `@/shared` / `@/security` (biome override on `src/codemode/**` blocks `@/agent`/`@/tool`/`@/permission`).
  - `src/agent/codemode-wire.ts#buildCodeCellDispatchPort` — THE security binding: closes over the loop's live `config`/`permission` (+ optional `autoClassifier`) and routes EVERY in-cell `tools.X(args)` through the REAL `dispatchTool` via a synthesized `cell_<cellId>_<seq>` ToolUseBlock.
  - `src/tool/codemode-tool.ts` — the GATED `code_cell` tool (`risk:"exec"`, `always-confirm`, `isReadOnly()=false`, NO-THROW typed result).
  - Wiring: `src/agent/optional-ports.ts` (`wireCodeCellDispatch`, behind `QUANTA_CODE_MODE=1`), `src/host/runtime/agent-arg-builder.ts` (`codeModePortSlot`), `src/shared/runtime-config.ts` (`codeMode` + 4 cap knobs).
  - Tests: `tests/unit/code-mode-hellgate.test.ts`, `tests/unit/code-mode-default-off-hellgate.test.ts`, `tests/unit/code-mode-phase2-full-surface.test.ts`, `tests/unit/code-mode-phase2-wire.test.ts`, `tests/unit/prompt-directives-hellgate.test.ts`, `tests/integration/code-mode-real-quickjs-wire-hellgate.test.ts`, `tests/integration/code-mode-full-surface-e2e.test.ts`.
  - Feature catalog: `tools/feature-catalog/features/02-tool-system/code-mode-js-runtime.yaml`.

## Context

The default dispatch model is one tool call per LLM turn: a multi-step sequence
(read N files, grep each, write a summary) costs N turns of tokens + latency. The
absorbed alternative is to let the model author a small JS PROGRAM that calls
tools as ordinary async functions and runs in one turn. The make-or-break
question is security: arbitrary model-authored code must NOT become a permission
bypass.

## Decision

Invert the dispatch model behind ONE seam. The cell is a DUMB QuickJS-WASM
isolate (`src/codemode/`) that can reach the host ONLY through an injected
`CodeCellDispatchPort`. The single implementation of that port
(`buildCodeCellDispatchPort`) closes over the loop's LIVE `config`/`permission`
and routes EACH in-cell call through the SAME `dispatchTool` the loop uses — so a
code cell IS, to the permission system, N ordinary gated tool calls. Phase 2
widens which tool NAMES are bound (the agent's real registered set) without
touching the gate; Phase 3 (`code_mode_only`) adds a prompt-only steering
directive that never hides or relaxes any tool.

## Fail-closed / security invariants

- **One dispatch path.** `@/codemode` CANNOT import `dispatchTool` (biome fence);
  inversion-of-control is the boundary. Every in-cell call hits the real
  admissibility gate / HARD_DENY / plan-mode.
- **Strictly more restrictive, never a bypass.** The composition-root wire leaves
  `autoClassifier` ABSENT ⇒ in-cell read-only ops do NOT auto-pass.
- **No host surface in the cell.** QuickJS gives no require/fetch/process/FS/net;
  we add none. Output passes the SAME `redactSecrets` chokepoint as a tool result.
- **Bounded + NO-THROW.** WASM memory cap, deadline interrupt, per-cell call cap,
  output cap; every failure (parse / throw / deny / timeout / memory / cap /
  abort) is a typed result, never a host fault.

## Default posture

OFF, byte-identical. Unset `QUANTA_CODE_MODE` ⇒ `code_cell` is not registered,
the QuickJS-WASM module is never instantiated (lazy import), and the tool menu +
dynamic prompt tail are byte-identical.

## ROI / tradeoff

HIGH on multi-step sequences (token + latency collapse from N turns to one), at
the cost of being the highest-architecture item on the board (a sandbox runtime +
a security-critical binding). Mitigated by the single-seam design: the entire
security story reduces to "the port is the only host reach, and it is the same
`dispatchTool`." Default-OFF means the cost is opt-in.
