// §7.3 long-tail — ci_finding structured CI-investigation record tool.
//
// Store determinism (injected clock + id-factory) + the tool's record/list/get
// ops + DEFAULT-OFF byte-identity over ghTools. The e2e hellgate (real registry
// dispatch) lives in tests/integration/longtail-new-tools-e2e.test.ts.

import { describe, expect, test } from "bun:test"
import { ciFindingTool, createCiFindingStore } from "@/tool/ci-finding"
import { ghTools } from "@/tool/gh"
import type { ToolContext, ToolEvent } from "@/tool/types"

const ctx = (): ToolContext =>
  ({ cwd: "/repo", signal: new AbortController().signal }) as unknown as ToolContext

const runTool = async (
  tool: ReturnType<typeof ciFindingTool>,
  input: Parameters<typeof tool.execute>[0],
): Promise<{ ok: boolean; output: string }> => {
  let last: { ok: boolean; output: string } = { ok: false, output: "(no result)" }
  for await (const ev of tool.execute(input, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = ev.result
  }
  return last
}

describe("ci_finding — store (deterministic)", () => {
  test("record mints monotonic id/seq with the injected clock", () => {
    let t = 1000
    const store = createCiFindingStore({ now: () => t, idFactory: (s) => `F${s}` })
    const a = store.record({
      job: "test",
      category: "test-failure",
      summary: "x failed",
      rootCause: "y",
      confidence: "high",
    })
    t = 2000
    const b = store.record({
      job: "lint",
      category: "lint",
      summary: "z",
      rootCause: "w",
      confidence: "low",
    })
    expect(a).toMatchObject({ id: "F0", seq: 0, recordedAt: 1000 })
    expect(b).toMatchObject({ id: "F1", seq: 1, recordedAt: 2000 })
    expect(store.size()).toBe(2)
  })

  test("list filters by job/category; get fetches by id", () => {
    const store = createCiFindingStore({ now: () => 0, idFactory: (s) => `F${s}` })
    store.record({ job: "a", category: "lint", summary: "1", rootCause: "r", confidence: "low" })
    store.record({ job: "b", category: "flaky", summary: "2", rootCause: "r", confidence: "low" })
    expect(store.list({ job: "a" }).map((f) => f.id)).toEqual(["F0"])
    expect(store.list({ category: "flaky" }).map((f) => f.id)).toEqual(["F1"])
    expect(store.get("F1")?.job).toBe("b")
    expect(store.get("nope")).toBeUndefined()
  })

  test("oldest-evicted ring bounds retention", () => {
    const store = createCiFindingStore({ now: () => 0, idFactory: (s) => `F${s}`, maxFindings: 2 })
    store.record({ job: "1", category: "other", summary: "1", rootCause: "r", confidence: "low" })
    store.record({ job: "2", category: "other", summary: "2", rootCause: "r", confidence: "low" })
    store.record({ job: "3", category: "other", summary: "3", rootCause: "r", confidence: "low" })
    expect(store.size()).toBe(2)
    expect(store.get("F0")).toBeUndefined() // evicted
    expect(store.list().map((f) => f.id)).toEqual(["F1", "F2"])
  })
})

describe("ci_finding — tool ops", () => {
  test("op:record requires job/category/summary/root_cause", async () => {
    const tool = ciFindingTool(createCiFindingStore())
    const r = await runTool(tool, { op: "record", job: "test" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("record requires")
    expect(r.output).toContain("category")
  })

  test("op:record stores then op:list / op:get retrieve", async () => {
    const store = createCiFindingStore({ now: () => 0, idFactory: (s) => `F${s}` })
    const tool = ciFindingTool(store)
    const rec = await runTool(tool, {
      op: "record",
      job: "test (ubuntu)",
      category: "test-failure",
      summary: "foo.test.ts failed",
      root_cause: "off-by-one in loop bound",
      evidence: "foo.test.ts:42",
      suggested_fix: "use <= not <",
      confidence: "high",
    })
    expect(rec.ok).toBe(true)
    expect(rec.output).toContain("[F0]")
    expect(rec.output).toContain("root-cause: off-by-one")

    const list = await runTool(tool, { op: "list" })
    expect(list.output).toContain("test (ubuntu)")

    const got = await runTool(tool, { op: "get", id: "F0" })
    expect(got.ok).toBe(true)
    expect(got.output).toContain("fix: use <= not <")

    const missing = await runTool(tool, { op: "get", id: "F99" })
    expect(missing.ok).toBe(false)
    expect(missing.output).toContain("no finding with id")
  })

  test("op:list on empty store renders a friendly empty marker", async () => {
    const r = await runTool(ciFindingTool(createCiFindingStore()), { op: "list" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("no CI findings recorded")
  })

  test("a throwing store collapses to ok:false (NO-THROW boundary)", async () => {
    const boom = {
      record() {
        throw new Error("boom")
      },
      list: () => [],
      get: () => undefined,
      size: () => 0,
    }
    const r = await runTool(ciFindingTool(boom), {
      op: "record",
      job: "j",
      category: "other",
      summary: "s",
      root_cause: "r",
    })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("ci_finding failed")
  })

  test("tool self-reports read-only + hitlTier none", () => {
    const tool = ciFindingTool(createCiFindingStore())
    expect(tool.isReadOnly()).toBe(true)
    expect(tool.hitlTier?.({ op: "list" })).toBe("none")
    expect(tool.name).toBe("ci_finding")
  })
})

describe("ci_finding — DEFAULT-OFF byte-identity", () => {
  const names = (opts?: Parameters<typeof ghTools>[1]) =>
    ghTools(undefined, opts).map((t) => t.name)

  test("ghTools() (no opts) does NOT include ci_finding", () => {
    expect(names()).not.toContain("ci_finding")
  })

  test("ghTools(undefined, {}) byte-identical to ghTools()", () => {
    expect(names({})).toEqual(names())
  })

  test("ghTools(runner, {ciFindingStore}) appends ci_finding", () => {
    expect(names({ ciFindingStore: createCiFindingStore() })).toContain("ci_finding")
  })
})
