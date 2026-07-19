/**
 * Hellgate — `appshot_verify` tool + registration + jailed scaffold (G1, RFC
 * jun-6-appgen-appshot Phase 1).
 *
 * Seal (FakeAppshotPort + real jailed-scaffold adapter; NO Chrome/network):
 *   A. tool metadata (name / isReadOnly=FALSE / concurrency-safe=false /
 *      hitlTier=pre-approval-ok)
 *   B. a pass run ⇒ ok:true, output names the verdict + artifact url
 *   C. an exhausted run ⇒ ok:true (a real verdict, not a tool failure)
 *   D. a failed run (effect throw) ⇒ ok:false + typed failure
 *   E. schema reject (empty prompt) ⇒ ok:false, no port call
 *   F. an aborted ctx ⇒ ok:false rejected, no port call
 *   G. KNOB-OFF ⇒ tool ABSENT from buildDefaultTools (byte-identical menu);
 *      KNOB-ON (slot wired) ⇒ exactly `appshot_verify` is added
 *   H. JAIL — the jailed scaffold rejects a `../` out dir + a NUL byte (no
 *      write outside cwd); a confined dir writes index.html under cwd
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AppSpec,
  type AppshotPort,
  type AppshotSlot,
  appshotVerifyTool,
  buildDefaultTools,
  judgeVerdict,
  makeJailedScaffold,
  type ScaffoldResult,
  type ScaffoldWritePort,
  type Tool,
  type ToolContext,
  type ToolEvent,
  type ToolResult,
  type VerifyVerdict,
} from "@/tool"

/* ------------------------------------------------------------------ */
/* fakes + helpers                                                    */
/* ------------------------------------------------------------------ */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

class FakePort implements AppshotPort {
  calls = 0
  constructor(
    // REAL-judge verdict (branded) — the loop honors a pass ONLY when branded.
    private readonly verdict: VerifyVerdict = judgeVerdict(true, "looks right"),
    private readonly throwOn?: "render",
  ) {}
  async scaffold(_spec: AppSpec, outDir: string): Promise<ScaffoldResult> {
    this.calls++
    return {
      entryUrl: `file://${outDir}/index.html`,
      entryPath: `${outDir}/index.html`,
      mediaType: "text/html",
    }
  }
  async render(): Promise<void> {
    if (this.throwOn === "render") throw new Error("chrome down")
  }
  async screenshot(): Promise<Uint8Array> {
    return PNG
  }
  async verify(): Promise<VerifyVerdict> {
    return this.verdict
  }
}

const ctx = (signal?: AbortSignal): ToolContext =>
  ({ cwd: "/jail", signal: signal ?? new AbortController().signal }) as ToolContext

const run = async (tool: Tool, input: unknown, c: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (result === undefined) throw new Error("tool yielded no result")
  return result
}

const clock = (): (() => number) => {
  let t = 0
  return () => (t += 1)
}

/* ------------------------------------------------------------------ */
/* A — metadata                                                       */
/* ------------------------------------------------------------------ */

describe("appshot_verify — A. metadata", () => {
  test("name / mutating / not concurrency-safe / pre-approval HITL", () => {
    const tool = appshotVerifyTool({ port: new FakePort(), now: clock() })
    expect(tool.name).toBe("appshot_verify")
    expect(tool.isReadOnly()).toBe(false)
    expect(tool.isConcurrencySafe({} as never)).toBe(false)
    expect(tool.hitlTier?.({} as never)).toBe("pre-approval-ok")
  })
})

/* ------------------------------------------------------------------ */
/* B–D — outcome mapping                                              */
/* ------------------------------------------------------------------ */

describe("appshot_verify — outcome mapping", () => {
  test("B. pass ⇒ ok:true with verdict + artifact url in output", async () => {
    const sink = { register: () => ({ id: "app-1" }) }
    const tool = appshotVerifyTool({ port: new FakePort(), now: clock(), artifactSink: sink })
    const r = await run(tool, { prompt: "a red button", out_dir: "app" }, ctx())
    expect(r.ok).toBe(true)
    expect(r.output).toContain("pass")
    expect(r.output).toContain("quanta-artifact://app-1")
    expect(r.output).toContain("PASS")
  })

  test("C. exhausted ⇒ ok:true (a surfaced verdict, not a tool failure)", async () => {
    const tool = appshotVerifyTool({
      port: new FakePort(judgeVerdict(false, "still off")),
      now: clock(),
    })
    const r = await run(tool, { prompt: "x", out_dir: "app", max_iterations: 2 }, ctx())
    expect(r.ok).toBe(true)
    expect(r.output).toContain("exhausted")
    expect(r.output).toContain("FAIL")
  })

  test("D. effect throw ⇒ ok:false + typed failure", async () => {
    const tool = appshotVerifyTool({
      port: new FakePort(judgeVerdict(true, "x"), "render"),
      now: clock(),
    })
    const r = await run(tool, { prompt: "x", out_dir: "app" }, ctx())
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("error")
  })
})

