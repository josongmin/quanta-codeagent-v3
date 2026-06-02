# ADR-0448 — Canvas Rich Layer (split DiffView + collapsible hunks + labeled UsageBar legend)

**Status:** Accepted (2026-06-02)
**RFC:** `docs/plans/jun-2-misc/10-canvas-diffview-usagebar.md`
**Builds on:** ADR-0440 (RFC-06 — base canvas primitives `DiffView`/`DiffStats`/`UsageBar`/`tokens` + the `tool.diff`/`context.usage` data port + `DiffPanel`)
**Default-OFF:** Yes — additive only. Existing `DiffView`/`UsageBar` render byte-identically; new modes/props default to current behavior; the usage panel renders `null` when the RFC-06 canvas channel is OFF.

## Context

RFC-06 (ADR-0440) shipped the BASE render-side canvas primitives in
`apps/web-frontend/src/components/canvas/`: an inline-only `DiffView`
(flat `DiffLineData[]`), `DiffStats`, a `UsageBar` primitive (segments +
remainder + labels, dropping each category's color + char count), `tokens.ts`
(the 7-hue palette), the lossless adapters, and the `tool.diff` / `context.usage`
WS data port. RFC-06 explicitly deferred (its NG3) the two Cursor
`cursor/canvas` helper primitives — `Swatch` and `CollapsibleSection` — and the
side-by-side / collapsible-hunk diff layout.

RFC-10 is STRICTLY that deferred rich layer. It re-runs no diff math and adds no
new WS channel — it re-segments the `DiffLineData[]` RFC-06 already ships and
re-colors the `context.usage` segments RFC-06 already sends.

## Decision

### New primitives (the two RFC-06 deferred — Cursor d.ts mirrors)
- `Swatch.tsx` — mirrors `swatch.d.ts:11-15` (`{ color: Color; style? }`, plus
  `className`). A 16px rounded category chip whose hue comes ONLY from
  `tokens.ts#colorPalette`, so a category's swatch matches its same-`color`
  `UsageBar` segment (swatch.d.ts:22-23 coherence). `aria-hidden` — the category
  text is always the a11y signal, never color alone.
- `CollapsibleSection.tsx` — mirrors `collapsible-section.d.ts:10-31`
  (`title`/`leading`/`count`/`trailing`/`children`/`style`, plus `className`).
  Uncontrolled, **closed-default** (d.ts:33 — no `defaultOpen`), chevron + indented
  tree body. The shared building block for both diff-hunk folding and usage
  drilldown.

### Rich DiffView (split + collapsible hunks) — ADDITIVE to ADR-0440
- `diff-hunks.ts` (pure) — `groupHunks(lines, contextLines=3)` re-segments the
  flat `DiffLineData[]` into visible-change hunks (a change + `contextLines` of
  surrounding context) interleaved with foldable unchanged runs
  (`collapsed: true`). `contextLines` is the validated git default, not an
  invented heuristic. Deterministic. No diff math.
- `SplitDiffView.tsx` — side-by-side: removed/unchanged on the LEFT (old side),
  added/unchanged on the RIGHT (new side); changed lines zipped del↔add in op
  order (LCS already orders del→add — no new alignment algorithm); the unpaired
  side gets an empty cell. Each hunk is a self-contained real `<table>` (matches
  ADR-0440's native-semantic inline table); collapsed hunks render inside a
  `CollapsibleSection`.
- `DiffView.tsx` (ADR-0440, edited) — gains `mode?: "inline" | "split"`
  (default `"inline"`) + `contextLines?`. **The inline path is byte-identical**
  (extracted to `inlineDiffTable`, unchanged output); `mode="split"` delegates to
  `SplitDiffView`. Every existing caller + test is unchanged.

### Labeled UsageBar legend — consumes the RICHER data
- `category-hues.ts` (pure) — `CATEGORY_TO_HUE` (System=gray, Tools=purple,
  Rules=green, Skills=yellow, MCP=pink, Subagents=blue, Conversation=orange) —
  the canonical mapping baked into Cursor `usage-bar.d.ts:44-50`, 1:1 with our
  `CATEGORY_ORDER`. `breakdownToUsageBarProps` converts a `ContextUsageMessage`
  → RFC-06 `UsageBarProps`, painting each segment its category hue (RFC-06's own
  adapter leaves color unset) and reproducing the CLI head-line labels verbatim
  via the RFC-06 `usage-adapter.ts` helpers. `max<=0` (unknown window) ⇒ label
  degrades to `?` (no false `0% Full`).
- `UsageBreakdownPanel.tsx` — consumes the `context.usage` frame directly:
  the RFC-06 `UsageBar` on top (hue-colored) + a per-category legend, each row a
  `CollapsibleSection` with a `Swatch` `leading` of the matching hue and a
  `tokens · chars · %` `trailing` readout (surfacing the `chars` RFC-06 drops).
  `null` usage ⇒ renders nothing (default-OFF). Empty segments ⇒ header + bar
  only.

### Wire — one optional additive field
- `types/protocol.ts#ContextUsageMessage` — segment gains an OPTIONAL `chars?`
  field (RFC-10 §4.3, the only wire change). Absent ⇒ the panel omits the chars
  readout gracefully ⇒ RFC-06 byte-compatible. `color` is NOT wired (derived
  client-side from the category id via `CATEGORY_TO_HUE`).

### Integration / mount points
- `DiffPanel.tsx` (ADR-0440, edited) — gains `mode?: DiffViewMode` (default
  `"inline"`), forwarded to `DiffView`. Any host can opt a tool diff into split.
- `ObservabilityPane.tsx` (edited) — gains an optional `usage?` prop; when
  present + non-null it mounts `UsageBreakdownPanel` at the top of the pane.
  Absent / null ⇒ pane byte-unchanged (default-OFF).
- `App.tsx` (edited) — wires `useContextUsage(canvasSource)` and passes it to the
  pane. The RFC-06 client-side canvas dispatch is not yet wired onto
  `SessionClient`, so `canvasSource` is `null` today ⇒ the panel stays
  un-rendered; the moment RFC-06 exposes canvas frames (e.g. `client.onCanvas`),
  swapping `null` for that source lights up the panel with no further change.

## Consequences

- **Additive / default-OFF:** existing `DiffView`/`UsageBar`/`DiffStats`/adapter
  tests are byte-identical and green. New modes/props default to current
  behavior; the rich panel is dormant until RFC-06's data channel feeds it.
- **No recomputation:** diff math (LCS) and usage breakdown stay single-sourced;
  this slice only re-segments + re-colors already-classified data.
- **Honest deferred:** the panel is mountable and wired through the pane, but its
  live data source depends on RFC-06's still-pending client-side canvas dispatch
  (`SessionClient` has no `onCanvas`). Until then it is a real, type-checked,
  mounted component fed `null`. The `chars` field is surfaced only if the daemon
  emitter serializes it. Interactive open/close of `CollapsibleSection` is not
  unit-exercised because the web-frontend test suite has no DOM environment (no
  jsdom / testing-library — every test uses `react-dom/server`); the
  closed-default contract IS sealed.

## Tests

45 new tests across 6 files (`diff-hunks`, `category-hues`, `Swatch`,
`CollapsibleSection`, `SplitDiffView` + DiffView mode prop, `UsageBreakdownPanel`):
hunk grouping (context preservation / folding / all-unchanged / boundaries /
determinism), category→hue 1:1 + fallback + label degrade, swatch palette
coherence, collapsible closed-default + slots, split zip + empty-cell + fold +
inline regression anchor, usage panel legend colors + chars + max=0 + empty +
default-OFF null. Full web-frontend suite: 155 passed / 19 files / 0 fail.
tsc clean for all new/edited files (one pre-existing ADR-0440 `canvas-hooks.test.ts`
type error is out of scope).
