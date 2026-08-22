import { describe, expect, test } from "bun:test"
import { TeeStream } from "../../src/stream/adapters/tee"
import type { StreamPort } from "../../src/stream/ports"
import type { AgentEvent } from "../../src/stream/types"

const ev = (turn: number): AgentEvent => ({ type: "turn_start", turn })

class CollectPort implements StreamPort {
  readonly seen: AgentEvent[] = []
  emit(e: AgentEvent): void {
    this.seen.push(e)
  }
}

class ThrowPort implements StreamPort {
  constructor(private readonly msg = "boom") {}
  emit(): void {
    throw new Error(this.msg)
  }
}

describe("TeeStream", () => {
  test("fans out to every port in order", () => {
    const order: string[] = []
    const a: StreamPort = { emit: () => order.push("a") }
    const b: StreamPort = { emit: () => order.push("b") }
    const c: StreamPort = { emit: () => order.push("c") }
    const tee = new TeeStream([a, b, c])

    tee.emit(ev(1))

    expect(order).toEqual(["a", "b", "c"])
  })

  test("delivers every event to every collecting port", () => {
    const a = new CollectPort()
    const b = new CollectPort()
    const tee = new TeeStream([a, b])

    tee.emit(ev(1))
    tee.emit(ev(2))

    expect(a.seen).toEqual([ev(1), ev(2)])
    expect(b.seen).toEqual([ev(1), ev(2)])
  })

  test("non-strict: a throwing port does not starve the others; degraded() records it", () => {
    const before = new CollectPort()
    const after = new CollectPort()
    const tee = new TeeStream([before, new ThrowPort("p1"), after])

    expect(() => tee.emit(ev(7))).not.toThrow()

    expect(before.seen).toEqual([ev(7)])
    expect(after.seen).toEqual([ev(7)])
    const d = tee.degraded()
    expect(d).toHaveLength(1)
    expect(d[0]?.component).toBe("TeeStream")
    expect(d[0]?.reason).toContain("p1")
    expect(d[0]?.count).toBe(1)
  })

  test("non-strict: repeated failures from the same port accumulate the count", () => {
    const tee = new TeeStream([new ThrowPort("again")])

    tee.emit(ev(1))
    tee.emit(ev(2))
    tee.emit(ev(3))

    const d = tee.degraded()
    expect(d).toHaveLength(1)
    expect(d[0]?.count).toBe(3)
  })

  test("non-strict: multiple faulty ports are each counted", () => {
    const tee = new TeeStream([new ThrowPort("x"), new ThrowPort("y")])

    tee.emit(ev(1))

    const d = tee.degraded()
    expect(d).toHaveLength(2)
    expect(d.reduce((n, e) => n + e.count, 0)).toBe(2)
  })

  test("strict: a throwing port rethrows so the caller can mark the verdict", () => {
    const after = new CollectPort()
    const tee = new TeeStream([new ThrowPort("strict-boom"), after], { strict: true })

    expect(() => tee.emit(ev(1))).toThrow("strict-boom")
    expect(after.seen).toEqual([])
  })

  test("empty ports is a no-op", () => {
    const tee = new TeeStream([])
    expect(() => tee.emit(ev(1))).not.toThrow()
    expect(tee.degraded()).toEqual([])
  })

  test("degraded() is empty when nothing failed", () => {
    const tee = new TeeStream([new CollectPort()])
    tee.emit(ev(1))
    expect(tee.degraded()).toEqual([])
  })
})