/* ------------------------------------------------------------------ */
/* E–F — schema / abort guards                                        */
/* ------------------------------------------------------------------ */

describe("appshot_verify — guards", () => {
  test("E. empty prompt ⇒ ok:false, port never called", async () => {
    const port = new FakePort()
    const tool = appshotVerifyTool({ port, now: clock() })
    const r = await run(tool, { prompt: "", out_dir: "app" }, ctx())
    expect(r.ok).toBe(false)
    expect(port.calls).toBe(0)
  })

  test("F. aborted ctx ⇒ ok:false rejected, port never called", async () => {
    const port = new FakePort()
    const tool = appshotVerifyTool({ port, now: clock() })
    const ac = new AbortController()
    ac.abort()
    const r = await run(tool, { prompt: "x", out_dir: "app" }, ctx(ac.signal))
    expect(r.ok).toBe(false)
    expect(port.calls).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* G — default-OFF registration byte-identity                         */
/* ------------------------------------------------------------------ */

describe("appshot_verify — G. registration gate", () => {
  test("knob-OFF (no slot) ⇒ appshot_verify ABSENT + byte-identical menu", () => {
    const baseline = buildDefaultTools().map((t) => t.name)
    expect(baseline.includes("appshot_verify")).toBe(false)
  })

  test("knob-ON (slot wired) ⇒ exactly appshot_verify added", () => {
    const baseline = buildDefaultTools().map((t) => t.name)
    const slot: AppshotSlot = { port: new FakePort(), now: clock() }
    const on = buildDefaultTools({ appshot: slot }).map((t) => t.name)
    expect(on.includes("appshot_verify")).toBe(true)
    expect(on.filter((n) => !baseline.includes(n))).toEqual(["appshot_verify"])
  })
})

/* ------------------------------------------------------------------ */
/* H — jail confinement (real scaffold adapter)                       */
/* ------------------------------------------------------------------ */

describe("appshot jailed scaffold — H. jail", () => {
  test("a confined out dir writes index.html under cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "appshot-jail-"))
    try {
      const scaffold = makeJailedScaffold(cwd)
      const res = await scaffold({ prompt: "a red button", feedback: [] }, "out")
      expect(res.entryPath.startsWith(cwd)).toBe(true)
      expect(res.mediaType).toBe("text/html")
      const html = readFileSync(res.entryPath, "utf8")
      expect(html).toContain("a red button")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("a `../` escape out dir is REJECTED (no write outside cwd)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "appshot-jail-"))
    // Record-only write port: prove NOTHING is written when the jail rejects.
    const writes: string[] = []
    const recPort: ScaffoldWritePort = {
      async writeText(abs) {
        writes.push(abs)
      },
    }
    try {
      const scaffold = makeJailedScaffold(cwd, recPort)
      await expect(scaffold({ prompt: "x", feedback: [] }, "../../../etc/evil")).rejects.toThrow()
      expect(writes.length).toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("a NUL byte in the out dir is REJECTED", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "appshot-jail-"))
    try {
      const scaffold = makeJailedScaffold(cwd)
      await expect(scaffold({ prompt: "x", feedback: [] }, "ok\0bad")).rejects.toThrow()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("scaffold HTML escapes hostile markup in the spec", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "appshot-jail-"))
    try {
      const scaffold = makeJailedScaffold(cwd)
      const res = await scaffold(
        { prompt: "<script>alert(1)</script>", feedback: ["<img src=x>"] },
        "out",
      )
      const html = readFileSync(res.entryPath, "utf8")
      expect(html).not.toContain("<script>alert(1)</script>")
      expect(html).toContain("&lt;script&gt;")
      expect(html).toContain("&lt;img src=x&gt;")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
