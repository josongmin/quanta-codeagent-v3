/**
 * ADR-0132 Phase A — TriggerSourcePort coverage for the CI + PR-comment
 * adapters. Both adapters share the closed-port shape: gh subprocess
 * (`GhCliPort`) + clock + (in-memory) dedup/watermark store. Tests build
 * canned-JSON `GhCliPort` fakes so the adapter logic is exercised without
 * a real `gh` binary.
 */

import { describe, expect, test } from "bun:test"
import {
  ALL_TRIGGER_REASONS,
  type ClockPort,
  createCiTriggerSource,
  createInMemorySeenRuns,
  createInMemoryWatermarkStore,
  createPrCommentTriggerSource,
  type GhCliPort,
  type GhCliResult,
  type SeenRunsStore,
  type TriggerSourcePort,
  type WatermarkStore,
} from "@/reactor"

/** Stable clock fixture — every test gets a predictable `now`. */
const fixedClock = (at: number): ClockPort => ({ now: () => at })

/** Build a recording fake `GhCliPort` that returns canned results per arg
 *  tuple. The recorder lets us assert WHICH `gh` invocations happened. */
interface FakeGhSetup {
  readonly port: GhCliPort
  readonly calls: ReadonlyArray<{ args: readonly string[]; cwd: string }>
}
const fakeGhPort = (
  responses: ReadonlyArray<{
    match: (args: readonly string[]) => boolean
    result: GhCliResult | Error
  }>,
): FakeGhSetup => {
  const calls: Array<{ args: readonly string[]; cwd: string }> = []
  const port: GhCliPort = {
    run: async (args, cwd) => {
      calls.push({ args, cwd })
      for (const r of responses) {
        if (r.match(args)) {
          if (r.result instanceof Error) throw r.result
          return r.result
        }
      }
      // No match ⇒ "I don't know" (exit 1, stderr-only).
      return { stdout: "", stderr: "no canned response", exitCode: 1 }
    },
  }
  return { port, calls }
}

const ok = (json: unknown): GhCliResult => ({
  stdout: JSON.stringify(json),
  stderr: "",
  exitCode: 0,
})

const fail = (stderr: string): GhCliResult => ({
  stdout: "",
  stderr,
  exitCode: 1,
})

describe("ADR-0132 — TriggerReason union", () => {
  test("ALL_TRIGGER_REASONS contains the six documented reasons in stable order", () => {
    expect(ALL_TRIGGER_REASONS).toEqual([
      "ci_completion",
      "pr_comment",
      "build_completion",
      "diff_ready",
      "test_pass",
      "manual_resume",
    ])
  })
})

