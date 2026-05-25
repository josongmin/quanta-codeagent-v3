# ADR-0308: ARCH-07 — Headless second-consumer proof

- Status: Accepted
- Date: 2026-05-26
- Related: ADR-0299 (CLI-01 bootstrap host extraction), ADR-0300 (CLI-02 SideConversationPort), ADR-0301 (CLI-05 session-commands shim removal), ADR-0302 (CLI-03 slash registry split), ADR-0303 (CLI-06 lift surface-adapter factories), RFC may-22 unified-agent-runtime §3 (surface decomposition), memory `surface-model` (quanta is multi-surface)

## Context

After Wave 1-3 (CLI-01 → CLI-06, ADRs 0297/0299/0300/0301/0302/0303) the CLI
surface is thinned: `src/host/bootstrap/` is independent of `src/apps/cli/**`,
the runner slices (`@/runner/session-ops`, `@/runner/orchestrate`,
`@/runner/side-conversation-port`) are slice-clean. The CLI now COMPOSES the
host + runner cores; it no longer owns the orchestration.

The question this ticket closes is: **does the host layer actually work as
SSOT for a second surface?** Until a second consumer exists, the slice fence
is theoretical — every CLI-01 invariant could trivially be circumvented by an
"obvious next caller" that the CLI couldn't anticipate. The memory file
`surface-model` records the original design intent: quanta is multi-surface
(CLI / Web-Tauri / CLI-embedded browser), and absorption-ROI must NEVER be
gated on which surface is present today.

This ADR makes the invariant LITERAL by adding a SECOND surface —
`src/apps/headless/` — that drives the SAME `bootstrapSession` +
`@/runner#runOnce` cores end-to-end with zero CLI imports, zero network,
zero env reads, zero TTY. The headless slice is a library + test proof,
not a shippable CLI.

## Decision

Land a leaf-surface `src/apps/headless/` (4 files, ~270 LOC total) plus a
biome `noRestrictedImports` slice-fence override plus a 19-case hellgate
test. The slice exposes ONE public entry, `runHeadlessOnce(input)`, which
internally:

1. Builds a complete `SessionBootstrapDeps` bundle (`buildFakeBootstrapDeps`)
   — every factory present, every body the leanest valid value (empty MCP /
   no store / no embedder / no metrics / no reviewer / no idle-monitor side
   effects).
2. Builds a typed `SessionRuntimeConfigShape` (`buildFakeRuntime`) — every
   field plain data; NO `process.cwd` / `process.env` reads inside the slice.
3. Calls `bootstrapSession(deps, runtime, {})` — the SAME entry the CLI
   surface uses.
4. Composes the per-turn `SessionDeps` from the bootstrap result + a fake
   recording stream + a fake LLM port.
5. Calls `runOnce({ deps, assembleConfig, history, prompt, state, idMeta })`
   — the SAME runner entry the CLI's argv-prompt branch uses.
6. Returns `{ ...boot, outcome, messages, events }` so callers can
   introspect every bootstrap field, the per-turn outcome, the resulting
   message history, and every `AgentEvent` the runner emitted.

### Slice geometry

```
src/apps/headless/
  ├─ index.ts        (~130 LOC — runHeadlessOnce entry + composeHeadlessSessionDeps)
  ├─ fake-deps.ts    (~130 LOC — buildFakeBootstrapDeps + buildFakeRuntime + RecordingStream)
  ├─ fake-llm.ts     (~55 LOC — FakeLlm pre-programmed LLMPort + scriptFromCompletion)
  └─ types.ts        (~75 LOC — HeadlessRunInput / HeadlessRunResult / FakeCompletion)
```

Total: ~390 LOC. Within the 200-400 ticket budget.

### Slice fence

A new biome `noRestrictedImports` override on `src/apps/headless/**`
forbids:

