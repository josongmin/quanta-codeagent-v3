/**
 * ADR-0121 — Auto-checkpoint policy for the shadow git ODB.
 *
 * Closes the "every SOTA has auto-checkpoint, quanta uniquely doesn't" gap.
 * Before this slice, every Shadow ODB anchor (`ShadowOdb.registerHead`) had to
 * be explicitly registered by a CALLER — the branch-search anchor (ADR-0116)
 * and the per-tool `shadow_rewind` (ADR-0119). Industry SOTA:
 *
 *   - Cline       — anchors BEFORE every tool use (finest grain; spammy).
 *   - Hermes      — anchors BEFORE every destructive op, dedup once per turn.
 *   - Codex/Cursor — anchors at verify-success boundaries (coarsest).
 *
 * This port surfaces all three policies as a closed enum + a single wrapper
 * around an `EffectChannel` that inserts the anchor BEFORE delegating. The
 * default mode is `"off"` ⇒ byte-identical to the pre-ADR path.
 *
 * # Posture (the same hard invariants as the rest of the shadow-odb slice)
 *
 *  1. **Closed enum.** `CheckpointTriggerMode` is a 4-arm string union;
 *     expanding it is an audit-time decision (ADR amendment + every
 *     exhaustive switch becomes a compile error).
 *  2. **No-throw.** Both predicates AND the wrap never throw. An anchor I/O
 *     failure collapses to a swallowed observability concern — the underlying
 *     tool call ALWAYS runs even when `odb.registerHead` rejects. This is the
 *     fail-OPEN posture (no checkpoint is better than a broken loop).
 *  3. **DI oracle.** `DestructivenessOracle` is pluggable so tests can pin a
 *     stricter classifier without a global side effect; the default oracle
 *     trusts `Tool.isReadOnly()` (tool-author contract).
 *  4. **Per-(workspace, turn) dedup.** At most ONE auto-checkpoint per
 *     (workspace, turnId) regardless of how many destructive calls fire —
 *     mirrors Hermes' "1 per dir per turn" invariant; prevents the per-tool
 *     mode from spamming snapshots when the model loops on edits.
 *  5. **Default-OFF.** `mode === "off"` ⇒ both predicates return false WITHOUT
 *     touching the odb port. The `withAutoCheckpoint` wrap is byte-identical
 *     to the underlying channel when mode is off (no extra calls, no
 *     allocation beyond the indirection).
 *
 * # What this module is NOT
 *
 *  - It is NOT a storage port — it is a POLICY over an existing
 *    {@link ShadowOdb}. The wrap is `EffectChannel → EffectChannel`, not
 *    `ShadowOdb → ShadowOdb`.
 *  - It does NOT decide WHERE to checkpoint (which ref, which workspace
 *    layout). That is the `ShadowOdb`'s concern; the policy only decides
 *    WHEN to call `registerHead`.
 *  - It does NOT inspect tool inputs beyond delegating to the
 *    `DestructivenessOracle`. Argument analysis is the oracle's job.
 *  - It is NOT a verify-based checkpoint (mark-and-anchor on verify success).
 *    That mode is reserved for ADR-0122 follow-up — explicit non-goal here so
 *    the 4-arm enum stays grep-stable.
 */

import type { ToolUseBlock } from "@/llm"
import type { ShadowOdb } from "@/storage/shadow-odb"
import type { Tool, ToolContext } from "@/tool"
import type { EffectChannel, ToolRequest, ToolResultEnvelope } from "./effect-channel"

/** Closed enum of trigger modes; expanding is an audit-time concern (a new
 *  arm becomes a compile error at every exhaustive switch). */
export type CheckpointTriggerMode =
  /** No auto-anchor (default). Byte-identical with pre-ADR-0121 behaviour —
   *  every predicate short-circuits to `false` WITHOUT touching the port. */
  | "off"
  /** Anchor BEFORE every mutating tool call, dedup per (workspace, turn) —
   *  Hermes' "1 per dir per turn" invariant. The SAFE default for an opt-in
   *  caller (single anchor per turn, regardless of how many edits fire). */
  | "pre-destructive"
  /** Anchor BEFORE every mutating tool call, NO dedup — Cline pattern.
   *  Finest grain, highest snapshot pressure; suitable for short turns where
   *  every tool boundary is a meaningful recovery point. */
  | "per-mutating"
  /** Anchor ONCE at the end of every turn, dedup per (workspace, turn) —
   *  Codex pattern. Coarsest grain; combines well with verify-loop driven
   *  workflows where the per-turn boundary IS the recovery boundary. */
  | "per-turn"

/** Pluggable predicate: given a tool + its call, is this destructive enough
 *  to anchor before? PURE: no I/O, no allocation beyond the boolean result.
 *  Implementations MUST NOT throw — the wrap fails-open on oracle errors. */
