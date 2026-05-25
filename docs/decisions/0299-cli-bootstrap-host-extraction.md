# ADR-0299: Host-bootstrap extraction — thin CLI / headless engine seam

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**:
  ADR-0024 (export-gap closure — CLI `internal.ts` as the env/argv envelope),
  RFC §3.1 (`@/runner` Layer-2 surface-agnostic invariant),
  surface-model memory (multi-surface CLI / Web-Tauri / CLI-embedded-browser),
  `worktree-node-modules-hazard` memory.
- **References**:
  `src/host/bootstrap/index.ts` (barrel),
  `src/host/bootstrap/bootstrap-session.ts` (the relocated `bootstrapSession`),
  `src/host/bootstrap/types.ts` (`SessionBootstrapDeps`, `SessionBootstrapResult`,
  `SessionBootstrapError`),
  `src/apps/cli/repl.ts` (CLI seam — wires the 14 new factory closures),
  `src/apps/cli/repl/session-setup.ts` (consumes `bootstrapSession` + composes terminal chrome),
  `src/apps/cli/repl/session-deps-compose.ts` (consumes the boot result; no
  direct reviewer-subagent import),
  `tests/unit/host/bootstrap-host-extraction-hellgate.test.ts` (27 adversarial cases).

## Context

The CLI surface (`src/apps/cli/repl/**`) owned the per-session bootstrap:
`bootstrapSession` in `src/apps/cli/repl/session-bootstrap.ts` (332 LOC)
called `buildLLM` + `RetryingLLM` + `composeLLM`, `buildStreaming`,
`buildTooling`, `loadFeatures`, `pickIdentity`, `pickPersona`,
`resolveResume`, `materializeReviewerAgent`,
`createSubagentBackedGuardianReview`, and `composeShellEvent` — all
either env-bound (`apps/cli/internal`) or terminal-bound
(`apps/cli/shell-stream-painter`, `apps/cli/image-loader`,
`apps/cli/session-io`).

That posture blocked the surface-model goal (`surface-model` memory):
a Web/Tauri/headless surface can't reuse `bootstrapSession` today
without forking it, because the bootstrap reaches into CLI internals
directly. Per ROI-agnostic absorption discipline (`surface-model`
memory: "흡수 ROI를 surface-가용성으로 게이팅하지 말 것"), the seam
must exist regardless of whether a non-CLI surface is shipping THIS
sprint.

Symmetric prior work: ADR-0024 moved env-driven helpers into
`apps/cli/internal.ts`; RFC §3.1 carved out `@/runner` for
surface-agnostic Layer-2 builders (`buildLLM`/`buildTooling`/
`assembleConfig`). The bootstrap was the last orchestrator that still
lived under `src/apps/cli/**`.

## Decision

Create a new top-level slice **`@/host/bootstrap`** owning the
surface-agnostic `bootstrapSession` function. The CLI surface continues
to do env / argv / terminal parsing in `apps/cli/internal` +
`apps/cli/repl/session-runtime-config`, then constructs a
`SessionBootstrapDeps` bundle of closures and calls
`bootstrapSession(deps, runtime)`.

### Slice layout

```
src/host/bootstrap/
  index.ts                  -- barrel: bootstrapSession, error, types
  bootstrap-session.ts      -- the verbatim-relocated function body
  types.ts                  -- deps + result + error + factory types
```

### Cross-cuts the host slice IS allowed to reach

`@/agent`, `@/llm`, `@/observability`, `@/permission`, `@/runner/*`,
`@/shared`, `@/stream`, `@/subagent`, `@/tool`. Enforced by a biome
`noRestrictedImports` override on `src/host/bootstrap/**` banning
`**/apps/**` + CLI-specific node modules (`node:readline`, `node:tty`,
`node:repl`).

### `SessionBootstrapDeps` factory fields

20 factory closures the surface provides:

| Field | Replaces (prior direct import in `apps/cli`) |
| --- | --- |
| `buildLifecycleBundle` | (already a dep before this ADR) |
| `deriveMcpPillServers` | (already a dep) |
| `buildCostPanelOrUndefined` | (already a dep) |
| `buildBranchProgressOrUndefined` | (already a dep) |
| `buildPlanStoreOrUndefined` | (already a dep) |
| `buildWorkMetricsSink` | (already a dep) |
| `buildLlm` | inline `buildLlmStack` helper — wraps `buildLLM` + `RetryingLLM` + `composeLLM` |
| `buildStreaming` | `apps/cli/internal#buildStreaming` |
| `buildTooling` | `apps/cli/internal#buildTooling` |
| `loadFeatures` | `apps/cli/internal#loadFeatures` |
| `loadImageBlock` | `apps/cli/image-loader#loadImageBlock` |
| `pickIdentity` | `apps/cli/internal#pickIdentity` |
| `pickPersona` | `apps/cli/internal#pickPersona` |
| `resolveResume` | `apps/cli/internal#resolveResume` (via `@/runner/orchestrate`) |
| `composeShellEvent` | `apps/cli/repl/session-bootstrap#composeShellEvent` (otel + painter) |
| `switchToSessionCwd` | `apps/cli/session-io#switchToSessionCwd` |
| `materializeReviewerAgent` | `@/agent/tier1/reviewer-subagent#materializeReviewerAgent` |
| `createSubagentBackedGuardianReview` | `@/agent/tier1/reviewer-subagent#createSubagentBackedGuardianReview` |
| `buildMcpSurfaceInfo` | `apps/cli/repl/mcp-surface-wire#buildMcpSurfaceInfo` |
| `buildIdleGuards` | inline helper wrapping `apps/cli/idle-monitor` + `apps/cli/reject-counter` |

