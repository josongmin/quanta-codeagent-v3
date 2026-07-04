import { runCloseoutCritic } from "../closeout-critic"
import { extractRefusalRationale, type AssembledMessage } from "../recovery"
import type { ToolHistoryEntry } from "../session-resources"
import type { TurnSession } from "../turn-context"
import { emitRecovery } from "./emit-helpers"

/**
 * Closeout-critic seam (P12). Invoked at the EXACT moment the loop is about to
 * seal a `{kind:"completed"}` turn, BEFORE that result is returned. Default-OFF
 * and FAIL-OPEN by construction:
 *
 *   - `runCloseoutCritic` short-circuits to `undefined` BEFORE any await when
 *     the knob is OFF (`config.closeoutCritic === undefined` / `enabled !==
 *     true`) or the critic port is absent — so the completion path stays
 *     byte-identical (no allocation here either: `config.closeoutCritic` read
 *     + a single sync call that returns immediately; the `req` object is built
 *     lazily only AFTER the OFF gate, so OFF allocates nothing extra).
 *   - a returned observation is surfaced as an EXISTING `recovery` event under
 *     the `closeout` reason — advisory data only. It is NEVER inspected for
 *     control flow; the loop seals `completed` regardless of the verdict.
 *   - this helper itself never throws (the underlying helper catches every
 *     critic failure and converts it to an observation detail).
 *
 * Returns `undefined` SYNCHRONOUSLY when the knob is OFF / port absent — so the
 * caller skips the `await` entirely and the completion seal stays byte-identical
 * (no microtask boundary, no `wm.append` reordering, no allocation). Only when
 * the critic is wired does it return a real promise the caller awaits.
 */
export const maybeRunCloseoutCritic = (
  session: TurnSession,
  message: AssembledMessage,
  history: readonly ToolHistoryEntry[],
): Promise<void> | undefined => {
  const { config } = session
  const cfg = config.closeoutCritic
  // OFF gate FIRST — byte-identical: no `req` allocation, no emit, no promise,
  // no await when OFF / port absent.
  if (cfg === undefined || cfg.enabled !== true || cfg.critic === undefined) return undefined
  return (async () => {
    const observation = await runCloseoutCritic(cfg, {
      finalText: extractRefusalRationale(message),
      history: history.map((h) => ({ name: h.name })),
      signal: config.signal,
    })
    if (observation !== undefined) emitRecovery(config, "closeout", observation.detail)
  })()
}
