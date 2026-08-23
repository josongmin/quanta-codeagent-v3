import {
  buildGitDirectiveCollector,
  type DirectiveEmitterPort,
  type DirectiveSink,
  defaultEmitter,
  type GitDirectiveCollector,
} from "@/git/directive-emit"
import type { Message } from "@/llm"
import { type RedactionHit, type RedactionOrigin, redactSecrets } from "@/security"
import { writeStderr, writeStdout } from "@/shared"
import { defaultGitRunner } from "@/tool/git"
import { buildCapEnforcer } from "./cap-enforcer"
import { DedupGate } from "./dispatch-dedup"
import { type TurnDiffSession, wireGitObservability } from "./git-observability"
import type { HookBus, HookPromptInject } from "./hooks"
import type { LocalizePhaseState } from "./localize-phase-guard"
import type { ReproDoubtState } from "./repro-doubt-guard"
import { buildLocalizePhase, buildReproDoubt } from "./session-resources"
import { extractSeedMessages, isUserInputSubmission } from "./submission"
import type { AgentConfig } from "./types"

/**
 * Pure-helper companions extracted from `loop.ts` to reduce the LOC of the
 * three god functions (runAgentInner / maybeCompact / streamConsume) without
 * changing any observable behavior. Every helper here either:
 *
 *   - takes explicit deps (no closure capture, no `this`), OR
 *   - constructs a closure with a single explicit dep so the boundary stays
 *     unit-testable in isolation,
 *
 * and is structurally equivalent to the inline block it replaced. The
 * default-OFF byte-identical contract is preserved: an absent/disabled
 * configuration sees the SAME early return / no-op the inline block produced.
 */

/**
 * SPLIT (aug-23 god-module ratchet). Three cohesive blocks moved to siblings and
 * are RE-EXPORTED below, so every consumer import path is unchanged:
 *   · `sampling-span.ts`      — OTel-GenAI `run_sampling_request` span assembly.
 *   · `automation-ticker.ts`  — ADR-0240 §B automation-engine tick wire.
 *   · `identity-reminder.ts`  — ADR-0240 §C per-turn identity reminder.
 * What REMAINS here is the loop's session-wiring block: the seed/transcript
 * derivation and the `build*`/`attach*`/`wire*` factories `runAgentInner` calls
 * once per session to arm an optional collaborator (each default-OFF and
 * byte-identical when its config slot is absent), plus the git-directive emit
 * sink resolver.
 */

export type { AutomationEngineTickerHandle, AutomationTickerDeps } from "./automation-ticker"
export { startAutomationEngineTicker } from "./automation-ticker"
export { buildIdentityReminderText, shouldSpliceIdentityReminder } from "./identity-reminder"
export type {
  CloseSamplingSpanArgs,
  FinalizeSamplingSpanArgs,
  SamplingSpanAttrsArgs,
  SamplingUsage,
} from "./sampling-span"
export {
  buildSamplingSpanAttrs,
  buildTtftAttrs,
  closeSamplingSpan,
  finalizeSamplingSpan,
  normalizeProviderName,
  samplingUsageFromEvent,
} from "./sampling-span"

/**
 * Derive the canonical session seed message buffer (RFC §6.3, ADR-0062 §A3).
 * When the typed Submission envelope projects to a user-input shape, append
 * the projected messages to `cfg.messages`. Otherwise return `cfg.messages`
 * verbatim. Pure; the caller's `cfg.messages` array is never mutated.
 *
 * Extracted from `runAgentInner` (inline at the top of the function); the
 * inline block was 5 LOC of derivation logic — moving it here lets the loop
 * function read `const seedMessages = buildSeedMessages(cfg)` as a single
 * line.
 */
export const buildSeedMessages = (cfg: AgentConfig): Message[] => {
  const submissionSeed =
    cfg.submission && isUserInputSubmission(cfg.submission)
      ? extractSeedMessages(cfg.submission)
      : undefined
  return submissionSeed ? [...cfg.messages, ...submissionSeed] : cfg.messages
}