### Reviewer factories — re-exposed on the result

`SessionBootstrapResult` carries `materializeReviewerAgent` +
`createSubagentBackedGuardianReview` back so
`apps/cli/repl/session-deps-compose.ts` calls
`boot.materializeReviewerAgent(...)` (not a direct import). This keeps
the slice fence: `src/apps/cli/repl/**` never references
`@/agent/tier1/reviewer-subagent` directly. The CLI seam
(`src/apps/cli/repl.ts`, OUTSIDE the `repl/` directory) imports the
reviewer factories once and threads them through the dep bundle.

### Old file deleted

`src/apps/cli/repl/session-bootstrap.ts` is **deleted outright** — no
re-export shim is left behind. Consumers (`index.ts`,
`session-setup.ts`, `session-deps-compose.ts`, the
`session-setup-hellgate` test) import from `@/host/bootstrap` directly.

### Default-OFF byte-identical

The CLI surface passes the SAME closures (`buildLLM`, `composeLLM`,
`buildTooling`, `loadFeatures`, …) the bootstrap used to call inline.
Every conditional, every log line, every shutdown order is preserved.
The 17 existing `tests/unit/apps/cli/session-setup-hellgate.test.ts`
cases continue to pass without behavior change.

## Slice-fence enforcement

1. **Biome override on `src/host/bootstrap/**`** — bans imports from
   `**/apps/**` and CLI-only node modules (`node:readline`, `tty`,
   `repl`).
2. **Biome override on `src/apps/cli/repl/**`** — bans imports from
   `@/agent/tier1/reviewer-subagent` (the reviewer factories must
   arrive via the dep bundle, not via direct import).
3. **Hellgate** — 27 adversarial cases at
   `tests/unit/host/bootstrap-host-extraction-hellgate.test.ts`. Key
   invariants:
   - the host slice text never contains `from "@/apps/cli"` or a
     relative `apps/cli` import,
   - no `reviewer-subagent` import lines in the host slice,
   - no standalone `materializeReviewerAgent(` /
     `createSubagentBackedGuardianReview(` calls in
     `src/apps/cli/repl/**` (calls through `boot.*` are allowed),
   - no `buildLlmStack` reference (the prior internal helper name),
   - no `loadFeatures(` calls in `src/apps/cli/repl/**` (must go through
     `deps.loadFeatures`),
   - `SessionBootstrapDeps` lists 20 required factory keys (no `?:`),
   - smoke: a fully-faked bootstrap call produces a typed result with
     reviewer factories re-exposed,
   - resume conflict / missing-id / `buildLlm` failure / `buildTooling`
     failure each get wrapped as a typed `SessionBootstrapError` and
     stop MCP clients before rethrowing.

## Net delta

- **Created**: `src/host/bootstrap/{index.ts, bootstrap-session.ts, types.ts}`
  (3 files, ~510 LOC including JSDoc and types).
- **Deleted**: `src/apps/cli/repl/session-bootstrap.ts` (332 LOC).
- **LOC moved out of `src/apps/cli/`**: 332.
- **LOC added in `src/host/bootstrap/`**: ~510 (the prior file was 332
  LOC; new file adds explicit typed `SessionBootstrapDeps` interface +
  20 named factory types + JSDoc + opaque type aliases for surface ports
  that the host doesn't need to introspect).
- **Hellgate cases**: 27 (`tests/unit/host/bootstrap-host-extraction-hellgate.test.ts`).
- **tsc/biome**: 0 new errors on the affected slice (baseline preserved).
- **Behavior tests**: `tests/unit/apps/cli/session-setup-hellgate.test.ts`
  (17 tests), `tests/unit/cli/repl-extract-shape.test.ts` (16 tests),
  `tests/integration/session-cli-subprocess.test.ts` (2 tests) all
  continue green.

## Consequences

- **A Web/Tauri/headless surface can reuse `bootstrapSession`** without
  forking. The surface composes its own `SessionBootstrapDeps` (e.g.
  HTTP-fed `loadFeatures`, IPC-fed `buildLlm`, a no-op
  `buildShellStreamPainter`, …) and calls the same function.
- The CLI surface (`src/apps/cli/repl.ts`) now allocates 14 small
  closures (~80 LOC) and threads them through `sessionSetupDeps`. The
  closures are byte-identical to the prior inline calls.
- `SessionBootstrapResult` re-exposes the surface-supplied reviewer
  factories so `session-deps-compose.ts` calls them through `boot.*`
  rather than re-importing. This is the only host result-side
  passthrough; future cross-slice helpers that need the same treatment
  follow the same pattern.

## Trade-offs accepted

- Some result-side ports are typed `unknown` at the host
  (`idleMonitor`, `rejectCounter`, `costPanel`, `branchProgress`,
  `mcpSurface`, `lifecyclePills`). The host doesn't introspect them —
  the surface narrows them at the seam (`session-setup.ts` /
  `session-deps-compose.ts` cast back to the concrete CLI types). A
  future generics-based parameterization of `SessionBootstrapResult`
  could push the narrowing into the type system; today the cast is
  isolated to two call sites and is easier to audit.
- `SessionBootstrapDeps.buildTooling` declares mutable `Tool[]`
  arguments to align with the existing CLI `buildTooling` signature.
  The bootstrap doesn't mutate the inputs; the looser typing keeps the
  CLI surface assignable without per-call casts.
- The host slice mirrors `McpServerConfig` structurally
  (`BootstrapMcpServerConfig`) rather than importing `@/mcp`, because
  `@/mcp` is not in the host's allowed cross-cuts. The shape is kept
  in sync with `@/mcp/types#McpServerConfig` by structural typing.
