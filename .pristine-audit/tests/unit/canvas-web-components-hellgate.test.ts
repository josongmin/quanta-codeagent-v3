/**
 * ADR-0440 — Canvas web components (daemon side) — hellgate.
 *
 * Pins the daemon-side half of the canvas slice WITHOUT booting a real
 * Bun.serve:
 *
 *   - protocol codec (`encodeCanvasFrame` / `decodeCanvasFrame`) round-trips +
 *     rejects malformed frames (NO-THROW).
 *   - `createCanvasEmitter` converts a before/after pair into a `tool.diff`
 *     frame using the CLI diff math ONCE (`diffOps`) — lossless ops→lines,
 *     binary placeholder, line-cap truncation, gutter numbering — and a
 *     `SegmentedUsageView` into a verbatim `context.usage` frame.
 *   - `diffOpsToLines` is lossless against the CLI `diffOps` output.
 *   - `attachCanvasSink(ws, ports)`: gate OFF (undefined ports) ⇒ no sink,
 *     ws.send never carries a canvas frame (byte-identical); gate ON ⇒
 *     snapshot-on-connect from `usageSource.latest()` + a frame per subsequent
 *     `subscribe` push; `detach()` freezes the send-count + unsubscribes;
 *     a throwing ws.send is swallowed (NO-THROW).
 */

import { describe, expect, test } from "bun:test"
import {
  createCanvasEmitter,
  diffOpStats,
  diffOpsToLines,
} from "@/../src/apps/web-daemon/canvas-emitter"
import { attachCanvasSink, type CanvasUsageSource } from "@/../src/apps/web-daemon/server"
import type { ContextUsageBreakdown } from "@/agent/context/usage-breakdown"
import {
  type CanvasMessage,
  decodeCanvasFrame,
  encodeCanvasFrame,
  isCanvasMessage,
} from "@/protocol/canvas"
import { diffOps } from "@/runner/diff-ops"

/** FAKE ServerWebSocket recording every `.send()` payload. */
class FakeWs {
  readonly sent: string[] = []
  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data))
  }
}

const decodedKinds = (ws: FakeWs): string[] =>
  ws.sent.map((f) => decodeCanvasFrame(f)?.kind ?? "<undecodable>")

const view = (overrides: Partial<ContextUsageBreakdown> = {}): ContextUsageBreakdown => ({
  segments: [
    { id: "System", tokens: 40_000, chars: 160_000, color: "cyan" },
    { id: "Conversation", tokens: 16_800, chars: 67_200, color: "white" },
  ],
  total: 56_800,
  max: 120_000,
  model: "gpt-5",
  ...overrides,
})

/** Tiny pushable usage source. */
const makeUsageSource = (initial?: ContextUsageBreakdown) => {
  let latest = initial
  const subs = new Set<(v: ContextUsageBreakdown) => void>()
  const source: CanvasUsageSource = {
    subscribe(h) {
      subs.add(h)
      return () => subs.delete(h)
    },
    latest: () => latest,
  }
  return {
    source,
    push: (v: ContextUsageBreakdown) => {
      latest = v
      for (const s of subs) s(v)
    },
  }
}

describe("ADR-0440 canvas protocol codec", () => {
  test("tool.diff round-trips", () => {
    const msg: CanvasMessage = {
      kind: "tool.diff",
      toolCallId: "t1",
      path: "a.ts",
      lines: [{ type: "added", content: "x", lineNumber: 1 }],
      additions: 1,
      deletions: 0,
      emittedAt: 5,
    }
    const back = decodeCanvasFrame(encodeCanvasFrame(msg))
    expect(back).toEqual(msg)
    expect(isCanvasMessage(msg)).toBe(true)
  })

  test("context.usage round-trips", () => {
    const msg: CanvasMessage = {
      kind: "context.usage",
      segments: [{ id: "System", tokens: 10 }],
      total: 10,
      max: 100,
      model: "gpt-5",
      emittedAt: 7,
    }
    expect(decodeCanvasFrame(encodeCanvasFrame(msg))).toEqual(msg)
  })

  test("malformed frames decode to null (NO-THROW)", () => {
    expect(decodeCanvasFrame("not json")).toBeNull()
    expect(decodeCanvasFrame(JSON.stringify({ kind: "wrong" }))).toBeNull()
    expect(decodeCanvasFrame(JSON.stringify({ version: "x", kind: "canvas" }))).toBeNull()
    expect(decodeCanvasFrame(42 as unknown as string)).toBeNull()
  })
})

