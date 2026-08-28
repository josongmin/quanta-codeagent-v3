/**
 * The EFFECTIVE model — one authority for "what the next turn will actually run"
 * (aug-28).
 *
 * THE DEFECT THIS CLOSES. `config.llm.model` is the BOOT model: the port the
 * composition root minted at session start. Once `/model` (and the web
 * `set_model` frame) could really swap the model per turn, every display that
 * reported `config.llm.model` started lying for the rest of the session:
 *
 *   - `SessionHost.describe().modelSlug` → the attach pill (`[session · <model>]`),
 *     the SDK's `session.model`, and the web `/state` + `/status` readouts — all
 *     four kept naming the boot model after a switch, on every surface;
 *   - `emitWorkMetrics` tagged the turn's token/cost rollup with the boot model,
 *     so a switched session's spend was attributed to a model that never ran.
 *
 * WHY A SLOT GETTER rather than deriving it here. The pick is keyed by
 * `<provider>:<mode>` and the store port is ASYNC, while every consumer above is
 * SYNC (`describe()` is a sync projection; the metrics flush cannot await). The
 * surface that owns the store already keeps a sync cell for exactly this reason
 * (the picker's `current()`), and it is the only party that knows the live mode.
 * So it PUBLISHES that cell on the slot, next to the `provider` it writes with —
 * the same one-authority rule: the value a display reports is produced by the
 * thing that performed the switch, not re-derived from a second source that can
 * disagree.
 *
 * Absent slot / absent getter / empty answer ⇒ the boot model, so every host that
 * wired no switch (headless `apps/agent`, bench, `serve --stdio`) is byte-identical
 * to before.
 *
 * The parameter is STRUCTURAL, not `AgentConfig`: this is imported from both
 * `@/agent` and `@/host/runtime`, and a nominal import would close an
 * `agent ↔ host` cycle.
 */

export interface EffectiveModelSource {
  readonly llm: { readonly model?: string | undefined }
  readonly stickyModelStore?:
    | {
        readonly effectiveModel?: (() => string | undefined) | undefined
      }
    | undefined
}

export const effectiveModelOf = (cfg: EffectiveModelSource): string | undefined => {
  const live = cfg.stickyModelStore?.effectiveModel?.()
  return live !== undefined && live.length > 0 ? live : cfg.llm.model
}
