/**
 * The web LLM-config commands must not report a change the running session cannot see.
 *
 * Two defects, both the CLI's `/knobs set` shape on a surface the CLI fix never
 * reached.
 *
 * 1. `/retry-with <slug>` did `postConfig({ QUANTA_MODEL: slug })` and then resent —
 *    the EXACT write the comment on the `/model` entry, seventy lines above it in the
 *    same file, says "changes nothing: the daemon builds its port ONCE at boot … it
 *    never reads QUANTA_MODEL". `/model` was migrated to the `set_model` control
 *    frame in aug-28; this entry was left behind, so the resend went out under the
 *    OLD model while the toast said "model override + resend".
 *
 * 2. Every `/config` write printed `applied: <keys>` in green. Those values are
 *    resolved once at the composition root and threaded into the LLM adapter as
 *    constructor config; the adapter's own contract says it "never reads process.env".
 *    The claim came from a docstring in `web-daemon/server/http.ts` asserting the
 *    opposite of the adapter — two docstrings in one repo, contradicting.
 *
 * These drive the REAL builder with a recording endpoint. A source-level grep would
 * pass on a file that no longer wires the action at all.
 */
import { describe, expect, it, vi } from "vitest"
import { buildLlmConfigSlashCommands, type LlmConfigEndpoint } from "./slash-llm-config"

interface Recorded {
  readonly posts: Record<string, unknown>[]
  readonly controls: { kind: string; [k: string]: unknown }[]
  readonly resends: string[]
  readonly results: { msg: string; kind: "ok" | "err" }[]
}

const endpoint = (
  over: Partial<LlmConfigEndpoint> = {},
): { ep: LlmConfigEndpoint; rec: Recorded } => {
  const rec: Recorded = { posts: [], controls: [], resends: [], results: [] }
  const ep: LlmConfigEndpoint = {
    httpUrl: "http://127.0.0.1:4096",
    onResult: (msg, kind) => rec.results.push({ msg, kind }),
    getMessages: () => [{ role: "user", text: "the original question" }] as never,
    resend: (text) => rec.resends.push(text),
    sendControlRequest: (request) => {
      rec.controls.push(request)
      return true
    },
    showReadout: async () => {},
    // The real readout's first line is `model  <id>` (`renderWebModelReadout`), and
    // `awaitModelApplied` matches `^model\s+<slug>\s*$`. A fixture with a colon does
    // not match — my first version used one and the confirmed-resend arm failed.
    readReadout: async () => "model  gpt-5.6-terra\n",
    delay: async () => {},
    ...over,
  }
  return { ep, rec }
}

const cmd = (ep: LlmConfigEndpoint, slug: string) => {
  const found = buildLlmConfigSlashCommands(ep).find((c) => c.slug === slug)
  if (found === undefined) throw new Error(`no /${slug} in the builder`)
  return found
}

describe("/retry-with goes through the live door, not the inert env write", () => {
  it("sends set_model and never POSTs QUANTA_MODEL", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchSpy)
    try {
      const { ep, rec } = endpoint({ readReadout: async () => "model  gpt-5.6-terra\n" })
      await cmd(ep, "retry-with").action?.("gpt-5.6-terra")
      expect(rec.controls, "the switch must go through the control frame").toEqual([
        { kind: "set_model", model: "gpt-5.6-terra" },
      ])
      // The inert path: no HTTP write of QUANTA_MODEL at all.
      const bodies = fetchSpy.mock.calls.map((c) => String((c[1] as RequestInit | undefined)?.body))
      expect(bodies.some((b) => b.includes("QUANTA_MODEL"))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("resends ONLY after the switch is confirmed", async () => {
    const { ep, rec } = endpoint({ readReadout: async () => "model  gpt-5.6-terra\n" })
    await cmd(ep, "retry-with").action?.("gpt-5.6-terra")
    expect(rec.resends).toEqual(["the original question"])
  })

  it("does NOT resend when the model never becomes effective", async () => {
    const { ep, rec } = endpoint({ readReadout: async () => "model  some-other-model\n" })
    await cmd(ep, "retry-with").action?.("gpt-5.6-terra")
    expect(rec.resends, "resending under the old model is the defect").toEqual([])
    expect(rec.results.at(-1)?.kind).toBe("err")
  })

  it("refuses when there is no live socket instead of writing env", async () => {
    const { ep, rec } = endpoint({ sendControlRequest: undefined })
    await cmd(ep, "retry-with").action?.("gpt-5.6-terra")
    expect(rec.resends).toEqual([])
    expect(rec.results.at(-1)?.msg).toContain("no live session socket")
  })
})

describe("/config writes do not claim to have taken effect", () => {
  it("names the restart requirement instead of saying `applied`", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchSpy)
    try {
      const { ep, rec } = endpoint()
      await cmd(ep, "fast").action?.("")
      const last = rec.results.at(-1)
      expect(last?.kind).toBe("ok")
      expect(last?.msg, "a bare `applied:` claims the running session saw it").not.toMatch(
        /^applied:/,
      )
      expect(last?.msg).toContain("NEXT daemon start")
      expect(last?.msg).toContain("restart")
      // The keys are still reported, so the operator knows what was stored.
      expect(last?.msg).toContain("QUANTA_FAST=1")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("the same wording covers every /config-backed command", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchSpy)
    try {
      for (const slug of ["fast", "standard", "flex"]) {
        const { ep, rec } = endpoint()
        await cmd(ep, slug).action?.("")
        expect(rec.results.at(-1)?.msg, `/${slug}`).toContain("NEXT daemon start")
      }
      const { ep, rec } = endpoint()
      await cmd(ep, "effort").action?.("high")
      expect(rec.results.at(-1)?.msg, "/effort").toContain("NEXT daemon start")
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
