/**
 * ADR-0340 — `activatePluginsFromMentions` hellgate.
 *
 * Coverage (≥ 8):
 *   A. empty mentions                            → empty result
 *   B. 1 plugin mention                          → handler called once
 *   C. multiple plugin mentions                  → all activated
 *   D. resolved skills deduped across plugins    → first-wins
 *   E. non-plugin mentions ignored               → @skill / @@app skipped
 *   F. turnId propagation                        → handler receives turnId
 *   G. handler throws on one plugin              → others survive
 *   H. all plugins return empty skills           → aggregated.resolvedSkills = []
 *   I. duplicate plugin mention deduped          → handler called once
 *   J. handles order matches mention order       → first-mentioned first
 *   K. non-array mentions input                  → empty result, NO-THROW
 */

import { describe, expect, test } from "bun:test"
import type { ParsedMention } from "@/agent/mention-injection"
import type { McpServerHandle } from "@/agent/plugin-mcp-launcher"
import type { ActiveSkillDescriptor } from "@/agent/plugin-skill-extension"
import { activatePluginsFromMentions } from "../composite-activation"
import type { ActivationHandler, ActivationResult } from "../types"

/** Build a fake parsed mention. */
const mention = (kind: ParsedMention["kind"], target: string, start = 0): ParsedMention => ({
  kind,
  target,
  span: { start, end: start + target.length },
  raw: target,
})

/** Stub handle for testability. */
const stubHandle = (serverId: string): McpServerHandle => ({
  serverId,
  ready: true,
  shutdown: async () => undefined,
})

/** Build a handler from a name → result map. Records call count + opts. */
const makeHandler = (
  map: Record<
    string,
    { handles?: readonly McpServerHandle[]; skills?: readonly ActiveSkillDescriptor[] }
  >,
): {
  handler: ActivationHandler
  calls: { id: string; opts?: { turnId?: string } }[]
} => {
  const calls: { id: string; opts?: { turnId?: string } }[] = []
  const handler: ActivationHandler = async (id, opts) => {
    calls.push(opts === undefined ? { id } : { id, opts })
    const entry = map[id]
    const result: ActivationResult = {
      pluginId: id,
      mcpHandles: entry?.handles ?? [],
      resolvedSkills: entry?.skills ?? [],
    }
    return result
  }
  return { handler, calls }
}

