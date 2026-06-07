/**
 * 1M-context resolution (gap-other-agent GAP 3).
 *
 * Anthropic exposes a 1M-token context as a BETA: the Claude CLI activates it via
 * a `[1m]` model-id suffix → the `context-1m-2025-08-07` beta header + the larger
 * window. quanta already carried the `-1m` window entries in
 * {@link MODEL_CONTEXT_WINDOWS} but had no resolver wiring the suffix/knob to the
 * header + window key (the `[1m]` literal in the advisor knob allowlist was an
 * orphan).
 *
 * This is the essential PURE function. Eligibility is DERIVED from the window
 * table — a model is 1M-capable iff its `<model>-1m` variant exists — so there is
 * no parallel hardcoded eligibility list to drift. Pure + NO-THROW; takes env in
 * (never reads `process.env`).
 *
 * Default-OFF: a plain model with no `[1m]` suffix and no `QUANTA_CONTEXT_1M` is
 * `active:false` with `windowKey === model` and no beta header — byte-identical
 * to pre-feature behavior.
 */
import { gateOn } from "@/shared"
import { MODEL_CONTEXT_WINDOWS } from "./provider-metadata"

/** The Anthropic beta channel that unlocks the 1M-token context window. */
export const CONTEXT_1M_BETA = "context-1m-2025-08-07"

/** Opt-in knob to request 1M context without the `[1m]` model suffix. */
export const CONTEXT_1M_FLAG = "QUANTA_CONTEXT_1M"

const SUFFIX = "[1m]"

export interface Context1MResolution {
  /** Canonical model id (the `[1m]` suffix stripped if present). */
  readonly model: string
  /** True iff 1M context is BOTH requested (suffix or knob) AND eligible. */
  readonly active: boolean
  /** The beta header to send — present ONLY when `active`. */
  readonly betaHeader?: string
  /** The {@link MODEL_CONTEXT_WINDOWS} key to look the window up under: the
   *  `<model>-1m` variant when active, else the plain model id. */
  readonly windowKey: string
}

/** A model is 1M-capable iff the window table has its `-1m` variant. */
const has1mVariant = (model: string): boolean => `${model}-1m` in MODEL_CONTEXT_WINDOWS

/**
 * Resolve 1M-context activation for a model id. See file header for the rules.
 */
export const resolveContext1M = (
  rawModel: string,
  env: Record<string, string | undefined>,
): Context1MResolution => {
  const suffixed = rawModel.endsWith(SUFFIX)
  const model = suffixed ? rawModel.slice(0, -SUFFIX.length) : rawModel
  const requested = suffixed || gateOn(env, CONTEXT_1M_FLAG)
  const active = requested && has1mVariant(model)
  return active
    ? { model, active: true, betaHeader: CONTEXT_1M_BETA, windowKey: `${model}-1m` }
    : { model, active: false, windowKey: model }
}