export type DestructivenessOracle = (tool: Tool, call: ToolUseBlock, ctx: ToolContext) => boolean

/** Default oracle: shells out to `tool.isReadOnly(call.input)` and treats
 *  `!readOnly` as destructive. Matches the tool-author contract — tools that
 *  lie about read-only are out-of-spec and the auto-checkpoint policy does
 *  NOT compensate for them (defense-in-depth is a tool-side concern).
 *
 *  Fail-open: if `tool.isReadOnly()` itself throws, the oracle returns
 *  `false` (no anchor). A throwing `isReadOnly` is a tool bug; we don't
 *  amplify the bug by spinning the checkpoint path on every call. */
export const defaultDestructivenessOracle: DestructivenessOracle = (tool, _call, _ctx) => {
  try {
    return tool.isReadOnly() === false
  } catch {
    return false
  }
}

/** Per-workspace dedup key used by the in-policy LRU. The KEY pair is the
 *  composite identity — at most ONE auto-checkpoint per pair regardless of
 *  how many destructive calls fire in that turn. */
export interface DedupKey {
  readonly workspace: string
  readonly turnId: string
}

/** Policy port — the closed-port surface the wrap consults. The default
 *  implementation is `defaultCheckpointPolicy`; tests inject fakes for the
 *  hellgate. */
export interface CheckpointPolicy {
  /** Called BEFORE the executor runs a tool call. Returns whether to anchor
   *  first. NO-THROW: an oracle failure or missing turnId collapses to
   *  `false` (fail-open; never blocks the call). */
  shouldAnchorBefore(tool: Tool, call: ToolUseBlock, ctx: ToolContext): Promise<boolean>
  /** Called when a turn completes. Returns whether to anchor now.
   *  NO-THROW: a missing turnId collapses to `false`. */
  shouldAnchorAfterTurn(turnId: string, workspace: string): Promise<boolean>
  /** Called when an anchor is ACTUALLY taken — records the dedup key so a
   *  subsequent `shouldAnchorBefore` / `shouldAnchorAfterTurn` for the same
   *  (workspace, turn) returns `false`. Idempotent: recording the same key
   *  twice is a no-op. */
  recordAnchored(key: DedupKey): void
}

/** Config seam — every collaborator is injectable so the hellgate can drive
 *  the full state machine without a real `ShadowOdb`. */
export interface CheckpointPolicyConfig {
  readonly mode: CheckpointTriggerMode
  /** The shadow store — only consulted indirectly through the wrap. The
   *  policy carries it so the consumer (wrap) doesn't have to thread two
   *  ports. */
  readonly odb: ShadowOdb
  /** Override the default oracle (testing or stricter classification). */
  readonly oracle?: DestructivenessOracle
  /** ADR-0121 follow-up (audit U7-11) — LRU cap, in bytes, enforced AFTER a
   *  successful auto-anchor. Without this, `registerHead` commits accumulate
   *  forever and the `ShadowOdb.cleanup(maxBytes)` cap is dead (zero runtime
   *  call-sites). When set, `withAutoCheckpoint` calls `odb.cleanup(this)` so
   *  the shadow store stays bounded.
   *
   *  Absent ⇒ NO cleanup is ever attempted (byte-identical to the pre-fix
   *  path; the wrap makes exactly the same calls it always did). To enable
   *  the documented 1 GiB default the composition root passes
   *  `DEFAULT_SHADOW_ODB_MAX_BYTES` (from `@/storage`) here.
   *
   *  SAFETY: `cleanup`/`evictLru` already treat a non-finite or negative cap
   *  as a no-op (HELL H9), so a misconfigured value can NEVER be read as
   *  "evict everything". The sweep is THROTTLED to at most once per
   *  (workspace, turn) by the wrap so the recursive size walk is not paid on
   *  every checkpoint. */
  readonly cleanupMaxBytes?: number
}

/** Build the LRU dedup key string. Kept private so external callers don't
 *  depend on the encoding (which could change to a richer hash if we ever
 *  add a third axis). The `\x1f` is the ASCII unit-separator, a non-printing
 *  delimiter that cannot collide with a workspace path or a turnId. */
const keyOf = (k: DedupKey): string => `${k.workspace}\x1f${k.turnId}`

