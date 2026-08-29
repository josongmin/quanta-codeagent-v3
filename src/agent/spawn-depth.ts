/**
 * Sub-agent nesting control — lineage-derived depth + capability-absence (RFC
 * jul-13 §4.1/§4.2/§6.5). SSOT for "what depth is THIS child?" and "is THIS
 * agent entitled to spawn tools?".
 *
 * Two layers live here, both DETERMINISTIC (not heuristic — no "usually leaf"
 * estimate):
 *
 *   1. LINEAGE AUTHORITY (§4.1) — `childDepthOf(parent)` derives a new child's
 *      depth as `parent.depth + 1`. This is the ONLY authority for a child's
 *      depth: the runner's `buildChildConfig` calls it against the REAL parent
 *      AgentConfig in scope, IGNORING any caller-asserted `req.depth`. That makes
 *      the historical `depth:0` hardcodes on the background/delegate paths
 *      advisory (they no longer feed the authority) — the fail-open holes vanish
 *      without per-source patches. `undefined` parent depth = a genuine root (that
 *      config IS the root); a malformed depth is a typed `SpawnLineageError`
 *      (fail-closed, never silently treated as root).
 *
 *   2. CAPABILITY PROJECTION (§4.2, rev.4 MIN-CAP) — `canExposeSpawnTools` /
 *      `canAdmitChildDepth` are the two derived predicates over the effective cap
 *      `effectiveCap(requested) = min(maxDescendantDepth policy, requested ?? +∞)`.
 *      A per-config `requested` cap can only TIGHTEN the operator policy, never
 *      raise it. The tier1 block builders gate a child's spawn-tool menu with
 *      `canExposeSpawnTools`; the runner reject bounds recursion with the SAME
 *      `effectiveCap`. Keeping the predicates + the min-cap resolution here — not
 *      inlined at each gate — makes the policy a single testable, mutation-covered
 *      surface with no split-brain between the two knobs.
 */
import { runtimeConfig } from "@/shared/runtime-config"
import type { AgentConfig } from "./types"

/** A parent AgentConfig carried a depth that is not a non-negative integer
 *  (NaN / negative / fractional). Thrown by {@link childDepthOf} so the spawn is
 *  denied fail-closed rather than silently coerced to a root (`depth:0`). */
export class SpawnLineageError extends Error {}

/** Derive a new child's depth from its REAL parent config (§4.1). This is the
 *  single authority for child lineage depth — caller/tool payload/adapter
 *  numbers are NOT trusted (a forged `req.depth:0` cannot forge a shallow child).
 *
 *  - `parent.depth === undefined` ⇒ the parent is a genuine root (that config IS
 *    the root), so the child is depth 1. (undefined ≠ "unknown to be denied";
 *    the AgentConfig contract is 0=root, absent=root.)
 *  - malformed depth (NaN / negative / non-integer) ⇒ {@link SpawnLineageError}
 *    (fail-closed; NO `depth:0` fallback). */
export const childDepthOf = (parent: Pick<AgentConfig, "depth">): number => {
  const d = parent.depth ?? 0
  if (!Number.isInteger(d) || d < 0) throw new SpawnLineageError(`malformed parent depth: ${d}`)
  return d + 1
}

/**
 * Is this config the run's ROOT agent, or a spawned descendant?
 *
 * One rule, one place. `depth` is assigned at spawn (`childDepthOf`) and
 * persisted, so it survives a resume — a rehydrated child this process never
 * spawned still answers correctly, which is why the question is asked of depth
 * and not of anything more incidental like the presence of a mailbox id.
 *
 * Two call sites depend on agreeing exactly: usage provenance (which agent
 * spent this) and the run's turn accounting (only root turns advance the run's
 * turn count and reset its per-turn cost guard). They were separate copies of
 * `depth > 0` until the second one shipped; a shared predicate is what keeps a
 * later change from moving one and not the other.
 */
export const isRootAgent = (config: Pick<AgentConfig, "depth">): boolean =>
  (config.depth ?? 0) === 0