describe("ADR-0440 diff adapter (lossless, daemon-side)", () => {
  test("diffOpsToLines is lossless against the CLI diffOps content + kind", () => {
    const before = "a\nb\nc"
    const after = "a\nB\nc\nd"
    const ops = diffOps(before, after)
    const lines = diffOpsToLines(ops)
    // every line's content + type mirrors the originating op (no diff re-run)
    expect(lines.length).toBe(ops.length)
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]
      const line = lines[i]
      if (op === undefined || line === undefined) throw new Error("index mismatch")
      expect(line.content).toBe(op.line)
      const expectType = op.kind === "add" ? "added" : op.kind === "del" ? "removed" : "unchanged"
      expect(line.type).toBe(expectType)
    }
  })

  test("gutter numbering: added/unchanged use new-side, removed uses old-side", () => {
    const ops = diffOps("a\nb", "a\nc")
    const lines = diffOpsToLines(ops)
    // a = unchanged (1), b = removed (old 2), c = added (new 2)
    const keep = lines.find((l) => l.content === "a")
    const removed = lines.find((l) => l.content === "b")
    const added = lines.find((l) => l.content === "c")
    expect(keep?.lineNumber).toBe(1)
    expect(removed?.lineNumber).toBe(2)
    expect(added?.lineNumber).toBe(2)
  })

  test("diffOpStats counts match a tally of the SAME ops", () => {
    const ops = diffOps("a\nb\nc", "a\nB\nc\nd")
    const { additions, deletions } = diffOpStats(ops)
    expect(additions).toBe(ops.filter((o) => o.kind === "add").length)
    expect(deletions).toBe(ops.filter((o) => o.kind === "del").length)
  })
})

describe("ADR-0440 canvas emitter", () => {
  test("feedToolDiff emits a converted tool.diff frame", () => {
    const ws = new FakeWs()
    const e = createCanvasEmitter({ ws, now: () => 1 })
    e.feedToolDiff({ toolCallId: "t1", before: "a\nb", after: "a\nc", path: "f.ts" })
    expect(ws.sent.length).toBe(1)
    const msg = decodeCanvasFrame(ws.sent[0] ?? "")
    if (msg?.kind !== "tool.diff") throw new Error("expected tool.diff")
    expect(msg.path).toBe("f.ts")
    expect(msg.additions).toBe(1)
    expect(msg.deletions).toBe(1)
    expect(msg.lines.some((l) => l.type === "added" && l.content === "c")).toBe(true)
  })

  test("binary content ⇒ binary placeholder frame (no lines)", () => {
    const ws = new FakeWs()
    const e = createCanvasEmitter({ ws, now: () => 1 })
    e.feedToolDiff({ toolCallId: "t1", before: "", after: `bin${String.fromCharCode(0)}x` })
    const msg = decodeCanvasFrame(ws.sent[0] ?? "")
    if (msg?.kind !== "tool.diff") throw new Error("expected tool.diff")
    expect(msg.binary).toBe(true)
    expect(msg.lines.length).toBe(0)
  })

  test("over-cap line count ⇒ truncated + moreLines", () => {
    const ws = new FakeWs()
    const e = createCanvasEmitter({ ws, now: () => 1, maxLines: 3 })
    const after = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
    e.feedToolDiff({ toolCallId: "t1", before: "", after })
    const msg = decodeCanvasFrame(ws.sent[0] ?? "")
    if (msg?.kind !== "tool.diff") throw new Error("expected tool.diff")
    expect(msg.truncated).toBe(true)
    expect(msg.lines.length).toBe(3)
    expect(msg.moreLines).toBe(7)
  })

  test("feedUsage serializes the view verbatim (no recompute)", () => {
    const ws = new FakeWs()
    const e = createCanvasEmitter({ ws, now: () => 1 })
    e.feedUsage(view())
    const msg = decodeCanvasFrame(ws.sent[0] ?? "")
    if (msg?.kind !== "context.usage") throw new Error("expected context.usage")
    expect(msg.segments).toEqual([
      { id: "System", tokens: 40_000 },
      { id: "Conversation", tokens: 16_800 },
    ])
    expect(msg.total).toBe(56_800)
    expect(msg.max).toBe(120_000)
    expect(msg.model).toBe("gpt-5")
  })

  test("gate OFF (no sink) ⇒ emitter is a no-op", () => {
    const e = createCanvasEmitter()
    expect(() => {
      e.feedUsage(view())
      e.feedToolDiff({ toolCallId: "t", before: "a", after: "b" })
    }).not.toThrow()
  })

  test("stop() freezes all subsequent feeds", () => {
    const ws = new FakeWs()
    const e = createCanvasEmitter({ ws, now: () => 1 })
    e.feedUsage(view())
    e.stop()
    e.feedUsage(view())
    e.feedToolDiff({ toolCallId: "t", before: "a", after: "b" })
    expect(ws.sent.length).toBe(1)
  })

  test("throwing ws.send is swallowed (NO-THROW)", () => {
    const hostile = {
      send: () => {
        throw new Error("dead socket")
      },
    }
    const e = createCanvasEmitter({ ws: hostile })
    expect(() => e.feedUsage(view())).not.toThrow()
  })
})

