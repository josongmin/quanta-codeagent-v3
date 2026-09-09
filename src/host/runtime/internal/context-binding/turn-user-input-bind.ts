import type { AgentConfig } from "@/agent"

/**
 * G-F12 — bind this turn's identity + originating AbortSignal onto the
 * `userInputPort` request. The tool still calls with promptId/prompt only;
 * the wrap adds session/turn/signal so the web port can settle THIS request
 * on turn abort without `cancelAll`.
 */
export const bindTurnUserInput = (
  cfg: AgentConfig,
  identity: {
    readonly sessionId: string
    readonly turnId: string
    readonly signal: AbortSignal | undefined
  },
): AgentConfig => {
  const inner = cfg.userInputPort
  if (inner === undefined) return cfg
  return {
    ...cfg,
    userInputPort: (req) =>
      inner({
        ...req,
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        ...(identity.signal !== undefined ? { signal: identity.signal } : {}),
      } as Parameters<typeof inner>[0]),
  }
}
