/**
 * Hellgate — pure snapshot + ref map + headless flow (ADR-0427).
 *
 * Proves perception is deterministic (byte-stable across fresh maps), refs are
 * monotonic + stable + reverse-resolvable + pruned, and the headless port
 * exhaustively branches its BrowserError union (control + adversarial pairs).
 *
 *  HELL-SNAP-01: same model + fresh refMap twice ⇒ byte-identical YAML
 *  HELL-SNAP-02: refs assigned monotonically in pre-order (e1,e2,e3,…)
 *  HELL-SNAP-03: re-render keeps refs; a new node gets the next counter
 *  HELL-SNAP-04: a vanished node's ref is pruned (resolve ⇒ null)
 *  HELL-SNAP-05: navigate→snapshot→click(valid ref) ⇒ ok
 *  HELL-SNAP-06: click(bogus ref) ⇒ element-not-found
 *  HELL-SNAP-07: navigate(unknown url) ⇒ navigation-denied
 *  HELL-SNAP-08: pre-aborted signal ⇒ cancelled
 *  HELL-SNAP-09: close is idempotent; post-close calls ⇒ closed
 */

import { describe, expect, test } from "bun:test"
import { assertOk } from "../_support/assert-ok"
import { buildSnapshot, createHeadlessBrowser, createRefMap, type DomModel } from "@/browser"

const MODEL: DomModel = {
  title: "Login",
  root: {
    backendPath: "/",
    role: "document",
    name: "Login",
    children: [
      { backendPath: "/0", role: "textbox", name: "Email", value: "" },
      { backendPath: "/1", role: "textbox", name: "Password", value: "", states: ["focused"] },
      { backendPath: "/2", role: "button", name: "Sign in" },
    ],
  },
}

