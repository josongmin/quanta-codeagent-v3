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
 *   2. CAPABILITY PROJECTION (§4.2) — `canExposeSpawnTools` / `canAdmitChildDepth`
 *      are the two derived predicates over the session-pinned cap
 *      `maxDescendantDepth` (= max descendant depth a spawn may create). The tier1
 *      block builders gate a child's spawn-tool menu with `canExposeSpawnTools`;
 *      the runner reject bounds recursion with the same cap. Keeping the
 *      predicates here — not inlined at each gate — makes the policy a single
 *      testable, mutation-covered surface.
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

/** Max descendant agent depth a spawn may create (default 3; `1` = root-only,
 *  `0` = total kill switch). Sourced from the typed runtime-config
 *  `maxDescendantDepth` field (env `QUANTA_MAX_DESCENDANT_DEPTH`, parsed with
 *  `parseNonNegativeInt` so `0` is a valid kill-switch value; negative /
 *  non-integer / unset ⇒ default 3). */
export const spawnDepthCap = (): number => runtimeConfig().maxDescendantDepth

/** Is THIS agent (`config.depth`) entitled to spawn tools? Derived predicate
 *  `canExposeSpawnTools(config.depth ?? 0, effectiveCap)` where the effective cap
 *  is `config.subagent?.maxDepth ?? spawnDepthCap()` — the IDENTICAL expression
 *  the runner uses to bound recursion (`opts.maxDepth ?? spawnDepthCap()` where
 *  `opts.maxDepth = config.subagent.maxDepth`). This keeps the capability gate
 *  and the runtime reject in lock-step: the pre-existing per-run knob
 *  `QUANTA_SUBAGENT_MAX_DEPTH` (→ `config.subagent.maxDepth`) widens BOTH surfaces
 *  together. Neither knob set ⇒ cap 3 (default), so depth 0/1/2 keep spawn tools
 *  (byte-identical to pre-landing) and depth ≥ 3 are leaves. */
export const spawnToolsAvailable = (config: Pick<AgentConfig, "depth" | "subagent">): boolean =>
  canExposeSpawnTools(config.depth ?? 0, config.subagent?.maxDepth ?? spawnDepthCap())
