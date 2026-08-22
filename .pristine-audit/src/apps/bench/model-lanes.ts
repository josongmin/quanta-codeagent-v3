/**
 * G1 — verify-select MODEL-LANE composition (apps/bench composition root).
 *
 * Builds `RunInstanceDeps.llmLanes`: an ordered list of DISTINCT-MODEL
 * `LLMPort`s so verify-select candidate `i` is generated against a DIFFERENT
 * model than candidate `i-1` (a diversity axis ORTHOGONAL to the per-candidate
 * fix-site `seeds[i]`). The driver consumes it via `resolveLaneLlm` /
 * `laneDepsFor` (src/runner/batch/eval/driver.ts).
 *
 * Default-OFF byte-identical: the knob `QUANTA_BENCH_MODEL_LANES` is UNSET ⇒
 * {@link resolveModelLanes} returns `undefined` ⇒ `deps.llmLanes` is omitted ⇒
 * `resolveLaneLlm` always returns `deps.llm` ⇒ every downstream config is the
 * single-port path verbatim. The feature engages ONLY when the knob names ≥2
 * DISTINCT model ids that EACH resolve to a real credential.
 *
 * Auth reality (2026-06): the only on-disk credential is ChatGPT-OAuth
 * (OpenAI-family). There is no Anthropic key, so a real cross-VENDOR lane is
 * impossible right now and an Anthropic id would just collapse to the base
 * fallback (a ghost lane). This builder is therefore MODEL-lane within the
 * authenticated provider: distinct OpenAI-family model ids (e.g. `gpt-5.4`,
 * `gpt-5-2`, `o4-mini`) each become a port pinned to that model. A lane whose
 * port cannot be built (no credential for that model) is DROPPED, not faked —
 * if fewer than 2 survive, the whole feature stays inert (returns undefined).
 *
 * Vendor-extensible: when an Anthropic (or other) credential later exists, the
 * `buildLanePort` factory will resolve those model ids to real ports and they
 * join the lane list automatically — no shape change here.
 */

import type { LLMPort } from "@/llm"
import { gateOn } from "@/shared"

/** Env knob name. Value = comma-separated DISTINCT model ids (the FIRST is the
 *  lane-0 / primary model). A bare `1`/`true`/`on` enables the built-in default
 *  pair (see {@link DEFAULT_MODEL_LANES}); a list overrides it. */
export const MODEL_LANES_ENV = "QUANTA_BENCH_MODEL_LANES"

/** Built-in default pair used when the knob is enabled WITHOUT an explicit list
 *  (`QUANTA_BENCH_MODEL_LANES=1`). Both are OpenAI-family models the on-disk
 *  ChatGPT-OAuth credential can serve. Override with an explicit comma list. */
export const DEFAULT_MODEL_LANES: readonly string[] = ["gpt-5.4", "gpt-5-2"]

/** Parse the knob value into an ORDERED, DISTINCT, non-empty model-id list, or
 *  `undefined` when the feature is off. A bare boolean-true value ⇒ the default
 *  pair; an explicit comma list ⇒ that list (trimmed, blanks dropped, de-duped
 *  preserving first-seen order). */
export const parseModelLaneIds = (
  env: Record<string, string | undefined>,
): readonly string[] | undefined => {
  const raw = env[MODEL_LANES_ENV]
  if (raw === undefined || raw.trim() === "") return undefined
  const value = raw.trim()
  // Boolean-true forms select the built-in default pair (no list given).
  if (gateOn(env, MODEL_LANES_ENV) && !value.includes(",") && DEFAULT_LANE_TRUE.has(value)) {
    return [...DEFAULT_MODEL_LANES]
  }
  const ids: string[] = []
  for (const part of value.split(",")) {
    const id = part.trim()
    if (id !== "" && !ids.includes(id)) ids.push(id)
  }
  return ids.length === 0 ? undefined : ids
}

const DEFAULT_LANE_TRUE = new Set(["1", "true", "on", "yes"])

/**
 * Resolve the model lanes for the run, or `undefined` (feature inert) when:
 *  - the knob is unset/empty, OR
 *  - fewer than 2 DISTINCT model ids are configured, OR
 *  - fewer than 2 ids resolve to a buildable (credentialed) port.
 *
 * `buildLanePort(modelId)` returns a port pinned to that model, or `null` when
 * no credential can serve it (so a misconfigured/unauthenticated lane is
 * dropped, never faked). `<2` surviving lanes ⇒ `undefined` ⇒ byte-identical.
 *
 * Hermetic: `buildLanePort` is injected (the prod composition root passes a
 * `tryCreateLLM`-backed factory); tests pass fakes. No `process.env` read for
 * credentials here — that lives in the injected factory.
 */
export const resolveModelLanes = (deps: {
  readonly env: Record<string, string | undefined>
  readonly buildLanePort: (modelId: string) => LLMPort | null
}): readonly LLMPort[] | undefined => {
  const ids = parseModelLaneIds(deps.env)
  if (ids === undefined || ids.length < 2) return undefined
  const lanes: LLMPort[] = []
  for (const id of ids) {
    const port = deps.buildLanePort(id)
    if (port !== null) lanes.push(port)
  }
  // <2 buildable lanes ⇒ no diversity to gain ⇒ stay inert (byte-identical).
  return lanes.length < 2 ? undefined : lanes
}
