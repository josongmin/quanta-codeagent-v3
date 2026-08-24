/**
 * `host/runtime/base-slot-registry.ts` — declarative slot registry for the
 * default-OFF feature slots `buildBaseFromArgs` folds into `AgentConfig.base`,
 * replacing the ~18 interleaved conditional-spreads in that keystone's object
 * literal. Same proven pattern as `PRE_FLIGHT_CONSULTS` (src/agent/dispatch.ts):
 * a `readonly` array of uniform `(ctx) => Partial<Base>` resolvers folded in a
 * single loop, so adding a slot is ONE array entry instead of a new inline
 * `...(cond ? {k} : {})` in the literal (OCP).
 *
 * BYTE-IDENTICAL invariant (the whole point):
 *   - Each resolver returns EITHER `{}` (slot absent) OR `{ key: value }` — NEVER
 *     `{ key: undefined }`, exactly like the spread-ready helpers it wraps. So
 *     folding via ordered `Object.assign` adds a key IFF the legacy spread did.
 *   - The array is authored in the EXACT literal spread order, and the fold is
 *     applied in array order onto a seed carrying the REQUIRED fields (which came
 *     first in the literal). Object insertion order is therefore preserved
 *     key-for-key — the assembled base is byte-identical for every input. (A
 *     dedicated hellgate snapshots the ordered key list + per-key shape and
 *     RED-fires on any drift; this module is designed against that guard.)
 *   - The shared cross-slot state (llm, searchWire, automationSlot, the artifact
 *     registry, …) is resolved ONCE by the caller and threaded in via `ctx`; the
 *     resolvers only PROJECT it into slots (no re-resolution, no re-read of env
 *     beyond what the legacy spread expression already read).
 *
 * The per-slot projection logic is unchanged: each resolver contains the SAME
 * `cond ? {k} : {}` expression the literal had, reading the pre-resolved value
 * off `ctx`. No slot's resolution logic moved here — only the AGGREGATION.
 */

import type { createArtifactRegistry } from "@/artifact"
import type { AssembleRequest } from "@/host/runtime/agent-config-assembler"
import type { AutomationEngineSlot } from "@/scheduler/runtime-wire"

/** The base shape the resolvers contribute to. */
type Base = AssembleRequest["base"]

/**
 * Pre-resolved shared state every slot resolver reads. Built ONCE by
 * `buildBaseFromArgs` (the same locals it already computed), then threaded to
 * the fold so each resolver is a pure projection. Fields are the exact values
 * the legacy conditional-spreads closed over — same types, same nullability, so
 * each `cond ? {} : {}` guard is preserved verbatim.
 */
export interface BaseSlotContext {
  /** The parsed partial (for the two partial-carried slots: localEnv +
   *  namedAgentResolver). */
  readonly p: import("./agent-arg-builder").AssembleRequestPartial
  /** Spread-ready egress-proxy slot (`{}` when off) — already resolved. */
  readonly networkProxySlot: { networkProxy?: NonNullable<Base["networkProxy"]> }
  /** The search wire (`null` when off); only its `.pipeline` is projected. */
  readonly searchWire: { pipeline: NonNullable<Base["searchPipeline"]> } | null
  readonly identityModeVariant: NonNullable<Base["identityModeVariant"]> | undefined
  readonly stickyModelStore: NonNullable<Base["stickyModelStore"]> | undefined
  readonly toolProfile: NonNullable<Base["toolProfile"]> | undefined
  readonly focusChain: NonNullable<Base["focusChain"]> | undefined
  /** Spread-ready prewarm slot (`{}` when off). */
  readonly prewarmSlot: { prewarm?: NonNullable<Base["prewarm"]> }
  /** Spread-ready lsp-prewarm slot (`{}` when off). */
  readonly lspPrewarmSlot: { lspPrewarm?: NonNullable<Base["lspPrewarm"]> }
  /** Spread-ready local-env slot (`{}` when off) — computed from `p`. */
  readonly localEnvSlot: Partial<Base>
  /** Spread-ready named-agent-resolver slot (`{}` when off) — computed from `p`. */
  readonly namedAgentResolverSlot: Partial<Base>
  /** The automation slot (`null` when off); projected onto `automationEngine`.
   *  Typed as the RESOLVER's `AutomationEngineSlot` (not `Base["automationEngine"]`,
   *  whose optional-property widening drops the required `handler`). */
  readonly automationSlot: AutomationEngineSlot | null
  /** Spread-ready observability slots (`{}` when off). */
  readonly observabilitySlots: Partial<Base>
  /** Spread-ready permission-profile manager slot (`{}` when off). */
  readonly permissionProfileSlot: Partial<Base>
  /** Spread-ready permission-pattern store slot (`{}` when off). */
  readonly permissionPatternStoreSlot: Partial<Base>
  /** Spread-ready file-history sink slot (`{}` when off). */
  readonly fileHistorySinkSlot: Partial<Base>
  /** The SHARED artifact registry (`undefined` when off). Typed as the
   *  resolver's real `ArtifactRegistry` (not `Base["artifactRegistry"]`, whose
   *  duck-typed `AppshotArtifactSink` widening drops get/list/destroy). */
  readonly artifactRegistry: ReturnType<typeof createArtifactRegistry> | undefined
  readonly artifactPreviewResolver: NonNullable<Base["artifactPreviewResolver"]> | undefined
}

