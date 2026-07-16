/**
 * ADR-0281 — `DefaultMemoryAutoTrigger`.
 *
 * Lexical-Jaccard scoring adapter against {@link MemoryAutoTrigger}.
 *
 * Pipeline:
 *
 *   onSessionEnd
 *     ├─ skip if rolloutMessages empty                         → {kind:"skipped", reason:"empty_session"}
 *     ├─ runPhase1(...)                                        → Stage1Output
 *     │    ├─ throw    → {kind:"error", error: TriggerError("phase1_throw")} + warn
 *     │    └─ abort    → re-throw (caller distinguishes cancellation)
 *     ├─ stage1Store.put(entry-from-output)                    → side-effect
 *     │    └─ throw    → {kind:"error", error: TriggerError("stage1_put_throw")} + warn
 *     ├─ shouldPromote(entry, {siblings: store.list(...)})     → bool
 *     │    └─ throw    → {kind:"error", error: TriggerError("promote_throw")} + warn
 *     └─ if promote: stage1Store.markSelectedForPhase2(...)    → side-effect
 *
 * The Phase 1 distill seam is injected via `phase1Port` — the same
 * `Phase1Port` shape the consolidator slice uses (no `@/llm` import).
 * The stage1 store is injected via the `Stage1OutputsStore` port.
 * The watermark-store side (`Stage1StorePort` from the consolidate
 * slice) is also injected because `runPhase1` requires it; the
 * trigger does not interact with it directly.
 *
 * No-throw contract: every catch site is structured (no bare
 * `catch {}` losing context). Logger sink defaults to no-op.
 */

import { errMessage, isAbortError } from "@/shared/errors"
import type { Phase1Port, Stage1StorePort } from "../consolidate"
import { runPhase1 } from "../consolidate"
import type { Stage1Entry, Stage1OutputsStore } from "../stage1-store"
import type {
  DistillRedactor,
  MemoryAutoTrigger,
  PromoteContext,
  SessionEndInput,
  SessionEndOutcome,
  SessionStartInput,
} from "./port"
import { DEFAULT_TRIGGER_POLICY, TriggerError, type TriggerPolicy } from "./types"

/** Tokenizer used by the default Jaccard scorer. Lowercase alphanumeric
 *  runs only — punctuation, whitespace, and unicode symbols split. */
const tokenize = (s: string): Set<string> => {
  const out = new Set<string>()
  for (const m of s.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    if (m[0]) out.add(m[0])
  }
  return out
}

/** Pure Jaccard similarity on two token sets. Empty/empty ⇒ 0 (no
 *  signal). One-empty ⇒ 0. Both-non-empty ⇒ |a ∩ b| / |a ∪ b|. */
const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

const redactMessage = (
  message: { role: string; content: unknown },
  redact: DistillRedactor,
): { role: string; content: unknown } => {
  if (typeof message.content === "string") {
    return { role: message.role, content: redact(message.content) }
  }
  if (!Array.isArray(message.content)) return message
  return {
    role: message.role,
    content: message.content.map((block): unknown => {
      if (
        block !== null &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block
      ) {
        const text = (block as { text: unknown }).text
        if (typeof text === "string") return { ...block, text: redact(text) }
      }
      return block
    }),
  }
}

const missingRedactor = (): never => {
  throw new Error("memory auto-trigger requires a distill redactor")
}

/** Inject opts — concrete dependencies the default impl needs. */
export interface DefaultMemoryAutoTriggerOpts {
  /** Phase 1 distill LLM seam. */
  readonly phase1Port: Phase1Port
  /** Watermark-store sink that `runPhase1` writes to. */
  readonly phase1Store: Stage1StorePort
  /** Usage/selection cache the trigger reads + writes. */
  readonly stage1Store: Stage1OutputsStore
  /** Required host adapter that removes secrets before Phase 1. */
  readonly redact: DistillRedactor
  /** Injected clock — `Date.now` in production, fixed in tests. */
  readonly now: () => number
  /** Promotion policy. Defaults to {@link DEFAULT_TRIGGER_POLICY}. */
  readonly policy?: TriggerPolicy
  /** Diagnostic sink for swallowed failures. Defaults to no-op. */
  readonly logWarn?: (msg: string) => void
}

export class DefaultMemoryAutoTrigger implements MemoryAutoTrigger {
  private readonly phase1Port: Phase1Port
  private readonly phase1Store: Stage1StorePort
  private readonly stage1Store: Stage1OutputsStore
  private readonly redact: DistillRedactor
  private readonly now: () => number
  private readonly policy: TriggerPolicy
  private readonly logWarn: (msg: string) => void

  constructor(opts: DefaultMemoryAutoTriggerOpts) {
    this.phase1Port = opts.phase1Port
    this.phase1Store = opts.phase1Store
    this.stage1Store = opts.stage1Store
    this.redact = typeof opts.redact === "function" ? opts.redact : missingRedactor
    this.now = opts.now
    this.policy = opts.policy ?? DEFAULT_TRIGGER_POLICY
    this.logWarn = opts.logWarn ?? ((): void => {})
  }

