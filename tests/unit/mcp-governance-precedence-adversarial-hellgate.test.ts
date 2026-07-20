/**
 * ADVERSARIAL layer-precedence hellgate for `mcp-launch-governance` (§12.4).
 * Security INVARIANTS under attack, at the two PURE seams `resolveMcpLaunchPolicy`
 * + `readMcpConfig` compose:
 *
 *   1. `mergeSettings` (layer resolution): an UNTRUSTED repo `.mcp.json`/settings
 *      CANNOT inject an `enabledServers` ALLOW-grant, but CAN `deniedServers`
 *      (tightening always applies). MANAGED `allowManagedMcpServersOnly`
 *      lockdown overrides even a TRUSTED repo. Deny wins over enable everywhere.
 *   2. `filterMcpServersByPolicy` (launch filter): denied servers NEVER
 *      materialize; a non-empty `enabledServers` is an exclusive allowlist; an
 *      empty one filters nothing (no behavior cliff).
 *
 * NOT a duplicate of `mcp-governance-live-wire-hellgate.test.ts` — that drives
 * the file-IO e2e for a handful of cells. This is the EXHAUSTIVE precedence
 * MATRIX (managed/user/project/local × enable/deny × trust) + repo-injection
 * attempts + malformed/empty configs + concurrent resolves, directly on the
 * merge + filter cores (deterministic, no temp dirs).
 *
 * red-on-injection (documented per-block): the tightening/lockdown/deny-wins
 * rules are mutated in-tree, run RED, and reverted (git diff empty after).
 */
import { describe, expect, test } from "bun:test"
import {
  filterMcpServersByPolicy,
  type McpLaunchPolicy,
  mergeSettings,
  type SettingsLayer,
  type SettingsLayerName,
} from "@/config"

// ── helpers ────────────────────────────────────────────────────────────────

/** Build one layer with an mcp block. */
const mcpLayer = (mcp: {
  enabledServers?: string[]
  deniedServers?: string[]
  allowManagedMcpServersOnly?: boolean
}): SettingsLayer => ({ security: { mcp } })

const resolve = (
  layers: Partial<Record<SettingsLayerName, SettingsLayer>>,
  trusted: boolean,
): McpLaunchPolicy => {
  const r = mergeSettings(layers, trusted)
  return { enabledServers: r.mcpEnabledServers, deniedServers: r.mcpDeniedServers }
}

const ALL_SERVERS = [{ name: "fs" }, { name: "evil" }, { name: "web" }] as const
const kept = (policy: McpLaunchPolicy): string[] =>
  filterMcpServersByPolicy(ALL_SERVERS, policy)
    .kept.map((s) => s.name)
    .sort()

// ── 1. trust-gate on the ENABLE (loosening) grant ────────────────────────────

describe("governance — untrusted repo CANNOT inject an enabledServers allow-grant", () => {
  test("UNTRUSTED project layer enabledServers ⇒ grant DROPPED (no allowlist materializes)", () => {
    // red-on-injection: making the enable grant survive untrust (drop the
    // `dropLoosening` guard on the mcpEnabled push) turns this RED.
    const policy = resolve({ project: mcpLayer({ enabledServers: ["evil"] }) }, false)
    expect(policy.enabledServers).toEqual([])
    // No allowlist active ⇒ all configured servers still launch (no cliff).
    expect(kept(policy)).toEqual(["evil", "fs", "web"])
  })

  test("UNTRUSTED local layer enabledServers ⇒ also dropped (local is a repo layer)", () => {
    const policy = resolve({ local: mcpLayer({ enabledServers: ["evil"] }) }, false)
    expect(policy.enabledServers).toEqual([])
  })

  test("TRUSTED project layer enabledServers ⇒ grant HONORED (exclusive allowlist)", () => {
    const policy = resolve({ project: mcpLayer({ enabledServers: ["fs"] }) }, true)
    expect(policy.enabledServers).toEqual(["fs"])
    expect(kept(policy)).toEqual(["fs"]) // evil + web excluded
  })

  test("machine-owned USER layer enabledServers ⇒ honored REGARDLESS of trust", () => {
    // user layer is NOT attacker-shippable, so its grant survives untrust.
    const untrusted = resolve({ user: mcpLayer({ enabledServers: ["fs"] }) }, false)
    expect(untrusted.enabledServers).toEqual(["fs"])
    expect(kept(untrusted)).toEqual(["fs"])
  })
})

// ── 2. deny is TIGHTENING — always applies, even untrusted ────────────────────