describe("HELLGATE snapshot — pure + deterministic", () => {
  test("HELL-SNAP-01: byte-identical across fresh refMaps", () => {
    const a = buildSnapshot(MODEL, createRefMap())
    const b = buildSnapshot(MODEL, createRefMap())
    expect(a).toBe(b)
    // and the rendered shape is what we expect
    expect(a).toContain("- e1 document")
    expect(a).toContain('- e2 textbox "Email"')
    expect(a).toContain('- e3 textbox "Password" [focused]')
    expect(a).toContain('- e4 button "Sign in"')
  })

  test("HELL-SNAP-02: monotonic pre-order refs", () => {
    const rm = createRefMap()
    buildSnapshot(MODEL, rm)
    expect(rm.refOf("/")).toBe("e1")
    expect(rm.refOf("/0")).toBe("e2")
    expect(rm.refOf("/1")).toBe("e3")
    expect(rm.refOf("/2")).toBe("e4")
    expect(rm.resolve("e2")).toBe("/0") // reverse roundtrip
  })

  test("HELL-SNAP-03: re-render keeps refs; new node gets next counter", () => {
    const rm = createRefMap()
    buildSnapshot(MODEL, rm)
    const grown: DomModel = {
      ...MODEL,
      root: {
        ...MODEL.root,
        children: [
          ...(MODEL.root.children ?? []),
          { backendPath: "/3", role: "link", name: "Forgot?" },
        ],
      },
    }
    buildSnapshot(grown, rm)
    expect(rm.refOf("/0")).toBe("e2") // unchanged
    expect(rm.refOf("/2")).toBe("e4") // unchanged
    expect(rm.refOf("/3")).toBe("e5") // monotonic next
  })

  test("HELL-SNAP-10: value + url suffixes render (R1 audit [25])", () => {
    const m: DomModel = {
      title: "T",
      root: {
        backendPath: "/",
        role: "document",
        name: "T",
        children: [
          { backendPath: "/0", role: "textbox", name: "Email", value: "" },
          { backendPath: "/1", role: "link", name: "Home", url: "https://x.test/" },
        ],
      },
    }
    const out = buildSnapshot(m, createRefMap())
    expect(out).toContain('- e2 textbox "Email" =""') // empty value still rendered
    expect(out).toContain('- e3 link "Home" (https://x.test/)') // url suffix
  })

  test("HELL-SNAP-11: placeholder + heading level render (Wave 4)", () => {
    const m: DomModel = {
      title: "T",
      root: {
        backendPath: "/",
        role: "document",
        name: "T",
        children: [
          { backendPath: "/0", role: "heading", name: "Welcome", level: 2 },
          { backendPath: "/1", role: "textbox", name: "Email", placeholder: "you@example.com" },
        ],
      },
    }
    const out = buildSnapshot(m, createRefMap())
    expect(out).toContain('- e2 heading "Welcome" h2')
    expect(out).toContain('ph="you@example.com"')
  })

  test("HELL-SNAP-04: vanished node pruned", () => {
    const rm = createRefMap()
    const grown: DomModel = {
      ...MODEL,
      root: {
        ...MODEL.root,
        children: [...(MODEL.root.children ?? []), { backendPath: "/3", role: "link", name: "x" }],
      },
    }
    buildSnapshot(grown, rm)
    expect(rm.resolve("e5")).toBe("/3")
    buildSnapshot(MODEL, rm) // "/3" gone
    expect(rm.resolve("e5")).toBeNull()
    expect(rm.refOf("/3")).toBeNull()
  })

  test("HELL-SNAP-12: invalidate() drops all bindings but the counter stays monotonic", () => {
    const rm = createRefMap()
    buildSnapshot(MODEL, rm) // e1..e4
    expect(rm.resolve("e2")).toBe("/0")
    expect(rm.refOf("/2")).toBe("e4")
    rm.invalidate()
    // every prior binding is gone in BOTH directions → stale refs fail closed
    expect(rm.resolve("e2")).toBeNull()
    expect(rm.resolve("e4")).toBeNull()
    expect(rm.refOf("/0")).toBeNull()
    expect(rm.refOf("/2")).toBeNull()
    // a fresh reconcile mints NEW ref numbers — the counter never rewinds, so
    // the SAME backendPath "/0" gets e5 (not e2): a stale ref can never silently
    // rebind to a coincidental same-path node on a later page.
    buildSnapshot(MODEL, rm) // pre-order: "/"→e5, "/0"→e6, "/1"→e7, "/2"→e8
    expect(rm.refOf("/")).toBe("e5")
    expect(rm.refOf("/0")).toBe("e6")
    expect(rm.refOf("/2")).toBe("e8")
    expect(rm.resolve("e2")).toBeNull() // the old number is permanently dead
  })
})