- `@/apps/cli` (and `*/apps/cli`, `**/apps/cli/**`)
- `@/apps/bench` (and `*/apps/bench`, `**/apps/bench/**`)
- `@/apps/agent` (and `*/apps/agent`, `**/apps/agent/**`)
- `node:readline` / `node:readline/promises` / `node:tty` / `node:repl`
  (TTY-only modules belong in `apps/cli`)

The allowed imports the slice actually uses:

| Import                  | Form                                  | Purpose                                  |
|-------------------------|---------------------------------------|------------------------------------------|
| `@/host/bootstrap`      | runtime: `bootstrapSession`           | the SSOT under proof                     |
| `@/host/bootstrap`      | types                                 | `SessionBootstrapDeps`, `…Result`, `…ConfigShape` |
| `@/runner/assemble`     | runtime: `assembleConfig`             | per-turn config composer                 |
| `@/runner/assemble`     | type: `SessionDeps`, `Tooling`        | dep contract                             |
| `@/runner/orchestrate`  | runtime: `runOnce`                    | one-shot turn driver                     |
| `@/runner/orchestrate`  | type: `ResolveResumeInput`, `ResumeResolution` | resume FSM contract             |
| `@/agent`               | type: `AgentOutcome`                  | runner result shape                      |
| `@/llm`                 | type: `LLMPort`, `Message`, `StreamEvent`, `StreamInput`, `ImageBlock` | fake-LLM + types |
| `@/stream`              | runtime: `StreamPort`, `AgentEvent`   | recording stream + event captures        |
| `@/observability`       | runtime: `StructuredLogger`           | one logger allocation                    |
| `@/tool`                | runtime: `ToolRegistry` + type `Tool` | empty/minimal registry                   |

NO `@/apps/cli`, NO `@/apps/bench`, NO `@/apps/agent`. NO `node:fs`,
`node:os`, `node:path`, `node:readline`, `node:tty`. NO `process.argv`,
`process.env`, `process.exit` in executable code.

### What's intentionally OMITTED from the headless result

Compared to the CLI's `SessionSetupResult` (the surface-side wrapper around
`SessionBootstrapResult`), the headless result OMITS:

- `statusBar` (TTY only)
- `turnIndicator` (TTY only)
- `turnSummary` (TTY only)
- `pills` (TTY only)
- `debugHandle` (TTY only)
- `timelinePanel` (TTY only)
- `costPanel` (carried opaquely through bootstrap but always undefined here)
- `branchProgress` (same)

The headless result IS-A `SessionBootstrapResult` (extends it), so every
bootstrap field passes through automatically. New bootstrap fields a future
ADR adds will surface through the headless result with zero churn.

## Consequences

- **Surface-isolation invariant is LITERAL, not theoretical.** The
  headless hellgate fails fast if any future change reaches back into
  `apps/cli` / `apps/bench` / `apps/agent` from the host slice (it would
  necessarily appear in the headless slice's transitive imports, which the
  whitelist test would flag).
- **The host's dep contract is exercised by TWO consumers.** Any
  CLI-specific assumption that snuck into the dep contract (e.g. a factory
  that secretly expected a TTY-only port) would be caught by the headless
  smoke (CASE 3) at landing time.
- **A Web/Tauri/embedded-browser surface has a working blueprint.** The
  headless slice is the literal minimum a new surface needs to compose: a
  `buildFakeBootstrapDeps`-shaped function, a runtime config builder, and a
  per-turn deps composer. ~270 LOC of leaf primitives + ~130 LOC of wiring.
- **No new boundaries, no public API mutation.** `@/host/bootstrap` and
  `@/runner` are unmodified. The CLI is unmodified. The new slice is purely
  additive.
- **Default-OFF, library-only.** No `package.json` entry, no shipped
  binary, no slash command. The slice is a test-time + future-surface-time
  proof.

## Alternatives considered

