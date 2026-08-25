/**
 * Hellgate for the S3-segment-backed {@link ReplayStore} adapter.
 *
 * The adapter must be a DROP-IN for `jsonlReplayStore`: same `append/match/
 * load/save/reset` semantics, same content-hash matching, same normalization —
 * so a cassette recorded via jsonl and via s3 are equivalent. These tests pin
 * that equivalence (cross-checking match() hits against a real jsonl store) and
 * the segment-level write discipline (one new segment per append, never a
 * whole-cassette re-PUT).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RemoteBackend } from "@/shared/remote-store"
import { segmentStore } from "@/shared/remote-store"
import { nth, present } from "../../../../tests/_helpers/expect-present"
import type { StreamEvent, StreamInput } from "../../types"
import { jsonlReplayStore } from "../jsonl-store"
import { s3ReplayStore } from "../s3-replay-store"
import type { RecordedInteraction } from "../types"

/**
 * Map-backed fake {@link RemoteBackend} that COUNTS puts and records every
 * (path, body) so a test can assert the exact write pattern (one put per
 * segment append, no whole-cassette re-PUT). `get` honors the not-found
 * contract (undefined, never throw).
 */
interface FakeBackend extends RemoteBackend {
  readonly puts: { path: string; body: string }[]
  readonly putCount: () => number
  readonly store: Map<string, string>
}

const fakeBackend = (): FakeBackend => {
  const store = new Map<string, string>()
  const puts: { path: string; body: string }[] = []
  return {
    store,
    puts,
    putCount: () => puts.length,
    async put(path, body) {
      puts.push({ path, body })
      store.set(path, body)
    },
    async get(path) {
      return store.get(path)
    },
    async list(prefix) {
      return [...store.keys()].filter((k) => k.startsWith(prefix))
    },
  }
}

/** Minimal valid StreamInput with a single user text message. */
const reqWithText = (text: string): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  tools: [],
})

const eventsFor = (reply: string): StreamEvent[] => [
  { type: "text_delta", delta: reply },
  { type: "usage", inputTokens: 1, outputTokens: 1, model: "test-model" },
]

const recordFor = (text: string, reply: string, recordedAt = 1000): RecordedInteraction => ({
  // `id` is informational on disk; match() rehashes the request, so the value
  // here is deliberately NOT the real hash (proves match() does not trust it).
  id: `placeholder-${text}`,
  request: reqWithText(text),
  events: eventsFor(reply),
  metadata: { recordedAt, model: "test-model", durationMs: 5 },
})

