/** Closed-port for the `reflect` self-correction tool (gap-other-agent GAP 11).
 *
 *  The actual reflection (a model consult over the agent's situation + proposed
 *  next steps) is injected so `@/tool` stays plane-clean (no `@/llm`). NO-THROW:
 *  the adapter collapses failures to `{ ok:false, reason }`; a throw is caught by
 *  the tool's own guard. */

export type ReflectFailureReason = "reflect-error" | "timeout" | "cancelled" | "empty-analysis"

export type ReflectResult =
  | { readonly ok: true; readonly analysis: string; readonly recommendNewApproach?: boolean }
  | { readonly ok: false; readonly reason: ReflectFailureReason }

/** The reflection request: the agent's current situation + the plan it proposes
 *  to commit to. Both are REQUIRED — reflect forces a concrete next-step. */
export interface ReflectRequest {
  readonly situation: string
  readonly nextSteps: string
}

export interface ReflectPort {
  reflect(req: ReflectRequest, signal?: AbortSignal): Promise<ReflectResult>
}
