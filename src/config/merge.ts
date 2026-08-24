/**
 * Precedence merge + managed-non-overridable + per-project trust gate for the
 * central config slice (ADR-0497, jun-7-misc 05, §4.b / §4.c).
 *
 * Precedence (high→low): managed > user > project > local. The merge is PURE —
 * it takes the already-parsed layers and a boolean `trusted` and produces the
 * resolved settings. No IO, no env, no clock.
 *
 * The three load-bearing rules (each maps to a competitor primitive, §3/§5):
 *
 *   1. **Managed non-overridable** (Claude `allowManagedPermissionRulesOnly` /
 *      `allowManagedHooksOnly`). When the MANAGED layer sets the flag, ONLY
 *      managed permission rules / hooks apply — user/project/local cannot add.
 *      This holds even for a TRUSTED repo.
 *   2. **Trust gate** (Codex `trust_level`, Claude `hasTrustDialogAccepted`).
 *      For an UNTRUSTED project, the repo layers (project + local) contribute
 *      NOTHING capability-granting: their permission `allow`/`ask`, `hooks`,
 *      and `mcp` are DROPPED. Only managed + user (machine-owned) apply.
 *   3. **Tightening always allowed** (asymmetry, §4.c). A repo layer's
 *      permission `deny` is applied EVEN when untrusted — a repo narrowing its
 *      own boundary is safe; only widening requires trust. `deny` always wins
 *      over `allow` in the resolved set (defense-in-depth).
 */

import type {
  HookGroupSetting,
  OpenAIEndpointOptions,
  ResolvedSettings,
  SettingsLayer,
  SettingsLayerName,
} from "./types"
import { LAYER_PRECEDENCE, REPO_LAYERS } from "./types"

/** De-dup a list preserving first-seen order. */
const uniq = (xs: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x)
      out.push(x)
    }
  }
  return out
}

/** A layer is a repo layer (project/local) iff it is attacker-shippable. */
const isRepoLayer = (layer: SettingsLayerName): boolean => REPO_LAYERS.includes(layer)

/**
 * Apply one LOOSENING grant from one layer, under both gates.
 *
 * Every capability-granting category — permission allow, permission ask, hooks,
 * mcp enabledServers, openaiEndpoints, and the benign band — was written out
 * with the same four lines: is it present, is the layer an untrusted repo, is
 * it blocked by a managed-only lock, otherwise apply. Six near-identical copies
 * is not merely 56 cognitive complexity in one function; it is the shape in
 * which a security bug hides, because a category that forgets one of the two
 * gates reads exactly like the five that do not.
 *
 * Returns whether the grant was DROPPED for untrust, which the caller ORs into
 * the layer's `droppedForUntrust` provenance. Note the asymmetry that is
 * deliberate and preserved: a drop is recorded only when the grant was
 * non-empty (a defined-but-empty `allow: []` drops nothing material and must
 * not raise a spurious "settings ignored" signal), and a MANAGED-blocked grant
 * is silently not applied WITHOUT being recorded as a trust drop — it was not
 * dropped for untrust, it was overridden by policy.
 *
 * TIGHTENING categories (permission `deny`, mcp `deniedServers`) deliberately do
 * NOT go through here: they are never trust-gated and never managed-blocked, so
 * routing them through a gate helper would invite someone to "make them
 * consistent".
 */
interface LooseningGrant {
  /** False for an absent or empty collection — nothing to drop, nothing to do. */
  readonly present: boolean
  /** The layer is a repo layer AND the project is untrusted. */
  readonly dropLoosening: boolean
  /** A managed-only lock covers this category and this is not the managed layer. */
  readonly blocked: boolean
  readonly apply: () => void
}

const applyLooseningGrant = (args: LooseningGrant): boolean => {
  if (!args.present) return false
  if (args.dropLoosening) return true
  if (!args.blocked) args.apply()
  return false
}

/** The mutable accumulators one layer folds into. */
interface MergeAcc {
  readonly allow: string[]
  readonly deny: string[]
  readonly ask: string[]
  readonly hooks: Record<string, HookGroupSetting[]>
  readonly mcpEnabled: string[]
  readonly mcpDenied: string[]
  readonly openaiEndpoints: Record<string, OpenAIEndpointOptions>
  model: string | undefined
}

/** The managed layer's non-overridable locks, read once. */
interface ManagedLocks {
  readonly perms: boolean
  readonly hooks: boolean
  readonly mcp: boolean
}