1. **Inline the proof into the CLI-01 hellgate.** Rejected: that test would
   still depend on `apps/cli` types (since CLI-01 sits next to the CLI
   slice). The point of ARCH-07 is to PROVE the host layer is consumable by
   code that has zero `apps/cli` imports. A test inside `apps/cli` test
   directory could pass even if `apps/cli/**` had grown circular
   dependencies into `@/host/bootstrap`.
2. **Ship the headless slice as a real binary (`quanta headless`) under
   `package.json#bin`.** Rejected for this ADR (out of ticket scope, opens
   security questions about a real fake-LLM endpoint, and the proof needs
   no binary to assert the invariant). A follow-up ADR can promote the
   slice to a binary if a use-case arises (CI loop replay / vendor-test
   harness / Tauri sidecar test).
3. **Use `@/agent#runAgent` directly without `bootstrapSession`.**
   Rejected: that would PROVE the agent loop is callable but NOT prove
   the host layer (`bootstrapSession` + its dep contract) is reusable.
   The whole point is that ARCH-07 closes the host-layer invariant, not
   the loop invariant.

## Hellgate

`tests/unit/apps/headless/headless-second-consumer-hellgate.test.ts` —
19 cases / 75 `expect()` calls / 0 failures:

| Case | Invariant                                                            |
|------|----------------------------------------------------------------------|
| 1    | source fence — no `from "@/apps/cli"` literal                        |
| 1b   | no relative `../cli` import                                          |
| 1c   | no path starting with `src/apps/cli`                                 |
| 2    | every import matches the allowed-prefix whitelist                    |
| 2b   | `@/agent` imports in headless are TYPE-ONLY                          |
| 2c   | `@/llm` imports are TYPE-ONLY                                        |
| 3    | smoke — `runHeadlessOnce({prompt,fakeCompletion})` returns completed |
| 4    | `index.ts` executable code does not call `process.exit/argv/env`     |
| 4b   | NO headless source file's executable code touches `process.*`        |
| 5    | result carries every `SessionBootstrapResult` field (35+)            |
| 6    | tool-call script + completion ticks the loop twice                   |
| 7    | already-aborted signal returns `outcome.reason === "aborted"`        |
| 8    | empty mcpTools / mcpClients work without MCP wiring                  |
| 9    | result does NOT carry TTY/UI chrome keys                             |
| 10   | determinism — same input ⇒ same assistant text + reason              |
| 11   | forbidden-import counter is 0 across all forbidden patterns          |
| 12   | caller-supplied cwd takes effect (no `process.cwd()` leak)           |
| 13   | empty `fakeCompletions` throws at FakeLlm construction               |
| 14   | runner emits ≥ 1 `llm_request` event with `provider === "headless"`  |

## Wire matrix

| Headless symbol                  | Defined in     | Consumed by                       |
|----------------------------------|----------------|-----------------------------------|
| `runHeadlessOnce`                | `index.ts`     | hellgate CASE 3, 6, 7, 8, 9, 10, 12, 14 |
| `composeHeadlessSessionDeps`     | `index.ts`     | `runHeadlessOnce` (module-private) |
| `FakeLlm`                        | `fake-llm.ts`  | `runHeadlessOnce`, hellgate CASE 13 |
| `scriptFromCompletion`           | `fake-llm.ts`  | `FakeLlm` constructor             |
| `buildFakeBootstrapDeps`         | `fake-deps.ts` | `runHeadlessOnce`                 |
| `buildFakeRuntime`               | `fake-deps.ts` | `runHeadlessOnce`                 |
| `RecordingStream`                | `fake-deps.ts` | `runHeadlessOnce`, hellgate CASE 14 |
| `HeadlessRunInput`               | `types.ts`     | `runHeadlessOnce` (param)         |
| `HeadlessRunResult`              | `types.ts`     | `runHeadlessOnce` (return)        |
| `FakeCompletion`                 | `types.ts`     | `HeadlessRunInput`, `FakeLlm`     |
