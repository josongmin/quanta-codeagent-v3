/**
 * Hellgate — skill-mcp-deps (ADR-0476).
 *
 * Adversarial proof of the skill→MCP dependency seam:
 *   - skill active + declared MCP ⇒ resolved-to-attach (gate ON)
 *   - gate OFF ⇒ NO resolution (byte-identical to today)
 *   - inactive skill ⇒ its deps not resolved
 *   - duplicate dep across skills ⇒ attached ONCE (dedupe by identity)
 *   - malformed dep ⇒ skipped, NOT thrown; valid siblings survive
 *   - no-deps skill ⇒ no-op
 *   - AttachMcpPort is the injected seam (port inversion); never throws.
 */

import { describe, expect, test } from "bun:test"
import { reconcileSkillMcpForTurn } from "@/agent/loop-activation-hook"
import { liftRawDependenciesBlock } from "@/skill/skill-frontmatter"
import {
  type ActiveSkillDeps,
  type AttachMcpPort,
  createSkillMcpSession,
  type DetachMcpPort,
  depIdentity,
  type McpAttachOutcome,
  type McpServerSpec,
  parseSkillMcpDeps,
  resolveMcpDeps,
  skillMcpDepsEnabled,
} from "@/skill/skill-mcp-deps"

const ON = { QUANTA_SKILL_MCP_DEPS: "1" } as const
const OFF = {} as const

const stdioTool = (value: string, command = `${value}-bin`) => ({
  type: "mcp",
  value,
  transport: "stdio",
  command,
  args: ["--x"],
})
const httpTool = (value: string, transport: "streamable_http" | "sse", url: string) => ({
  type: "mcp",
  value,
  transport,
  url,
})
const skill = (skillId: string, tools: unknown[]): ActiveSkillDeps => ({
  skillId,
  rawDependencies: { tools },
})

describe("skillMcpDepsEnabled gate", () => {
  test("only exact '1' enables", () => {
    expect(skillMcpDepsEnabled(ON)).toBe(true)
    expect(skillMcpDepsEnabled(OFF)).toBe(false)
    for (const v of ["0", "true", "on", "yes", " 1", "1 "]) {
      expect(skillMcpDepsEnabled({ QUANTA_SKILL_MCP_DEPS: v })).toBe(false)
    }
  })
})

describe("resolveMcpDeps — gate", () => {
  test("gate OFF ⇒ no resolution even with declared deps", () => {
    const skills = [skill("a", [stdioTool("svc-a")])]
    expect(resolveMcpDeps(skills, OFF)).toEqual([])
  })

  test("gate ON + declared MCP ⇒ resolved-to-attach", () => {
    const specs = resolveMcpDeps([skill("a", [stdioTool("svc-a")])], ON)
    expect(specs.length).toBe(1)
    expect(specs[0]?.serviceName).toBe("svc-a")
    expect(specs[0]?.transport).toBe("stdio")
    expect(specs[0]?.command).toBe("svc-a-bin")
    expect(specs[0]?.args).toEqual(["--x"])
  })

  test("empty active set ⇒ []", () => {
    expect(resolveMcpDeps([], ON)).toEqual([])
  })
})

describe("resolveMcpDeps — active vs inactive", () => {
  test("only ACTIVE skills' deps are resolved", () => {
    // The resolver receives only the active skills; an inactive skill is
    // simply not in the array, so its deps never appear.
    const active = [skill("active", [stdioTool("svc-active")])]
    const specs = resolveMcpDeps(active, ON)
    expect(specs.map((s) => s.serviceName)).toEqual(["svc-active"])
    // The inactive skill's server is absent.
    expect(specs.find((s) => s.serviceName === "svc-inactive")).toBeUndefined()
  })
})

