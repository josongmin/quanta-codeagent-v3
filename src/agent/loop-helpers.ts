import type { Message } from "@/llm"
import { GEN_AI_ATTRS, type TurnTiming } from "@/observability"
import { type RedactionHit, type RedactionOrigin, redactSecrets } from "@/security"
import { defaultGitRunner } from "@/tool/git"
import { buildCapEnforcer } from "./cap-enforcer"
import { DedupGate } from "./dispatch-dedup"
import { type TurnDiffSession, wireGitObservability } from "./git-observability"
import type { HookBus, HookPromptInject } from "./hooks"
import type { LocalizePhaseState } from "./localize-phase-guard"
import { buildLocalizePhase } from "./session-resources"
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
 * Build the OTel TTFT attribute payload for `run_sampling_request` span close
 * (RFC-0002 §11 / Cursor `setTtftMs` reject-and-skip contract). Returns a
 * single-keyed object when `ttftMs` is a finite non-negative value; an empty
 * object otherwise (the attribute is OMITTED on the span — matching the
 * Cursor "guarded value only" rule). Pure given `TurnTiming`.
 *
 * Extracted from `streamConsume.finally`; the inline derivation was a 2-line
 * ternary — moving it here gives the seam a unit-testable boundary and lets
 * `streamConsume` read it as one call.
 */
export const buildTtftAttrs = (timing: TurnTiming): Record<string, number> =>
  timing.ttftMs !== null ? { [GEN_AI_ATTRS.response.timeToFirstTokenMs]: timing.ttftMs } : {}
