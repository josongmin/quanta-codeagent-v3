/**
 * Bench BOOT wiring — "which provider + which model does this bench run use, and
 * what port do we drive it through?".
 *
 * Split out of the `run-main.ts` keystone (god-MODULE ratchet: the keystone was
 * at 1028 lines). This is a cohesive unit, not a size-driven slice: everything
 * here answers the boot question — the MR-01 model precedence, the trajectory
 * record/replay lane that wraps the port, the bench reasoning-summary code
 * default, and the "no API key ⇒ exit 0 with guidance" contract. `run-main.ts`
 * keeps a one-line binding that supplies its module-private injectable exit.
 *
 * NO edge back to `run-main.ts` (the exit is a parameter), so the keystone
 * imports this and never the reverse.
 */

import {
  type BootSelection,
  type LLMPort,
  type Provider,
  resolveBootSelection,
  tryCreateLLM,
} from "@/llm"
import { logger } from "@/shared"
import {
  resolveBenchReasoningSummary,
  resolveBenchReasoningSummaryDetail,
} from "./reasoning-summary"
import { argValue } from "./run-args"
import {
  applyBenchTrajectoryMode,
  replayTrajectoryPort,
  resolveBenchTrajectoryMode,
} from "./trajectory"

/**
 * MR-01 — bench's BOOT provider + model, through the ONE authority (`@/llm`
 * `resolveBootSelection`): `--model` (argv) > `QUANTA_MODEL` > canonical
 * `DEFAULT_MODEL[provider]`.
 *
 * NO behaviour change for bench — this precedence is exactly what the
 * hand-rolled `argValue("--model") ?? process.env.QUANTA_MODEL ??
 * DEFAULT_MODEL[provider]` chain did — with two honest edges tightened: an
 * empty / whitespace-only `--model` or `QUANTA_MODEL` is now UNSET (it used to
 * boot a port with a literal `""` model id), and the slug table is no longer
 * re-read here.
 *
 * Exported so the MR-01 producer hellgate drives the REAL line;
 * {@link resolveBenchLLM} (which the `run-main.ts` keystone binds) calls exactly
 * this and nothing else resolves a bench boot model.
 */
export const resolveBenchBootSelection = (): BootSelection => {
  const modelArg = argValue("--model")
  return resolveBootSelection({
    env: process.env,
    ...(modelArg !== undefined ? { modelArg } : {}),
  })
}

/** Resolve provider/model/LLM; exits 0 with guidance when the key is absent
 *  (shared by both bench modes). `noun` tailors the message. The exit is routed
 *  through the injected `exitFn`; in production this is `process.exit` (truly
 *  `never`) so the post-exit code is unreachable. A test that injects a no-op
 *  exit gets `null` back and the caller bails. */
export const resolveBenchLLM = (
  noun: string,
  /** The bench keystone's module-private injectable exit (`run-main.ts`
   *  `exitFn`). Passed IN rather than imported so this module has NO edge back
   *  to the keystone — a test that injects a no-op exit gets `null` back. */
  exitFn: (code: number) => never,
): {
  provider: Provider
  model: string
  llm: LLMPort
  freshLlm: (ctx?: { instanceId?: string; runId?: string }) => LLMPort
} | null => {
  const boot = resolveBenchBootSelection()
  const provider = boot.provider
  const model = boot.modelId
  const trajectory = resolveBenchTrajectoryMode()
  if (trajectory.kind === "replay" && trajectory.onMiss === "throw") {
    // `freshLlm` builds an INDEPENDENT replay port (fresh `used` set) per call —
    // the fork-branch fan-out needs this so each branch re-replays the full
    // prefix instead of sharing a consumed cassette (RFC jun-23 §4.1).
    const freshLlm = (_ctx?: { instanceId?: string; runId?: string }): LLMPort =>
      replayTrajectoryPort({
        path: trajectory.path,
        onMiss: trajectory.onMiss,
        ...(trajectory.limit !== undefined ? { limit: trajectory.limit } : {}),
        provider,
        model,
      })
    return { provider, model, llm: freshLlm(), freshLlm }
  }
  // Bench defaults reasoning-summary ON (a CODE default, no env forwarding) so
  // reasoning models (gpt-5.5) STREAM their reasoning instead of thinking
  // silently and tripping the LLM idle-timeout → silent-retry stall loop. An
  // explicit `QUANTA_REASONING_SUMMARY=0`/off still wins (operator override).
  const reasoningSummary = resolveBenchReasoningSummary(process.env)
  const reasoningSummaryDetail = resolveBenchReasoningSummaryDetail(process.env)
  const llm = tryCreateLLM(
    provider,
    {
      // MR-01 — always pass the RESOLVED id. The prior `...(modelArg !== undefined
      // ? {model: modelArg} : {})` spread relied on the factory re-deriving the
      // same `DEFAULT_MODEL[provider]` value the line above had already computed
      // — two derivations of one answer. Same value, one authority.
      model,
      reasoningSummary,
      reasoningSummaryDetail,
    },
    process.env,
  )
  if (!llm) {
    logger.info(
      `Found ${noun} but no API key for provider "${provider}". Set ANTHROPIC_API_KEY or OPENAI_API_KEY to run. Exiting.`,
    )
    exitFn(0)
    return null
  }
  // Bench records the FULL LLM trajectory by DEFAULT (industry-SOTA opt-OUT;
  // QUANTA_BENCH_RECORD_TRAJECTORY=0 opts out). Log where it lands so the
  // operator can find the cassette without grepping the source for the default.
  if (trajectory.kind === "record") {
    logger.info(
      `bench: recording LLM trajectory → ${trajectory.path} (set QUANTA_BENCH_RECORD_TRAJECTORY=0 to opt out)`,
    )
  }
  // Live LLM is stateless across calls, so off/live mode can share it; replay
  // mode re-wraps a fresh store each call (applyBenchTrajectoryMode → fresh
  // replayTrajectoryPort) so branches stay isolated.
  const freshLlm = (ctx?: { instanceId?: string; runId?: string }): LLMPort =>
    applyBenchTrajectoryMode(llm, trajectory, { provider, model }, ctx)
  return { provider, model, llm: freshLlm(), freshLlm }
}
