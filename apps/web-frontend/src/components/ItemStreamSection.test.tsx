/**
 * S2 — ItemStreamSection render + gate-OFF parity tests (node env, static
 * markup). Drives the component off folded `ItemStreamState` produced by the
 * reducer so the render assertions ride the real fold path.
 */

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { EMPTY_ITEM_STREAM, itemStreamReducer } from "../ws/item-stream-hooks"
import { ItemStreamSection } from "./ItemStreamSection"

const fold = (...actions: Parameters<typeof itemStreamReducer>[1][]) =>
  actions.reduce((s, a) => itemStreamReducer(s, a), EMPTY_ITEM_STREAM)

describe("S2 ItemStreamSection (gate-OFF parity)", () => {
  it("renders nothing for null state (QUANTA_ITEM_STREAM OFF ⇒ byte-identical)", () => {
    expect(renderToStaticMarkup(<ItemStreamSection state={null} />)).toBe("")
  })

  it("renders nothing for the empty stream (no item frame yet)", () => {
    expect(renderToStaticMarkup(<ItemStreamSection state={EMPTY_ITEM_STREAM} />)).toBe("")
  })
})

describe("S2 ItemStreamSection render", () => {
  it("renders one row per item with its type + accumulated text", () => {
    const state = fold(
      { type: "message", msg: { kind: "item.started", itemId: "i1", itemType: "reasoning", itemIndex: 0, emittedAt: 0 } },
      { type: "message", msg: { kind: "item.delta", itemId: "i1", itemType: "reasoning", deltaKind: "text", delta: "thinking…", emittedAt: 0 } },
    )
    const html = renderToStaticMarkup(<ItemStreamSection state={state} />)
    expect(html).toContain("item-stream-section")
    expect(html).toContain("reasoning")
    expect(html).toContain("thinking")
    // running item ⇒ pulsing status dot.
    expect(html).toContain("animate-pulse")
  })

  it("sorts rows by itemIndex (emission order) regardless of id-keyed Map order", () => {
    const state = fold(
      { type: "message", msg: { kind: "item.started", itemId: "z", itemType: "t", itemIndex: 1, emittedAt: 0 } },
      { type: "message", msg: { kind: "item.delta", itemId: "z", itemType: "t", deltaKind: "text", delta: "SECOND", emittedAt: 0 } },
      { type: "message", msg: { kind: "item.started", itemId: "a", itemType: "t", itemIndex: 0, emittedAt: 0 } },
      { type: "message", msg: { kind: "item.delta", itemId: "a", itemType: "t", deltaKind: "text", delta: "FIRST", emittedAt: 0 } },
    )
    const html = renderToStaticMarkup(<ItemStreamSection state={state} />)
    expect(html.indexOf("FIRST")).toBeLessThan(html.indexOf("SECOND"))
  })

  it("shows the completed status for a finished item", () => {
    const state = fold(
      { type: "message", msg: { kind: "item.started", itemId: "i1", itemType: "t", itemIndex: 0, emittedAt: 0 } },
      { type: "message", msg: { kind: "item.completed", itemId: "i1", itemType: "t", text: "done", emittedAt: 0 } },
    )
    const html = renderToStaticMarkup(<ItemStreamSection state={state} />)
    expect(html).toContain("completed")
    expect(html).toContain("done")
    expect(html).not.toContain("animate-pulse")
  })
})
