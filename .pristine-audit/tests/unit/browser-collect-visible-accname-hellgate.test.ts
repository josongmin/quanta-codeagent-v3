/**
 * Hellgate — in-page collector primitives `pageVisible` + `pageAccName`
 * (ADR-0427, REPORT-jun26 fix #5: CDP visibility fail-open + accName over-capture).
 *
 * The two helpers run in the page (serialized into COLLECT_SCRIPT via toString),
 * so we test them directly against a fake DOM. Red-on-injection: reverting the
 * ancestor-walk / container-cap makes these fail.
 *
 *  HELL-VIS-01: own display:none ⇒ hidden (pre-existing behavior preserved)
 *  HELL-VIS-02: ANCESTOR display:none ⇒ hidden (the fail-open bug)
 *  HELL-VIS-03: visible element ⇒ visible
 *  HELL-VIS-04: position:fixed (offsetParent null but shown) ⇒ visible
 *  HELL-VIS-05: visibility:hidden / aria-hidden ⇒ hidden
 *  HELL-AN-01: leaf control textContent used as name
 *  HELL-AN-02: container with element children does NOT slurp descendant text
 *  HELL-AN-03: aria-label / placeholder always win (even on containers)
 *  HELL-WIRE-01: COLLECT_SCRIPT embeds the real serialized functions
 */

import { describe, expect, test } from "bun:test"
import { COLLECT_SCRIPT, NAME_CAP, pageAccName, pageVisible } from "@/browser/cdp/collect"

// --- minimal fake DOM ---------------------------------------------------------

type Style = { display?: string; visibility?: string; position?: string }

class FakeEl {
  tagName: string
  attrs: Record<string, string> = {}
  style: Style
  parentNode: FakeEl | null = null
  children: FakeEl[] = []
  textContent = ""
  value?: string
  placeholder?: string
  constructor(tagName: string, style: Style = {}) {
    this.tagName = tagName.toUpperCase()
    this.style = style
  }
  getAttribute(k: string): string | null {
    return Object.hasOwn(this.attrs, k) ? (this.attrs[k] ?? null) : null
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v
  }
  append(...kids: FakeEl[]): this {
    for (const c of kids) {
      c.parentNode = this
      this.children.push(c)
    }
    return this
  }
  // jsdom/browser-faithful offsetParent: null when this OR any ancestor has
  // display:none, or when position:fixed.
  get offsetParent(): FakeEl | null {
    if (this.style.position === "fixed") return null
    let node: FakeEl | null = this
    while (node) {
      if (node.style.display === "none") return null
      node = node.parentNode
    }
    return this.parentNode
  }
  // own computed display/visibility only — does NOT resolve inheritance, exactly
  // like real getComputedStyle for `display`/`visibility` (non-inherited).
  get _computed(): Required<Pick<Style, "display" | "visibility" | "position">> {
    return {
      display: this.style.display ?? "block",
      visibility: this.style.visibility ?? "visible",
      position: this.style.position ?? "static",
    }
  }
}

const fakeWindow = {
  getComputedStyle: (el: FakeEl) => el._computed,
}

const withDoc = (el: FakeEl): FakeEl => {
  // biome-ignore lint/suspicious/noExplicitAny: test shim wiring ownerDocument
  ;(el as any).ownerDocument = { defaultView: fakeWindow }
  for (const c of el.children) withDoc(c)
  return el
}

// biome-ignore lint/suspicious/noExplicitAny: structural shim for the in-page helpers
const visible = (el: FakeEl): boolean => pageVisible(el as any)
// biome-ignore lint/suspicious/noExplicitAny: structural shim for the in-page helpers
const accName = (el: FakeEl): string => pageAccName(el as any)