describe("resolveMcpDeps — dedupe", () => {
  test("duplicate stdio dep across two skills ⇒ attached once, first wins", () => {
    const specs = resolveMcpDeps(
      [
        skill("a", [stdioTool("shared", "first-bin")]),
        skill("b", [stdioTool("shared", "second-bin")]),
      ],
      ON,
    )
    expect(specs.length).toBe(1)
    expect(specs[0]?.command).toBe("first-bin")
  })

  test("same service over different HTTP transports ⇒ two distinct attachments", () => {
    const specs = resolveMcpDeps(
      [
        skill("a", [httpTool("svc", "sse", "https://e/v1")]),
        skill("b", [httpTool("svc", "streamable_http", "https://e/v1")]),
      ],
      ON,
    )
    expect(specs.length).toBe(2)
    expect(new Set(specs.map(depIdentity)).size).toBe(2)
  })

  test("same HTTP service+url over same transport ⇒ deduped to one", () => {
    const specs = resolveMcpDeps(
      [
        skill("a", [httpTool("svc", "sse", "https://e/v1")]),
        skill("b", [httpTool("svc", "sse", "https://e/v1")]),
      ],
      ON,
    )
    expect(specs.length).toBe(1)
  })

  test("dedupe within a single skill", () => {
    const specs = resolveMcpDeps([skill("a", [stdioTool("x"), stdioTool("x")])], ON)
    expect(specs.length).toBe(1)
  })
})

describe("parseSkillMcpDeps — malformed handling (NO-THROW)", () => {
  test("malformed dep skipped, valid sibling survives", () => {
    const res = parseSkillMcpDeps({
      tools: [
        { type: "mcp", value: "good", transport: "stdio", command: "g" },
        { type: "mcp", value: "bad", transport: "stdio" }, // missing command
      ],
    })
    expect(res.deps.map((d) => d.serviceName)).toEqual(["good"])
    expect(res.errors.length).toBe(1)
    expect(res.errors[0]?.kind).toBe("malformed")
  })

  test("unknown transport ⇒ malformed, not thrown", () => {
    const res = parseSkillMcpDeps({
      tools: [{ type: "mcp", value: "x", transport: "carrier-pigeon" }],
    })
    expect(res.deps).toEqual([])
    expect(res.errors[0]?.kind).toBe("malformed")
  })

  test("HTTP transport missing url ⇒ malformed", () => {
    const res = parseSkillMcpDeps({ tools: [{ type: "mcp", value: "x", transport: "sse" }] })
    expect(res.errors[0]?.kind).toBe("malformed")
  })

  test("non-mcp tool entry ⇒ not-mcp-tool, dropped from resolve set", () => {
    const res = parseSkillMcpDeps({ tools: [{ type: "skill", value: "other" }] })
    expect(res.deps).toEqual([])
    expect(res.errors[0]?.kind).toBe("not-mcp-tool")
    // resolver drops non-mcp entirely (no attach)
    const specs = resolveMcpDeps([skill("a", [{ type: "skill", value: "other" }])], ON)
    expect(specs).toEqual([])
  })

  test("bad args (non-array / non-string element) ⇒ malformed", () => {
    expect(
      parseSkillMcpDeps({
        tools: [{ type: "mcp", value: "x", transport: "stdio", command: "c", args: "nope" }],
      }).errors[0]?.kind,
    ).toBe("malformed")
    expect(
      parseSkillMcpDeps({
        tools: [{ type: "mcp", value: "x", transport: "stdio", command: "c", args: [1, 2] }],
      }).errors[0]?.kind,
    ).toBe("malformed")
  })

  test("blank value ⇒ malformed", () => {
    expect(
      parseSkillMcpDeps({ tools: [{ type: "mcp", value: "  ", transport: "stdio", command: "c" }] })
        .errors[0]?.kind,
    ).toBe("malformed")
  })

  test("garbage top-level shapes never throw", () => {
    expect(parseSkillMcpDeps(undefined)).toEqual({ deps: [], errors: [] })
    expect(parseSkillMcpDeps(null)).toEqual({ deps: [], errors: [] })
    expect(parseSkillMcpDeps(42).errors[0]?.kind).toBe("malformed")
    expect(parseSkillMcpDeps("string").errors[0]?.kind).toBe("malformed")
    expect(parseSkillMcpDeps({ tools: 99 }).errors[0]?.kind).toBe("malformed")
    // dependencies block with no tools key is legal & empty.
    expect(parseSkillMcpDeps({ otherKind: [] })).toEqual({ deps: [], errors: [] })
  })

  test("hostile getter on raw block ⇒ caught, not thrown", () => {
    const hostile = {
      get tools(): never {
        throw new Error("boom")
      },
    }
    const res = parseSkillMcpDeps(hostile)
    expect(res.deps).toEqual([])
    expect(res.errors[0]?.kind).toBe("malformed")
  })
})

