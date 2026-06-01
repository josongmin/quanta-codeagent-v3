/**
 * Hellgate — DevTools endpoint poll + DomModel parse (ADR-0427, Wave 2).
 *
 * Two pure cores: the endpoint discovery poll loop (fake fs + manual clock) and
 * the page-output trust boundary (fail-closed validation + caps).
 *
 *  HELL-EP-01: well-formed file ⇒ ws url (with + without ws path)
 *  HELL-EP-02: malformed/empty file ⇒ malformed
 *  HELL-EP-03: file appears after N polls ⇒ resolves
 *  HELL-EP-04: file never appears ⇒ spawn-failed at timeout (loop terminates)
 *  HELL-DM-01: valid nested model ⇒ ok (string or object input)
 *  HELL-DM-02: missing title/root or bad node ⇒ malformed (fail-closed)
 *  HELL-DM-03: one bad child rejects the whole tree
 *  HELL-DM-04: name/value capped defensively (page is untrusted)
 */

import { describe, expect, test } from "bun:test"
import { parseDomModel } from "@/browser/cdp/collect"
import { parseDevToolsActivePort, readDevToolsEndpoint } from "@/browser/cdp/dev-tools-endpoint"
import type { Clock, Scheduler } from "@/browser/cdp/ports"

// scheduler that resolves immediately and advances a shared clock each poll
const tickEnv = (pollMs: number) => {
  const state = { t: 0 }
  const clock: Clock = { now: () => state.t }
  const scheduler: Scheduler = {
    schedule: (_ms, cb) => {
      state.t += pollMs
      cb()
      return () => {}
    },
  }
  return { clock, scheduler, state }
}

describe("HELLGATE endpoint — parse + poll", () => {
  test("HELL-EP-01: well-formed ⇒ ws url", () => {
    const a = parseDevToolsActivePort("9222\n/devtools/browser/abc")
    expect(a.ok).toBe(true)
    if (a.ok) expect(a.value).toBe("ws://127.0.0.1:9222/devtools/browser/abc")
    const b = parseDevToolsActivePort("9222") // no ws path line
    expect(b.ok).toBe(true)
    if (b.ok) expect(b.value).toBe("ws://127.0.0.1:9222")
  })

  test("HELL-EP-02: malformed ⇒ malformed", () => {
    expect(parseDevToolsActivePort("").ok).toBe(false)
    expect(parseDevToolsActivePort("notaport\n/x").ok).toBe(false)
    expect(parseDevToolsActivePort("  \n/x").ok).toBe(false)
  })

  test("HELL-EP-03: file appears after N polls ⇒ resolves", async () => {
    const reads: Array<string | null> = [null, null, "9222\n/devtools/browser/x"]
    let i = 0
    const env = tickEnv(50)
    const r = await readDevToolsEndpoint({
      read: () => reads[Math.min(i++, reads.length - 1)] ?? null,
      scheduler: env.scheduler,
      clock: env.clock,
      timeoutMs: 1000,
      pollMs: 50,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe("ws://127.0.0.1:9222/devtools/browser/x")
  })

  test("HELL-EP-05: malformed-then-valid (mid-write) ⇒ resolves [31]", async () => {
    const reads: Array<string | null> = ["9222 partial-bad", "garbage", "9222\n/devtools/browser/x"]
    let i = 0
    const env = tickEnv(50)
    const r = await readDevToolsEndpoint({
      read: () => reads[Math.min(i++, reads.length - 1)] ?? null,
      scheduler: env.scheduler,
      clock: env.clock,
      timeoutMs: 1000,
      pollMs: 50,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe("ws://127.0.0.1:9222/devtools/browser/x")
  })

  test("HELL-EP-06: always-malformed ⇒ spawn-failed at timeout [31]", async () => {
    const env = tickEnv(50)
    const r = await readDevToolsEndpoint({
      read: () => "not-a-port",
      scheduler: env.scheduler,
      clock: env.clock,
      timeoutMs: 200,
      pollMs: 50,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("spawn-failed")
  })

  test("HELL-EP-07: pre-aborted signal ⇒ cancelled, no spin (R2 [14])", async () => {
    const env = tickEnv(50)
    const ac = new AbortController()
    ac.abort()
    const r = await readDevToolsEndpoint({
      read: () => null, // would otherwise poll until the (huge) timeout
      scheduler: env.scheduler,
      clock: env.clock,
      timeoutMs: 1_000_000,
      pollMs: 50,
      signal: ac.signal,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cancelled")
    expect(env.state.t).toBe(0) // returned on the first iteration, before any poll
  })

  test("HELL-EP-04: never appears ⇒ spawn-failed (terminates)", async () => {
    const env = tickEnv(50)
    const r = await readDevToolsEndpoint({
      read: () => null,
      scheduler: env.scheduler,
      clock: env.clock,
      timeoutMs: 200,
      pollMs: 50,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("spawn-failed")
  })
})

describe("HELLGATE DomModel — fail-closed parse + caps", () => {
  const valid = {
    title: "Home",
    root: {
      backendPath: "/",
      role: "document",
      name: "Home",
      children: [{ backendPath: "/0", role: "button", name: "Go", tag: "button" }],
    },
  }

  test("HELL-DM-01: valid model ⇒ ok (object and string input)", () => {
    const a = parseDomModel(valid)
    expect(a.ok).toBe(true)
    if (a.ok) expect(a.value.root.children?.[0]?.name).toBe("Go")
    const b = parseDomModel(JSON.stringify(valid))
    expect(b.ok).toBe(true)
  })

  test("HELL-DM-02: missing fields ⇒ malformed", () => {
    expect(parseDomModel(null).ok).toBe(false)
    expect(parseDomModel("not json{").ok).toBe(false)
    expect(parseDomModel({ root: valid.root }).ok).toBe(false) // no title
    expect(parseDomModel({ title: "x" }).ok).toBe(false) // no root
    expect(parseDomModel({ title: "x", root: { role: "x", name: "y" } }).ok).toBe(false) // no backendPath
  })

  test("HELL-DM-03: one bad child rejects whole tree", () => {
    const bad = {
      title: "x",
      root: {
        backendPath: "/",
        role: "document",
        name: "x",
        children: [{ backendPath: "/0", role: "button", name: "ok" }, { role: "button" }],
      },
    }
    expect(parseDomModel(bad).ok).toBe(false)
  })

  test("HELL-DM-04: name/value capped (untrusted page)", () => {
    const huge = "x".repeat(5000)
    const m = {
      title: huge,
      root: { backendPath: "/", role: "textbox", name: huge, value: huge },
    }
    const r = parseDomModel(m)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.title.length).toBe(200)
      expect(r.value.root.name.length).toBe(200)
      expect(r.value.root.value?.length).toBe(100)
    }
  })
})