/**
 * ADR-0125 turn-diff loop wiring — opt-in factory for the per-session
 * `TurnDiffSession`. Returns `undefined` when
 * `cfg.gitObservability?.enabled !== true` (default-OFF, no `git rev-parse`
 * spawn). When enabled, a caller-supplied `session` (test-injection seam,
 * mirrors `dedupGate`) is honored verbatim; otherwise the helper constructs
 * one via `wireGitObservability` against `defaultGitRunner` + `cfg.cwd` +
 * `cfg.signal`.
 *
 * Extracted from `runAgentInner`; the inline block was 6 LOC of a single
 * conditional expression — moving it here lets the loop function read it as
 * one line.
 */
export const buildTurnDiffSession = (cfg: AgentConfig): TurnDiffSession | undefined => {
  if (cfg.gitObservability?.enabled !== true) return undefined
  return (
    cfg.gitObservability.session ??
    wireGitObservability({ runner: defaultGitRunner, cwd: cfg.cwd, signal: cfg.signal }).turnDiff
  )
}

/**
 * ADR-0133 — wire the session-scoped pending list of hook-emitted
 * `promptHook` responses. Returns the list (so the loop can drain/snapshot
 * it per turn) and attaches a `subagentPendingPrompt` push port to `cfg`
 * IFF the caller did not already provide one. Idempotent against a
 * caller-supplied port.
 *
 * Extracted from `runAgentInner`; the inline block was 6 LOC of allocation
 * + side-effect — kept as a single explicit-side-effect call (`cfg` is
 * mutated only when the caller's `subagentPendingPrompt` was absent, exactly
 * matching the pre-refactor behavior).
 */
export const wireHookPromptPending = (cfg: AgentConfig): HookPromptInject[] => {
  const hookPromptPending: HookPromptInject[] = []
  if (cfg.subagentPendingPrompt === undefined) {
    cfg.subagentPendingPrompt = {
      push: (entry: HookPromptInject) => hookPromptPending.push(entry),
    }
  }
  return hookPromptPending
}

/**
 * ADR-0078 point #2 — scan every text block of the final transcript at the
 * persistence boundary and fold the redaction hits into the run rollup.
 * Counting only — the block text is NOT mutated here so the memory_distill
 * path (point #3) still redacts the SAME raw secret independently (each
 * origin fires once per secret).
 *
 * Pure given explicit deps. Caller must gate on `redactionEnabled && cfg.store`
 * — the helper does NOT re-check that condition (the caller's branch already
 * cleared it).
 *
 * Extracted from `runAgentInner.finish()`; the inline block was a 7-line
 * nested loop — moving it here lets `finish()` read it as a single
 * conditional call.
 */
export const scanEnvelopeForRedactions = (
  messages: readonly Message[],
  recordRedaction: (origin: RedactionOrigin, hits: readonly RedactionHit[]) => void,
): void => {
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type !== "text") continue
      const r = redactSecrets(b.text, { origin: "envelope_jsonl" })
      if (!r.unchanged) recordRedaction("envelope_jsonl", r.hits)
    }
  }
}

/**
 * ADR-0133 — bridge the typed `pre_compact` hook event onto the
 * `compactIfNeeded` preCompactHook contract. Absent `hooks` ⇒ returns
 * `undefined` (compactIfNeeded fast-paths past the extra await — byte-
 * identical to the pre-ADR-0133 path). When wired, a hook that returns
 * `{ abort: { reason } }` causes `compactIfNeeded` to skip THIS compaction
 * (returns `{compacted:false}` — same shape the breaker observes as no
 * progress).
 *
 * Extracted from `maybeCompact`; the inline block was 14 LOC of a single
 * arrow expression. Moving it here lets `maybeCompact` read it as one line.
 */
export type PreCompactHookFn = (q: {
  messagesToCompact: number
  isFirstCompaction: boolean
}) => Promise<{ abortReason: string | null }>

export const buildPreCompactHook = (hooks: HookBus | undefined): PreCompactHookFn | undefined => {
  if (hooks === undefined) return undefined
  return async (q) => {
    const emit = await hooks.emit({
      type: "pre_compact",
      messagesToCompact: q.messagesToCompact,
      isFirstCompaction: q.isFirstCompaction,
    })
    return { abortReason: emit.abort?.reason ?? null }
  }
}

