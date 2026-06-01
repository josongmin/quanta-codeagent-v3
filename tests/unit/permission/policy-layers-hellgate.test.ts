/**
 * Layered policy/config merge engine — hellgate battery.
 *
 * Seals `src/permission/policy-layers/` (Cursor `SandboxPolicyMergeSources` +
 * Codex `ConfigLayer/ConfigLayerSource/MergeStrategy/OverriddenMetadata`
 * absorption): a pure layered struct-merge with per-field override metadata.
 *
 *   HELL-PL-01  source precedence: team-admin > per-repo > per-user > default
 *   HELL-PL-02  layerSourceRank monotonic + matches the ASC tuple indices
 *   HELL-PL-03  isLayerSource guard accepts the 4, rejects everything else
 *   HELL-PL-04  empty layers ⇒ merged === base (clone), overrides === []
 *   HELL-PL-05  per-field winner = most-authoritative SETTER (not array order)
 *   HELL-PL-06  overrode list = the OTHER setters, most-authoritative first
 *   HELL-PL-07  field set by exactly one layer ⇒ overrode === []
 *   HELL-PL-08  field NO layer sets ⇒ taken from base, absent from overrides
 *   HELL-PL-09  ALL 24 permutations of {default,per-user,per-repo,team-admin}
 *               presence resolve identically (order-independent by source)
 *   HELL-PL-10  conflicting SAME-source layers ⇒ LATER declaration wins
 *   HELL-PL-11  most-restrictive: SAFER boolean wins regardless of source
 *   HELL-PL-12  most-restrictive: SAFER enum wins regardless of source
 *   HELL-PL-13  most-restrictive: field with NO ordering falls back to source-prec
 *   HELL-PL-14  most-restrictive tie on safety ⇒ break by source authority
 *   HELL-PL-15  explicit `undefined` value still counts as SET (key presence)
 *   HELL-PL-16  resolvePolicyLayers shaping == equivalent mergeLayered call
 *   HELL-PL-17  base is NOT mutated; result merged is a distinct object
 *   HELL-PL-18  property: random layer permutation ⇒ deeply-equal merged
 *   HELL-PL-19  overrides array sorted by field key (deterministic)
 */

import { describe, expect, test } from "bun:test"
import {
  type ConfigLayer,
  isLayerSource,
  LAYER_SOURCE_PRECEDENCE_ASC,
  type LayerSource,
  layerSourceRank,
  mergeLayered,
  type RestrictivenessSpec,
  resolvePolicyLayers,
} from "@/permission/policy-layers"

// A permission-ish struct exercising boolean + enum + scalar fields.
interface SandboxCfg {
  networkIsolated: boolean // SAFER = true
  workspaceWrite: boolean // SAFER = false
  approvalMode: "auto" | "once" | "session" | "always" // SAFER = always
  label: string // no restrictiveness ordering
}

const BASE: SandboxCfg = {
  networkIsolated: false,
  workspaceWrite: true,
  approvalMode: "auto",
  label: "base",
}

const APPROVAL_RANK: Record<SandboxCfg["approvalMode"], number> = {
  always: 3,
  session: 2,
  once: 1,
  auto: 0,
}

const RESTRICTIVE: RestrictivenessSpec<SandboxCfg> = {
  networkIsolated: (v) => (v ? 1 : 0), // true safer
  workspaceWrite: (v) => (v ? 0 : 1), // false safer
  approvalMode: (v) => APPROVAL_RANK[v],
}