describe("resolveMcpDeps — no-deps skill is a no-op", () => {
  test("skill with no dependencies block", () => {
    expect(resolveMcpDeps([{ skillId: "a" }], ON)).toEqual([])
  })
  test("skill with dependencies but no MCP tools", () => {
    expect(resolveMcpDeps([skill("a", [{ type: "skill", value: "x" }])], ON)).toEqual([])
  })
})

describe("AttachMcpPort — injected seam (port inversion)", () => {
  test("composition calls attach on resolved specs; idempotent fake", () => {
    const attached = new Set<string>()
    const calls: McpServerSpec[][] = []
    const port: AttachMcpPort = {
      attach: async (specs) => {
        calls.push([...specs])
        const out: McpAttachOutcome[] = []
        for (const s of specs) {
          const id = depIdentity(s)
          const already = attached.has(id)
          attached.add(id)
          out.push({
            serviceName: s.serviceName,
            attached: !already,
            reason: already ? "already-attached" : undefined,
          })
        }
        return out
      },
    }

    const specs = resolveMcpDeps(
      [skill("a", [stdioTool("svc")]), skill("b", [stdioTool("svc")])],
      ON,
    )
    expect(specs.length).toBe(1) // resolver already deduped

    return (async () => {
      const first = await port.attach(specs)
      expect(first[0]?.attached).toBe(true)
      // Second activation of the same set ⇒ port reports no-op (never throws).
      const second = await port.attach(specs)
      expect(second[0]?.attached).toBe(false)
      expect(second[0]?.reason).toBe("already-attached")
      expect(calls.length).toBe(2)
    })()
  })

  test("gate OFF ⇒ resolver yields nothing ⇒ port never invoked with servers", async () => {
    let invokedWith = -1
    const port: AttachMcpPort = {
      attach: async (specs) => {
        invokedWith = specs.length
        return []
      },
    }
    const specs = resolveMcpDeps([skill("a", [stdioTool("svc")])], OFF)
    expect(specs).toEqual([])
    await port.attach(specs)
    expect(invokedWith).toBe(0)
  })
})

// --------------------------------------------------------------------------
// ADR-0476 WIRING — frontmatter lift + per-session attach coordinator + the
// loop-activation-hook glue. These prove the slice is WIRED into the live
// activation seam end-to-end, with the hard PERFORMANCE invariant asserted.
// --------------------------------------------------------------------------

describe("liftRawDependenciesBlock — SKILL.md frontmatter (ADR-0476)", () => {
  const SKILL_WITH_DEPS = `---
name: my-skill
description: does a thing
userInvocable: true
allowedTools: ["Read"]
category: skill
stability: stable
dependencies:
  tools:
    - type: mcp
      value: my-server
      transport: stdio
      command: my-mcp-binary
      args: ["--flag"]
    - type: mcp
      value: remote-svc
      transport: streamable_http
      url: "https://mcp.example.com/v1"
---
body text
`

  test("lifts dependencies.tools[] into resolver-ready raw block", () => {
    const raw = liftRawDependenciesBlock(SKILL_WITH_DEPS)
    expect(raw).not.toBeUndefined()
    // Feed straight into the validator — proves the SHAPE contract end-to-end.
    const parsed = parseSkillMcpDeps(raw)
    expect(parsed.errors).toEqual([])
    expect(parsed.deps.map((d) => d.serviceName)).toEqual(["my-server", "remote-svc"])
    const stdio = parsed.deps.find((d) => d.transport === "stdio")
    expect(stdio?.command).toBe("my-mcp-binary")
    expect(stdio?.args).toEqual(["--flag"])
    const http = parsed.deps.find((d) => d.transport === "streamable_http")
    expect(http?.url).toBe("https://mcp.example.com/v1")
  })

  test("absent dependencies block ⇒ undefined (byte-identical no-op)", () => {
    const noDeps = `---
name: x
description: y
userInvocable: false
allowedTools: []
category: skill
stability: stable
---
body
`
    expect(liftRawDependenciesBlock(noDeps)).toBeUndefined()
    // undefined flows to the resolver as a no-op skill.
    expect(resolveMcpDeps([{ skillId: "x", rawDependencies: undefined }], ON)).toEqual([])
  })

  test("malformed content never throws", () => {
    expect(() => liftRawDependenciesBlock("not frontmatter at all")).not.toThrow()
    expect(liftRawDependenciesBlock("not frontmatter at all")).toBeUndefined()
    expect(() => liftRawDependenciesBlock("---\nname: a\n")).not.toThrow() // no closing fence
  })

  test("dependencies block with no tools key ⇒ empty tools (legal)", () => {
    const onlyDepHeader = `---
name: a
description: b
userInvocable: false
allowedTools: []
category: skill
stability: stable
dependencies:
  other: 1
---
`
    expect(liftRawDependenciesBlock(onlyDepHeader)).toEqual({ tools: [] })
  })
})

