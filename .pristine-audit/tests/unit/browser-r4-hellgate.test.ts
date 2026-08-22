/**
 * Hellgate — R4 cross-cutting fixes (ADR-0427 R4 audit [2][4][5][6][8]).
 *
 * Guards the fixes the slice-internal rounds never reached:
 *   [4] DNS lookup is bounded by a timeout (a hung resolver fails closed);
 *   [5] pathological DOM depth is capped (no stack overflow / unbounded tree);
 *   [2] abort threads into snapshot/screenshot/cdp (pre-aborted ⇒ cancelled);
 *   [6] a throwing spawner still cleans up the mkdir'd profile;
 *   [8] concurrent adapters sharing a profileRoot get UNIQUE profile dirs.
 */

import { describe, expect, test } from "bun:test"
import { parseDomModel } from "@/browser/cdp/collect"
import type {
  BrowserFs,
  CdpConnection,
  CdpTransport,
  Clock,
  ProcessSpawner,
  Scheduler,
} from "@/browser/cdp/ports"
import { createCdpBrowser } from "@/browser/cdp-adapter"
import { ok } from "@/shared"
import { type DnsResolver, guardNavigationUrl } from "@/tool/browser/net-guard"

describe("R4 [4] — DNS lookup timeout", () => {
  test("a hung resolver fails closed via the timeout (does not hang)", async () => {
    const hung: DnsResolver = { lookup: () => new Promise<never>(() => {}) } // never settles
    const r = await guardNavigationUrl("https://flaky.test/", hung, 10)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("timed out")
  })
  test("a fast public resolver still passes within the budget", async () => {
    const fast: DnsResolver = { lookup: async () => ["8.8.8.8"] }
    const r = await guardNavigationUrl("https://ok.test/", fast, 1000)
    expect(r.ok).toBe(true)
  })
})

describe("R4 [5] — DOM depth cap (no stack overflow / unbounded tree)", () => {
  const deep = (n: number) => {
    let node: Record<string, unknown> = { backendPath: "/", role: "div", name: "leaf" }
    for (let i = 0; i < n; i++) {
      node = { backendPath: `/${i}`, role: "div", name: "x", children: [node] }
    }
    return { title: "deep", root: node }
  }
  const depthOf = (n: { children?: readonly unknown[] }): number => {
    let d = 0
    let cur: { children?: readonly unknown[] } | undefined = n
    while (cur?.children && cur.children.length > 0) {
      d += 1
      cur = cur.children[0] as { children?: readonly unknown[] }
    }
    return d
  }
  test("a 3000-deep model parses without throwing and is depth-capped", () => {
    const r = parseDomModel(deep(3000))
    expect(r.ok).toBe(true)
    if (r.ok) expect(depthOf(r.value.root)).toBeLessThanOrEqual(1000)
  })
})

// --- real adapter over fakes (for [2][6][8]) ---------------------------------

const DOM = {
  title: "P",
  root: { backendPath: "/", role: "document", name: "P", children: [] as unknown[] },
}
const baseTransport: CdpTransport = {
  connect: async () => {
    let emit: (raw: string) => void = () => {}
    const conn: CdpConnection = {
      onMessage: (cb) => {
        emit = cb
      },
      close: () => {},
      send: (raw) => {
        const m = JSON.parse(raw) as { id: number; method: string; params: { expression?: string } }
        queueMicrotask(() => {
          if (m.method === "Target.createTarget")
            emit(JSON.stringify({ id: m.id, result: { targetId: "t1" } }))
          else if (m.method === "Target.attachToTarget")
            emit(JSON.stringify({ id: m.id, result: { sessionId: "s1" } }))
          else if (m.method === "Runtime.evaluate") {
            const v = (m.params.expression ?? "").includes("walk(document.body")
              ? JSON.stringify(DOM)
              : true
            emit(JSON.stringify({ id: m.id, result: { result: { value: v } } }))
          } else emit(JSON.stringify({ id: m.id, result: {} }))
        })
      },
    }
    return ok(conn)
  },
}
const okFs = (): BrowserFs => ({
  existsSync: () => false,
  readFile: (p) => (p.endsWith("DevToolsActivePort") ? "9222\n/x" : null),
  mkdirp: () => {},
  rmrf: () => {},
})
const okSpawner: ProcessSpawner = {
  which: () => "/usr/bin/google-chrome",
  spawn: () => ({ pid: 1, kill: () => {}, exited: new Promise<number>(() => {}) }),
}
const idle: Scheduler = { schedule: () => () => {} }
const clock: Clock = { now: () => 0 }

describe("R4 [2] — abort threads into snapshot/cdp", () => {
  test("pre-aborted signal ⇒ snapshot cancelled (signal reached the CDP request)", async () => {
    const b = createCdpBrowser({
      spawner: okSpawner,
      transport: baseTransport,
      fs: okFs(),
      scheduler: idle,
      clock,
      profileRoot: "/jail/b",
    })
    const h = await b.spawn()
    expect(h.ok).toBe(true)
    if (!h.ok) return
    const ac = new AbortController()
    ac.abort()
    const r = await b.snapshot(h.value, undefined, ac.signal)
    expect(r.ok).toBe(false) // a snapshot with no signal would have succeeded
  })
})

describe("R4 [6] — throwing spawner cleans up the profile", () => {
  test("spawner.spawn throws ⇒ spawn-failed + profile rmrf'd", async () => {
    const rm: string[] = []
    const fs: BrowserFs = { ...okFs(), rmrf: (p) => rm.push(p) }
    const throwing: ProcessSpawner = {
      which: () => "/usr/bin/google-chrome",
      spawn: () => {
        throw new Error("EMFILE")
      },
    }
    const b = createCdpBrowser({
      spawner: throwing,
      transport: baseTransport,
      fs,
      scheduler: idle,
      clock,
      profileRoot: "/jail/b",
    })
    const r = await b.spawn()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("spawn-failed")
    expect(rm).toHaveLength(1) // the mkdir'd profile dir was removed despite the throw
  })
})

describe("R4 [8] — unique profile dir across adapters sharing a profileRoot", () => {
  test("two adapters with the SAME profileRoot mkdir DISTINCT dirs", async () => {
    const dirsA: string[] = []
    const dirsB: string[] = []
    const fsRec = (sink: string[]): BrowserFs => ({ ...okFs(), mkdirp: (p) => sink.push(p) })
    const a = createCdpBrowser({
      spawner: okSpawner,
      transport: baseTransport,
      fs: fsRec(dirsA),
      scheduler: idle,
      clock,
      profileRoot: "/shared",
    })
    const b = createCdpBrowser({
      spawner: okSpawner,
      transport: baseTransport,
      fs: fsRec(dirsB),
      scheduler: idle,
      clock,
      profileRoot: "/shared",
    })
    await a.spawn()
    await b.spawn()
    expect(dirsA[0]).toBeDefined()
    expect(dirsB[0]).toBeDefined()
    expect(dirsA[0]).not.toBe(dirsB[0]) // nonce makes them unique despite same root + same seq=1
  })
})
