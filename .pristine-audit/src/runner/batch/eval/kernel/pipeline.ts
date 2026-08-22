/**
 * SOTA architecture spine — Pillar B core: the GENERIC pipeline kernel.
 *
 * The whole point: the orchestrator must NOT know which features exist. Today the
 * bench driver names every feature inline (`if (posture.verifySelectN) …` ×253),
 * so toggling/removing one is god-module surgery. Here the engine is a ~15-line
 * fold over a list of `Step`s; a feature is a self-contained `Step` that REGISTERS
 * into the pipeline. The kernel references zero feature names. Adding a feature =
 * one new Step module; removing one = delete that module + drop it from the list.
 *
 * Generic over:
 *   - `C` — the accumulating context the steps thread (the eval state bag).
 *   - `G` — the resolved-config the gate reads (for bench eval: `BenchPosture`).
 *
 * Inversion of control: steps depend on the kernel's `Step` contract; the kernel
 * depends on nothing. This is the open/closed boundary the current driver lacks.
 *
 * Additive + default-OFF: this kernel is NOT yet wired into the live driver. It
 * is exercised by parity tests (kernel-over-steps === current driver for the
 * migrated phases) until every phase is a Step, then the driver becomes a thin
 * `runPipeline(EVAL_STEPS, ctx0, posture)` call.
 */

/** A single composable unit of the eval pipeline. Self-contained: owns its gate
 *  (is it active for this config?) and its effect (transform the context). */
export interface Step<C, G> {
  /** Stable id (kebab) — used for telemetry, ordering, and pipeline specs. */
  readonly id: string
  /** Pure predicate: is this step included for the resolved config? Keeps the
   *  "default-OFF byte-identical" invariant a per-step property, not a driver if. */
  gate(config: G): boolean
  /** The effect: fold the context forward. MUST be a no-op-equivalent (return the
   *  input context unchanged) when its work is not applicable, so a gated-in step
   *  that finds nothing to do stays byte-identical. */
  run(ctx: C): Promise<C>
}

/** Telemetry hook: fired once per step with whether the gate admitted it. Lets the
 *  report show the EXACT pipeline that ran (no more "which knobs actually engaged?"
 *  archaeology). Never throws — observability must not change control flow. */
export type StepObserver = (entry: {
  readonly id: string
  readonly included: boolean
  readonly index: number
}) => void

/**
 * Run an ordered pipeline: fold each gated-in step over the context. The ONLY
 * control-flow engine for the eval. Deterministic, feature-agnostic, ~one screen.
 *
 * A step that throws aborts the pipeline (the caller decides recovery) — the
 * kernel does not swallow, so a real failure is never laundered into a silent
 * pass (the verify-select empty-patch class is structurally impossible here:
 * there is no "winner-or-empty" selection in the engine; a step either produces
 * its contribution or the pipeline surfaces the throw).
 */
export const runPipeline = async <C, G>(
  steps: readonly Step<C, G>[],
  ctx0: C,
  config: G,
  observe?: StepObserver,
): Promise<C> => {
  let ctx = ctx0
  let index = 0
  for (const step of steps) {
    const included = step.gate(config)
    observe?.({ id: step.id, included, index })
    index += 1
    if (included) ctx = await step.run(ctx)
  }
  return ctx
}

/** Validate a pipeline at assembly time: ids unique + non-empty. Cheap structural
 *  guard so a duplicate/typo step id fails fast at wiring, not mid-run. */
export const assertPipelineWellFormed = <C, G>(steps: readonly Step<C, G>[]): void => {
  const seen = new Set<string>()
  for (const s of steps) {
    if (s.id.trim() === "") throw new Error("pipeline: a step has an empty id")
    if (seen.has(s.id)) throw new Error(`pipeline: duplicate step id "${s.id}"`)
    seen.add(s.id)
  }
}