describe("policy-layers — source precedence + ranks", () => {
  test("HELL-PL-01 team-admin > per-repo > per-user > default", () => {
    const layers: Array<ConfigLayer<SandboxCfg>> = [
      { source: "default", value: { label: "d" } },
      { source: "per-user", value: { label: "u" } },
      { source: "per-repo", value: { label: "r" } },
      { source: "team-admin", value: { label: "a" } },
    ]
    const { merged } = mergeLayered(layers, { base: BASE, strategy: "source-precedence" })
    expect(merged.label).toBe("a")
  })

  test("HELL-PL-02 layerSourceRank monotonic, matches ASC indices", () => {
    LAYER_SOURCE_PRECEDENCE_ASC.forEach((s, i) => {
      expect(layerSourceRank(s)).toBe(i)
    })
    expect(layerSourceRank("team-admin")).toBeGreaterThan(layerSourceRank("per-repo"))
    expect(layerSourceRank("per-repo")).toBeGreaterThan(layerSourceRank("per-user"))
    expect(layerSourceRank("per-user")).toBeGreaterThan(layerSourceRank("default"))
  })

  test("HELL-PL-03 isLayerSource guard", () => {
    for (const s of LAYER_SOURCE_PRECEDENCE_ASC) expect(isLayerSource(s)).toBe(true)
    for (const bad of ["", "admin", "user", "repo", "DEFAULT", "team_admin"])
      expect(isLayerSource(bad)).toBe(false)
  })
})

describe("policy-layers — merge core", () => {
  test("HELL-PL-04 empty layers ⇒ base clone, no overrides", () => {
    const { merged, overrides } = mergeLayered([], {
      base: BASE,
      strategy: "source-precedence",
    })
    expect(merged).toEqual(BASE)
    expect(merged).not.toBe(BASE)
    expect(overrides).toEqual([])
  })

  test("HELL-PL-05 winner = most-authoritative setter, not array order", () => {
    // team-admin appears FIRST in the array but per-repo also sets label; admin must win.
    const layers: Array<ConfigLayer<SandboxCfg>> = [
      { source: "team-admin", value: { label: "a" } },
      { source: "per-repo", value: { label: "r" } },
      { source: "per-user", value: { label: "u" } },
    ]
    const { merged, overrides } = mergeLayered(layers, {
      base: BASE,
      strategy: "source-precedence",
    })
    expect(merged.label).toBe("a")
    const o = overrides.find((x) => x.field === "label")
    expect(o?.winner).toBe("team-admin")
  })

  test("HELL-PL-06 overrode = other setters, most-authoritative first", () => {
    const layers: Array<ConfigLayer<SandboxCfg>> = [
      { source: "per-user", value: { label: "u" } },
      { source: "default", value: { label: "d" } },
      { source: "per-repo", value: { label: "r" } },
    ]
    const { overrides } = mergeLayered(layers, { base: BASE, strategy: "source-precedence" })
    const o = overrides.find((x) => x.field === "label")
    expect(o?.winner).toBe("per-repo")
    expect(o?.overrode).toEqual(["per-user", "default"])
  })

  test("HELL-PL-07 single setter ⇒ overrode []", () => {
    const { overrides } = mergeLayered([{ source: "per-user", value: { label: "u" } }], {
      base: BASE,
      strategy: "source-precedence",
    })
    expect(overrides).toEqual([{ field: "label", winner: "per-user", overrode: [] }])
  })

  test("HELL-PL-08 unset field taken from base, absent from overrides", () => {
    const { merged, overrides } = mergeLayered([{ source: "per-repo", value: { label: "r" } }], {
      base: BASE,
      strategy: "source-precedence",
    })
    expect(merged.networkIsolated).toBe(BASE.networkIsolated)
    expect(merged.workspaceWrite).toBe(BASE.workspaceWrite)
    expect(overrides.map((o) => o.field)).toEqual(["label"])
  })

  test("HELL-PL-09 all 24 permutations of presence resolve identically", () => {
    const slotValues: Record<LayerSource, Partial<SandboxCfg>> = {
      default: { label: "d", workspaceWrite: true },
      "per-user": { label: "u", networkIsolated: false },
      "per-repo": { label: "r", approvalMode: "once" },
      "team-admin": { label: "a", approvalMode: "always" },
    }
    const sources = [...LAYER_SOURCE_PRECEDENCE_ASC]
    const perm = <X>(arr: X[]): X[][] =>
      arr.length <= 1
        ? [arr]
        : arr.flatMap((x, i) =>
            perm([...arr.slice(0, i), ...arr.slice(i + 1)]).map((rest) => [x, ...rest]),
          )
    const permutations = perm(sources)
    expect(permutations.length).toBe(24)
    const canonical = JSON.stringify(
      mergeLayered(
        sources.map((s) => ({ source: s, value: slotValues[s] })),
        { base: BASE, strategy: "source-precedence" },
      ),
    )
    for (const p of permutations) {
      const got = mergeLayered(
        p.map((s) => ({ source: s, value: slotValues[s] })),
        { base: BASE, strategy: "source-precedence" },
      )
      expect(JSON.stringify(got)).toBe(canonical)
    }
  })

  test("HELL-PL-10 conflicting SAME-source ⇒ later wins", () => {
    const layers: Array<ConfigLayer<SandboxCfg>> = [
      { source: "per-repo", value: { label: "first" } },
      { source: "per-repo", value: { label: "second" } },
    ]
    const { merged, overrides } = mergeLayered(layers, {
      base: BASE,
      strategy: "source-precedence",
    })
    expect(merged.label).toBe("second")
    // Same source twice: winner per-repo, overrode lists the superseded per-repo entry.
    const o = overrides.find((x) => x.field === "label")
    expect(o?.winner).toBe("per-repo")
    expect(o?.overrode).toEqual(["per-repo"])
  })
})

