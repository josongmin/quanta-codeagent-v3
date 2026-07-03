/**
 * `@/sdk/profiles` — capability profile → run mode (Phase 4, first cut).
 *
 * All three profiles currently map to the `batch` mode: multi-turn
 * (`termination: verdict`), auto/acceptEdits, per-instance sandbox — the only
 * stock preset that fits a repo-analysis MAIN LOOP (`headless` is single-turn;
 * see MODE_PRESETS in `@/agent/run-mode`).
 *
 * Phase 4 refines this into custom lever overrides (read-only = mutating-tool
 * block + net denied; analysis = net OPEN; full = memory/subagent/MCP slots)
 * via `narrowMode` + wire-slot gating. Until then the profile only selects the
 * mode; wire-slots stay OFF (audit A/F: no surprise memory-distill LLM call).
 */

import type { RunMode } from "@/agent"

// `full` (memory/subagent/MCP wire-slots) is intentionally NOT in the union
// yet — exposing it while it behaves identically to `analysis` would be a
// silent trap. It returns when its wire-slot assembly lands (plan §04-B).
export type AnalysisProfile = "read-only" | "analysis"

export const DEFAULT_PROFILE: AnalysisProfile = "analysis"

/**
 * Chosen path (jul-4 decision): all profiles map to `batch` — the only stock
 * mode that is BOTH multi-turn (`termination: verdict`) AND safe for a
 * repo-analysis loop. Its `network: denied` lever blocks only quanta's OWN
 * egress tools (Bash/web_fetch) — a consumer's injected in-process
 * `defineTool` (no `url`/`host` field, non-shell) is NOT classified as
 * egress-bearing, so consumer tools that do network via their own SDK run
 * unaffected. A future net-open loop would need a NEW matrix mode (plan §04-B).
 */
export const modeForProfile = (_profile: AnalysisProfile): RunMode => "batch"

/** `read-only` additionally strips mutating tools from the registry (mode
 *  policy alone can't be lever-customised — the matrix is frozen). */
export const isReadOnlyProfile = (profile: AnalysisProfile): boolean => profile === "read-only"
