# C5059-01 — Code-mode efficacy baseline

- **Priority:** P0
- **Class:** MEASURE-FIRST
- **Effort:** S
- **Status:** READY
- **Dependencies:** none
- **Blocks:** C5059-02, C5059-03

## Goal

Determine whether the already-landed QuickJS tools-as-code runtime improves Quanta workloads before adding more code-mode surface.

## Existing authority — do not rebuild

- `src/codemode/runtime.ts`: QuickJS-WASM cell, memory/time/call/output caps.
- `src/agent/codemode-wire.ts`: every in-cell tool call re-enters `dispatchTool`.
- `src/tool/codemode-tool.ts`: gated `code_cell` tool.
- `QUANTA_CODE_MODE` / `QUANTA_CODE_MODE_ONLY`: default-OFF knobs.
- ADR-0488 and the code-mode hellgates are current design/security authority.

## Work

1. Add one paired eval preset: identical model, prompt, task, budget, and seed; only code mode differs.
2. Use a fixed tool-heavy slice containing:
   - sequential read → search → edit tasks;
   - branch/loop tasks where a cell can avoid a model round trip;
   - a control group of simple one-tool tasks where code mode should not help.
3. Emit per-attempt fields through the existing eval/trajectory sink:
   - task success and verifier result;
   - model turns and provider round trips;
   - input/output/reasoning tokens and USD;
   - in-cell dispatch count and direct dispatch count;
   - wall time;
   - code-cell terminal status (`ok/error/timeout/memory/cap/aborted`);
   - direct-tool fallback count.
4. Keep raw tool inputs/results out of the new telemetry fields.

## Acceptance

- Same task set and run budgets are used in both arms.
- Multi-step tasks show a material round-trip or token reduction.
- Task success and verifier pass rate do not regress beyond the predeclared tolerance.
- Security hellgates remain green.
- Results distinguish simple tasks from compositional tasks; aggregate-only reporting is insufficient.
- A written verdict selects exactly one: `continue C5059-02/03`, `keep code mode experimental`, or `disable/cut further investment`.

## Proof rail

```sh
bun test tests/unit/code-mode-hellgate.test.ts \
  tests/unit/code-mode-default-off-hellgate.test.ts \
  tests/unit/code-mode-surface-escape-hellgate.test.ts \
  tests/integration/code-mode-real-quickjs-wire-hellgate.test.ts \
  tests/integration/code-mode-full-surface-e2e.test.ts
```

The eval command and result artifact path must be added when the paired preset lands.

## Kill rule

If code mode does not improve either tokens or round trips on compositional tasks without a success regression, stop C5059-02 and C5059-03. Keep the landed kernel default-OFF; do not rewrite it.