describe("governance — deniedServers (tightening) survives untrust AND wins over enable", () => {
  test("UNTRUSTED repo deniedServers ⇒ deny SURVIVES (server never materializes)", () => {
    // red-on-injection: gating the deny push behind `!dropLoosening` (i.e.
    // treating deny as loosening) turns this RED.
    const policy = resolve({ project: mcpLayer({ deniedServers: ["evil"] }) }, false)
    expect(policy.deniedServers).toEqual(["evil"])
    expect(kept(policy)).toEqual(["fs", "web"])
    const filtered = filterMcpServersByPolicy(ALL_SERVERS, policy)
    expect(filtered.dropped).toEqual([{ name: "evil", reason: "denied" }])
  })

  test("deny WINS over enable when the SAME server is both (defense-in-depth)", () => {
    // red-on-injection: removing the `mcpEnabledFinal = ... filter(!denySet)`
    // step lets the doubly-listed server survive ⇒ RED.
    const policy = resolve(
      { user: mcpLayer({ enabledServers: ["fs", "evil"], deniedServers: ["evil"] }) },
      true,
    )
    expect(policy.enabledServers).toEqual(["fs"]) // evil scrubbed from enabled
    expect(policy.deniedServers).toEqual(["evil"])
    expect(kept(policy)).toEqual(["fs"])
  })

  test("enabled-by-USER but denied-by-a-different-layer ⇒ deny still wins (cross-layer)", () => {
    const policy = resolve(
      {
        user: mcpLayer({ enabledServers: ["fs", "web"] }),
        managed: mcpLayer({ deniedServers: ["web"] }),
      },
      true,
    )
    expect(policy.enabledServers).toEqual(["fs"])
    expect(kept(policy)).toEqual(["fs"])
  })
})

// ── 3. MANAGED lockdown overrides even a TRUSTED repo ────────────────────────

describe("governance — allowManagedMcpServersOnly lockdown overrides trusted repo", () => {
  test("managed lockdown ⇒ trusted project's enable ADDS are blocked (only managed applies)", () => {
    // red-on-injection: dropping the `!mcpBlocked` guard on the enable push
    // lets the trusted repo's adds survive the managed lockdown ⇒ RED.
    const policy = resolve(
      {
        managed: mcpLayer({ enabledServers: ["fs"], allowManagedMcpServersOnly: true }),
        project: mcpLayer({ enabledServers: ["evil", "web"] }),
      },
      true, // even trusted
    )
    expect(policy.enabledServers).toEqual(["fs"])
    expect(kept(policy)).toEqual(["fs"])
  })

  test("managed lockdown does NOT suppress a repo DENY (tightening always survives)", () => {
    // The lockdown blocks LOOSENING only; a repo can still narrow.
    const policy = resolve(
      {
        managed: mcpLayer({ enabledServers: ["fs", "web"], allowManagedMcpServersOnly: true }),
        project: mcpLayer({ deniedServers: ["web"] }),
      },
      true,
    )
    expect(policy.deniedServers).toEqual(["web"])
    expect(policy.enabledServers).toEqual(["fs"]) // web denied-out of the managed allowlist
    expect(kept(policy)).toEqual(["fs"])
  })

  test("lockdown flag on a NON-managed layer is INERT (only honored on managed)", () => {
    // A hostile repo setting allowManagedMcpServersOnly must not lock the host
    // out of its own user grants.
    const policy = resolve(
      {
        user: mcpLayer({ enabledServers: ["fs"] }),
        project: mcpLayer({ enabledServers: ["evil"], allowManagedMcpServersOnly: true }),
      },
      true,
    )
    // user grant survives; the repo's inert lockdown does not suppress it.
    expect([...policy.enabledServers].sort()).toEqual(["evil", "fs"])
  })
})

// ── 4. full precedence matrix sanity (managed > user > project > local) ───────

describe("governance — precedence union across all four layers", () => {
  test("all four layers enable distinct servers (trusted) ⇒ union of grants", () => {
    const policy = resolve(
      {
        managed: mcpLayer({ enabledServers: ["m"] }),
        user: mcpLayer({ enabledServers: ["u"] }),
        project: mcpLayer({ enabledServers: ["p"] }),
        local: mcpLayer({ enabledServers: ["l"] }),
      },
      true,
    )
    expect([...policy.enabledServers].sort()).toEqual(["l", "m", "p", "u"])
  })

  test("untrusted ⇒ only machine-owned (managed+user) grants survive the union", () => {
    const policy = resolve(
      {
        managed: mcpLayer({ enabledServers: ["m"] }),
        user: mcpLayer({ enabledServers: ["u"] }),
        project: mcpLayer({ enabledServers: ["p"] }),
        local: mcpLayer({ enabledServers: ["l"] }),
      },
      false,
    )
    expect([...policy.enabledServers].sort()).toEqual(["m", "u"])
  })
})

// ── 5. filter core — edge/boundary semantics ─────────────────────────────────

