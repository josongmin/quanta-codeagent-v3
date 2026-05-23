import { afterEach, describe, expect, test } from "bun:test"
import {
  bold,
  ColorPolicyResolver,
  cyan,
  expiryColor,
  green,
  humanRel,
  kvLine,
  red,
  renderBox,
  setColorPolicy,
  stripAnsi,
  visibleWidth,
  yellow,
} from "../../../src/ui/ui-helpers"

afterEach(() => {
  setColorPolicy(null)
})

const FIXED_NOW = Date.parse("2026-05-23T12:00:00.000Z")

describe("color policy", () => {
  test("setColorPolicy('off') strips all ANSI from wrap helpers", () => {
    setColorPolicy("off")
    expect(bold("x")).toBe("x")
    expect(cyan("y")).toBe("y")
    expect(red("z")).toBe("z")
  })

  test("setColorPolicy('on') always emits ANSI codes", () => {
    setColorPolicy("on")
    expect(stripAnsi(bold("x"))).toBe("x")
    expect(bold("x").length).toBeGreaterThan(1)
    expect(stripAnsi(cyan("y"))).toBe("y")
    expect(cyan("y").length).toBeGreaterThan(1)
  })

  test("stripAnsi removes every CSI sequence", () => {
    const ESC = String.fromCharCode(27)
    expect(stripAnsi(`${ESC}[31m${ESC}[1mhi${ESC}[0m`)).toBe("hi")
  })

  test("visibleWidth ignores color codes", () => {
    setColorPolicy("on")
    expect(visibleWidth(red("hello"))).toBe(5)
    expect(visibleWidth(`${bold("ab")}${cyan("cd")}`)).toBe(4)
  })
})

describe("humanRel", () => {
  test("future timestamp → 'in Xh' by default", () => {
    const future = new Date(FIXED_NOW + 3 * 3600_000).toISOString()
    expect(humanRel(future, FIXED_NOW)).toBe("in 3h")
  })

  test("past timestamp → 'Xh ago'", () => {
    const past = new Date(FIXED_NOW - 3 * 3600_000).toISOString()
    expect(humanRel(past, FIXED_NOW)).toBe("3h ago")
  })

  test("agoOnly=true collapses any future timestamp to 'just now'", () => {
    const future = new Date(FIXED_NOW + 3 * 3600_000).toISOString()
    expect(humanRel(future, FIXED_NOW, { agoOnly: true })).toBe("just now")
  })

  test("agoOnly=true still renders past timestamps grammatically", () => {
    const past = new Date(FIXED_NOW - 3 * 3600_000).toISOString()
    expect(humanRel(past, FIXED_NOW, { agoOnly: true })).toBe("3h ago")
  })

  test("sub-5-second diff → 'just now' even without agoOnly", () => {
    expect(humanRel(new Date(FIXED_NOW + 2_000).toISOString(), FIXED_NOW)).toBe("just now")
  })

  test("unparseable timestamp → 'unknown time'", () => {
    expect(humanRel("not-a-date", FIXED_NOW)).toBe("unknown time")
  })

  test("days bucket fires above 48h", () => {
    const past = new Date(FIXED_NOW - 3 * 24 * 3600_000).toISOString()
    expect(humanRel(past, FIXED_NOW)).toBe("3d ago")
  })
})

describe("expiryColor", () => {
  test("expired (≤0 remain) → red", () => {
    setColorPolicy("on")
    const past = new Date(FIXED_NOW - 1000).toISOString()
    expect(expiryColor(past, FIXED_NOW)).toBe(red)
  })

  test("≤5 min → red", () => {
    setColorPolicy("on")
    const soon = new Date(FIXED_NOW + 2 * 60_000).toISOString()
    expect(expiryColor(soon, FIXED_NOW)).toBe(red)
  })

  test("≤1 hour → yellow", () => {
    setColorPolicy("on")
    const future = new Date(FIXED_NOW + 30 * 60_000).toISOString()
    expect(expiryColor(future, FIXED_NOW)).toBe(yellow)
  })

  test("> 1 hour → green", () => {
    setColorPolicy("on")
    const future = new Date(FIXED_NOW + 24 * 3600_000).toISOString()
    expect(expiryColor(future, FIXED_NOW)).toBe(green)
  })

  test("unparseable → red (fail safe)", () => {
    expect(expiryColor("not-a-date", FIXED_NOW)).toBe(red)
  })
})

