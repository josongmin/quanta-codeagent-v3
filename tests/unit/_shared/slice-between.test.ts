/**
 * The helper that closes the silent-widening class. See `slice-between.ts` for the
 * measured false PASS that motivated it.
 */
import { describe, expect, test } from "bun:test"
import { sliceBetween } from "./slice-between"

const SRC = "AAA<start>MIDDLE<end>BBBBBBBBBB"

describe("sliceBetween", () => {
  test("byte-identical to the raw idiom when both anchors resolve", () => {
    expect(sliceBetween(SRC, "<start>", "<end>")).toBe(
      SRC.slice(SRC.indexOf("<start>"), SRC.indexOf("<end>")),
    )
    expect(sliceBetween(SRC, 0, "<end>")).toBe(SRC.slice(0, SRC.indexOf("<end>")))
  })

  /** The whole point: the raw idiom returns a WIDER window and no error. */
  test("a missing end anchor throws instead of widening", () => {
    const raw = SRC.slice(SRC.indexOf("<start>"), SRC.indexOf("<GONE>"))
    expect(raw.length, "the raw idiom really does widen").toBeGreaterThan(
      SRC.slice(SRC.indexOf("<start>"), SRC.indexOf("<end>")).length,
    )
    expect(() => sliceBetween(SRC, "<start>", "<GONE>")).toThrow(/end anchor/)
    expect(() => sliceBetween(SRC, 0, "<GONE>")).toThrow(/end anchor/)
  })

  test("a missing start anchor throws instead of returning an empty window", () => {
    expect(SRC.slice(SRC.indexOf("<GONE>"), SRC.indexOf("<end>"))).toBe("")
    expect(() => sliceBetween(SRC, "<GONE>", "<end>")).toThrow(/start anchor/)
  })

  /** An end anchor BEFORE the start gives the raw idiom an empty window and this
   *  helper a loud failure, which is the honest outcome for a broken anchor. */
  test("the end anchor is searched after the start, never before it", () => {
    const s = "<end>XXX<start>YYY"
    expect(s.slice(s.indexOf("<start>"), s.indexOf("<end>"))).toBe("")
    expect(() => sliceBetween(s, "<start>", "<end>")).toThrow(/end anchor/)
  })

  test("an out-of-range start offset throws", () => {
    expect(() => sliceBetween(SRC, -1, "<end>")).toThrow(/start offset/)
    expect(() => sliceBetween(SRC, SRC.length + 1, "<end>")).toThrow(/start offset/)
  })

  test("the label reaches the message so a failure names the file", () => {
    expect(() => sliceBetween(SRC, "<start>", "<GONE>", { label: "foo.ts" })).toThrow(/foo\.ts/)
  })

  test("repeated anchors take the first start and the first end after it", () => {
    const s = "<a>1<b>2<a>3<b>"
    expect(sliceBetween(s, "<a>", "<b>")).toBe("<a>1")
  })
})