describe("HELLGATE snapshot — headless flow exhaustive branches", () => {
  const pages = new Map([["https://app.test/login", { title: "Login", dom: MODEL }]])

  test("HELL-SNAP-05: navigate→snapshot→click(valid) ⇒ ok", async () => {
    const b = createHeadlessBrowser({ pages })
    const h = await b.spawn()
    expect(h.ok).toBe(true)
    assertOk(h)
    const nav = await b.navigate(h.value, "https://app.test/login")
    expect(nav.ok).toBe(true)
    const snap = await b.snapshot(h.value)
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    expect(snap.value.title).toBe("Login")
    expect(snap.value.yaml).toContain('button "Sign in"')
    const click = await b.click(h.value, "e4") // the Sign in button
    expect(click.ok).toBe(true)
  })

  test("HELL-SNAP-06: click(bogus ref) ⇒ element-not-found", async () => {
    const b = createHeadlessBrowser({ pages })
    const h = await b.spawn()
    assertOk(h)
    await b.navigate(h.value, "https://app.test/login")
    await b.snapshot(h.value)
    const r = await b.click(h.value, "e999")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("element-not-found")
      if (r.error.kind === "element-not-found") expect(r.error.ref).toBe("e999")
    }
  })

  test("HELL-SNAP-07: navigate(unknown url) ⇒ navigation-denied", async () => {
    const b = createHeadlessBrowser({ pages })
    const h = await b.spawn()
    assertOk(h)
    const r = await b.navigate(h.value, "https://evil.test/")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("navigation-denied")
  })

  test("HELL-SNAP-08: pre-aborted signal ⇒ cancelled", async () => {
    const b = createHeadlessBrowser({ pages })
    const h = await b.spawn()
    assertOk(h)
    const ac = new AbortController()
    ac.abort()
    const r = await b.navigate(h.value, "https://app.test/login", ac.signal)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cancelled")
  })

  test("HELL-SNAP-09: close idempotent; post-close ⇒ closed", async () => {
    const b = createHeadlessBrowser({ pages })
    const h = await b.spawn()
    assertOk(h)
    const c1 = await b.close(h.value)
    expect(c1.ok).toBe(true)
    const c2 = await b.close(h.value) // second close — no throw
    expect(c2.ok).toBe(true)
    const after = await b.navigate(h.value, "https://app.test/login")
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.error.kind).toBe("closed")
  })

  // PAGE_B shares MODEL's exact child-index structure (/0,/1,/2) but is a
  // different document — the "silent rebind" trap: an index-path ref scheme
  // would happily resolve a page-A ref to page-B's node at the same path.
  const PAGE_B: DomModel = {
    title: "Dashboard",
    root: {
      backendPath: "/",
      role: "document",
      name: "Dashboard",
      children: [
        { backendPath: "/0", role: "button", name: "Delete account" },
        { backendPath: "/1", role: "textbox", name: "Search" },
        { backendPath: "/2", role: "button", name: "Log out" },
      ],
    },
  }
  const pages2 = new Map([
    ["https://app.test/login", { title: "Login", dom: MODEL }],
    ["https://app.test/home", { title: "Dashboard", dom: PAGE_B }],
  ])

  test("HELL-SNAP-13: a ref from page A is DEAD after navigating to page B (no fresh snapshot) ⇒ element-not-found", async () => {
    const b = createHeadlessBrowser({ pages: pages2 })
    const h = await b.spawn()
    assertOk(h)
    await b.navigate(h.value, "https://app.test/login")
    await b.snapshot(h.value) // mints e1..e4 against page A
    // sanity: the page-A ref is live BEFORE we navigate away
    expect((await b.click(h.value, "e4")).ok).toBe(true)
    // navigate to page B WITHOUT taking a fresh snapshot
    await b.navigate(h.value, "https://app.test/home")
    // the page-A ref must now fail closed — even though page B has a node at the
    // same "/2" child-index path (Log out), the stale ref must NOT actuate it.
    const stale = await b.click(h.value, "e4")
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error.kind).toBe("element-not-found")
    const staleFill = await b.fill(h.value, "e2", "x")
    expect(staleFill.ok).toBe(false)
  })

  test("HELL-SNAP-14: after re-snapshot on page B, the same path mints FRESH ref numbers (no silent rebind)", async () => {
    const b = createHeadlessBrowser({ pages: pages2 })
    const h = await b.spawn()
    assertOk(h)
    await b.navigate(h.value, "https://app.test/login")
    const snapA = await b.snapshot(h.value)
    expect(snapA.ok).toBe(true)
    if (!snapA.ok) return
    expect(snapA.value.yaml).toContain('e4 button "Sign in"')
    await b.navigate(h.value, "https://app.test/home")
    const snapB = await b.snapshot(h.value)
    expect(snapB.ok).toBe(true)
    if (!snapB.ok) return
    // page B's nodes get brand-new ref numbers (counter kept climbing past e4),
    // so "e4" is NOT reused for page B's "/2" — it stays permanently dead.
    expect(snapB.value.yaml).not.toContain('e4 button "Log out"')
    expect(snapB.value.yaml).toContain('button "Log out"')
    expect((await b.click(h.value, "e4")).ok).toBe(false) // old number still dead
    // the freshly-minted page-B refs DO work
    const freshRef = /- (e\d+) button "Log out"/.exec(snapB.value.yaml)?.[1]
    expect(freshRef).toBeDefined()
    if (freshRef) expect((await b.click(h.value, freshRef)).ok).toBe(true)
  })
})