describe("policy-layers — most-restrictive", () => {
  test("HELL-PL-11 safer boolean wins regardless of source", () => {
    // per-user (low authority) sets the SAFER values; team-admin sets unsafe.
    const layers: Array<ConfigLayer<SandboxCfg>> = [
      { source: "team-admin", value: { networkIsolated: false, workspaceWrite: true } },
      { source: "per-user", value: { networkIsolated: true, workspaceWrite: false } },
    ]
    const { merged, overrides } = mergeLayered(layers, {
      base: BASE,
      strategy: "most-restrictive",
      restrictiveness: RESTRICTIVE,
    })
    expect(merged.networkIsolated).toBe(true) // safer
    expect(merged.workspaceWrite).toBe(false) // safer
    const ni = overrides.find((x) => x.field === "networkIsolated")
    expect(ni?.winner).toBe("per-user")
    expect(ni?.overrode).toEqual(["team-admin"])
  })

  test("HELL-PL-12 safer enum wins regardless of source", () => {
    const layers: Array<ConfigLayer<SandboxCfg>> = [
      { source: "team-admin", value: { approvalMode: "auto" } }, // least safe
      { source: "default", value: { approvalMode: "always" } }, // safest
    ]
    const { merged, overrides } = mergeLayered(layers, {
      base: BASE,
      strategy: "most-restrictive",
      restrictiveness: RESTRICTIVE,
    })
    expect(merged.approvalMode).toBe("always")
    expect(overrides.find((x) => x.field === "approvalMode")?.winner).toBe("default")
  })

  test("HELL-PL-13 no ordering for field ⇒ source-precedence fallback", () => {
    // `label` has no restrictiveness entry ⇒ team-admin wins by authority.
    const layers: Array<ConfigLayer<SandboxCfg>> = [
      { source: "per-user", value: { label: "u" } },
      { source: "team-admin", value: { label: "a" } },
    ]
    const { merged } = mergeLayered(layers, {
      base: BASE,
      strategy: "most-restrictive",
      restrictiveness: RESTRICTIVE,
    })
    expect(merged.label).toBe("a")
  })

  test("HELL-PL-14 tie on safety ⇒ break by source authority", () => {
    // Both set networkIsolated=true (equal safety); team-admin must win the tie.
    const layers: Array<ConfigLayer<SandboxCfg>> = [
      { source: "per-user", value: { networkIsolated: true } },
      { source: "team-admin", value: { networkIsolated: true } },
    ]
    const { overrides } = mergeLayered(layers, {
      base: BASE,
      strategy: "most-restrictive",
      restrictiveness: RESTRICTIVE,
    })
    const o = overrides.find((x) => x.field === "networkIsolated")
    expect(o?.winner).toBe("team-admin")
    expect(o?.overrode).toEqual(["per-user"])
  })
})

