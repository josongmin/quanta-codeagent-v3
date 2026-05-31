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
import { type DomModel, buildSnapshot, createHeadlessBrowser, createRefMap } from "@/browser"

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
})

describe("HELLGATE snapshot — headless flow exhaustive branches", () => {
  const pages = new Map([["https://app.test/login", { title: "Login", dom: MODEL }]])

  test("HELL-SNAP-05: navigate→snapshot→click(valid) ⇒ ok", async () => {
    const b = createHeadlessBrowser({ pages })
    const h = await b.spawn()
    expect(h.ok).toBe(true)
    if (!h.ok) return
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
    if (!h.ok) return
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
    if (!h.ok) return
    const r = await b.navigate(h.value, "https://evil.test/")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("navigation-denied")
  })

  test("HELL-SNAP-08: pre-aborted signal ⇒ cancelled", async () => {
    const b = createHeadlessBrowser({ pages })
    const h = await b.spawn()
    if (!h.ok) return
    const ac = new AbortController()
    ac.abort()
    const r = await b.navigate(h.value, "https://app.test/login", ac.signal)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cancelled")
  })

  test("HELL-SNAP-09: close idempotent; post-close ⇒ closed", async () => {
    const b = createHeadlessBrowser({ pages })
    const h = await b.spawn()
    if (!h.ok) return
    const c1 = await b.close(h.value)
    expect(c1.ok).toBe(true)
    const c2 = await b.close(h.value) // second close — no throw
    expect(c2.ok).toBe(true)
    const after = await b.navigate(h.value, "https://app.test/login")
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.error.kind).toBe("closed")
  })
})