/**
 * Fold ONE layer into the accumulator, and report whether a non-empty loosening
 * grant was dropped for untrust (the caller records that in
 * `droppedForUntrust`).
 *
 * Split out of {@link mergeSettings}, which held the four refusal/lock reads,
 * this whole body and the final defense-in-depth subtraction in one 56-complexity
 * function. Per-layer folding is the unit that actually has a contract — "what
 * does THIS layer contribute, under these two gates" — and it is the one a
 * reader has to hold in their head to answer a security question about any
 * single category.
 */
const contributeLayer = (
  acc: MergeAcc,
  layerName: SettingsLayerName,
  layer: SettingsLayer,
  trusted: boolean,
  locks: ManagedLocks,
): boolean => {
  const repo = isRepoLayer(layerName)
  const managedLayer = layerName === "managed"

  // For an UNTRUSTED repo layer, its LOOSENING grants are dropped. Note: deny
  // (tightening) still applies below regardless of trust.
  const dropLoosening = repo && !trusted

  // ── managed-non-overridable: when managed sets the flag, lower layers cannot
  //    contribute allow/ask/hooks/mcp. Managed itself still applies. ──
  const permsBlocked = locks.perms && !managedLayer
  const hooksBlocked = locks.hooks && !managedLayer
  const mcpBlocked = locks.mcp && !managedLayer

  // ── benign band — §9 Q6 v1 decision: DROP the WHOLE repo band when the
  //    project is untrusted (benign keys included). A repo-shipped `model`
  //    could redirect the agent's model id, so an untrusted repo contributes
  //    nothing — not even a "benign" override. Machine-owned (managed/user)
  //    benign keys always apply. ──
  //
  // A drop is recorded in `droppedForUntrust` provenance ONLY when a NON-EMPTY
  // loosening grant was actually dropped (round-3 F5 precision). A
  // defined-but-empty collection (`allow:[]`, `events:{}`, `enabledServers:[]`)
  // drops nothing material, so it must NOT surface a spurious "settings
  // ignored" signal — which is what every `present:` predicate below encodes.
  // (The parse path collapses empties to `undefined`; the guard makes the public
  // `mergeSettings` seam — consumed by ticket 04 — precise for direct
  // construction too.)
  const benignModel = layer.benign?.model
  const grants: LooseningGrant[] = [
    {
      present: benignModel !== undefined,
      dropLoosening,
      blocked: false,
      apply: () => {
        acc.model = benignModel
      },
    },
  ]

  const sec = layer.security
  if (sec !== undefined) {
    // ── TIGHTENING — permission deny and the mcp denylist are applied even for
    //    an untrusted repo and are never managed-blocked: a layer narrowing its
    //    own boundary is safe, only widening needs trust. They are deliberately
    //    NOT expressed as grants, so nobody "makes them consistent" later. ──
    acc.deny.push(...(sec.permissions?.deny ?? []))
    acc.mcpDenied.push(...(sec.mcp?.deniedServers ?? []))

    const secAllow = sec.permissions?.allow ?? []
    const secAsk = sec.permissions?.ask ?? []
    const secEvents = sec.hooks?.events ?? {}
    const secEnabled = sec.mcp?.enabledServers ?? []
    const eps = sec.openaiEndpoints ?? {}
    grants.push(
      {
        present: secAllow.length > 0,
        dropLoosening,
        blocked: permsBlocked,
        apply: () => acc.allow.push(...secAllow),
      },
      {
        present: secAsk.length > 0,
        dropLoosening,
        blocked: permsBlocked,
        apply: () => acc.ask.push(...secAsk),
      },
      {
        // hooks — command EXECUTION, the most capability-granting category here.
        present: Object.keys(secEvents).length > 0,
        dropLoosening,
        blocked: hooksBlocked,
        apply: () => {
          for (const [event, groups] of Object.entries(secEvents)) {
            const bucket = acc.hooks[event] ?? []
            // T04 — STAMP the provenance authoritatively from the LAYER NAME,
            // overwriting any (already-stripped) disk `source`. This is the
            // single trusted derivation point: a repo (project/local) layer's
            // groups carry a repo-class source ⇒ the command-hooks loader marks
            // them `needsReview`; managed/user stay trusted. Migration-imported
            // hooks land in the project layer, so they inherit `source:"project"`
            // here even without the legacy import marker.
            bucket.push(...groups.map((g) => ({ ...g, source: layerName })))
            acc.hooks[event] = bucket
          }
        },
      },
      {
        present: secEnabled.length > 0,
        dropLoosening,
        blocked: mcpBlocked,
        apply: () => acc.mcpEnabled.push(...secEnabled),
      },
      {
        // openaiEndpoints — redirects the LLM transport / references a
        // credential, so it is loosening. Id-keyed REPLACE, not a field union,
        // so a higher-precedence layer's same id wins. No managed-only lockdown
        // flag exists for endpoints (none is defined in the schema), so this
        // category is never policy-blocked.
        present: Object.keys(eps).length > 0,
        dropLoosening,
        blocked: false,
        apply: () => {
          for (const [id, ep] of Object.entries(eps)) acc.openaiEndpoints[id] = ep
        },
      },
    )
  }

  // Every grant is evaluated — no short-circuit — because each has its own
  // side effect and its own drop verdict.
  let droppedHere = false
  for (const grant of grants) droppedHere = applyLooseningGrant(grant) || droppedHere
  return droppedHere
}

