/**
 * Bench env-var parsers + A/B opt-in resolver (pure code motion from
 * `driver.ts`, byte-identical). Owns the BENCH-INTENTIONAL opt-out doc block,
 * `parseBenchBranchSearchK`, the `IssueHintMode` alias, `benchOptIns` (the thin
 * projection over the unified preset/knob framework), and `parseLocalizePhaseEnv`.
 * A leaf: it only reads `process.env` + the knob framework, so both `driver.ts`
 * and the extracted selection-port factories import `benchOptIns` from HERE
 * (no driver import cycle).
 */

import type { AgentConfig } from "@/agent"
import {
  type BenchIssueHintMode,
  type BenchPosture,
  benchPostureFromState,
  resolveBenchKnobs,
} from "../knobs-bench"

/**
 * BENCH-INTENTIONAL OPT-OUTS (Codex absorption Phases 0-8 + Round 3):
 * the SWE-bench grader is byte-sensitive (the official Python harness diffs
 * the agent's patch against the reference), so the bench harness deliberately
 * omits every optional Codex-absorption knob below. The agent runs in the
 * *plainest possible posture* — only the cache lever (ADR-0004), compaction
 * (ADR-0011), and `verifyGuard` (ADR-0013, when explicitly enabled by the
 * caller) are touched. The omissions are NOT oversight; reintroducing them
 * would change measurement integrity:
 *
 *   - `mode`             — bench is plain "default" (no plan/review/audit
 *                          posture forcing); the agent's task is the diff,
 *                          not the report shape.
 *   - `repoRules`        — sandbox repo's own `CONTRIBUTING.md`/etc. is not
 *                          loaded as agent authority; bench measures the
 *                          agent's intrinsic skill, not its rule-reading.
 *   - `hitl`             — bench is unattended (`acceptEdits` permission);
 *                          a HITL gate would deadlock on every confirm.
 *   - `closeoutGuard`    — closeout reminders shape report text, not patch
 *                          contents; bench measures patches.
 *   - `workingState`     — L3 scratchpad rides the reminder and changes the
 *                          turn-context bytes; bench keeps a stable prompt.
 *   - `skills`           — skill discovery + active-skills block likewise
 *                          shifts the per-turn reminder.
 *
 * Opt-in flags added (A/B measurement; default-OFF preserves byte-identity):
 *   - QUANTA_BENCH_LSP=1            wire LSP nav tools (OR with QUANTA_LSP_TOOLS=full)
 *   - QUANTA_BENCH_SUBAGENT=1       wire `subagent` AgentConfig block
 *   - QUANTA_BENCH_SKILLS=1         wire `skills` AgentConfig block (bundled-only)
 *   - QUANTA_BENCH_BRANCH_SEARCH=K  wire `branchSearch` AgentConfig block with
 *                                   `defaultN=K` (Agentless N-best, ADR-0084).
 *                                   K must be an integer >= 2 (1-best ≡ baseline
 *                                   ⇒ ignored; non-integer / NaN / negative /
 *                                   garbage ⇒ ignored). Cost scales ~K× vs
 *                                   baseline — keep OFF unless measuring N-best.
 *                                   NOT auto-enabled for `instance.swebench` —
 *                                   explicit opt-in only (cost discipline).
 *   - QUANTA_BENCH_LLM_SELECT=chooser|reviewer  LLM soft-rerank over the acceptance
 *                                   admissible survivors (SWE-agent Chooser/Score
 *                                   retry-loop absorption). Re-ranks WITHIN the
 *                                   deterministic admissible set only (never-veto)
 *                                   and fails open to the vote winner; needs the
 *                                   acceptance selector to be active to have an
 *                                   effect. ~N× one-shot LLM cost. See
 *                                   {@link resolveAcceptanceLlmRerank}.
 *  See {@link benchOptIns} (just below) for the resolver — the BENCH-INTENTIONAL
 *  posture is unchanged when all four are unset. If a future bench mode wants
 *  any of the other listed knobs, add another opt-in flag — do NOT remove this
 *  comment block without an accompanying measurement-integrity ADR.
 */

/** Parse `QUANTA_BENCH_BRANCH_SEARCH` to a positive integer K>=2. Returns
 *  `undefined` for every other shape (absent / `"0"` / `"1"` / negative /
 *  non-integer / NaN / garbage / empty / whitespace) — the gate is *strict*
 *  by design (K=1 is byte-identical to baseline, so wiring it would only add
 *  overhead without measurement effect). Exported for direct unit + hellgate.
 *
 *  No heuristics: K bounds match the slice's own `tool.ts` zod schema
 *  (`.min(2).max(8)`). K>8 is rejected here too so a misconfigured env can't
 *  cause the model to emit a request the tool would reject at runtime. */