/** One base-slot resolver: projects the pre-resolved `ctx` into AT MOST one
 *  slot's worth of keys. Returns `{}` (slot absent) or `{ key: value }` — never
 *  `{ key: undefined }`, so the fold is byte-identical to the legacy spread. */
export type BaseSlotResolver = (ctx: BaseSlotContext) => Partial<Base>

/**
 * The ordered slot registry. AUTHORED IN THE EXACT ORDER the spreads appeared in
 * the `buildBaseFromArgs` base literal — this order IS the assembled key order,
 * so it is load-bearing (see the byte-identical hellgate). Each entry is the SAME
 * conditional-spread expression the literal held, reading off `ctx`.
 *
 * Slots that were already spread-ready helpers (`{}`-when-off) pass through
 * verbatim; the inline-conditional ones keep their exact `!== undefined` /
 * `!== null` guard (NOT truthiness) so a falsy-but-present value behaves
 * identically.
 */
export const BASE_SLOT_RESOLVERS: readonly BaseSlotResolver[] = [
  // 1. ADR-0428 — socket-level egress proxy (spread-ready `{}` when off).
  (ctx) => ctx.networkProxySlot,
  // 2. ADR-0277/0278 — helper-only search pipeline slot (present iff a wire).
  (ctx) => (ctx.searchWire !== null ? { searchPipeline: ctx.searchWire.pipeline } : {}),
  // 3-6. ADR-0236 — composition-root mega-wire slots (default-OFF; `!== undefined`).
  (ctx) =>
    ctx.identityModeVariant !== undefined ? { identityModeVariant: ctx.identityModeVariant } : {},
  (ctx) => (ctx.stickyModelStore !== undefined ? { stickyModelStore: ctx.stickyModelStore } : {}),
  (ctx) => (ctx.toolProfile !== undefined ? { toolProfile: ctx.toolProfile } : {}),
  (ctx) => (ctx.focusChain !== undefined ? { focusChain: ctx.focusChain } : {}),
  // 7-8. ADR-0452 / RFC jun-17 — prewarm + lsp-prewarm (spread-ready).
  (ctx) => ctx.prewarmSlot,
  (ctx) => ctx.lspPrewarmSlot,
  // 9-10. ADR-0455 / named-agent — partial-carried slots (spread-ready).
  (ctx) => ctx.localEnvSlot,
  (ctx) => ctx.namedAgentResolverSlot,
  // 11. ADR-0279 — automation engine (default-OFF; `!== null`).
  (ctx) => (ctx.automationSlot !== null ? { automationEngine: ctx.automationSlot } : {}),
  // 12. ADR-0404 + ADR-0415 — observability slots (spread-ready `{}` when off).
  (ctx) => ctx.observabilitySlots,
  // 13. Track A2 — named-permission-profile manager (spread-ready).
  (ctx) => ctx.permissionProfileSlot,
  // 14. CLUSTER D #5 — shared PatternGrantStore (spread-ready).
  (ctx) => ctx.permissionPatternStoreSlot,
  // 15. file_history_rewind — capture sink (spread-ready).
  (ctx) => ctx.fileHistorySinkSlot,
  // 16. A2 — shared artifact registry (default-OFF; `!== undefined`).
  (ctx) => (ctx.artifactRegistry !== undefined ? { artifactRegistry: ctx.artifactRegistry } : {}),
  // 17. A2 — read-only preview resolver (default-OFF; `!== undefined`).
  (ctx) =>
    ctx.artifactPreviewResolver !== undefined
      ? { artifactPreviewResolver: ctx.artifactPreviewResolver }
      : {},
]

/**
 * Fold {@link BASE_SLOT_RESOLVERS} onto `seed` (which carries the REQUIRED base
 * fields, in their literal order) IN ARRAY ORDER, mutating `seed` in place.
 * Because each resolver contributes disjoint keys (or none), and the seed's
 * required keys come first, the resulting insertion order is identical to the
 * legacy object literal — byte-identical.
 *
 * `Object.assign` is the fold primitive: a resolver returning `{}` adds nothing;
 * one returning `{ key: v }` appends `key` at first-write position. Since no slot
 * key collides with another or with a required field, first-write === this
 * position === the legacy spread position.
 */
export const foldBaseSlots = (seed: Base, ctx: BaseSlotContext): Base => {
  for (const resolve of BASE_SLOT_RESOLVERS) Object.assign(seed, resolve(ctx))
  return seed
}