describe("governance — filterMcpServersByPolicy boundary semantics", () => {
  test("EMPTY enabledServers ⇒ allowlist INACTIVE ⇒ nothing filtered (no cliff)", () => {
    expect(kept({ enabledServers: [], deniedServers: [] })).toEqual(["evil", "fs", "web"])
  })

  test("non-empty enabledServers ⇒ exclusive: unlisted dropped as not-enabled", () => {
    const res = filterMcpServersByPolicy(ALL_SERVERS, {
      enabledServers: ["fs"],
      deniedServers: [],
    })
    expect(res.kept.map((s) => s.name)).toEqual(["fs"])
    expect(res.dropped).toEqual([
      { name: "evil", reason: "not-enabled" },
      { name: "web", reason: "not-enabled" },
    ])
  })

  test("deny takes precedence over an active allowlist (listed-and-denied ⇒ denied)", () => {
    const res = filterMcpServersByPolicy(ALL_SERVERS, {
      enabledServers: ["fs", "evil"],
      deniedServers: ["evil"],
    })
    expect(res.kept.map((s) => s.name)).toEqual(["fs"])
    expect(res.dropped).toContainEqual({ name: "evil", reason: "denied" })
  })

  test("original order + references preserved for kept servers", () => {
    const servers = [{ name: "a", tag: 1 }, { name: "b", tag: 2 }, { name: "c", tag: 3 }]
    const res = filterMcpServersByPolicy(servers, { enabledServers: [], deniedServers: ["b"] })
    expect(res.kept).toEqual([servers[0]!, servers[2]!])
    expect(res.kept[0]).toBe(servers[0]!) // same reference, not a copy
  })

  test("filter is pure — never throws on empty server list", () => {
    expect(filterMcpServersByPolicy([], { enabledServers: ["x"], deniedServers: ["y"] })).toEqual({
      kept: [],
      dropped: [],
    })
  })
})

// ── 6. malformed / empty merge inputs ────────────────────────────────────────

describe("governance — malformed / empty layer inputs degrade safely", () => {
  test("no layers at all ⇒ empty policy (no filtering)", () => {
    const policy = resolve({}, false)
    expect(policy.enabledServers).toEqual([])
    expect(policy.deniedServers).toEqual([])
    expect(kept(policy)).toEqual(["evil", "fs", "web"])
  })

  test("layer with no mcp block ⇒ contributes nothing (no crash)", () => {
    const policy = resolve({ project: { security: { permissions: { allow: ["ls"] } } } }, true)
    expect(policy.enabledServers).toEqual([])
    expect(policy.deniedServers).toEqual([])
  })

  test("empty enabledServers array from a trusted repo ⇒ no spurious allowlist", () => {
    const policy = resolve({ project: mcpLayer({ enabledServers: [] }) }, true)
    expect(policy.enabledServers).toEqual([])
    expect(kept(policy)).toEqual(["evil", "fs", "web"])
  })

  test("duplicate server ids across layers ⇒ de-duped, first-seen order", () => {
    const policy = resolve(
      {
        user: mcpLayer({ enabledServers: ["fs", "fs"] }),
        project: mcpLayer({ enabledServers: ["fs"] }),
      },
      true,
    )
    expect(policy.enabledServers).toEqual(["fs"])
  })
})

// ── 7. prototype-pollution via a hostile server NAME in the deny/enable path ──

describe("governance — hostile server names never reach into Object.prototype", () => {
  test("a server named __proto__ denied ⇒ dropped as an ordinary own-key, no crash", () => {
    const servers = [{ name: "__proto__" }, { name: "fs" }]
    const res = filterMcpServersByPolicy(servers, {
      enabledServers: [],
      deniedServers: ["__proto__"],
    })
    expect(res.kept.map((s) => s.name)).toEqual(["fs"])
    expect(res.dropped).toEqual([{ name: "__proto__", reason: "denied" }])
    // No prototype contamination from the Set membership tests.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("constructor / prototype server names are handled as plain strings", () => {
    const servers = [{ name: "constructor" }, { name: "prototype" }, { name: "ok" }]
    const res = filterMcpServersByPolicy(servers, {
      enabledServers: ["ok"],
      deniedServers: [],
    })
    expect(res.kept.map((s) => s.name)).toEqual(["ok"])
  })
})

// ── 8. concurrent resolves are independent (pure, no shared state) ────────────

describe("governance — concurrent policy resolves never cross-contaminate", () => {
  test("interleaved trusted/untrusted merges resolve independently", async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const trusted = i % 2 === 0
        return Promise.resolve(
          resolve({ project: mcpLayer({ enabledServers: ["evil"] }) }, trusted),
        )
      }),
    )
    results.forEach((policy, i) => {
      if (i % 2 === 0) {
        expect(policy.enabledServers).toEqual(["evil"]) // trusted honors
      } else {
        expect(policy.enabledServers).toEqual([]) // untrusted drops
      }
    })
  })
})
