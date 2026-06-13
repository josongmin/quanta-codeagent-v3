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

import type { HookGroupSetting, ResolvedSettings, SettingsLayer, SettingsLayerName } from "./types"
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
  const managedPermsOnly = managed?.security?.permissions?.allowManagedPermissionRulesOnly === true
  const managedHooksOnly = managed?.security?.hooks?.allowManagedHooksOnly === true
  const managedMcpOnly = managed?.security?.mcp?.allowManagedMcpServersOnly === true

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
  let model: string | undefined
  const droppedForUntrust: SettingsLayerName[] = []

  // Low→high so higher-precedence layers append last; `uniq` then preserves the
  // de-dup but the union semantics (§4.b list-union) mean order is informational.
  const lowToHigh = [...LAYER_PRECEDENCE].reverse()
  for (const layerName of lowToHigh) {
    const layer = layers[layerName]
    if (layer === undefined) continue
    const repo = isRepoLayer(layerName)
    const managedLayer = layerName === "managed"

    // For an UNTRUSTED repo layer, its LOOSENING grants are dropped. Note: deny
    // (tightening) still applies below regardless of trust.
    const dropLoosening = repo && !trusted

    let droppedHere = false

    // ── benign band — §9 Q6 v1 decision: DROP the WHOLE repo band when the
    //    project is untrusted (benign keys included). A repo-shipped `model`
    //    could redirect the agent's model id, so an untrusted repo contributes
    //    nothing — not even a "benign" override. Machine-owned (managed/user)
    //    benign keys always apply. ──
    // `droppedHere` records the layer in `droppedForUntrust` provenance, but
    // ONLY when a NON-EMPTY loosening grant was actually dropped (round-3 F5
    // precision). A defined-but-empty collection (`allow:[]`, `events:{}`,
    // `enabledServers:[]`) drops nothing material, so it must NOT surface a
    // spurious "settings ignored" signal. (The parse path collapses empties to
    // `undefined`; this guard makes the public `mergeSettings` seam — consumed
    // by ticket 04 — precise for direct construction too.)
    if (layer.benign?.model !== undefined) {
      if (dropLoosening) droppedHere = true
      else model = layer.benign.model
    }

    const sec = layer.security
    if (sec === undefined) {
      if (droppedHere) droppedForUntrust.push(layerName)
      continue
    }

    // ── permission deny — TIGHTENING, always applied (even untrusted repo) ──
    if (sec.permissions?.deny !== undefined) deny.push(...sec.permissions.deny)

    // ── managed-non-overridable: when managed sets the flag, lower layers
    //    cannot contribute allow/ask/hooks. Managed itself still applies. ──
    const permsBlocked = managedPermsOnly && !managedLayer
    const hooksBlocked = managedHooksOnly && !managedLayer
    const mcpBlocked = managedMcpOnly && !managedLayer

    // ── permission allow/ask — LOOSENING ──
    if (sec.permissions?.allow !== undefined && sec.permissions.allow.length > 0) {
      if (dropLoosening) droppedHere = true
      else if (!permsBlocked) allow.push(...sec.permissions.allow)
    }
    if (sec.permissions?.ask !== undefined && sec.permissions.ask.length > 0) {
      if (dropLoosening) droppedHere = true
      else if (!permsBlocked) ask.push(...sec.permissions.ask)
    }

    // ── hooks — command execution, LOOSENING ──
    if (sec.hooks?.events !== undefined && Object.keys(sec.hooks.events).length > 0) {
      if (dropLoosening) droppedHere = true
      else if (!hooksBlocked) {
        for (const [event, groups] of Object.entries(sec.hooks.events)) {
          const bucket = hooks[event] ?? []
          // T04 — STAMP the provenance authoritatively from the LAYER NAME,
          // overwriting any (already-stripped) disk `source`. This is the
          // single trusted derivation point: a repo (project/local) layer's
          // groups carry a repo-class source ⇒ the command-hooks loader marks
          // them `needsReview`; managed/user stay trusted. Migration-imported
          // hooks land in the project layer, so they inherit `source:"project"`
          // here even without the legacy import marker.
          bucket.push(...groups.map((g) => ({ ...g, source: layerName })))
          hooks[event] = bucket
        }
      }
    }

    // ── mcp server launchers — LOOSENING (enabled) ──
    if (sec.mcp?.enabledServers !== undefined && sec.mcp.enabledServers.length > 0) {
      if (dropLoosening) droppedHere = true
      else if (!mcpBlocked) mcpEnabled.push(...sec.mcp.enabledServers)
    }
    // ── mcp denylist — TIGHTENING: never trust-gated, never managed-blocked
    //    (a deny narrows the boundary; like permission `deny` it always applies). ──
    if (sec.mcp?.deniedServers !== undefined && sec.mcp.deniedServers.length > 0) {
      mcpDenied.push(...sec.mcp.deniedServers)
    }

    if (droppedHere) droppedForUntrust.push(layerName)
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
    model,
    droppedForUntrust,
  }
}