/** Build an instrumented attach/detach port pair that records call shapes so
 *  the PERFORMANCE invariant can be asserted on real call counts. */
const makeInstrumentedPorts = () => {
  const attachCalls: McpServerSpec[][] = []
  const detachCalls: McpServerSpec[][] = []
  const live = new Set<string>()
  const attach: AttachMcpPort = {
    attach: async (specs) => {
      attachCalls.push([...specs])
      const out: McpAttachOutcome[] = []
      for (const s of specs) {
        const id = depIdentity(s)
        const already = live.has(id)
        live.add(id)
        out.push({ serviceName: s.serviceName, attached: !already })
      }
      return out
    },
  }
  const detach: DetachMcpPort = {
    detach: async (specs) => {
      detachCalls.push([...specs])
      for (const s of specs) live.delete(depIdentity(s))
    },
  }
  return { attach, detach, attachCalls, detachCalls, live }
}

describe("createSkillMcpSession — e2e attach/dedupe/shutdown (ADR-0476)", () => {
  test("gate ON: active skill with a dep ⇒ launcher asked to attach exactly that server", async () => {
    const p = makeInstrumentedPorts()
    const session = createSkillMcpSession({ attach: p.attach, detach: p.detach }, ON)

    const r = await session.reconcile([skill("a", [stdioTool("svc-a")])])
    expect(r.attached).toEqual([depIdentity({ serviceName: "svc-a", transport: "stdio" })])
    // launcher saw exactly one attach call carrying exactly that one server.
    expect(p.attachCalls.length).toBe(1)
    expect(p.attachCalls[0]?.map((s) => s.serviceName)).toEqual(["svc-a"])
    expect([...p.live]).toEqual([depIdentity({ serviceName: "svc-a", transport: "stdio" })])
  })

  test("SECOND skill with the SAME dep ⇒ attached ONCE across reconciles", async () => {
    const p = makeInstrumentedPorts()
    const session = createSkillMcpSession({ attach: p.attach, detach: p.detach }, ON)

    await session.reconcile([skill("a", [stdioTool("shared")])])
    // Second skill ALSO needs `shared`; both now active.
    const r2 = await session.reconcile([
      skill("a", [stdioTool("shared")]),
      skill("b", [stdioTool("shared")]),
    ])
    // Nothing NEW to attach — already live; the dedupe survived the reconcile.
    expect(r2.attached).toEqual([])
    expect(r2.detached).toEqual([])
    // Total distinct servers attached = 1, NOT once-per-skill.
    expect(session.attachedIdentities().length).toBe(1)
  })

  test("deactivation ⇒ orphaned server is detached", async () => {
    const p = makeInstrumentedPorts()
    const session = createSkillMcpSession({ attach: p.attach, detach: p.detach }, ON)

    await session.reconcile([skill("a", [stdioTool("svc-a")]), skill("b", [stdioTool("svc-b")])])
    expect(session.attachedIdentities().length).toBe(2)
    // Skill b deactivates (only a remains active).
    const r = await session.reconcile([skill("a", [stdioTool("svc-a")])])
    expect(r.detached).toEqual([depIdentity({ serviceName: "svc-b", transport: "stdio" })])
    expect(session.attachedIdentities()).toEqual([
      depIdentity({ serviceName: "svc-a", transport: "stdio" }),
    ])
    expect([...p.live]).toEqual([depIdentity({ serviceName: "svc-a", transport: "stdio" })])
  })

  test("shutdownAll ⇒ everything detached + tracking cleared", async () => {
    const p = makeInstrumentedPorts()
    const session = createSkillMcpSession({ attach: p.attach, detach: p.detach }, ON)
    await session.reconcile([skill("a", [stdioTool("svc-a")]), skill("b", [stdioTool("svc-b")])])
    await session.shutdownAll()
    expect(session.attachedIdentities()).toEqual([])
    expect(p.live.size).toBe(0)
  })

  test("gate OFF ⇒ ZERO attach calls (byte-identical no-op)", async () => {
    const p = makeInstrumentedPorts()
    const session = createSkillMcpSession({ attach: p.attach, detach: p.detach }, OFF)
    const r = await session.reconcile([
      skill("a", [stdioTool("svc-a")]),
      skill("b", [stdioTool("svc-b")]),
    ])
    expect(r.attached).toEqual([])
    expect(p.attachCalls.length).toBe(0)
    expect(session.attachedIdentities()).toEqual([])
  })

  test("NO-THROW: a throwing attach port leaves the identity untracked for retry", async () => {
    let throwOnce = true
    const attachCalls: McpServerSpec[][] = []
    const port: AttachMcpPort = {
      attach: async (specs) => {
        attachCalls.push([...specs])
        if (throwOnce) {
          throwOnce = false
          throw new Error("spawn failed")
        }
        return specs.map((s) => ({ serviceName: s.serviceName, attached: true }))
      },
    }
    const session = createSkillMcpSession({ attach: port }, ON)
    // First reconcile: port throws ⇒ swallowed, nothing tracked.
    const r1 = await session.reconcile([skill("a", [stdioTool("svc")])])
    expect(r1.attached).toEqual([depIdentity({ serviceName: "svc", transport: "stdio" })]) // intent
    expect(session.attachedIdentities()).toEqual([]) // but NOT committed
    // Second reconcile retries (still desired, still untracked).
    await session.reconcile([skill("a", [stdioTool("svc")])])
    expect(session.attachedIdentities().length).toBe(1)
    expect(attachCalls.length).toBe(2)
  })
})