describe("policy-layers — edge + invariants", () => {
  test("HELL-PL-15 explicit undefined value still counts as SET", () => {
    interface Opt {
      x?: number
    }
    // Build a value object whose `x` key is PRESENT but undefined. We assign the
    // key onto an empty object so the property is present (distinct from
    // omitting it) — exactly the "set to undefined" case the engine must honour.
    // (A literal `{ x: undefined }` is rejected under exactOptionalPropertyTypes.)
    const undefinedX: Partial<Opt> = {}
    ;(undefinedX as Record<string, unknown>).x = undefined
    const layers: Array<ConfigLayer<Opt>> = [
      { source: "default", value: { x: 5 } },
      { source: "team-admin", value: undefinedX },
    ]
    const { merged, overrides } = mergeLayered(layers, {
      base: { x: 99 },
      strategy: "source-precedence",
    })
    expect(merged.x).toBeUndefined()
    expect(overrides.find((o) => o.field === "x")?.winner).toBe("team-admin")
    expect(overrides.find((o) => o.field === "x")?.overrode).toEqual(["default"])
  })

  test("HELL-PL-16 resolvePolicyLayers == equivalent mergeLayered", () => {
    const opts = { base: BASE, strategy: "source-precedence" as const }
    const viaResolve = resolvePolicyLayers<SandboxCfg>(
      {
        default: { label: "d" },
        perUser: { label: "u", networkIsolated: true },
        teamAdmin: { approvalMode: "always" },
      },
      opts,
    )
    const viaMerge = mergeLayered<SandboxCfg>(
      [
        { source: "default", value: { label: "d" } },
        { source: "per-user", value: { label: "u", networkIsolated: true } },
        { source: "team-admin", value: { approvalMode: "always" } },
      ],
      opts,
    )
    expect(viaResolve).toEqual(viaMerge)
  })

  test("HELL-PL-17 base not mutated, merged distinct", () => {
    const base = { ...BASE }
    const { merged } = mergeLayered([{ source: "team-admin", value: { label: "x" } }], {
      base,
      strategy: "source-precedence",
    })
    expect(base.label).toBe("base")
    expect(merged).not.toBe(base)
    expect(merged.label).toBe("x")
  })

  test("HELL-PL-18 property: random permutation ⇒ deeply-equal merged", () => {
    const sources = [...LAYER_SOURCE_PRECEDENCE_ASC]
    const slotValues: Record<LayerSource, Partial<SandboxCfg>> = {
      default: { label: "d", approvalMode: "auto" },
      "per-user": { networkIsolated: true, label: "u" },
      "per-repo": { workspaceWrite: false },
      "team-admin": { approvalMode: "session", label: "a" },
    }
    const build = (order: LayerSource[]) =>
      mergeLayered(
        order.map((s) => ({ source: s, value: slotValues[s] })),
        { base: BASE, strategy: "source-precedence" },
      ).merged
    const canonical = build(sources)
    let seed = 1337
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let i = 0; i < 200; i++) {
      const shuffled = [...sources]
      for (let j = shuffled.length - 1; j > 0; j--) {
        const k = Math.floor(rand() * (j + 1))
        ;[shuffled[j], shuffled[k]] = [shuffled[k] as LayerSource, shuffled[j] as LayerSource]
      }
      expect(build(shuffled)).toEqual(canonical)
    }
  })

  test("HELL-PL-19 overrides sorted by field key", () => {
    const layers: Array<ConfigLayer<SandboxCfg>> = [
      {
        source: "team-admin",
        value: { workspaceWrite: false, approvalMode: "always", label: "z", networkIsolated: true },
      },
    ]
    const { overrides } = mergeLayered(layers, {
      base: BASE,
      strategy: "source-precedence",
    })
    const fields = overrides.map((o) => String(o.field))
    expect(fields).toEqual([...fields].sort((a, b) => a.localeCompare(b)))
    expect(fields).toEqual(["approvalMode", "label", "networkIsolated", "workspaceWrite"])
  })
})
