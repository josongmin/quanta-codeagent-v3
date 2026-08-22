/**
 * CLI-06 — REPL host-bootstrap factories barrel.
 *
 * Each factory is a thin, individually-testable composer for one default-OFF
 * surface adapter. The `runRepl` orchestrator imports them via this barrel so
 * the host file (`src/apps/cli/repl.ts`) drops below ~300 LOC and owns ONLY
 * entry routing + prompt UX + slash-ctx compose + turn-sink compose.
 *
 * Slice fence: these files live UNDER `src/apps/cli/repl/` so they may import
 * from sibling `src/apps/cli/<file>` modules — the CLI-01 host bootstrap slice
 * (`src/host/bootstrap/`) is unaffected. See ADR-0307.
 */
export { buildBranchProgressOrUndefined } from "./branch-progress"
export { buildCostPanelOrUndefined } from "./cost-panel"
export { buildDebugTracerAndStream } from "./debug-tracer"
export { buildLifecycleBundle, deriveMcpPillServers, type LifecycleBundle } from "./lifecycle"
export { buildWorkMetricsSink } from "./metrics-sink"
// RFC-09 (A+B) — completion-notify + pre-compaction warning host bundle.
export { buildNotifyAndContextWarning, type NotifyAndWarningBundle } from "./notify-and-warning"
export { buildPlanStoreOrUndefined } from "./plan-store"
export { buildTimelinePanelAndStream } from "./timeline-panel"
export { buildTurnIndicatorAndStream } from "./turn-indicator"
export { buildTurnSummaryAndStream } from "./turn-summary"