describe("HELLGATE collect — pageVisible ancestor-aware", () => {
  test("HELL-VIS-01: own display:none ⇒ hidden", () => {
    const el = new FakeEl("div", { display: "none" })
    new FakeEl("body").append(el)
    withDoc(el)
    expect(visible(el)).toBe(false)
  })

  test("HELL-VIS-02: ANCESTOR display:none ⇒ hidden (fail-open bug)", () => {
    const child = new FakeEl("button") // child's OWN style is visible
    const hiddenParent = new FakeEl("div", { display: "none" }).append(child)
    new FakeEl("body").append(hiddenParent)
    withDoc(hiddenParent)
    // own computed display is NOT 'none' — the old check would pass it through.
    expect(child._computed.display).not.toBe("none")
    expect(visible(child)).toBe(false)
  })

  test("HELL-VIS-03: visible element ⇒ visible", () => {
    const child = new FakeEl("button")
    const parent = new FakeEl("div").append(child)
    new FakeEl("body").append(parent)
    withDoc(parent)
    expect(visible(child)).toBe(true)
  })

  test("HELL-VIS-04: position:fixed shown (offsetParent null) ⇒ visible", () => {
    const el = new FakeEl("div", { position: "fixed" })
    new FakeEl("body").append(el)
    withDoc(el)
    expect(el.offsetParent).toBeNull()
    expect(visible(el)).toBe(true)
  })

  test("HELL-VIS-05: visibility:hidden and aria-hidden ⇒ hidden", () => {
    const a = new FakeEl("div", { visibility: "hidden" })
    const b = new FakeEl("div")
    b.setAttribute("aria-hidden", "true")
    new FakeEl("body").append(a, b)
    withDoc(a)
    withDoc(b)
    expect(visible(a)).toBe(false)
    expect(visible(b)).toBe(false)
  })
})

describe("HELLGATE collect — pageAccName container over-capture", () => {
  test("HELL-AN-01: leaf control textContent ⇒ name", () => {
    const btn = new FakeEl("button")
    btn.textContent = "Submit"
    expect(accName(btn)).toBe("Submit")
  })

  test("HELL-AN-02: container with element children does NOT slurp descendant text", () => {
    const container = new FakeEl("div")
    container.setAttribute("role", "region")
    const p1 = new FakeEl("p")
    p1.textContent = "lots of paragraph text ".repeat(20)
    const p2 = new FakeEl("p")
    p2.textContent = "more and more descendant content ".repeat(20)
    container.append(p1, p2)
    // textContent aggregates descendants in a real DOM — emulate that.
    container.textContent = p1.textContent + p2.textContent
    expect(accName(container)).toBe("")
  })

  test("HELL-AN-03: aria-label / placeholder win even on containers", () => {
    const container = new FakeEl("div").append(new FakeEl("span"), new FakeEl("span"))
    container.textContent = "noise ".repeat(50)
    container.setAttribute("aria-label", "Search results")
    expect(accName(container)).toBe("Search results")

    const input = new FakeEl("input")
    input.placeholder = "Type here"
    expect(accName(input)).toBe("Type here")
  })
})

describe("HELLGATE collect — wiring: COLLECT_SCRIPT embeds the real fns", () => {
  test("HELL-WIRE-01: serialized helpers present in the in-page script", () => {
    expect(COLLECT_SCRIPT).toContain(pageVisible.toString())
    expect(COLLECT_SCRIPT).toContain(pageAccName.toString())
  })

  test("HELL-WIRE-02: pageAccName's baked cap stays in sync with NAME_CAP", () => {
    // The helper is serialized into the page so it can't close over NAME_CAP;
    // the literal 200 is hardcoded. Guard against silent drift.
    expect(NAME_CAP).toBe(200)
    expect(pageAccName.toString()).toContain("200")
    const longLeaf = { getAttribute: () => null, children: [], textContent: "z".repeat(5000) }
    // biome-ignore lint/suspicious/noExplicitAny: structural shim for the in-page helper
    expect(pageAccName(longLeaf as any).length).toBe(NAME_CAP)
  })
})
