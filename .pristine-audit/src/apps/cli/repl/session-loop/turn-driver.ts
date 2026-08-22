import type { AgentOutcome } from "@/agent"
import type { ImageBlock, Message } from "@/llm"
import { type ApprovalResolver, driveSessionTurn } from "@/runner/orchestrate"
import type { RuntimeContext, RuntimeSession } from "@/sdk/runtime"
import type { ModeCycleStore } from "../../mode-cycle"
import type { SessionState } from "../session-state"
import { drainTurnImages } from "./turn-helpers"

/** The result shape both branches await from a single turn. */
export interface RunSessionTurnResult {
  readonly messages: readonly Message[]
  readonly outcomeReason?: AgentOutcome["reason"]
}

/** The per-turn adapter signature both branches call. Signature preserved from
 *  the prior inline `runSessionTurn` so call sites are unchanged. */
export type RunSessionTurn = (args: {
  readonly text: string
  readonly images?: readonly ImageBlock[]
  readonly turnSignal: AbortSignal
}) => Promise<RunSessionTurnResult>

/** The permission-mode cell accessor the beforeTurn hook syncs into. */
type PermissionModeCellPort = Pick<RuntimeContext, "permissionModeState">

/** ADR-0303 — build the thin `runSessionTurn` adapter over `driveSessionTurn`.
 *  The `append → turn.run → resolve-approval → loop` turn-completion primitive
 *  lives below the surface in `@/runner/orchestrate` so the CLI interactive +
 *  one-shot branches AND headless share ONE definition. This adapter keeps the
 *  CLI-only concerns in the surface: the per-turn image drain (mutates
 *  surfaceState via the injected accessor) and the §3.1 permission-posture sync
 *  (read the slash-local mode-cycle, write the engine-owned permissionModeState
 *  cell BEFORE the turn). Extracted verbatim; behavior is byte-identical. */
export const makeRunSessionTurn = (deps: {
  readonly session: RuntimeSession
  readonly resolveApproval: ApprovalResolver
  readonly modeCycle: ModeCycleStore | undefined
  readonly runtimeContext: PermissionModeCellPort
  readonly getSurfaceState: () => SessionState
  readonly setSurfaceState: (next: SessionState) => void
}): RunSessionTurn => {
  const { session, resolveApproval, modeCycle, runtimeContext, getSurfaceState, setSurfaceState } =
    deps
  return async (args) => {
    const { nextState, images } = drainTurnImages(getSurfaceState(), args.images ?? [])
    setSurfaceState(nextState)
    const surfaceState = getSurfaceState()
    return driveSessionTurn({
      session,
      resolveApproval,
      text: args.text,
      images,
      turnSignal: args.turnSignal,
      // ADR-0528 — env THREADED from the composition root (this CLI surface IS
      // an allowed `process.env` reader); the crash-resume marker reads its gate
      // off THIS env, never an ambient literal below the surface.
      env: process.env,
      // ADR-0528 — crash-resume marker for the durable (id-mode) session;
      // gate-gated + no-op when the session id is absent/ephemeral. Read from
      // the LIVE surface state (not the boot snapshot) so a `/fork` switch
      // (UUX-4-07) moves the marker onto the fork; byte-identical otherwise
      // (surfaceState.sessionId is seeded from setup.sessionId and only ever
      // reassigned by the switch closure).
      ...(surfaceState.sessionId !== undefined ? { sessionId: surfaceState.sessionId } : {}),
      // RFC-06 §RFC06-2 — the turn-boundary cwd-pin port. This CLI surface IS an
      // allowed `process.*` reader, so it threads the real chdir/getcwd pair
      // (the `@/runner` slice is process-pure). The follower SELF-GATES on
      // `QUANTA_WORKTREE_CWD_PIN` (default-OFF) inside `driveSessionTurn`: gate
      // off ⇒ nothing is loaded and no chdir happens ⇒ byte-identical. Passing
      // the port is always safe (it is never consumed unless the gate is on AND
      // the session owns a `ready`/`active` worktree).
      cwdPin: {
        cwd: () => process.cwd(),
        chdir: (t) => {
          process.chdir(t)
          return process.cwd()
        },
      },
      // host concern — absent cycle ⇒ no hook ⇒ byte-identical.
      ...(modeCycle !== undefined
        ? {
            beforeTurn: () => {
              runtimeContext.permissionModeState()?.set(modeCycle.current().permissionMode)
            },
          }
        : {}),
    })
  }
}