describe("s3ReplayStore — load order + byte fidelity", () => {
  it("append N records → load() returns them in order, byte-faithful", async () => {
    const be = fakeBackend()
    const store = s3ReplayStore({ store: segmentStore(be, "cassette/abc") })

    const recs = [recordFor("alpha", "A"), recordFor("bravo", "B"), recordFor("charlie", "C")]
    for (const r of recs) await store.append(r)

    const loaded = await store.load()
    expect(loaded).toHaveLength(3)
    // Byte-faithful: re-serialize loaded === re-serialize originals, in order.
    expect(loaded.map((r) => JSON.stringify(r))).toEqual(recs.map((r) => JSON.stringify(r)))
  })

  it("each append writes EXACTLY one new segment (no whole-cassette rewrite)", async () => {
    const be = fakeBackend()
    const store = s3ReplayStore({ store: segmentStore(be, "cassette/seg") })

    await store.append(recordFor("one", "1"))
    expect(be.putCount()).toBe(1)
    await store.append(recordFor("two", "2"))
    expect(be.putCount()).toBe(2)
    await store.append(recordFor("three", "3"))
    expect(be.putCount()).toBe(3)

    // Three distinct, monotonic, zero-padded segment paths — never a re-PUT of
    // an earlier seq.
    const paths = be.puts.map((p) => p.path).sort()
    expect(paths).toEqual([
      "cassette/seg/events/000000.json",
      "cassette/seg/events/000001.json",
      "cassette/seg/events/000002.json",
    ])
    // The fourth append adds a fourth object, not a rewrite of any prior one.
    await store.append(recordFor("four", "4"))
    expect(be.putCount()).toBe(4)
    expect(new Set(be.puts.map((p) => p.path)).size).toBe(4)
  })

  it("each segment body is exactly one JSON record (newline-free)", async () => {
    const be = fakeBackend()
    const store = s3ReplayStore({ store: segmentStore(be, "cassette/body") })
    const rec = recordFor("solo", "S")
    await store.append(rec)
    expect(be.puts).toHaveLength(1)
    const body = nth(be.puts, 0, "be.puts").body
    expect(body).toBe(JSON.stringify(rec))
    expect(body).not.toContain("\n")
  })

  it("monotonic seq survives a re-open (resumes after the highest existing seq)", async () => {
    const be = fakeBackend()
    const ss = segmentStore(be, "cassette/resume")
    const first = s3ReplayStore({ store: ss })
    await first.append(recordFor("a", "A"))
    await first.append(recordFor("b", "B"))

    // Fresh adapter over the SAME backend — must not clobber seq 0/1.
    const second = s3ReplayStore({ store: segmentStore(be, "cassette/resume") })
    await second.append(recordFor("c", "C"))

    const loaded = await second.load()
    expect(
      loaded.map(
        (r) =>
          (nth(r.request.messages, 0, "r.request.messages").content[0] as { text: string }).text,
      ),
    ).toEqual(["a", "b", "c"])
    expect(be.putCount()).toBe(3)
    expect(new Set(be.puts.map((p) => p.path)).size).toBe(3)
  })

  it("fails closed on a non-contiguous zero-based segment log", async () => {
    const be = fakeBackend()
    const ss = segmentStore(be, "cassette/hole")
    await ss.putSegment(0, JSON.stringify(recordFor("a", "A")))
    await ss.putSegment(2, JSON.stringify(recordFor("c", "C")))
    const store = s3ReplayStore({ store: ss })
    await expect(store.load()).rejects.toThrow(/expected contiguous segment 1/)
  })

  it("never overwrites an occupied malformed segment when appending", async () => {
    const be = fakeBackend()
    const ss = segmentStore(be, "cassette/malformed")
    await ss.putSegment(0, "not-json")
    const store = s3ReplayStore({ store: ss })
    await store.append(recordFor("next", "N"))
    expect(await ss.getSegment(0)).toBe("not-json")
    expect(await ss.getSegment(1)).toContain('"next"')
  })
})