export const parseBenchBranchSearchK = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  // Trim whitespace; empty after trim ⇒ unset.
  const s = raw.trim()
  if (s === "") return undefined
  // Reject if the trimmed string contains any internal whitespace (e.g.
  // "1 2"), or anything that isn't a leading optional sign + digits.
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  // K<2 ⇒ 1-best ≡ baseline; K>8 ⇒ matches slice's hard cap (tool.ts zod
  // `.min(2).max(8)`). Out-of-range ⇒ ignored (don't silently clamp).
  if (n < 2 || n > 8) return undefined
  return n
}

/** SWE-bench A/B opt-in resolver. EVERY flag default-OFF; an unset env yields
 *  `{ lspNav:false, subagent:undefined, skills:undefined, branchSearch:undefined }`
 *  and `buildConfig` is byte-identical to the BENCH-INTENTIONAL posture above.
 *  Exported for direct unit testing — four independent env reads, no
 *  cross-coupling.
 *
 *  Slice-isolation choice: the CLI has cousins (`buildSubagentConfig` /
 *  `buildSkillsConfig` in `src/apps/cli/internal.ts`) but they read DIFFERENT
 *  env keys (`QUANTA_SUBAGENT` / `QUANTA_SKILLS_DIR` + a `--skills` argv
 *  check). Bench needs its OWN bench-only gate so a `QUANTA_SUBAGENT=1`
 *  exported in a dev shell does NOT silently leak into measurement runs.
 *  Inline duplication is intentional: ~3 lines per builder, isolated test
 *  surface, no `apps/bench → apps/cli` import dependency. */
/**
 * Issue-hint mode resolved from `QUANTA_BENCH_ISSUE_HINT`:
 *   - `"off"`       — flag unset OR value not in the accept-list. Default-OFF
 *                     posture: byte-identical to the pre-feature path.
 *   - `"regex"`     — `=1` / `=on`. The legacy regex extractor
 *                     (`extractIssueHint` + `composeIssueHint`) runs synchronously
 *                     inside `buildConfig`. Pre-existing behavior — kept stable.
 *   - `"agentless"` — `=agentless`. The new LLM-driven path (Agentless paper
 *                     Stage 1). Async pre-compute via `prepareIssueHint`; on any
 *                     failure the wiring falls back to `regex`.
 *
 * Strict accept-list — anything else (`true`, `yes`, garbage) ⇒ `off`. */
export type IssueHintMode = BenchIssueHintMode

/**
 * SWE-bench A/B posture resolver — now a THIN PROJECTION over the unified
 * preset/knob framework (`resolveBenchKnobs` → `benchPostureFromState`), NOT a
 * pile of raw `process.env` reads. This is the chokepoint both `buildConfig`
 * (config fields) and the apps driver (`issueHintMode` / `reproTestK` /
 * `retryTransient`) consume, so a selected preset (`QUANTA_BENCH_PRESET=...`,
 * or the `QUANTA_BENCH_SOTA=1` alias) ACTUALLY drives the run — and the same
 * resolved state feeds the telemetry report, so report == applied by
 * construction (no more report-lie).
 *
 * Layering (handled inside `resolveBenchKnobs`): explicit `QUANTA_BENCH_*` env
 * var > preset value > knob default. With no preset and no env, every field is
 * OFF/undefined — byte-identical to the historical baseline.
 *
 * The legacy `parseBenchBranchSearchK` / `parseLocalizePhaseEnv` exports below
 * are retained for the unit/hellgate tests that pin the parsers directly; the
 * production parse now happens inside the framework knobs (verbatim-migrated).
 */
export const benchOptIns = (): BenchPosture =>
  benchPostureFromState(resolveBenchKnobs({ envVars: process.env }), process.env)

/** Pure parser for the `QUANTA_BENCH_LOCALIZE_PHASE` env var. Exported for
 *  direct unit testing — keeps the resolver above one-line readable.
 *
 *  Domain (ACTIVE):
 *    - The string parses to a finite integer N in [1, 20] ⇒ `{ phase1Turns: N }`.
 *
 *  Domain (INACTIVE, all return `undefined`):
 *    - absent / empty string
 *    - non-numeric ("garbage", "1.5", "abc")
 *    - 0 / negative / NaN / Infinity
 *    - > 20 (measurement-integrity cap)
 *
 *  Closed parser: explicit `Number.isFinite` + `Number.isInteger` checks (no
 *  `parseInt`-then-coerce that would silently swallow "1abc" as 1). */
export const parseLocalizePhaseEnv = (
  raw: string | undefined,
): AgentConfig["localizePhase"] | undefined => {
  if (typeof raw !== "string") return undefined
  if (raw.length === 0) return undefined
  // Use Number(...) (NOT parseInt) so "1abc" / "1.5" cleanly become NaN /
  // non-integer and fail the validity check — no partial-parse foot-gun.
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  if (!Number.isInteger(n)) return undefined
  if (n < 1) return undefined
  if (n > 20) return undefined
  return { phase1Turns: n }
}