/** ADR-0409 — sibling of {@link buildPreCompactHook} for the `post_compact`
 *  HookBus event. Fires AFTER a compaction settles with the typed
 *  {@link RecoveryProvenance} (reason / tokens before-after / turns
 *  dropped-kept / summary + resume strings). The bus already fast-paths the
 *  zero-subscriber case, so an unsubscribed event is byte-identical to the
 *  pre-ADR-0409 path. NO-THROW: the emit itself runs inside compaction's own
 *  try/catch around `postCompactEmit`. Returns `undefined` when no hook bus
 *  is wired so `compactIfNeeded` omits the field entirely (legacy fast-path). */
export const buildPostCompactEmit = (
  hooks: HookBus | undefined,
  threadId: string,
):
  | ((provenance: import("@/agent/recovery-reason").RecoveryProvenance) => Promise<void>)
  | undefined => {
  if (hooks === undefined) return undefined
  return async (provenance) => {
    await hooks.emit({ type: "post_compact", threadId, provenance })
  }
}

/**
 * T3 — pre-flight dedup gate. ON by default with `DEFAULT_DEDUP_GATE_CAPS` so
 * a pallets-style env-loop thrash is structurally braked. Honors a
 * caller-supplied `cfg.dedupGate` (test injection / explicit override) and
 * falls back to constructing from `cfg.dedupGateConfig.caps`. Setting
 * `dedupGateConfig.disabled:true` opts out entirely. Side-effect: attaches the
 * constructed gate to `cfg.dedupGate` (so `dispatchTool` sees it through the
 * AgentConfig channel) — only when the caller did not already supply one.
 * Returns the gate (or `undefined` when disabled) so the caller can branch on
 * activeness without re-reading `cfg`.
 *
 * Extracted from `runAgentInner`; the inline block was 4 LOC across a `const
 * +if`. Moving it here lets the loop function read it as one line.
 */
export const attachDedupGate = (cfg: AgentConfig): DedupGate | undefined => {
  const dedupGate =
    cfg.dedupGate ??
    (cfg.dedupGateConfig?.disabled ? undefined : new DedupGate(cfg.dedupGateConfig?.caps))
  if (dedupGate !== undefined && cfg.dedupGate === undefined) cfg.dedupGate = dedupGate
  return dedupGate
}

/**
 * ADR-0062 rule #3 — cap-as-instruction enforcement (DEFAULT-OFF). Built only
 * when `cfg.capEnforce === true` OR `QUANTA_CAP_ENFORCE=1` env flag is set
 * (checked inside `buildCapEnforcer`). A caller-supplied `cfg.capEnforcer`
 * (e.g. test injection) is honored without re-building. Side-effect: attaches
 * to `cfg.capEnforcer` iff absent — exactly the same pattern as
 * `attachDedupGate`.
 *
 * Extracted from `runAgentInner`; the inline block was 4 LOC.
 */
export const attachCapEnforcer = (cfg: AgentConfig): void => {
  const capEnforcer = cfg.capEnforcer ?? buildCapEnforcer(cfg.capEnforce)
  if (capEnforcer !== undefined && cfg.capEnforcer === undefined) {
    cfg.capEnforcer = capEnforcer
  }
}

/**
 * Agentless "localize-first" absorption (Tier 0) — build the localize-phase
 * guard state when `cfg.localizePhase.phase1Turns` is a positive integer
 * (`buildLocalizePhase` validates the active domain), attach it to
 * `cfg.localizePhaseState` so the sibling dispatch module reads it via the
 * AgentConfig channel. Returns the state (or `undefined`) so the loop can
 * still bump `state.turn` per iteration without re-reading `cfg`.
 *
 * Extracted from `runAgentInner`; the inline block was 4 LOC.
 */
export const attachLocalizePhase = (cfg: AgentConfig): LocalizePhaseState | undefined => {
  const state = buildLocalizePhase(cfg)
  if (state !== undefined && cfg.localizePhaseState === undefined) {
    cfg.localizePhaseState = state
  }
  return state
}

/**
 * repro-doubt absorption (jun-20) — build the guard state when
 * `cfg.reproDoubt.stuckRuns` is active and attach it to `cfg.reproDoubtState` so
 * the sibling dispatch module advances it per tool call (via the AgentConfig
 * channel, exactly like `attachLocalizePhase`). Unlike localize-phase the loop
 * does NOT bump this state — dispatch advances it on each tool dispatch — so the
 * return value is informational only. Default-OFF: `undefined` when inactive.
 */