describe("createSkillMcpSession — PERFORMANCE invariant (ADR-0476)", () => {
  test("attach call count == distinct servers, NOT == skills", async () => {
    const p = makeInstrumentedPorts()
    const session = createSkillMcpSession({ attach: p.attach, detach: p.detach }, ON)

    // 5 skills, but only 2 DISTINCT servers (shared + per-skill duplicate).
    const skills = [
      skill("s1", [stdioTool("alpha")]),
      skill("s2", [stdioTool("alpha")]),
      skill("s3", [stdioTool("beta")]),
      skill("s4", [stdioTool("alpha")]),
      skill("s5", [stdioTool("beta")]),
    ]
    await session.reconcile(skills)

    // HARD assertion: total servers handed to attach across ALL calls equals
    // the number of DISTINCT servers (2), never the skill count (5).
    const totalServersAttached = p.attachCalls.reduce((n, c) => n + c.length, 0)
    expect(totalServersAttached).toBe(2)
    expect(session.attachedIdentities().length).toBe(2)
  })

  test("reconcile with no NEW server ⇒ ZERO attach calls (turn not blocked by redundant launches)", async () => {
    const p = makeInstrumentedPorts()
    const session = createSkillMcpSession({ attach: p.attach, detach: p.detach }, ON)
    await session.reconcile([skill("a", [stdioTool("svc")])])
    const before = p.attachCalls.length
    // Re-activate the identical set 3 more times.
    for (let i = 0; i < 3; i++) await session.reconcile([skill("a", [stdioTool("svc")])])
    // HARD assertion: NO additional attach call — idempotent reconcile.
    expect(p.attachCalls.length).toBe(before)
    expect(before).toBe(1)
  })
})

describe("reconcileSkillMcpForTurn — loop-activation-hook glue (ADR-0476)", () => {
  test("absent session ⇒ no-op (byte-identical)", async () => {
    const r = await reconcileSkillMcpForTurn({}, [skill("a", [stdioTool("svc")])])
    expect(r).toEqual({ attached: [], detached: [] })
  })

  test("present session ⇒ delegates reconcile (gate ON, attaches)", async () => {
    const p = makeInstrumentedPorts()
    const session = createSkillMcpSession({ attach: p.attach, detach: p.detach }, ON)
    const r = await reconcileSkillMcpForTurn({ skillMcpSession: session }, [
      skill("a", [stdioTool("svc")]),
    ])
    expect(r.attached.length).toBe(1)
    expect(p.attachCalls.length).toBe(1)
  })

  test("hostile session that throws ⇒ swallowed, turn not broken", async () => {
    const hostile = {
      reconcile: async () => {
        throw new Error("boom")
      },
      shutdownAll: async () => {},
      attachedIdentities: () => [],
    }
    const r = await reconcileSkillMcpForTurn({ skillMcpSession: hostile }, [])
    expect(r).toEqual({ attached: [], detached: [] })
  })
})