/** The two derived predicates (§4.2), both reading the SAME session cap
 *  `maxDescendantDepth` (= the max descendant depth a spawn may create), so the
 *  exposure gate and the runtime admission never diverge in a static policy:
 *
 *    canExposeSpawnTools(parentDepth, cap) = parentDepth < cap
 *    canAdmitChildDepth  (childDepth,  cap) = childDepth  <= cap
 *
 *  | cap | parent | expose | childDepth | admit |
 *  |-----|--------|--------|-----------|-------|
 *  |  3  |   0    |  yes   |     1     |  yes  |
 *  |  3  |   2    |  yes   |     3     |  yes  |
 *  |  3  |   3    |  no    |     4     |  no   |
 *  |  0  |   0    |  no    |     1     |  no   |  (kill switch)
 */
export const canExposeSpawnTools = (parentDepth: number, maxDescendantDepth: number): boolean =>
  parentDepth < maxDescendantDepth
export const canAdmitChildDepth = (childDepth: number, maxDescendantDepth: number): boolean =>
  childDepth <= maxDescendantDepth

/** The OPERATOR POLICY ceiling: max descendant agent depth a spawn may create
 *  (default 1 = root-only; `0` = total kill switch). Sourced from the typed
 *  runtime-config `maxDescendantDepth` field (env `QUANTA_MAX_DESCENDANT_DEPTH`,
 *  parsed with `parseNonNegativeInt` so `0` is a valid kill-switch value;
 *  negative / non-integer / unset ⇒ default 1). This is THE authoritative
 *  ceiling — see {@link effectiveCap}. */
export const spawnDepthCap = (): number => runtimeConfig().maxDescendantDepth

/** rev.4 MIN-CAP authority (§4.2, RFC line ~188): the effective recursion cap is
 *  `min(operator policy, requested)`. A caller/per-config `requested` cap can
 *  only ever TIGHTEN the operator policy, NEVER RAISE it above the policy ceiling.
 *
 *    effectiveCap(requested) = Math.min(spawnDepthCap(), requested ?? +∞)
 *
 *  This is the SINGLE resolution used by all three cap sources (the exposure
 *  gate {@link spawnToolsAvailable}, the runner reject in subagent-runner.ts, and
 *  the two `@/subagent` secondary pre-checks), so the 3-source agreement holds
 *  structurally. It also RESOLVES R1's two-knob split-brain: `maxDescendantDepth`
 *  (`QUANTA_MAX_DESCENDANT_DEPTH`) is the authoritative policy ceiling, and the
 *  per-config `maxDepth` (legacy `QUANTA_SUBAGENT_MAX_DEPTH`) is a tightening-only
 *  override that can never widen the cap above policy.
 *
 *  Examples: policy 1, requested 5 ⇒ min(1,5)=1 (config canNOT raise past policy);
 *  policy 3, requested 1 ⇒ min(3,1)=1 (config tightens); no requested ⇒ policy. */
export const effectiveCap = (requested?: number): number =>
  Math.min(spawnDepthCap(), requested ?? Number.POSITIVE_INFINITY)

/** Is THIS agent (`config.depth`) entitled to spawn tools? Derived predicate
 *  `canExposeSpawnTools(config.depth ?? 0, effectiveCap(config.subagent?.maxDepth))`
 *  — the IDENTICAL min-cap expression the runner uses to bound recursion
 *  (`effectiveCap(opts.maxDepth)` where `opts.maxDepth = config.subagent.maxDepth`).
 *  This keeps the capability gate and the runtime reject in lock-step: the
 *  per-config knob `config.subagent.maxDepth` can only LOWER the cap below the
 *  operator policy, never raise it. Neither knob set ⇒ cap = policy (default 1),
 *  so only the root (depth 0) keeps spawn tools and depth ≥ 1 are leaves. */
export const spawnToolsAvailable = (config: Pick<AgentConfig, "depth" | "subagent">): boolean =>
  canExposeSpawnTools(config.depth ?? 0, effectiveCap(config.subagent?.maxDepth))