describe("ADR-0132 Phase A — createCiTriggerSource", () => {
  test("gh exits 0 with a COMPLETED check ⇒ one trigger of reason ci_completion", async () => {
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "pr" && a[1] === "checks",
        result: ok([
          {
            name: "unit",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            link: "https://github.com/owner/repo/actions/runs/42",
          },
        ]),
      },
      {
        match: (a) => a[0] === "pr" && a[1] === "view",
        result: ok({ url: "https://github.com/owner/repo/pull/7", number: 7 }),
      },
    ])
    const src = createCiTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(1_000_000),
      repoCwd: "/tmp/repo",
      prRef: "7",
    })
    const out = await src.poll()
    expect(out.length).toBe(1)
    const t = out[0]
    if (t === undefined) throw new Error("unreachable")
    expect(t.reason).toBe("ci_completion")
    expect(t.evidence.kind).toBe("url")
    expect(t.evidence.value).toBe("https://github.com/owner/repo/pull/7")
    expect(t.simulatedMessage).toContain("CI completed on PR 7")
    expect(t.simulatedMessage).toContain("1 passed")
  })

  test("gh exit 1 (network failure / unknown ref) ⇒ no trigger (degraded gracefully)", async () => {
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "pr" && a[1] === "checks",
        result: fail("could not resolve PR"),
      },
    ])
    const src = createCiTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(1),
      repoCwd: "/tmp/repo",
      prRef: "x",
    })
    expect(await src.poll()).toEqual([])
  })

  test("gh throws (spawn failure) ⇒ no trigger (collapsed to empty array)", async () => {
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "pr",
        result: new Error("ENOENT: no gh binary"),
      },
    ])
    const src = createCiTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(1),
      repoCwd: "/tmp/repo",
      prRef: "1",
    })
    expect(await src.poll()).toEqual([])
  })

  test("stdout is not valid JSON ⇒ no trigger", async () => {
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "pr" && a[1] === "checks",
        result: { stdout: "<<not json>>", stderr: "", exitCode: 0 },
      },
    ])
    const src = createCiTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(1),
      repoCwd: "/tmp/repo",
      prRef: "1",
    })
    expect(await src.poll()).toEqual([])
  })

  test("no COMPLETED rows (all IN_PROGRESS / QUEUED) ⇒ no trigger", async () => {
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "pr" && a[1] === "checks",
        result: ok([
          { name: "lint", status: "IN_PROGRESS" },
          { name: "test", status: "QUEUED" },
        ]),
      },
    ])
    const src = createCiTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(1),
      repoCwd: "/tmp/repo",
      prRef: "1",
    })
    expect(await src.poll()).toEqual([])
  })

  test("same completed run on a second poll ⇒ deduped (no re-fire)", async () => {
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "pr" && a[1] === "checks",
        result: ok([
          {
            name: "unit",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            link: "https://example/runs/1",
          },
        ]),
      },
      {
        match: (a) => a[0] === "pr" && a[1] === "view",
        result: ok({ url: "https://example/pr/1", number: 1 }),
      },
    ])
    const src = createCiTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(1),
      repoCwd: "/tmp/repo",
      prRef: "1",
    })
    const first = await src.poll()
    expect(first.length).toBe(1)
    const second = await src.poll()
    expect(second).toEqual([])
  })

  test("NEW completed run after the previous one was deduped ⇒ fires once", async () => {
    let phase = 0
    const port: GhCliPort = {
      run: async (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return ok({ url: "https://example/pr/3", number: 3 })
        }
        if (args[0] === "pr" && args[1] === "checks") {
          phase++
          if (phase === 1) {
            return ok([
              {
                name: "unit",
                status: "COMPLETED",
                conclusion: "SUCCESS",
                link: "https://example/runs/a",
              },
            ])
          }
          return ok([
            {
              name: "unit",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              link: "https://example/runs/a",
            },
            {
              name: "e2e",
              status: "COMPLETED",
              conclusion: "FAILURE",
              link: "https://example/runs/b",
            },
          ])
        }
        return fail("nope")
      },
    }
    const src = createCiTriggerSource({
      ghCliPort: port,
      clockPort: fixedClock(1),
      repoCwd: "/tmp/repo",
      prRef: "3",
    })
    expect((await src.poll()).length).toBe(1)
    const next = await src.poll()
    expect(next.length).toBe(1)
    if (next[0] === undefined) throw new Error("unreachable")
    // The first run was deduped on the second poll, so the summary covers
    // only the NEW failed run.
    expect(next[0].simulatedMessage).toContain("1 failed")
    expect(next[0].simulatedMessage).not.toContain("1 passed")
  })

  test("abortSignal already aborted ⇒ poll short-circuits to empty", async () => {
    const gh = fakeGhPort([])
    const src = createCiTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(1),
      repoCwd: "/tmp/repo",
      prRef: "1",
    })
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await src.poll({ signal: ctrl.signal })).toEqual([])
    expect(gh.calls).toEqual([])
  })

  test("custom SeenRunsStore is honored — pre-seeded run is suppressed", async () => {
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "pr" && a[1] === "checks",
        result: ok([
          {
            name: "unit",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            link: "https://example/runs/known",
          },
        ]),
      },
      {
        match: (a) => a[0] === "pr" && a[1] === "view",
        result: ok({ url: "https://example/pr/9", number: 9 }),
      },
    ])
    const seeded = new Set<string>(["https://example/runs/known"])
    const store: SeenRunsStore = {
      has: (id) => seeded.has(id),
      add: (id) => {
        seeded.add(id)
      },
    }
    const src = createCiTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(1),
      repoCwd: "/tmp/repo",
      prRef: "9",
      seenRunsStore: store,
    })
    expect(await src.poll()).toEqual([])
  })

  test("createInMemorySeenRuns caps at 1024 entries (LRU-ish eviction)", () => {
    const store = createInMemorySeenRuns()
    for (let i = 0; i < 1100; i++) store.add(`run-${i}`)
    // First ~76 entries should be evicted (1100 - 1024).
    expect(store.has("run-0")).toBe(false)
    expect(store.has("run-50")).toBe(false)
    // Latest entries retained.
    expect(store.has("run-1099")).toBe(true)
    expect(store.has("run-1024")).toBe(true)
  })

  test("link missing ⇒ falls back to name+conclusion+bucket dedup tuple", async () => {
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "pr" && a[1] === "checks",
        result: ok([
          {
            name: "build",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            bucket: "pass",
          },
        ]),
      },
      {
        match: (a) => a[0] === "pr" && a[1] === "view",
        result: ok({ url: "https://example/pr/2", number: 2 }),
      },
    ])
    const src = createCiTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(1),
      repoCwd: "/tmp/repo",
      prRef: "2",
    })
    expect((await src.poll()).length).toBe(1)
    // Second poll with IDENTICAL row ⇒ dedup hits the tuple key.
    expect(await src.poll()).toEqual([])
  })

  test("pr view fails after checks succeed ⇒ trigger uses gh:// fallback URL", async () => {
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "pr" && a[1] === "checks",
        result: ok([
          {
            name: "unit",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            link: "https://example/runs/z",
          },
        ]),
      },
      {
        match: (a) => a[0] === "pr" && a[1] === "view",
        result: fail("view denied"),
      },
    ])
    const src = createCiTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(1),
      repoCwd: "/tmp/repo",
      prRef: "42",
    })
    const triggers = await src.poll()
    expect(triggers.length).toBe(1)
    if (triggers[0] === undefined) throw new Error("unreachable")
    expect(triggers[0].evidence.value).toBe("gh://pr/42")
  })

  test("pr view is cached — only one `pr view` call across multiple polls", async () => {
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "pr" && a[1] === "checks",
        result: ok([
          {
            name: "unit",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            link: "https://example/runs/cache-1",
          },
        ]),
      },
      {
        match: (a) => a[0] === "pr" && a[1] === "view",
        result: ok({ url: "https://example/pr/77", number: 77 }),
      },
    ])
    const src = createCiTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(1),
      repoCwd: "/tmp/repo",
      prRef: "77",
    })
    await src.poll()
    await src.poll() // second poll: dedupes the run; no need to re-fetch view.
    const viewCalls = gh.calls.filter((c) => c.args[1] === "view")
    expect(viewCalls.length).toBe(1)
  })

  test("abort after checks but before dedup commit returns [] and re-fires on the next poll", async () => {
    const seen = new Set<string>()
    const ctrl = new AbortController()
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "pr" && a[1] === "checks",
        result: ok([
          {
            name: "unit",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            link: "https://example/runs/retryable",
          },
        ]),
      },
      {
        match: (a) => a[0] === "pr" && a[1] === "view",
        result: {
          stdout: JSON.stringify({ url: "https://example/pr/retryable", number: 1 }),
          stderr: "",
          exitCode: 0,
        },
      },
    ])
    const src = createCiTriggerSource({
      ghCliPort: {
        run: async (args, cwd, signal) => {
          const out = await gh.port.run(args, cwd, signal)
          if (args[0] === "pr" && args[1] === "view") ctrl.abort()
          return out
        },
      },
      clockPort: fixedClock(1),
      repoCwd: "/tmp/repo",
      prRef: "1",
      seenRunsStore: {
        has: (id) => seen.has(id),
        add: (id) => {
          seen.add(id)
        },
      },
    })
    expect(await src.poll({ signal: ctrl.signal })).toEqual([])
    expect(ctrl.signal.aborted).toBe(true)
    expect(seen.size).toBe(0)
    const next = await src.poll()
    expect(next).toHaveLength(1)
    expect(seen.has("https://example/runs/retryable")).toBe(true)
  })

  test("materialized CI trigger is detached from later poll aborts", async () => {
    const ctrl = new AbortController()
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "pr" && a[1] === "checks",
        result: ok([
          {
            name: "unit",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            link: "https://example/runs/detached",
          },
        ]),
      },
      {
        match: (a) => a[0] === "pr" && a[1] === "view",
        result: ok({ url: "https://example/pr/detached", number: 1 }),
      },
    ])
    const src = createCiTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(1),
      repoCwd: "/tmp/repo",
      prRef: "1",
    })
    const triggers = await src.poll({ signal: ctrl.signal })
    expect(triggers).toHaveLength(1)
    ctrl.abort()
    expect(triggers[0]?.abortSignal.aborted).toBe(false)
    // Detachment invariant: outer poll signal flipped, materialized trigger
    // signal MUST NOT have followed it.
    expect(ctrl.signal.aborted).toBe(true)
  })
})