export const attachReproDoubt = (cfg: AgentConfig): ReproDoubtState | undefined => {
  const state = buildReproDoubt(cfg)
  if (state !== undefined && cfg.reproDoubtState === undefined) {
    cfg.reproDoubtState = state
  }
  return state
}

/**
 * ADR-0234 git-directive emit wire — opt-in factory for the per-session
 * `GitDirectiveCollector`. Returns `undefined` when
 * `cfg.gitDirectiveEmit?.enabled !== true` (default-OFF, no collector built,
 * no emit wire installed).
 *
 * When enabled the resolution order is (in priority):
 *
 *   1. caller-supplied `cfg.gitDirectiveEmit.collector` (test injection
 *      seam — used verbatim, `emitter` + `sink` are ignored because the
 *      collector already owns its emitter).
 *   2. caller-supplied `cfg.gitDirectiveEmit.emitter` (test injection or
 *      a custom port the host wired) — wrapped in a fresh collector.
 *   3. built-in `defaultEmitter` against `cfg.gitDirectiveEmit.sink`
 *      (`"stdout"` default → `process.stdout`; `"stderr"` →
 *      `process.stderr`; inline function → adapter sink that calls it once
 *      per wire line — newline stripped so the host owns framing).
 *
 * `includeIntermediate` is forwarded to the constructed collector so a
 * live-progress surface (when the host opts in) sees record-time emits as
 * well as the deferred flush emits.
 *
 * Side-effect: attaches the constructed collector to `cfg.gitDirectiveEmit`
 * (mutates the `.collector` field IFF the caller did not supply one) so a
 * downstream tool wire (`gitTools({ gitDirectiveCollector })` at the
 * composition root) reads the SAME instance the loop will flush. Mirrors
 * the `attachDedupGate` / `attachCapEnforcer` pattern.
 *
 * Returns the collector (or `undefined` when disabled) so the loop can
 * call `collector.flush()` at turn end without re-reading `cfg`.
 */
export const buildGitDirectiveEmit = (cfg: AgentConfig): GitDirectiveCollector | undefined => {
  const block = cfg.gitDirectiveEmit
  if (block === undefined || block.enabled !== true) return undefined
  // Branch 1: caller-supplied collector — use verbatim.
  if (block.collector !== undefined) return block.collector
  // Branch 2/3: build or adopt an emitter, wrap in fresh collector.
  const emitter = block.emitter ?? defaultEmitterFor(block.sink ?? "stdout")
  const collectorOpts =
    block.includeIntermediate !== undefined
      ? { includeIntermediate: block.includeIntermediate }
      : {}
  const collector = buildGitDirectiveCollector(emitter, collectorOpts)
  // Mutate cfg so a downstream tool wire can read the SAME instance via
  // `cfg.gitDirectiveEmit.collector`. Only when the caller did not already
  // supply one (block.collector === undefined was checked above). The
  // mutation respects exactOptionalPropertyTypes by re-assigning the whole
  // block with the new collector folded in.
  cfg.gitDirectiveEmit = { ...block, collector }
  return collector
}

/** Resolve the configured sink into a concrete `DirectiveEmitterPort`. The
 *  inline-function form wraps the caller's callback in a sink adapter that
 *  strips the trailing newline (the protocol writes `<line>\n`; a function
 *  consumer typically wants the bare line). */
const defaultEmitterFor = (
  sink: "stdout" | "stderr" | ((line: string) => void),
): DirectiveEmitterPort => {
  if (sink === "stdout") {
    return defaultEmitter({
      write(chunk: string): boolean {
        writeStdout(chunk)
        return true
      },
    })
  }
  if (sink === "stderr") {
    return defaultEmitter({
      write(chunk: string): boolean {
        writeStderr(chunk)
        return true
      },
    })
  }
  // Function sink — adapter wraps once per write, stripping the trailing
  // newline. A throwing callback is caught at the emitter boundary (see
  // defaultEmitter implementation) and surfaces as a typed invalid-directive
  // error rather than propagating.
  const fnSink: DirectiveSink = {
    write(chunk: string): boolean {
      const trimmed = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk
      sink(trimmed)
      return true
    },
  }
  return defaultEmitter(fnSink)
}