describe("s3ReplayStore — match() parity with jsonlReplayStore", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "s3-replay-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("match() finds a recorded request by content hash, regardless of disk `id`", async () => {
    const be = fakeBackend()
    const store = s3ReplayStore({ store: segmentStore(be, "cassette/match") })
    await store.append(recordFor("find-me", "HIT"))
    await store.append(recordFor("other", "MISS"))

    const hit = await store.match(reqWithText("find-me"))
    expect(hit).not.toBeNull()
    expect((present(hit, "hit").events[0] as { delta: string }).delta).toBe("HIT")

    // A request not in the cassette misses.
    expect(await store.match(reqWithText("absent"))).toBeNull()
  })

  it("CROSS-CHECK: same interactions → jsonl + s3 return the SAME match for the same input", async () => {
    const recs = [
      recordFor("q-one", "ans-one"),
      recordFor("q-two", "ans-two"),
      recordFor("q-three", "ans-three"),
    ]

    const jsonl = jsonlReplayStore({ path: join(tmp, "cassette.jsonl") })
    const be = fakeBackend()
    const s3 = s3ReplayStore({ store: segmentStore(be, "cassette/xcheck") })

    for (const r of recs) {
      await jsonl.append(r)
      await s3.append(r)
    }

    for (const probe of ["q-one", "q-two", "q-three", "q-absent"]) {
      const jHit = await jsonl.match(reqWithText(probe))
      const sHit = await s3.match(reqWithText(probe))
      // Reset the used-markers between probes so each store sees a fresh window
      // (match() consumes a hit; we want to compare the SAME index each probe).
      jsonl.reset()
      s3.reset()
      if (jHit === null) {
        expect(sHit).toBeNull()
      } else {
        expect(sHit).not.toBeNull()
        expect(JSON.stringify(sHit)).toBe(JSON.stringify(jHit))
      }
    }
  })

  it("respects every MatchPolicy identically to jsonl (exact / messages-only / fuzzy-content)", async () => {
    // Two requests that differ ONLY in trailing whitespace — exact misses,
    // fuzzy-content hits. Pins that the s3 store reuses jsonl's normalization.
    const recorded = recordFor("hello world", "OK")
    const jsonl = jsonlReplayStore({ path: join(tmp, "policy.jsonl") })
    const be = fakeBackend()
    const s3 = s3ReplayStore({ store: segmentStore(be, "cassette/policy") })
    await jsonl.append(recorded)
    await s3.append(recorded)

    const probe = reqWithText("hello   world  ") // collapsed whitespace differs

    for (const policy of ["exact", "messages-only", "fuzzy-content"] as const) {
      const jHit = await jsonl.match(probe, { policy })
      const sHit = await s3.match(probe, { policy })
      jsonl.reset()
      s3.reset()
      if (jHit === null) expect(sHit).toBeNull()
      else expect(JSON.stringify(sHit)).toBe(JSON.stringify(jHit))
    }
  })

  it("match() consumes a hit (used-marker) and reset() restores it — like jsonl", async () => {
    const be = fakeBackend()
    const store = s3ReplayStore({ store: segmentStore(be, "cassette/used") })
    // Same request recorded twice ⇒ two distinct unused hits.
    await store.append(recordFor("dup", "first"))
    await store.append(recordFor("dup", "second"))

    const h1 = await store.match(reqWithText("dup"))
    const h2 = await store.match(reqWithText("dup"))
    const h3 = await store.match(reqWithText("dup"))
    expect((present(h1, "h1").events[0] as { delta: string }).delta).toBe("first")
    expect((present(h2, "h2").events[0] as { delta: string }).delta).toBe("second")
    expect(h3).toBeNull() // both consumed

    store.reset()
    const again = await store.match(reqWithText("dup"))
    expect((present(again, "again").events[0] as { delta: string }).delta).toBe("first")
  })
})

describe("s3ReplayStore — limit window + save()", () => {
  it("limit caps the eligible window (fork-at-N), matching jsonl semantics", async () => {
    const be = fakeBackend()
    const store = s3ReplayStore({ store: segmentStore(be, "cassette/limit"), limit: 1 })
    await store.append(recordFor("first", "1"))
    await store.append(recordFor("second", "2"))

    // index 0 is in-window → hit; index 1 is past the limit → miss.
    expect(await store.match(reqWithText("first"))).not.toBeNull()
    expect(await store.match(reqWithText("second"))).toBeNull()
  })

  it("save() overwrites the whole cassette and load() reflects it", async () => {
    const be = fakeBackend()
    const store = s3ReplayStore({ store: segmentStore(be, "cassette/save") })
    await store.append(recordFor("old", "X"))

    const fresh = [recordFor("new-a", "A"), recordFor("new-b", "B")]
    await store.save(fresh)

    const loaded = await store.load()
    expect(loaded.map((r) => JSON.stringify(r))).toEqual(fresh.map((r) => JSON.stringify(r)))
    // The stale "old" record is gone after the overwrite.
    expect(await store.match(reqWithText("old"))).toBeNull()
    expect(await store.match(reqWithText("new-a"))).not.toBeNull()
  })
})
