# ADR-0440 — Canvas Web Components (render-side DiffView + UsageBar)

**Status:** Accepted (2026-06-02)
**RFC:** `docs/plans/jun-2-misc/06-canvas-web-components.md`
**Companion to:** ADR-0408 (observability protocol + UI pane), ADR-0420 (observability served-WS sink — the wiring pattern this slice reuses)
**Default-OFF:** Yes — `QUANTA_WEB_CANVAS` unset ⇒ byte-identical (no facade canvas source, no `onPromptAssembled` capture, no WS sink, components render nothing).

## Context

quanta already COMPUTES both the data a rich web canvas would show:

- **Diff** — `src/apps/cli/diff-preview.ts` runs a line-level LCS (Hunt–McIlroy) over write/edit/apply_patch/scripted_replace, but immediately serializes the `DiffOp[]` to ANSI; the structured form never escaped the CLI.
- **Usage** — the loop's `onPromptAssembled` seam → `buildUsageBreakdownDefault` (bound to the loop's own `estimateTokens`) → a per-category `ContextUsageBreakdown` (System/Tools/Rules/Skills/MCP/Subagents/Conversation). The CLI `/context` slash renders it; the web surface had only a cumulative token pill.

The web/Tauri surface (`apps/web-frontend`) is a basic chat UI with no diff/usage renderer. This ADR adds render-side React components mirroring Cursor's `cursor/canvas` SDK prop shapes (`DiffViewProps` / `UsageBarProps` / `colorPalette`), fed by the EXISTING computed data via two new default-OFF WS channels — **no recomputation**, lossless adapters only.

## Decision

### Protocol — `src/protocol/canvas/` (NEW, self-contained slice)
- `ToolDiffMessage` (`kind: "tool.diff"`) — `toolCallId`, optional `path`/`language`, `binary?`, `truncated?`/`moreLines?`, `lines: DiffLineData[]`, `additions`/`deletions`, `emittedAt`. The daemon converts `DiffOp[]` → `DiffLineData[]` BEFORE building the frame.
- `ContextUsageMessage` (`kind: "context.usage"`) — `segments:{id,tokens}[]`, `total`, `max`, `model?`, `emittedAt` — structurally identical to `ContextUsageBreakdown`; serialized verbatim.
- `encodeCanvasFrame` / `decodeCanvasFrame` (NO-THROW) + tag/shape guards, mirroring `src/protocol/observability`. Wire envelope `{ version: "canvas.v1", kind: "canvas", payload }`.

### Diff math hoisted to `@/runner/diff-ops` (surface-agnostic)
The pure line-LCS math + caps (64 KiB/side, 200-line) + NUL binary probe moved from `src/apps/cli/diff-preview.ts` into `src/runner/diff-ops.ts` so BOTH the CLI ANSI preview AND the web-daemon canvas emitter consume ONE implementation. `diff-preview.ts` re-exports `diffOps` / `resolveEnvCaps` / `isBinaryContent` / `DiffOp` and keeps its ANSI serialization + file-reading concerns. **The legacy ANSI path is byte-identical** (it still calls the same `diffLines`; `tests/unit/cli/diff-preview.test.ts` passes unchanged). This avoids the slice-fence violation of importing `@/apps/cli/*` from the daemon.

### Daemon emit — `src/apps/web-daemon/canvas-emitter.ts` (NEW) + sink in `server.ts`
- `createCanvasEmitter({ ws })`: `feedToolDiff({toolCallId, before, after, path?})` runs `diffOps` ONCE + caps + binary probe + the lossless `diffOpsToLines` adapter → `tool.diff` frame; `feedUsage(view)` serializes the `ContextUsageBreakdown` verbatim → `context.usage` frame. No sink ⇒ no-op; throwing `ws.send` swallowed (NO-THROW).
- `attachCanvasSink(ws, ports)` (server.ts) mints a per-connection emitter, snapshot-on-connect forwards `usageSource.latest()`, subscribes for subsequent views, returns `{ handle, detach }`. Absent ports ⇒ `null` (gate OFF, byte-identical). Lifecycle mirrors `attachObservabilitySink`: `open` attaches, `close` detaches. `WebDaemonConfig` (shared) untouched — widened locally via `WebDaemonServerConfig.canvasPorts`.
- `canvas-usage-source.ts` (NEW) adapts `onPromptAssembled` → a subscribe-able source via the SAME `buildUsageBreakdownDefault(snapshotToBreakdownInput(...))` the CLI uses (no second heuristic).
- `runtime-factory.ts`: when `QUANTA_WEB_CANVAS=1`, builds the source, wires `AgentConfig.onPromptAssembled = source.sink`, exposes `canvasUsage` on the facade. `index.ts`: eagerly mints the facade for the canvas gate too, projects `buildCanvasPorts(facade)` into the server config.

### Frontend — `apps/web-frontend/src/`
- `components/canvas/{DiffView,DiffStats,UsageBar}.tsx` — mirror Cursor prop APIs 1:1 (`className` substituted for `style`); colors ONLY from `components/canvas/tokens.ts` (canvas-tokens light/dark mirror, no hardcoded hex). Accessibility: DiffView `role="table"`/`role="row"` + per-line `aria-label`; UsageBar `role="img"` + summary label + per-segment `title`.
- `components/DiffPanel.tsx` — host card (DiffStats header + DiffView body), binary placeholder.
- `adapters/{diff-adapter,usage-adapter}.ts` — lossless. `usage-adapter` copies `formatTokens` + `viewPercent` VERBATIM from `status-line.ts`; labels reproduce the CLI head line (`64% Full`, `76.8k / 120k Tokens`). `diff-adapter` reads daemon-computed counts (no recompute).
- `ws/canvas-hooks.ts` — `useToolDiffs` (Map by toolCallId, latest-wins) / `useContextUsage` (latest) over a `CanvasSource`. Exported reducer for testability.
- `types/protocol.ts` — local copies of the canvas shapes (copy-not-import, same as observability).

## Scope (Non-Goals)

- **Not an agent-authored `.canvas.tsx` execution sandbox.** Cursor's full canvas (esbuild → proto → host webview + `useCanvasState`/`useCanvasAction` RPC) is a separate future RFC. This is render-side only.
- No per-line syntax highlighting (v2 via `path`/`language`), no interactive hunk staging, no window virtualization (the daemon cap suffices for v1).

## Consequences

- Web surface gains a rich diff renderer + segmented usage bar driven by the single source of truth. **Zero recompute** — diff math runs once daemon-side; usage uses the loop's own estimator.
- **Negative invariants:** agent-authored canvas execution NOT introduced; diff math NEVER duplicated in the web bundle (the frontend only receives `DiffLineData[]`); the chat path (`MessageBubble`/`ChatPanel`) is import-unchanged.
- **Honest stubbed-vs-wired:** the `context.usage` channel is wired LIVE end-to-end (facade source → `onPromptAssembled` → WS → hook → `UsageBar`). The `tool.diff` channel's protocol, emitter (`feedToolDiff`), frontend hook + `DiffPanel` are fully wired and tested; the live agent-seam binding that surfaces a tool's before/after file text does not yet exist, so the diff channel lights up the moment such a seam is added (documented in `canvas-emitter.ts` / `server.ts`).

## Knob

`QUANTA_WEB_CANVAS=1` — eagerly mint the facade + wire `onPromptAssembled` + attach the per-connection canvas sink. Unset ⇒ byte-identical.
