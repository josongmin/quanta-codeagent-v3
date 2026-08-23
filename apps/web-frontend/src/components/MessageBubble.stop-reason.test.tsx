/**
 * HELLGATE — the web bubble actually SHOWS why a turn stopped
 * (aug-23 §13 / audit follow-up)
 *
 * The objective audit found that `50e3e65d6` ("keep the stop reason visible")
 * made nothing visible: `stopCategory` was carried onto `UiMessage` and every
 * `.tsx` ignored it, so a `max_turns` / rate-limited / refused turn still
 * rendered as an ordinary assistant bubble. Carrying data no component reads is
 * the very defect §13 documents, one layer up.
 *
 * Invariants:
 *
 *  H1  RENDERED — a non-success category produces visible text naming the stop.
 *  H2  PAIRED CONTROL — a clean completion renders NO badge, so the fix is not
 *      "always show a banner".
 *  H3  ABSENT ⇒ UNCHANGED — a message with no category renders exactly as
 *      before (back-compat with pre-slice producers).
 *  H4  PROSE SURVIVES — the badge is additive; the assistant's text is intact.
 *  H5  UNKNOWN CODE degrades to a non-success label rather than disappearing —
 *      an unrecognized stop must not silently read as success.
 */

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { UiMessage } from "../types/protocol"
import { MessageBubble } from "./MessageBubble"

const html = (message: UiMessage): string =>
  renderToStaticMarkup(<MessageBubble message={message} />)

const assistant = (over: Partial<UiMessage> = {}): UiMessage => ({
  id: "m1",
  role: "assistant",
  text: "Here is what I found.",
  timestamp: "2026-08-23T13:00:00.000Z",
  ...over,
})

describe("H1 — a non-success stop is visible", () => {
  it("renders a label for max_turns", () => {
    const out = html(
      assistant({ stopCategory: { kind: "max_turns", reasonCode: "completed.max_turns" } }),
    )
    expect(out).toMatch(/turn limit/i)
  })

  it("renders a label for a provider failure", () => {
    const out = html(
      assistant({ stopCategory: { kind: "failed", reasonCode: "provider.rate_limit" } }),
    )
    expect(out).toMatch(/rate limit/i)
  })
})

describe("H2 — paired control: a clean completion shows no badge", () => {
  it("completed.normal renders no stop label", () => {
    const out = html(
      assistant({ stopCategory: { kind: "completed", reasonCode: "completed.normal" } }),
    )
    expect(out).not.toMatch(/stopped/i)
  })
})

describe("H3 — absent category is unchanged", () => {
  it("renders no stop label", () => {
    const out = html(assistant())
    expect(out).not.toMatch(/stopped/i)
    expect(out).toContain("Here is what I found.")
  })
})

describe("H4 — the badge is additive", () => {
  it("keeps the assistant prose", () => {
    const out = html(
      assistant({ stopCategory: { kind: "failed", reasonCode: "provider.network" } }),
    )
    expect(out).toContain("Here is what I found.")
  })
})

describe("H5 — an unrecognized code still reads as a stop", () => {
  it("does not vanish", () => {
    const out = html(
      assistant({ stopCategory: { kind: "failed", reasonCode: "some.future.code" } }),
    )
    expect(out).toMatch(/stopped/i)
  })
})
