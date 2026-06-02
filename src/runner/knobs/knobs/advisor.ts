/**
 * Knob: `advisor` — agent-callable ADVISOR consult tool (ADR-0429).
 *
 * Env-flips the `advisor` tool from ABSENT to LIVE. When `QUANTA_ADVISOR_MODEL`
 * names a model in the closed advisor allowlist, `apply` populates
 * `config.advisor` (the `{consult, models}` slot `buildAdvisorBlock` reads) so
 * the tier-1 features assembly registers the `advisor` tool. Absent / unlisted
 * env ⇒ `parse` returns `undefined`, `config.advisor` stays unset, and the
 * ToolRegistry is byte-identical (RFC §1.2 default-OFF — proven in tests).
 *
 * The consult mechanism is built PURELY from the baseline `AgentConfig.llm`
 * (always present) via `advisorConsultFromLLM`: it streams ONE assistant turn
 * with NO tools offered (the advisor cannot call tools or mutate anything) and
 * returns the text. `resolveModel` honors an explicit (already-allowlist-
 * validated by the tool) `requested` model and otherwise falls back to the
 * env-chosen advisor model. This mirrors the `lsp` knob's posture of importing
 * `@/agent` to fold a real capability into the config — it is still a PURE fold
 * (a closure over `cfg.llm` + the parsed model), never an env / fs read here.
 *
 * NO HEURISTICS: `parse` is a STRICT membership test against a closed,
 * hand-curated allowlist of advisor-eligible model ids. Anything not in the set
 * (typos, case variants, prefixes, garbage, empty, whitespace) returns
 * `undefined` so the caller falls through to the next layer rather than being
 * silently coerced — and an off-allowlist model can never reach the LLM.
 *
 * Surfaces: cli + agent-batch + agent-interactive. EXCLUDES `bench` —
 * a deliberate mid-loop second-opinion call changes trajectory length + the
 * prefix-cache key, so SWE-bench-style measurement stays on the no-advisor path.
 */

import type { AgentConfig } from "@/agent"
import { advisorConsultFromLLM } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["cli", "agent-batch", "agent-interactive"]

/**
 * Closed advisor-model allowlist. These are the model ids an operator may set
 * `QUANTA_ADVISOR_MODEL` to AND the set the tool validates an explicit `model`
 * argument against (fail-closed). Kept as a hand-curated closed set — adding a
 * model is a one-line, reviewable diff — rather than accepting any string, so a
 * stronger / costlier model can never be invoked off-allowlist by typo or
 * prompt-injection. No heuristics, no prefix matching.
 */
export const ADVISOR_MODEL_ALLOWLIST: readonly string[] = Object.freeze([
  "o3",
  "o3-pro",
  "gpt-5",
  "gpt-5-pro",
  "claude-opus-4-8",
  "claude-opus-4-8[1m]",
])

const ALLOWED = new Set<string>(ADVISOR_MODEL_ALLOWLIST)

/** The parsed value: the resolved advisor model id + the allowlist the tool
 *  enforces an explicit `model` against. */
interface AdvisorValue {
  readonly model: string
  readonly models: readonly string[]
}

/** STRICT membership test — no trimming, no case folding, no prefixing. An id
 *  outside the closed allowlist returns `undefined` (falls through). */
const parseAdvisor = (raw: string | undefined): AdvisorValue | undefined => {
  if (raw === undefined) return undefined
  if (!ALLOWED.has(raw)) return undefined
  return { model: raw, models: ADVISOR_MODEL_ALLOWLIST }
}

/**
 * Fold the parsed advisor model into `config.advisor`. PURE: closes over the
 * baseline `cfg.llm` (always present) to build a genuine one-shot `consult`,
 * never reading env / fs here. `resolveModel` honors an explicit requested
 * model (already validated against the allowlist by the tool) and otherwise
 * uses the env-chosen advisor model.
 */
const applyAdvisor = (
  cfg: AgentConfig,
  value: AdvisorValue,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  const consult = advisorConsultFromLLM({
    llm: cfg.llm,
    resolveModel: (requested?: string) => requested ?? value.model,
  })
  return { ...cfg, advisor: { consult, models: value.models } }
}

export const advisorKnob: Knob<AdvisorValue> = {
  id: "advisor",
  envKey: "QUANTA_ADVISOR_MODEL",
  category: "tool",
  surfaces: SURFACES,
  parse: parseAdvisor,
  apply: applyAdvisor,
  describe: "Agent-callable advisor consult tool (second opinion from a stronger model)",
  source: "ADR-0429",
}

registerKnob(advisorKnob)