  async onSessionEnd(input: SessionEndInput): Promise<SessionEndOutcome> {
    // Skip 1: empty session (0 messages). Phase 1 would also skip via
    // `no_messages`, but doing it here avoids an unnecessary call into
    // the consolidator and gives the trigger surface a distinct enum.
    if (input.rolloutMessages.length === 0) {
      return { kind: "skipped", reason: "empty_session" }
    }

    // Run Phase 1. `runPhase1` is no-throw on skip; it throws on LLM
    // failure or store failure. Abort is propagated as `AbortError`.
    let outcome: Awaited<ReturnType<typeof runPhase1>>
    try {
      const rolloutMessages = input.rolloutMessages.map((message) =>
        redactMessage(message, this.redact),
      )
      outcome = await runPhase1(
        {
          threadId: input.threadId,
          sessionId: input.sessionId,
          rolloutMessages,
          turnCount: input.turnCount,
          memoryMode: "enabled",
          now: this.now,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        },
        this.phase1Port,
        this.phase1Store,
      )
    } catch (e) {
      // AbortError propagates — caller distinguishes cancellation.
      if (isAbortError(e)) throw e
      const err = new TriggerError("phase1_throw", errMessage(e), e)
      this.logWarn(err.message)
      return { kind: "error", error: err }
    }

    // Skip path — record a no-op outcome without touching stage1
    // (Phase 1 already skipped, so no row exists to promote). Map the
    // consolidator's "skipped" reason to the trigger surface as
    // `policy_off` (the host's per-thread policy did not allow it).
    if (outcome.kind === "skipped") {
      return { kind: "skipped", reason: "policy_off" }
    }

    // outcome.kind === "distilled" — write a Stage 1 row into the
    // usage-cache store (sibling to phase1Store; see ADR-0207).
    const generatedAt = this.now()
    const entry: Stage1Entry = {
      threadId: outcome.stage1.threadId,
      sourceUpdatedAt: outcome.stage1.sourceUpdatedAt,
      rawMemory: outcome.stage1.rawMemory,
      rolloutSummary: outcome.stage1.rolloutSummary,
      generatedAt,
      rolloutSlug: outcome.stage1.rolloutSlug,
      usageCount: 0,
      lastUsage: generatedAt,
      selectedForPhase2: false,
    }
    try {
      this.stage1Store.put(entry)
    } catch (e) {
      const err = new TriggerError("stage1_put_throw", errMessage(e), e)
      this.logWarn(err.message)
      return { kind: "error", error: err }
    }

    // Re-read after put so we get the frozen, store-canonical version
    // (defense-in-depth: a future adapter may rewrite optional fields).
    // If get returns null between put + get (concurrent prune), treat
    // as not-promoted — the entry was evicted under us.
    const stored = this.stage1Store.get(entry.threadId)
    if (stored === null) {
      return { kind: "stored", stage1ThreadId: entry.threadId, promoted: false }
    }

    // Usage-count gate (pre-scorer): cheap predicate first, scorer
    // second. Saves a tokenize pass on entries that cannot promote.
    if (stored.usageCount < this.policy.minUsageCount) {
      return { kind: "stored", stage1ThreadId: stored.threadId, promoted: false }
    }

    // Scoring. Custom scorers may throw; we wrap.
    let promote: boolean
    try {
      // Siblings: every OTHER stage1 entry currently in the store.
      // We deliberately include un-promoted ones so the scorer has
      // the broadest corpus.
      const all = this.stage1Store.list()
      const siblings = all.filter((e) => e.threadId !== stored.threadId)
      promote = this.shouldPromote(stored, { siblings })
    } catch (e) {
      const err = new TriggerError("promote_throw", errMessage(e), e)
      this.logWarn(err.message)
      return { kind: "error", error: err }
    }

    if (!promote) {
      return { kind: "stored", stage1ThreadId: stored.threadId, promoted: false }
    }

    // Promotion: best-effort. If the row was pruned between get + mark,
    // markSelectedForPhase2 is a silent no-op per the port contract.
    this.stage1Store.markSelectedForPhase2(stored.threadId, stored.sourceUpdatedAt)
    return { kind: "stored", stage1ThreadId: stored.threadId, promoted: true }
  }

  async onSessionStart(_input: SessionStartInput): Promise<void> {
    // No-op for the default impl. ADR-0282 cross-session inject runs
    // outside this port (the host calls `CrossSessionInjector` directly).
    return
  }

  shouldPromote(entry: Stage1Entry, ctx: PromoteContext): boolean {
    // Threshold > 1 ⇒ unreachable for jaccard ∈ [0,1] ⇒ nothing
    // promotes. We fast-path so the scorer cost is avoided.
    if (this.policy.promoteThreshold > 1) return false
    // Threshold <= 0 ⇒ everything passes (edge — useful for tests
    // and firehose modes). usageCount gate has already been applied
    // by `onSessionEnd`, but we re-check here so direct callers of
    // `shouldPromote` still observe the gate.
    if (entry.usageCount < this.policy.minUsageCount) return false
    if (this.policy.promoteThreshold <= 0) return true
    // Otherwise: lexical Jaccard against the union of all sibling
    // rolloutSummary token sets.
    const myTokens = tokenize(entry.rolloutSummary)
    const corpus = new Set<string>()
    for (const s of ctx.siblings) {
      for (const t of tokenize(s.rolloutSummary)) corpus.add(t)
    }
    const score = jaccard(myTokens, corpus)
    return score >= this.policy.promoteThreshold
  }
}