describe("ADR-0440 attachCanvasSink (per-connection)", () => {
  test("gate OFF ⇒ no sink, ws never carries a canvas frame", () => {
    const ws = new FakeWs()
    const handle = attachCanvasSink(ws, undefined)
    expect(handle).toBeNull()
    expect(ws.sent.length).toBe(0)
  })

  test("snapshot-on-connect forwards the current usage view", () => {
    const ws = new FakeWs()
    const { source } = makeUsageSource(view())
    const handle = attachCanvasSink(ws, { usageSource: source })
    expect(handle).not.toBeNull()
    expect(decodedKinds(ws)).toEqual(["context.usage"])
  })

  test("subsequent source pushes emit a frame per push", () => {
    const ws = new FakeWs()
    const { source, push } = makeUsageSource()
    attachCanvasSink(ws, { usageSource: source })
    // no latest ⇒ no snapshot-on-connect
    expect(ws.sent.length).toBe(0)
    push(view({ total: 1 }))
    push(view({ total: 2 }))
    expect(decodedKinds(ws)).toEqual(["context.usage", "context.usage"])
  })

  test("detach() unsubscribes + freezes the send-count", () => {
    const ws = new FakeWs()
    const { source, push } = makeUsageSource(view())
    const handle = attachCanvasSink(ws, { usageSource: source })
    if (handle === null) throw new Error("expected a sink")
    const before = ws.sent.length // snapshot-on-connect = 1
    handle.detach()
    push(view({ total: 99 }))
    expect(ws.sent.length).toBe(before)
  })

  test("two connections each get their own snapshot", () => {
    const { source, push } = makeUsageSource(view())
    const a = new FakeWs()
    const b = new FakeWs()
    attachCanvasSink(a, { usageSource: source })
    attachCanvasSink(b, { usageSource: source })
    expect(a.sent.length).toBe(1)
    expect(b.sent.length).toBe(1)
    push(view({ total: 2 }))
    expect(a.sent.length).toBe(2)
    expect(b.sent.length).toBe(2)
  })

  test("throwing ws.send during snapshot is swallowed (NO-THROW)", () => {
    const hostile = {
      send: () => {
        throw new Error("dead")
      },
    }
    const { source } = makeUsageSource(view())
    expect(() => attachCanvasSink(hostile, { usageSource: source })).not.toThrow()
  })
})
