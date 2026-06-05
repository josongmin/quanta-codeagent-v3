/**
 * e2e Hellgate — C1 artifact tools end-to-end + default-OFF registration.
 *
 *   artifact_register → artifact_list → artifact_get → artifact_destroy
 * driven through the real `Tool.execute` generators over a real
 * `createArtifactRegistry()`. Plus: the tools are registered ONLY when a
 * registry is wired (`DefaultToolPorts.artifactRegistry`) — absent ⇒
 * byte-identical default menu.
 */

import { describe, expect, test } from "bun:test"
import { createArtifactRegistry, monotonicIdFactory } from "@/artifact"
import { artifactTools, buildDefaultTools } from "@/tool"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

const ctx = (): ToolContext => ({ cwd: "/repo", signal: new AbortController().signal })

const run = async (tool: Tool, input: unknown): Promise<{ ok: boolean; output: string }> => {
  let last = { ok: false, output: "no result" }
  for await (const ev of tool.execute(input as never, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
  }
  return last
}

const reg = () =>
  createArtifactRegistry({ now: () => 1, idFactory: monotonicIdFactory("art") })

const byName = (tools: Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool not found: ${name}`)
  return t
}

describe("artifact tools — register/list/get/destroy round-trip", () => {
  test("a registered artifact surfaces in list + get with a preview URL, then destroys", async () => {
    const tools = artifactTools(reg())
    const register = byName(tools, "artifact_register")
    const list = byName(tools, "artifact_list")
    const get = byName(tools, "artifact_get")
    const destroy = byName(tools, "artifact_destroy")

    const reg1 = await run(register, {
      kind: "spreadsheet",
      path: "/jail/out/q3.xlsx",
      media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      label: "Q3 numbers",
    })
    expect(reg1.ok).toBe(true)
    expect(reg1.output).toContain("art-1")
    expect(reg1.output).toContain("quanta-artifact://art-1")

    const listed = await run(list, {})
    expect(listed.ok).toBe(true)
    expect(listed.output).toContain("art-1")
    expect(listed.output).toContain("Q3 numbers")
    expect(listed.output).toContain("quanta-artifact://art-1")

    const got = await run(get, { id: "art-1" })
    expect(got.ok).toBe(true)
    expect(got.output).toContain("/jail/out/q3.xlsx")

    const gone = await run(get, { id: "missing" })
    expect(gone.ok).toBe(false)
    expect(gone.output.toLowerCase()).toContain("unknown artifact")

    const del = await run(destroy, { id: "art-1" })
    expect(del.ok).toBe(true)
    const delAgain = await run(destroy, { id: "art-1" })
    expect(delAgain.ok).toBe(false)

    const empty = await run(list, {})
    expect(empty.output).toContain("No artifacts")
  })

  test("list kind filter", async () => {
    const tools = artifactTools(reg())
    const register = byName(tools, "artifact_register")
    const list = byName(tools, "artifact_list")
    await run(register, { kind: "image", path: "/a.png", media_type: "image/png" })
    await run(register, { kind: "document", path: "/b.docx", media_type: "application/x" })
    const onlyImages = await run(list, { kind: "image" })
    expect(onlyImages.output).toContain("/a.png")
    expect(onlyImages.output).not.toContain("/b.docx")
  })

  test("bad input ⇒ typed ok:false (no throw)", async () => {
    const tools = artifactTools(reg())
    const get = byName(tools, "artifact_get")
    const r = await run(get, {})
    expect(r.ok).toBe(false)
  })
})

describe("artifact tools — default-OFF registration", () => {
  test("absent registry ⇒ artifact_* NOT in the default menu (byte-identical)", () => {
    const off = buildDefaultTools().map((t) => t.name)
    expect(off).not.toContain("artifact_register")
    expect(off).not.toContain("artifact_list")
    expect(off).not.toContain("artifact_get")
    expect(off).not.toContain("artifact_destroy")
  })

  test("wired registry ⇒ all four artifact tools registered", () => {
    const on = buildDefaultTools({ artifactRegistry: reg() }).map((t) => t.name)
    expect(on).toContain("artifact_register")
    expect(on).toContain("artifact_list")
    expect(on).toContain("artifact_get")
    expect(on).toContain("artifact_destroy")
  })
})