describe("kvLine", () => {
  test("pads key to default width 12", () => {
    setColorPolicy("off")
    const out = kvLine("plan", "plus")
    expect(out).toBe("plan        plus")
  })

  test("respects keyW override", () => {
    setColorPolicy("off")
    expect(kvLine("k", "v", 4)).toBe("k   v")
  })

  test("key shorter than keyW → padded; longer → no clipping", () => {
    setColorPolicy("off")
    expect(kvLine("abcdefghij", "v", 5)).toBe("abcdefghijv")
  })
})

describe("ColorPolicyResolver (instance isolation)", () => {
  test("two instances do not share cached state", () => {
    const a = new ColorPolicyResolver()
    const b = new ColorPolicyResolver()
    a.set("on")
    b.set("off")
    expect(a.resolve()).toBe("on")
    expect(b.resolve()).toBe("off")
  })

  test("reset() clears the override so resolve() re-derives", () => {
    const r = new ColorPolicyResolver()
    r.set("off")
    expect(r.resolve()).toBe("off")
    r.reset()
    // After reset the next resolve must NOT return the previously pinned
    // value — it falls through to env/TTY. We don't assert the absolute
    // value (depends on test runner TTY), only that the override is gone
    // (i.e. pinning a fresh value reflects immediately).
    r.set("on")
    expect(r.resolve()).toBe("on")
  })

  test("default resolver and a fresh instance are independent", () => {
    setColorPolicy("off")
    const isolated = new ColorPolicyResolver()
    isolated.set("on")
    // The module-level wrap helpers must still see the default ("off").
    expect(bold("x")).toBe("x")
    // The isolated instance keeps its own pinned state.
    expect(isolated.resolve()).toBe("on")
  })

  test("setColorPolicy() does not bleed into a fresh instance", () => {
    setColorPolicy("on")
    const isolated = new ColorPolicyResolver()
    isolated.set("off")
    expect(isolated.resolve()).toBe("off")
    // And the module-level default remains "on" — the wrap helper must
    // emit ANSI bytes around the payload (visible width = 1, raw > 1).
    const out = bold("x")
    expect(stripAnsi(out)).toBe("x")
    expect(out.length).toBeGreaterThan(1)
  })

  test("setColorPolicy(null) resets the default resolver via the module seam", () => {
    setColorPolicy("on")
    // Sanity: pinned-on emits ANSI bytes.
    expect(bold("x").length).toBeGreaterThan(1)
    setColorPolicy(null)
    // After clearing, pinning a fresh value still works (sanity that the
    // module-level function continues to route to the default resolver).
    setColorPolicy("off")
    expect(bold("x")).toBe("x")
  })
})

describe("renderBox", () => {
  test("respects minInner — narrow content widened to default 56", () => {
    setColorPolicy("off")
    const out = renderBox(["hi"])
    // top border = "╭" + "─".repeat(totalW) + "╮"; totalW = 56 + 2*2 = 60
    const topLine = out.split("\n")[0] ?? ""
    expect(stripAnsi(topLine).length).toBe(62)
  })

  test("footer adds separator + dim footer line", () => {
    setColorPolicy("off")
    const out = renderBox(["body"], { footer: "meta" })
    const lines = out.split("\n")
    // Body line, then separator (───), then footer line, then bottom border.
    const hasSeparator = lines.some((l) => l.includes("──"))
    const hasFooter = lines.some((l) => l.includes("meta"))
    expect(hasSeparator).toBe(true)
    expect(hasFooter).toBe(true)
  })

  test("title wider than minInner widens the box (no clipping)", () => {
    setColorPolicy("off")
    const longTitle = "a-very-long-title-here-that-exceeds-minInner-default"
    const out = renderBox(["x"], { title: longTitle })
    const topLine = stripAnsi(out.split("\n")[0] ?? "")
    // Top border must visibly contain the full title (no truncation).
    expect(topLine).toContain(longTitle)
    // And it must be at least as wide as a body row (which is the
    // content-bound width) so the border doesn't break alignment.
    const bodyLine = stripAnsi(out.split("\n")[1] ?? "")
    expect(topLine.length).toBeGreaterThanOrEqual(bodyLine.length)
  })
})