describe("ADR-0132 Phase A — createPrCommentTriggerSource", () => {
  test("first poll seeds the watermark and emits no triggers (no backfill)", async () => {
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "api",
        result: ok([{ id: 1, body: "stale", html_url: "https://example/c/1" }]),
      },
    ])
    const store = createInMemoryWatermarkStore()
    const src = createPrCommentTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(Date.UTC(2026, 4, 24, 12, 0, 0)),
      repoCwd: "/tmp/repo",
      repoSlug: "owner/repo",
      prNumber: 5,
      watermarkKey: "owner/repo#5",
      watermarkStore: store,
    })
    expect(await src.poll()).toEqual([])
    // Watermark was seeded.
    expect(await store.load("owner/repo#5")).toBeDefined()
    // No `gh api` call should have been made on the first poll (seed-only).
    expect(gh.calls.length).toBe(0)
  })

  test("subsequent poll surfaces only comments strictly newer than the watermark", async () => {
    const baseStamp = "2026-05-24T12:00:00Z"
    const store: WatermarkStore = {
      load: async () => baseStamp,
      save: async () => {
        /* no-op for this assertion */
      },
    }
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "api",
        result: ok([
          // Same stamp as watermark → must be skipped (since is inclusive).
          {
            id: 1,
            body: "old",
            html_url: "https://example/c/1",
            updated_at: baseStamp,
            user: { login: "alice" },
          },
          // Newer → must fire.
          {
            id: 2,
            body: "fresh take",
            html_url: "https://example/c/2",
            updated_at: "2026-05-24T13:00:00Z",
            user: { login: "bob" },
          },
        ]),
      },
    ])
    const src = createPrCommentTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(0),
      repoCwd: "/tmp/repo",
      repoSlug: "owner/repo",
      prNumber: 5,
      watermarkKey: "wk",
      watermarkStore: store,
    })
    const triggers = await src.poll()
    expect(triggers.length).toBe(1)
    if (triggers[0] === undefined) throw new Error("unreachable")
    expect(triggers[0].reason).toBe("pr_comment")
    expect(triggers[0].evidence.value).toBe("https://example/c/2")
    expect(triggers[0].simulatedMessage).toContain("@bob")
    expect(triggers[0].simulatedMessage).toContain("fresh take")
  })

  test("watermark is advanced to the max stamp across the batch", async () => {
    let saved: string | undefined
    const store: WatermarkStore = {
      load: async () => "2026-05-24T00:00:00Z",
      save: async (_k, v) => {
        saved = v
      },
    }
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "api",
        result: ok([
          {
            id: 1,
            body: "a",
            html_url: "https://example/c/a",
            updated_at: "2026-05-24T11:00:00Z",
            user: { login: "u" },
          },
          {
            id: 2,
            body: "b",
            html_url: "https://example/c/b",
            updated_at: "2026-05-24T15:00:00Z",
            user: { login: "u" },
          },
          {
            id: 3,
            body: "c",
            html_url: "https://example/c/c",
            updated_at: "2026-05-24T09:00:00Z",
            user: { login: "u" },
          },
        ]),
      },
    ])
    const src = createPrCommentTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(0),
      repoCwd: "/tmp/repo",
      repoSlug: "owner/repo",
      prNumber: 5,
      watermarkKey: "wk",
      watermarkStore: store,
    })
    await src.poll()
    expect(saved).toBe("2026-05-24T15:00:00Z")
  })

  test("body longer than 280 chars is clamped with ellipsis", async () => {
    const longBody = "x".repeat(1000)
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "api",
        result: ok([
          {
            id: 1,
            body: longBody,
            html_url: "https://example/c/long",
            updated_at: "2026-05-24T13:00:00Z",
            user: { login: "u" },
          },
        ]),
      },
    ])
    const store: WatermarkStore = {
      load: async () => "2026-05-24T12:00:00Z",
      save: async () => {
        /* no-op */
      },
    }
    const src = createPrCommentTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(0),
      repoCwd: "/tmp/repo",
      repoSlug: "owner/repo",
      prNumber: 5,
      watermarkKey: "wk",
      watermarkStore: store,
    })
    const out = await src.poll()
    expect(out.length).toBe(1)
    if (out[0] === undefined) throw new Error("unreachable")
    // Trigger message includes prefix "New PR comment from ..." + clamped body.
    expect(out[0].simulatedMessage.length).toBeLessThan(400)
    expect(out[0].simulatedMessage.endsWith("…")).toBe(true)
  })

  test("api failure (gh exit 1) ⇒ no triggers; watermark intact", async () => {
    let savedCalls = 0
    const store: WatermarkStore = {
      load: async () => "2026-05-24T12:00:00Z",
      save: async () => {
        savedCalls++
      },
    }
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "api",
        result: fail("rate-limited"),
      },
    ])
    const src = createPrCommentTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(0),
      repoCwd: "/tmp/repo",
      repoSlug: "owner/repo",
      prNumber: 5,
      watermarkKey: "wk",
      watermarkStore: store,
    })
    expect(await src.poll()).toEqual([])
    expect(savedCalls).toBe(0)
  })

  test("aborted signal short-circuits poll without calling gh", async () => {
    const gh = fakeGhPort([
      {
        match: () => true,
        result: ok([]),
      },
    ])
    const store = createInMemoryWatermarkStore()
    await store.save("wk", "2026-05-24T12:00:00Z")
    const src = createPrCommentTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(0),
      repoCwd: "/tmp/repo",
      repoSlug: "owner/repo",
      prNumber: 5,
      watermarkKey: "wk",
      watermarkStore: store,
    })
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await src.poll({ signal: ctrl.signal })).toEqual([])
    expect(gh.calls.length).toBe(0)
  })

  test("watermark load failure collapses to [] and does not call gh", async () => {
    const errors: string[] = []
    const gh = fakeGhPort([
      {
        match: () => true,
        result: ok([]),
      },
    ])
    const src = createPrCommentTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(0),
      repoCwd: "/tmp/repo",
      repoSlug: "owner/repo",
      prNumber: 5,
      watermarkKey: "wk",
      watermarkStore: {
        load: async () => {
          throw new Error("disk unreadable")
        },
        save: async () => {},
      },
      onError: (message) => errors.push(message),
    })
    expect(await src.poll()).toEqual([])
    expect(gh.calls.length).toBe(0)
    expect(errors[0]).toContain("watermark.load failed")
  })

  test("watermark save failure collapses to [] and leaves the watermark unchanged", async () => {
    let saved = 0
    const errors: string[] = []
    const store: WatermarkStore = {
      load: async () => "2026-05-24T12:00:00Z",
      save: async () => {
        saved += 1
        throw new Error("disk full")
      },
    }
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "api",
        result: ok([
          {
            id: 1,
            body: "fresh",
            html_url: "https://example/c/fresh",
            updated_at: "2026-05-24T13:00:00Z",
            user: { login: "u" },
          },
        ]),
      },
    ])
    const src = createPrCommentTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(0),
      repoCwd: "/tmp/repo",
      repoSlug: "owner/repo",
      prNumber: 5,
      watermarkKey: "wk",
      watermarkStore: store,
      onError: (message) => errors.push(message),
    })
    expect(await src.poll()).toEqual([])
    expect(saved).toBe(1)
    expect(errors[0]).toContain("watermark.save failed")
  })

  test("abort after fetch but before watermark advance returns [] and preserves replay", async () => {
    let watermark = "2026-05-24T12:00:00Z"
    const ctrl = new AbortController()
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "api",
        result: ok([
          {
            id: 1,
            body: "fresh",
            html_url: "https://example/c/abortable",
            updated_at: "2026-05-24T13:00:00Z",
            user: { login: "u" },
          },
        ]),
      },
    ])
    const src = createPrCommentTriggerSource({
      ghCliPort: {
        run: async (args, cwd, signal) => {
          const out = await gh.port.run(args, cwd, signal)
          ctrl.abort()
          return out
        },
      },
      clockPort: fixedClock(0),
      repoCwd: "/tmp/repo",
      repoSlug: "owner/repo",
      prNumber: 5,
      watermarkKey: "wk",
      watermarkStore: {
        load: async () => watermark,
        save: async (_k, v) => {
          watermark = v
        },
      },
    })
    expect(await src.poll({ signal: ctrl.signal })).toEqual([])
    expect(ctrl.signal.aborted).toBe(true)
    expect(watermark).toBe("2026-05-24T12:00:00Z")
    const next = await src.poll()
    expect(next).toHaveLength(1)
    expect(watermark).toBe("2026-05-24T13:00:00Z")
  })

  test("materialized PR-comment trigger is detached from later poll aborts", async () => {
    const ctrl = new AbortController()
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "api",
        result: ok([
          {
            id: 1,
            body: "fresh",
            html_url: "https://example/c/detached",
            updated_at: "2026-05-24T13:00:00Z",
            user: { login: "u" },
          },
        ]),
      },
    ])
    const src = createPrCommentTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(0),
      repoCwd: "/tmp/repo",
      repoSlug: "owner/repo",
      prNumber: 5,
      watermarkKey: "wk",
      watermarkStore: {
        load: async () => "2026-05-24T12:00:00Z",
        save: async () => {},
      },
    })
    const triggers = await src.poll({ signal: ctrl.signal })
    expect(triggers).toHaveLength(1)
    ctrl.abort()
    expect(triggers[0]?.abortSignal.aborted).toBe(false)
    // Outer poll signal MUST have flipped while the materialized child stayed clean.
    expect(ctrl.signal.aborted).toBe(true)
  })

  test("comment without html_url is skipped (no evidence anchor)", async () => {
    const store: WatermarkStore = {
      load: async () => "2026-05-24T12:00:00Z",
      save: async () => {},
    }
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "api",
        result: ok([
          {
            id: 1,
            body: "no url",
            updated_at: "2026-05-24T13:00:00Z",
            user: { login: "u" },
          },
        ]),
      },
    ])
    const src = createPrCommentTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(0),
      repoCwd: "/tmp/repo",
      repoSlug: "owner/repo",
      prNumber: 5,
      watermarkKey: "wk",
      watermarkStore: store,
    })
    expect(await src.poll()).toEqual([])
  })

  test("returns triggers as a frozen array (no mutation by callers)", async () => {
    const store: WatermarkStore = {
      load: async () => "2026-05-24T12:00:00Z",
      save: async () => {},
    }
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "api",
        result: ok([
          {
            id: 1,
            body: "x",
            html_url: "https://example/c/1",
            updated_at: "2026-05-24T13:00:00Z",
            user: { login: "u" },
          },
        ]),
      },
    ])
    const src = createPrCommentTriggerSource({
      ghCliPort: gh.port,
      clockPort: fixedClock(0),
      repoCwd: "/tmp/repo",
      repoSlug: "owner/repo",
      prNumber: 5,
      watermarkKey: "wk",
      watermarkStore: store,
    })
    const out = await src.poll()
    expect(out.length).toBe(1)
    if (out[0] === undefined) throw new Error("unreachable")
    expect(Object.isFrozen(out[0])).toBe(true)
    expect(Object.isFrozen(out[0].evidence)).toBe(true)
  })
})

describe("ADR-0132 Phase A — abort-signal propagation", () => {
  test("CI source: poll() passes the caller signal to gh.run", async () => {
    const observedSignals: Array<AbortSignal | undefined> = []
    const port: GhCliPort = {
      run: async (_args, _cwd, signal) => {
        observedSignals.push(signal)
        return ok([])
      },
    }
    const src: TriggerSourcePort = createCiTriggerSource({
      ghCliPort: port,
      clockPort: fixedClock(1),
      repoCwd: "/tmp/repo",
      prRef: "1",
    })
    const ctrl = new AbortController()
    await src.poll({ signal: ctrl.signal })
    expect(observedSignals.length).toBeGreaterThanOrEqual(1)
    expect(observedSignals[0]).toBe(ctrl.signal)
  })
})