/** Default `CheckpointPolicy` implementation. */
export const defaultCheckpointPolicy = (cfg: CheckpointPolicyConfig): CheckpointPolicy => {
  const oracle: DestructivenessOracle = cfg.oracle ?? defaultDestructivenessOracle
  // In-memory dedup. The set grows monotonically per session — bounded by the
  // number of distinct (workspace, turnId) pairs the loop produces. A long-
  // running daemon could eventually trim by LRU, but the live set per session
  // is tiny (≤ turn count) so we keep this simple here; bookkeeping lives
  // alongside the policy, NOT inside the odb port.
  const anchored = new Set<string>()

  return {
    async shouldAnchorBefore(tool, call, ctx) {
      if (cfg.mode === "off") return false
      // Oracle decides destructiveness; read-only calls never anchor regardless
      // of mode.
      let destructive: boolean
      try {
        destructive = oracle(tool, call, ctx)
      } catch {
        // Fail-open: an oracle bug must not break dispatch.
        destructive = false
      }
      if (!destructive) return false
      if (cfg.mode === "per-mutating") return true
      if (cfg.mode === "pre-destructive") {
        const turnId = ctx.turnId
        // No turnId ⇒ no dedup window. Pre-destructive without dedup behaves
        // like per-mutating (anchor on every destructive call) for the
        // single-call case — but the wrap caller controls this by deciding
        // whether to plumb a turnId.
        if (typeof turnId !== "string" || turnId.length === 0) return true
        return !anchored.has(keyOf({ workspace: ctx.cwd, turnId }))
      }
      // mode === "per-turn" never anchors BEFORE a tool call — it only
      // anchors AFTER a turn completes.
      return false
    },

    async shouldAnchorAfterTurn(turnId, workspace) {
      if (cfg.mode !== "per-turn") return false
      if (typeof turnId !== "string" || turnId.length === 0) return false
      return !anchored.has(keyOf({ workspace, turnId }))
    },

    recordAnchored(key) {
      anchored.add(keyOf(key))
    },
  }
}

/** Tool-resolver port the wrap uses to look up a `Tool` by name so the
 *  policy's oracle can classify destructiveness. Closed surface — a single
 *  function. Returns `undefined` when the call's tool is unknown (the wrap
 *  then SKIPS the anchor for that call; fail-open). */
export type ToolResolver = (name: string) => Tool | undefined

/** Consult the policy with the resolved tool. NO-THROW: a buggy policy or
 *  unknown tool collapses to `false` (no anchor). Extracted from
 *  `withAutoCheckpoint` to keep the wrap's `execute` under biome's cognitive-
 *  complexity ceiling. */
const decideAnchorBefore = async (
  policy: CheckpointPolicy,
  resolveTool: ToolResolver,
  req: ToolRequest,
): Promise<boolean> => {
  const tool = resolveTool(req.call.name)
  if (tool === undefined) return false
  try {
    return await policy.shouldAnchorBefore(tool, req.call, req.ctx)
  } catch {
    return false
  }
}

/** Per-wrap cleanup throttle. The LRU sweep (`odb.cleanup`) walks the whole
 *  shadow base recursively, so paying it on EVERY anchor would turn a cheap
 *  checkpoint into an O(store-size) scan. We bound it to at most one sweep per
 *  (workspace, turn) — the same natural cadence the anchor dedup already uses —
 *  plus a single-flight guard so two concurrent anchors in the same turn never
 *  launch two overlapping sweeps. State is closure-local to the wrap (NOT the
 *  policy, which stays pure) so it resets with the channel lifetime. */
interface CleanupThrottle {
  readonly swept: Set<string>
  inFlight: boolean
}

/** Cleanup throttle key — reuses the (workspace, turn) composite identity. A
 *  call without a turnId falls back to the workspace alone so a turn-less loop
 *  still sweeps at most once per workspace per channel lifetime (rather than on
 *  every anchor). */
const cleanupKeyOf = (workspace: string, turnId: string | undefined): string =>
  typeof turnId === "string" && turnId.length > 0 ? `${workspace}\x1f${turnId}` : workspace

/** Run the LRU cap once per (workspace, turn), single-flight. Fire-and-forget
 *  by design: the sweep MUST NOT block or fail the tool call, so every error
 *  is swallowed (same fail-open posture as `takeAnchor`). No-op when
 *  `cfg.cleanupMaxBytes` is absent (byte-identical to the pre-fix wrap). */
const maybeCleanup = (
  cfg: CheckpointPolicyConfig,
  throttle: CleanupThrottle,
  req: ToolRequest,
): void => {
  const maxBytes = cfg.cleanupMaxBytes
  if (maxBytes === undefined) return
  if (throttle.inFlight) return
  const turnId = req.ctx.turnId
  const key = cleanupKeyOf(req.ctx.cwd, typeof turnId === "string" ? turnId : undefined)
  if (throttle.swept.has(key)) return
  throttle.swept.add(key)
  throttle.inFlight = true
  // Detach: the sweep runs to completion in the background; the anchor +
  // delegated tool call do not await it. `cleanup` itself guards against a
  // malformed cap (non-finite / negative ⇒ no-op, HELL H9).
  void cfg.odb
    .cleanup(maxBytes)
    .catch(() => {
      // Swallow — observability instrumentation MUST NOT alter the call
      // outcome (mirrors `takeAnchor`).
    })
    .finally(() => {
      throttle.inFlight = false
    })
}

