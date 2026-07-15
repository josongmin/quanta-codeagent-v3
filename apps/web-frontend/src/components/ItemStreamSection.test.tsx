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

describe("jul-15 peerMessage — dedicated 'Sent from another task' row", () => {
  // The projector emits a peerMessage item whose completed.text is
  // `from→to [kind] body` (item-stream-projector `onPeerMessage`).
  const peerState = (text: string) =>
    fold(
      { type: "message", msg: { kind: "item.started", itemId: "p1", itemType: "peerMessage", itemIndex: 0, emittedAt: 0 } },
      { type: "message", msg: { kind: "item.completed", itemId: "p1", itemType: "peerMessage", text, emittedAt: 0 } },
    )

  it("renders the Codex-parity label + parsed attribution + body bubble", () => {
    const html = renderToStaticMarkup(<ItemStreamSection state={peerState("root/1→root [request] compute the sum")} />)
    expect(html).toContain("peer-message-row")
    expect(html).toContain("Sent from another task")
    // attribution meta parsed out of the text
    expect(html).toContain("root/1")
    expect(html).toContain("request")
    // the body renders in the bubble (NOT the raw `from→to [kind]` prefix)
    expect(html).toContain("compute the sum")
    // it does NOT fall back to the generic itemType badge row
    expect(html).not.toContain(">peerMessage<")
  })

  it("a non-peerMessage item still gets the generic row (no false positive)", () => {
    const state = fold(
      { type: "message", msg: { kind: "item.started", itemId: "i1", itemType: "reasoning", itemIndex: 0, emittedAt: 0 } },
      { type: "message", msg: { kind: "item.completed", itemId: "i1", itemType: "reasoning", text: "x", emittedAt: 0 } },
    )
    const html = renderToStaticMarkup(<ItemStreamSection state={state} />)
    expect(html).not.toContain("peer-message-row")
    expect(html).not.toContain("Sent from another task")
  })

  it("a malformed peerMessage text falls back to the raw text in the bubble", () => {
    const html = renderToStaticMarkup(<ItemStreamSection state={peerState("no arrow here")} />)
    expect(html).toContain("peer-message-row")
    expect(html).toContain("Sent from another task")
    expect(html).toContain("no arrow here")
  })
})