/**
 * Merge the parsed layers into the trust-gated {@link ResolvedSettings}.
 *
 * @param layers   parsed layers (a subset of the four; absent ⇒ contributes
 *                 nothing). Iterated low→high so higher precedence wins last.
 * @param trusted  whether the current PROJECT path is trusted. When false, the
 *                 repo layers' capability grants are dropped (§4.c).
 */
export const mergeSettings = (
  layers: Partial<Record<SettingsLayerName, SettingsLayer>>,
  trusted: boolean,
): ResolvedSettings => {
  const managed = layers.managed
  const locks: ManagedLocks = {
    perms: managed?.security?.permissions?.allowManagedPermissionRulesOnly === true,
    hooks: managed?.security?.hooks?.allowManagedHooksOnly === true,
    mcp: managed?.security?.mcp?.allowManagedMcpServersOnly === true,
  }

  const allow: string[] = []
  const deny: string[] = []
  const ask: string[] = []
  // NULL-PROTOTYPE accumulator (round-3 F6): a hooks EVENT NAME of `__proto__`
  // (or `constructor`/`prototype`) must be treated as an ordinary own-key, NOT
  // a reach into Object.prototype. With a plain `{}`, `hooks["__proto__"] ?? []`
  // returns the PROTOTYPE OBJECT (truthy, no `.push`) → a TypeError CRASH on a
  // hostile-or-typo event name, AND `hooks["__proto__"] = …` is a prototype
  // assignment. A null-proto object makes every event name a safe own-key.
  const hooks: Record<string, HookGroupSetting[]> = Object.create(null)
  const mcpEnabled: string[] = []
  const mcpDenied: string[] = []
  // Id-keyed endpoint map. Iterating low→high means a higher-precedence layer's
  // same-id endpoint OVERWRITES the lower one (deterministic replace, §4.a) —
  // NOT a field union. NULL-PROTO so an id of `__proto__` stays a safe own-key.
  const openaiEndpoints: Record<string, OpenAIEndpointOptions> = Object.create(null)
  const acc: MergeAcc = {
    allow,
    deny,
    ask,
    hooks,
    mcpEnabled,
    mcpDenied,
    openaiEndpoints,
    model: undefined,
  }
  const droppedForUntrust: SettingsLayerName[] = []

  // Low→high so higher-precedence layers append last; `uniq` then preserves the
  // de-dup but the union semantics (§4.b list-union) mean order is informational.
  const lowToHigh = [...LAYER_PRECEDENCE].reverse()
  for (const layerName of lowToHigh) {
    const layer = layers[layerName]
    if (layer === undefined) continue
    if (contributeLayer(acc, layerName, layer, trusted, locks)) droppedForUntrust.push(layerName)
  }

  // deny always wins over allow (defense-in-depth, §4.b).
  const denySet = new Set(deny)
  const allowFinal = uniq(allow).filter((rule) => !denySet.has(rule))
  const askFinal = uniq(ask).filter((rule) => !denySet.has(rule))

  // MCP denylist wins over enable (defense-in-depth, mirrors permission deny).
  const mcpDenySet = new Set(mcpDenied)
  const mcpEnabledFinal = uniq(mcpEnabled).filter((s) => !mcpDenySet.has(s))

  return {
    permissions: { allow: allowFinal, deny: uniq(deny), ask: askFinal },
    hooks,
    mcpEnabledServers: mcpEnabledFinal,
    mcpDeniedServers: uniq(mcpDenied),
    model: acc.model,
    openaiEndpoints,
    droppedForUntrust,
  }
}
