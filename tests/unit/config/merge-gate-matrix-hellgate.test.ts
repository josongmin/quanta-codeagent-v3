/**
 * HELLGATE — every loosening category obeys BOTH gates, checked as a matrix.
 *
 * `mergeSettings` enforces the two rules that decide what an attacker-shippable
 * repo may grant: the trust gate (an untrusted project's `project`/`local`
 * layers contribute nothing capability-granting) and managed-non-overridable
 * (when the managed layer sets a lock, no lower layer may add). Six categories
 * are loosening — benign `model`, permission `allow`, permission `ask`, hooks,
 * mcp `enabledServers`, `openaiEndpoints` — and two are tightening, permission
 * `deny` and mcp `deniedServers`, which apply even to an untrusted repo.
 *
 * The existing hellgates cover those rules one scenario at a time, and that is
 * the gap this closes. The rules had been written out six times, once per
 * category, in one 56-complexity function; the failure mode of that shape is not
 * a wrong answer in the case someone thought to test, it is ONE category quietly
 * missing ONE gate — which reads exactly like the five that do not, and which a
 * per-scenario test only catches if that scenario happened to combine the right
 * layer, the right lock and the right category.
 *
 * So this asserts the invariants over the cross-product instead: 4 layers × 5
 * layer shapes × trusted/untrusted, plus the three managed locks taken
 * independently. Nothing here pins an implementation detail — every assertion is
 * one of the documented rules, applied to every combination that can express it.
 */

import { describe, expect, test } from "bun:test"

import { mergeSettings } from "@/config/merge"
import type { SettingsLayer, SettingsLayerName } from "@/config/types"

const NAMES: readonly SettingsLayerName[] = ["managed", "user", "project", "local"]
const REPO: readonly SettingsLayerName[] = ["project", "local"]
const MACHINE: readonly SettingsLayerName[] = ["managed", "user"]

/** A layer that exercises EVERY category at once. */
const full = (tag: string): SettingsLayer =>
  ({
    benign: { model: `model-${tag}` },
    security: {
      permissions: {
        allow: [`allow-${tag}`],
        deny: [`deny-${tag}`],
        ask: [`ask-${tag}`],
      },
      hooks: {
        events: {
          PreToolUse: [{ matcher: `m-${tag}`, hooks: [{ type: "command", command: `c-${tag}` }] }],
        },
      },
      mcp: { enabledServers: [`en-${tag}`], deniedServers: [`den-${tag}`] },
      // Only `baseUrl` is set: the merge REPLACES endpoints by id and never
      // reads their fields, so a partial shape is the honest fixture here.
      openaiEndpoints: { [`ep-${tag}`]: { baseUrl: `https://${tag}` } },
    },
  }) as unknown as SettingsLayer

/** Defined but EMPTY everywhere — drops nothing material. */
const emptyish = (): SettingsLayer =>
  ({
    benign: {},
    security: {
      permissions: { allow: [], deny: [], ask: [] },
      hooks: { events: {} },
      mcp: { enabledServers: [], deniedServers: [] },
      openaiEndpoints: {},
    },
  }) as unknown as SettingsLayer

const withLock = (tag: string, lock: "perms" | "hooks" | "mcp" | "none"): SettingsLayer => {
  const base = full(tag) as {
    benign?: unknown
    security: Record<string, Record<string, unknown>>
  }
  const sec = {
    ...base.security,
    permissions: {
      ...base.security.permissions,
      ...(lock === "perms" ? { allowManagedPermissionRulesOnly: true } : {}),
    },
    hooks: {
      ...base.security.hooks,
      ...(lock === "hooks" ? { allowManagedHooksOnly: true } : {}),
    },
    mcp: { ...base.security.mcp, ...(lock === "mcp" ? { allowManagedMcpServersOnly: true } : {}) },
  }
  return { ...base, security: sec } as unknown as SettingsLayer
}

const all = (): Partial<Record<SettingsLayerName, SettingsLayer>> =>
  Object.fromEntries(NAMES.map((n) => [n, full(n)]))

