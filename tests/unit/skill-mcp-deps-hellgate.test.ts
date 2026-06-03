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
import {
  type ActiveSkillDeps,
  type AttachMcpPort,
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
