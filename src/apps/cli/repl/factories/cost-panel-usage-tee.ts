/**
 * MR-05 — teach the CLI cost panel WHICH model each turn ran on.
 *
 * THE DEFECT. `CostPanel.state.model` is seeded once at session start
 * (`bootstrap-session.ts` → `runtime.model`) and NOTHING in production ever calls
 * `update({model})` — a grep over `src/` finds zero callers. Its only usage feed is
 * an OTel counter DELTA (`turn-sinks.ts` → `foldCostPanelDelta`), and those
 * counters carry no model dimension. So after a `/model` switch — or on any
 * session that boots onto a persisted pick — every turn was priced with the boot
 * model's rates and filed under its name in `byModel()`. That is the CLI twin of
 * the `emitWorkMetrics` misattribution, and it is worse than a missing number
 * because it renders as data.
 *
 * THE FEED. The `usage` AgentEvent carries `model`, reported by the adapter that
 * actually streamed the request (`emit-helpers.ts`), so this tee records it and
 * `turn-sinks.ts` hands it to `incrementTurn`.
 *
 * HONEST LIMIT. The token numbers still come from the counter delta, which is a
 * per-turn aggregate with no model dimension — so a turn that spans TWO models
 * (a mid-turn switch, a provider fallback) is attributed to the LAST model that
 * reported usage in it, not split between them. That is strictly better than
 * "always the boot model" and it is exact for the single-model turn, which is
 * every ordinary one. True per-request splitting exists on the work-metrics path
 * (`TurnWorkMetricsCollector`, which buckets each `recordUsage` by its own model);
 * bringing it here needs per-model counters in the metrics layer, which is a
 * separate change.
 *
 * Default-safe: the tee is a pass-through. It adds no event, drops none, reorders
 * none, and never throws into the stream.
 */

import type { AgentEvent, StreamPort } from "@/stream"

/** A one-slot cell holding the model of the most recent `usage` event. */
export interface LastUsageModelCell {
  /** `undefined` until a usage event with a model has been seen this session. */
  readonly get: () => string | undefined
}

export const buildCostPanelUsageTee = (
  stream: StreamPort,
): { readonly stream: StreamPort; readonly lastUsageModel: LastUsageModelCell } => {
  let last: string | undefined
  return {
    lastUsageModel: { get: () => last },
    stream: {
      emit: (event: AgentEvent): void => {
        if (event.type === "usage") {
          const model = (event as { readonly model?: string }).model
          if (model !== undefined && model.length > 0) last = model
        }
        stream.emit(event)
      },
    },
  }
}
