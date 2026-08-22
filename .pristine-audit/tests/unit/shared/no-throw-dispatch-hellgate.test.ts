import { describe, expect, test } from "bun:test"
import { dispatchNoThrow, dispatchNoThrowWith, notifyAllNoThrow } from "@/shared"

/**
 * T07 hellgate — the shared no-throw listener dispatcher. The ONE primitive
 * realtime/stream/llm consume so a hostile best-effort callback can never
 * abort primary delivery or starve sibling listeners.
 */
describe("T07 no-throw dispatch hellgate", () => {
  test("dispatchNoThrow: clean callback returns true and runs", () => {
    let ran = false
    const ok = dispatchNoThrow(() => {
      ran = true
    })
    expect(ran).toBe(true)
    expect(ok).toBe(true)
  })

  test("dispatchNoThrow: undefined callback is a clean no-op", () => {
    expect(dispatchNoThrow(undefined)).toBe(true)
  })

  test("dispatchNoThrow: a throwing callback is swallowed and returns false", () => {
    let after = false
    const ok = dispatchNoThrow(() => {
      throw new Error("boom")
    })
    after = true
    expect(ok).toBe(false)
    expect(after).toBe(true)
  })

  test("dispatchNoThrow: passes args through", () => {
    const seen: number[] = []
    dispatchNoThrow((a: number, b: number) => seen.push(a, b), 1, 2)
    expect(seen).toEqual([1, 2])
  })

  test("dispatchNoThrowWith: routes thrown error to sink without re-throwing", () => {
    let captured: unknown
    const ok = dispatchNoThrowWith(
      () => {
        throw new Error("sunk")
      },
      (e) => {
        captured = e
      },
    )
    expect(ok).toBe(false)
    expect((captured as Error).message).toBe("sunk")
  })

  test("dispatchNoThrowWith: a throwing error-sink cannot escalate", () => {
    expect(() =>
      dispatchNoThrowWith(
        () => {
          throw new Error("primary")
        },
        () => {
          throw new Error("sink-also-throws")
        },
      ),
    ).not.toThrow()
  })

  test("notifyAllNoThrow: every listener runs even when one throws; returns throw count", () => {
    const seen: string[] = []
    const threw = notifyAllNoThrow(
      [
        () => seen.push("a"),
        () => {
          throw new Error("x")
        },
        () => seen.push("c"),
      ],
      undefined,
    )
    expect(seen).toEqual(["a", "c"])
    expect(threw).toBe(1)
  })

  test("notifyAllNoThrow: forwards args + routes each error to sink", () => {
    const errs: unknown[] = []
    const seen: number[] = []
    const threw = notifyAllNoThrow<[number]>(
      [
        (n) => seen.push(n),
        () => {
          throw new Error("e1")
        },
        () => {
          throw new Error("e2")
        },
      ],
      (e) => errs.push(e),
      7,
    )
    expect(seen).toEqual([7])
    expect(threw).toBe(2)
    expect(errs.length).toBe(2)
  })
})
