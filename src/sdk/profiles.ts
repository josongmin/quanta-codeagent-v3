/**
 * `@/sdk/profiles` — capability profile → run mode (Phase 4, first cut).
 *
 * All three profiles currently map to the `batch` mode's POLICY levers: multi-turn
 * (`termination: verdict`), auto/acceptEdits, per-instance sandbox — the only stock
 * preset whose policy fits a repo-analysis MAIN LOOP (`headless` is single-turn;
 * see MODE_PRESETS in `@/agent/run-mode`).
 *
 * PROMPT ≠ POLICY (3-axis independence). The `batch` ModePolicy declares
 * `promptPack: {kind:"benchmark"}`, but — exactly like EVERY app mode-preset
 * (`apps/agent/mode-presets/{interactive,daemon,headless,ci-bot}.ts`, all of which
 * do `system: req.base.system ?? buildSystemPrompt(cwd)`) — the SDK builds the
 * system prompt via `buildSystemPrompt(cwd)` with the DEFAULT interactive prompt
 * pack (`embed.ts`). The mode's `promptPack` lever is a task-pack axis consumed by
 * the bench harness path, NOT re-applied to the loop's system prompt here; that
 * axis is deliberately orthogonal to the env-posture prompt (jul-04 3-axis prompt
 * refactor). So the SDK agent runs the interactive-assistant prompt under batch
 * POLICY by design. A consumer who wants a task-focused prompt passes their own
 * `opts.system` (embed.ts honors it verbatim). Do NOT special-case the SDK to
 * thread `promptPack` — that would make it the lone preset diverging from the rest.
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