/** Everything a layer contributes, flattened for containment checks. */
const granted = (r: ReturnType<typeof mergeSettings>): readonly string[] => [
  ...r.permissions.allow,
  ...r.permissions.ask,
  ...r.mcpEnabledServers,
  ...Object.keys(r.openaiEndpoints),
  ...Object.values(r.hooks).flatMap((gs) =>
    gs.map((g) => (g as { matcher?: string }).matcher ?? ""),
  ),
  ...(r.model === undefined ? [] : [r.model]),
]

describe("mergeSettings gate matrix", () => {
  test("anti-vacuity: a TRUSTED merge really does grant from every layer", () => {
    // If this ever went empty, every "must not contain" below would pass for
    // free and the whole file would be decorative.
    const g = granted(mergeSettings(all(), true))
    for (const n of NAMES) {
      for (const prefix of ["allow", "ask", "en", "ep", "m"]) {
        expect(g, `${prefix}-${n} missing from a trusted merge`).toContain(`${prefix}-${n}`)
      }
    }
    // `model` is single-valued: highest precedence wins rather than unioning,
    // so only managed's survives — asserted separately from the union categories.
    expect(g).toContain("model-managed")
  })

  test("UNTRUSTED: no repo layer contributes ANY loosening grant, in any category", () => {
    const g = granted(mergeSettings(all(), false))
    for (const n of REPO) {
      for (const prefix of ["allow", "ask", "en", "ep", "m", "model"]) {
        expect(g, `${prefix}-${n} leaked from an untrusted repo layer`).not.toContain(
          `${prefix}-${n}`,
        )
      }
      // Even if it were the only `model` in play, an untrusted repo's must not win.
      expect(mergeSettings({ [n]: full(n) }, false).model).toBeUndefined()
    }
    // …while the machine-owned layers are untouched.
    for (const n of MACHINE) {
      for (const prefix of ["allow", "ask", "en", "ep", "m"]) {
        expect(g).toContain(`${prefix}-${n}`)
      }
    }
  })

  test("UNTRUSTED: tightening still applies — deny and mcp denies survive", () => {
    const r = mergeSettings(all(), false)
    for (const n of NAMES) {
      expect(r.permissions.deny, `deny-${n} was dropped`).toContain(`deny-${n}`)
      expect(r.mcpDeniedServers, `den-${n} was dropped`).toContain(`den-${n}`)
    }
  })

  const LOCK_CASES = [
    { lock: "perms", blocked: ["allow", "ask"], stillGranted: ["en", "ep", "m"] },
    { lock: "hooks", blocked: ["m"], stillGranted: ["allow", "ask", "en", "ep"] },
    { lock: "mcp", blocked: ["en"], stillGranted: ["allow", "ask", "ep", "m"] },
  ] as const

  for (const { lock, blocked, stillGranted } of LOCK_CASES) {
    test(`the managed ${lock} lock blocks ITS category from every lower layer, and no other`, () => {
      // Trusted, so the ONLY thing that can suppress a lower layer is the lock.
      const g = granted(mergeSettings({ ...all(), managed: withLock("managed", lock) }, true))
      for (const n of ["user", "project", "local"] as const) {
        for (const p of blocked) {
          expect(g, `${lock} lock did not block ${p}-${n}`).not.toContain(`${p}-${n}`)
        }
        for (const p of stillGranted) {
          expect(g, `${lock} lock wrongly blocked ${p}-${n}`).toContain(`${p}-${n}`)
        }
      }
      // Managed's own grants always survive its own lock.
      for (const p of [...blocked, ...stillGranted]) {
        expect(g, `${lock} lock blocked managed's own ${p}`).toContain(`${p}-managed`)
      }
    })
  }

  test("a managed lock does NOT block tightening from lower layers", () => {
    for (const lock of ["perms", "mcp"] as const) {
      const r = mergeSettings({ ...all(), managed: withLock("managed", lock) }, true)
      for (const n of ["user", "project", "local"] as const) {
        expect(r.permissions.deny).toContain(`deny-${n}`)
        expect(r.mcpDeniedServers).toContain(`den-${n}`)
      }
    }
  })

  test("droppedForUntrust names exactly the repo layers that lost something real", () => {
    // Precision, both ways: an untrusted repo layer with material grants is
    // reported, and one whose collections are all defined-but-EMPTY is not —
    // an empty `allow: []` drops nothing, so flagging it would tell an operator
    // their settings were ignored when nothing was.
    expect([...mergeSettings(all(), false).droppedForUntrust].sort()).toEqual(["local", "project"])
    expect(mergeSettings(all(), true).droppedForUntrust).toEqual([])
    const emptyRepo = { ...all(), project: emptyish(), local: emptyish() }
    expect(mergeSettings(emptyRepo, false).droppedForUntrust).toEqual([])
    // A managed LOCK is not a trust drop: the grant was overridden by policy,
    // not discarded for untrust, and conflating them would misreport why.
    const locked = { ...all(), managed: withLock("managed", "perms") }
    expect(mergeSettings(locked, true).droppedForUntrust).toEqual([])
  })

  test("deny wins over allow and ask; mcp deny wins over enable", () => {
    const layer = {
      security: {
        permissions: { allow: ["x"], ask: ["x"], deny: ["x"] },
        mcp: { enabledServers: ["s"], deniedServers: ["s"] },
      },
    } as SettingsLayer
    const r = mergeSettings({ user: layer }, true)
    expect(r.permissions.allow).toEqual([])
    expect(r.permissions.ask).toEqual([])
    expect(r.permissions.deny).toEqual(["x"])
    expect(r.mcpEnabledServers).toEqual([])
    expect(r.mcpDeniedServers).toEqual(["s"])
  })

  test("higher precedence wins for the single-valued categories", () => {
    // `model` and an id-keyed endpoint are REPLACE, not union — the iteration
    // runs low→high so managed must be what survives.
    const shared = (tag: string) =>
      ({
        benign: { model: `model-${tag}` },
        security: { openaiEndpoints: { shared: { baseUrl: `https://${tag}` } } },
      }) as unknown as SettingsLayer
    const r = mergeSettings(Object.fromEntries(NAMES.map((n) => [n, shared(n)])), true)
    expect(r.model).toBe("model-managed")
    expect((r.openaiEndpoints.shared as { baseUrl: string }).baseUrl).toBe("https://managed")
  })

  test("a hostile `__proto__` key is an ordinary own-key, not a prototype reach", () => {
    // With a plain `{}` accumulator, `hooks["__proto__"] ?? []` returns the
    // PROTOTYPE OBJECT — truthy, no `.push` — so a hostile or mistyped event
    // name crashes the merge, and `hooks["__proto__"] = …` is a prototype
    // assignment. The null-prototype accumulators make it an own-key.
    //
    // The fixture is built with `Object.defineProperty` rather than an object
    // literal, twice over: `{ __proto__: x }` is prototype-assignment SYNTAX and
    // creates no own-property at all, and biome's `useLiteralKeys` rewrites the
    // computed-key workaround `{ ["__proto__"]: x }` straight back into it.
    const events: Record<string, unknown> = {}
    Object.defineProperty(events, "__proto__", {
      value: [{ matcher: "hostile", hooks: [{ type: "command", command: "x" }] }],
      enumerable: true,
      writable: true,
      configurable: true,
    })
    const endpoints: Record<string, unknown> = {}
    Object.defineProperty(endpoints, "__proto__", {
      value: { baseUrl: "https://hostile" },
      enumerable: true,
      writable: true,
      configurable: true,
    })
    expect(Object.hasOwn(events, "__proto__")).toBe(true) // the fixture is real

    const layer = {
      security: { hooks: { events }, openaiEndpoints: endpoints },
    } as unknown as SettingsLayer
    const r = mergeSettings({ user: layer }, true)
    expect(Object.hasOwn(r.hooks, "__proto__")).toBe(true)
    expect(Object.hasOwn(r.openaiEndpoints, "__proto__")).toBe(true)
    // Nothing leaked onto Object.prototype.
    expect(({} as Record<string, unknown>).baseUrl).toBeUndefined()
  })
})