describe("activatePluginsFromMentions — ADR-0340 hellgate", () => {
  test("A. empty mentions ⇒ empty aggregated result", async () => {
    const { handler, calls } = makeHandler({})
    const out = await activatePluginsFromMentions([], handler)
    expect(out).toEqual({ handles: [], resolvedSkills: [] })
    expect(calls).toEqual([])
  })

  test("B. 1 plugin mention ⇒ handler called once", async () => {
    const { handler, calls } = makeHandler({
      github: {
        handles: [stubHandle("github::fs")],
        skills: [{ name: "pr-review", description: "Review PRs" }],
      },
    })
    const out = await activatePluginsFromMentions([mention("plugin", "github")], handler)
    expect(calls).toEqual([{ id: "github" }])
    expect(out.handles).toHaveLength(1)
    expect(out.resolvedSkills).toEqual([{ name: "pr-review", description: "Review PRs" }])
  })

  test("C. multiple plugin mentions ⇒ all activated", async () => {
    const { handler, calls } = makeHandler({
      a: { handles: [stubHandle("a::s")] },
      b: { handles: [stubHandle("b::s")] },
      c: { handles: [stubHandle("c::s")] },
    })
    const out = await activatePluginsFromMentions(
      [mention("plugin", "a"), mention("plugin", "b"), mention("plugin", "c")],
      handler,
    )
    expect(calls.map((c) => c.id)).toEqual(["a", "b", "c"])
    expect(out.handles).toHaveLength(3)
  })

  test("D. skills deduped across plugins (first wins)", async () => {
    const { handler } = makeHandler({
      a: { skills: [{ name: "shared", description: "from a" }] },
      b: {
        skills: [
          { name: "shared", description: "from b" },
          { name: "unique-b", description: "from b" },
        ],
      },
    })
    const out = await activatePluginsFromMentions(
      [mention("plugin", "a"), mention("plugin", "b")],
      handler,
    )
    expect(out.resolvedSkills).toEqual([
      { name: "shared", description: "from a" }, // a came first
      { name: "unique-b", description: "from b" },
    ])
  })

  test("E. non-plugin mentions are ignored", async () => {
    const { handler, calls } = makeHandler({
      myplug: { handles: [stubHandle("myplug::s")] },
    })
    const out = await activatePluginsFromMentions(
      [mention("skill", "code-review"), mention("plugin", "myplug"), mention("app", "chrome")],
      handler,
    )
    expect(calls.map((c) => c.id)).toEqual(["myplug"])
    expect(out.handles).toHaveLength(1)
  })

  test("F. turnId propagation: handler receives turnId via opts", async () => {
    const { handler, calls } = makeHandler({
      gh: { skills: [{ name: "s1", description: "d1" }] },
    })
    await activatePluginsFromMentions([mention("plugin", "gh")], handler, { turnId: "t-99" })
    expect(calls[0]?.opts?.turnId).toBe("t-99")
  })

  test("G. one plugin handler throws ⇒ others still activated", async () => {
    const handler: ActivationHandler = async (id) => {
      if (id === "bad") throw new Error("boom")
      return {
        pluginId: id,
        mcpHandles: [stubHandle(`${id}::s`)],
        resolvedSkills: [],
      }
    }
    const out = await activatePluginsFromMentions(
      [mention("plugin", "good"), mention("plugin", "bad"), mention("plugin", "good2")],
      handler,
    )
    // good + good2 succeed; bad contributes empty arrays
    expect(out.handles.map((h) => h.serverId)).toEqual(["good::s", "good2::s"])
  })

  test("H. all plugins return empty skills ⇒ aggregated.resolvedSkills = []", async () => {
    const { handler } = makeHandler({
      a: { handles: [stubHandle("a::s")] },
      b: { handles: [stubHandle("b::s")] },
    })
    const out = await activatePluginsFromMentions(
      [mention("plugin", "a"), mention("plugin", "b")],
      handler,
    )
    expect(out.resolvedSkills).toEqual([])
    expect(out.handles).toHaveLength(2)
  })

  test("I. duplicate plugin mention deduped ⇒ handler called once", async () => {
    const { handler, calls } = makeHandler({
      gh: { handles: [stubHandle("gh::s")] },
    })
    await activatePluginsFromMentions(
      [mention("plugin", "gh"), mention("plugin", "gh"), mention("plugin", "gh")],
      handler,
    )
    expect(calls).toEqual([{ id: "gh" }])
  })

  test("J. handles order matches mention order then handler launch order", async () => {
    const { handler } = makeHandler({
      first: { handles: [stubHandle("first::a"), stubHandle("first::b")] },
      second: { handles: [stubHandle("second::a")] },
    })
    const out = await activatePluginsFromMentions(
      [mention("plugin", "first"), mention("plugin", "second")],
      handler,
    )
    expect(out.handles.map((h) => h.serverId)).toEqual(["first::a", "first::b", "second::a"])
  })

  test("K. non-array mentions input ⇒ empty result, NO-THROW", async () => {
    const { handler } = makeHandler({})
    // biome-ignore lint/suspicious/noExplicitAny: hostile-input fuzz
    const out = await activatePluginsFromMentions(undefined as any, handler)
    expect(out).toEqual({ handles: [], resolvedSkills: [] })
  })

  test("L. only @@app mentions ⇒ no handler invocation", async () => {
    const { handler, calls } = makeHandler({})
    const out = await activatePluginsFromMentions(
      [mention("app", "chrome"), mention("app", "code")],
      handler,
    )
    expect(calls).toEqual([])
    expect(out).toEqual({ handles: [], resolvedSkills: [] })
  })

  test("M. mixed types — handler call count matches plugin count", async () => {
    const { handler, calls } = makeHandler({
      gh: { handles: [stubHandle("gh::s")] },
      stripe: { handles: [stubHandle("stripe::s")] },
    })
    await activatePluginsFromMentions(
      [
        mention("skill", "a"),
        mention("plugin", "gh"),
        mention("app", "x"),
        mention("plugin", "stripe"),
        mention("skill", "b"),
      ],
      handler,
    )
    expect(calls.map((c) => c.id)).toEqual(["gh", "stripe"])
  })
})