/** Take the actual anchor: record the dedup key (when turnId is present) and
 *  call `odb.registerHead`, swallowing any I/O failure. Extracted from
 *  `withAutoCheckpoint`'s execute for the same complexity reason. Returns
 *  `true` when `registerHead` resolved (so the wrap can gate the LRU sweep on
 *  an actual new commit), `false` when it rejected. */
const takeAnchor = async (
  cfg: CheckpointPolicyConfig,
  policy: CheckpointPolicy,
  req: ToolRequest,
): Promise<boolean> => {
  const turnId = req.ctx.turnId
  if (typeof turnId === "string" && turnId.length > 0) {
    // Record FIRST so a concurrent wrap sees the dedup; even if the anchor
    // I/O rejects, we don't want to re-attempt the I/O on every dispatched
    // call within the same turn.
    policy.recordAnchored({ workspace: req.ctx.cwd, turnId })
  }
  try {
    const sha = await cfg.odb.registerHead(req.ctx.cwd)
    // ADR-0203 — when the policy is granular (the surface wired a
    // `GranularCheckpointPolicy`), record the registerHead SHA against the
    // canonical tag so `/rewind-tool` can resolve+restore it. NON-granular
    // (default) policies lack these methods ⇒ the branch is skipped ⇒
    // byte-identical legacy behaviour. NO-THROW preserved (still inside try).
    const gp = policy as Partial<import("./per-tool-checkpoint").GranularCheckpointPolicy>
    if (typeof gp.computeTag === "function" && typeof gp.recordAnchorSha === "function") {
      const anchorCtx = {
        workspace: req.ctx.cwd,
        ...(typeof turnId === "string" && turnId.length > 0 ? { turnId } : {}),
        toolName: req.call.name,
      }
      const tag = gp.computeTag(anchorCtx)
      if (tag !== null && tag !== undefined) gp.recordAnchorSha(tag, sha, anchorCtx)
    }
    return true
  } catch {
    // Swallow — observability instrumentation MUST NOT alter the call
    // outcome. A real observability hook would forward this to a trace
    // event; the wrap stays I/O-free so the contract is "no extra
    // failure modes" by construction.
    return false
  }
}

/** Higher-order wrapper around an `EffectChannel`. Inserts an auto-anchor
 *  BEFORE delegating to the underlying channel when the policy says so.
 *
 *  - The underlying channel's `execute` contract is preserved exactly:
 *    NEVER throws (contract §1), pre-flight abort honored (§2), envelope
 *    fields surfaced verbatim. The wrap adds NOTHING to the envelope.
 *  - Anchor failures (any rejection from `odb.registerHead`) are SWALLOWED.
 *    The wrap NEVER aborts a tool call because of observability
 *    instrumentation. This is fail-open by design.
 *  - On a successful anchor, the wrap records the dedup key BEFORE the
 *    delegated call so a concurrent second wrap on the same (workspace,
 *    turnId) sees the record.
 *  - When the tool resolver returns `undefined` for the call (unknown tool
 *    name) the wrap skips the anchor entirely — the policy NEVER sees a
 *    null/synthetic Tool object so a future stricter oracle does not have
 *    to defend against probe shapes. */
export const withAutoCheckpoint = (
  inner: EffectChannel,
  policy: CheckpointPolicy,
  cfg: CheckpointPolicyConfig,
  resolveTool: ToolResolver,
): EffectChannel => {
  // Closure-local LRU-sweep throttle (audit U7-11). Lives here — NOT in the
  // policy (which stays pure) — so it shares the wrap's lifetime and resets
  // when the channel is rebuilt.
  const cleanupThrottle: CleanupThrottle = { swept: new Set<string>(), inFlight: false }
  return {
    async execute(
      req: ToolRequest,
      onProgress?: (message: string) => void,
    ): Promise<ToolResultEnvelope> {
      // Default-OFF fast path: when the mode is "off", the wrap is
      // byte-identical to the underlying channel (the policy already
      // short-circuits, but skipping the lookup avoids the resolver call).
      if (cfg.mode === "off") return await inner.execute(req, onProgress)
      if (await decideAnchorBefore(policy, resolveTool, req)) {
        // Only enforce the LRU cap when a NEW commit actually landed — a
        // failed `registerHead` adds no bytes, so there is nothing to evict.
        if (await takeAnchor(cfg, policy, req)) {
          maybeCleanup(cfg, cleanupThrottle, req)
        }
      }
      // Delegate verbatim. The inner channel's no-throw contract carries us
      // through executor exceptions; the wrap adds nothing here.
      return await inner.execute(req, onProgress)
    },
  }
}
