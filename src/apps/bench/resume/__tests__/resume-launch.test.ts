/**
 * Hellgate — bench-resume READ/LAUNCH path (`prepareResume`) + the worker
 * wiring that ships the recorded cassette + replay env to a relaunched box.
 *
 * The whole point: when a box is LOST and an ELIGIBLE cassette exists in S3, a
 * relaunch must REPLAY the recorded turns then diverge live — but ONLY behind
 * `resumeActive` (DEFAULT-OFF, byte-identical: the live campaign is untouched).
 *
 * TEETH:
 *   - default-off: prepareResume({}, id) ⇒ undefined and NEVER touches the store
 *     (a fresh run never reads S3). Byte-identical guard.
 *   - eligible receipt + segments ⇒ replayEnv carries BOTH replay keys and the
 *     materialized cassette file equals concat() of the segments.
 *   - fail-closed: degraded receipt ⇒ undefined; absent receipt ⇒ undefined;
 *     concat() throws (corrupt log) ⇒ undefined (NEVER a partial replay).
 *   - wiring-proof: a simulated LOST-instance requeue with resume active+eligible
 *     relaunches with QUANTA_BENCH_REPLAY_TRAJECTORY + record-and-passthrough +
 *     the resume S3 download knobs; with resume OFF the requeue env carries NONE
 *     of those keys (identical to the pre-existing fresh path).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { RemoteBackend } from "@/shared/remote-store"
import { type ResumeReceipt, segmentStore } from "@/shared/remote-store"
import { nth, present } from "../../../../../tests/_helpers/expect-present"
import { prepareResume } from "../resume-launch"
import type { ResumeStore } from "../store"

const CAMPAIGN = "camp-X"
const INSTANCE = "django__django-11138"

/** Map-backed fake backend that COUNTS gets so we can prove S3 is never touched
 *  on the default-off path. `get` honors the not-found contract (undefined). */
interface FakeBackend extends RemoteBackend {
  readonly gets: string[]
  readonly store: Map<string, string>
}
const fakeBackend = (): FakeBackend => {
  const store = new Map<string, string>()
  const gets: string[] = []
  return {
    store,
    gets,
    async put(path, body) {
      store.set(path, body)
    },
    async get(path) {
      gets.push(path)
      return store.get(path)
    },
    async list(prefix) {
      return [...store.keys()].filter((k) => k.startsWith(prefix))
    },
  }
}

const receipt = (over: Partial<ResumeReceipt> = {}): ResumeReceipt => ({
  key: `${CAMPAIGN}/${INSTANCE}`,
  campaignId: CAMPAIGN,
  instanceId: INSTANCE,
  latestSeq: 1,
  degraded: false,
  updatedAt: "2026-06-27T00:00:00Z",
  ...over,
})

/** Build a {@link ResumeStore} over a fake backend seeded with the given
 *  segments + receipt. Returned with the backend so a test can inspect gets. */
const seededStore = async (args: {
  segments?: readonly string[]
  receipt?: ResumeReceipt | undefined
  concatThrows?: boolean
}): Promise<{ store: ResumeStore; backend: FakeBackend }> => {
  const backend = fakeBackend()
  const key = `${CAMPAIGN}/${INSTANCE}`
  const segs = segmentStore(backend, key)
  const segments = args.segments ?? []
  for (let i = 0; i < segments.length; i++) {
    await segs.putSegment(i + 1, nth(segments, i, "segments"))
  }
  const rcpt = args.receipt
  const store: ResumeStore = {
    backend,
    segments: args.concatThrows
      ? { ...segs, concat: async () => Promise.reject(new Error("corrupt log")) }
      : segs,
    // replayStore is unused by prepareResume; a thin stub keeps the shape.
    replayStore: {} as ResumeStore["replayStore"],
    writeReceipt: async () => {},
    readReceipt: async () => rcpt,
  }
  return { store, backend }
}

const RESUME_ON_ENV = {
  QUANTA_BENCH_RESUME: "on",
  QUANTA_BENCH_RESUME_S3_BUCKET: "my-bucket",
  QUANTA_BENCH_CAMPAIGN_ID: CAMPAIGN,
} as const

describe("prepareResume — DEFAULT-OFF byte-identical guard", () => {
  test("resume OFF ⇒ undefined and the store is NEVER built/read", async () => {
    let built = false
    const out = await prepareResume({}, INSTANCE, {
      makeStore: () => {
        built = true
        throw new Error("must not build a store when resume is OFF")
      },
    })
    expect(out).toBeUndefined()
    expect(built).toBe(false)
  })

  test("enabled but NO bucket ⇒ still OFF (fail-closed) ⇒ undefined, no store", async () => {
    let built = false
    const out = await prepareResume({ QUANTA_BENCH_RESUME: "on" }, INSTANCE, {
      makeStore: () => {
        built = true
        throw new Error("no bucket ⇒ not active ⇒ must not build a store")
      },
    })
    expect(out).toBeUndefined()
    expect(built).toBe(false)
  })
})

describe("prepareResume — eligible ⇒ materialize cassette + replay env", () => {
  test("eligible receipt + segments ⇒ replayEnv has both keys + file == concat()", async () => {
    const segments = ['{"seq":1,"turn":"a"}', '{"seq":2,"turn":"b"}']
    const { store, backend } = await seededStore({ segments, receipt: receipt() })
    const expectedConcat = await segmentStore(backend, `${CAMPAIGN}/${INSTANCE}`).concat()

    const out = await prepareResume(RESUME_ON_ENV, INSTANCE, { makeStore: () => store })
    expect(out).toBeDefined()
    const prepared = present(out, "prepareResume result")
    expect(out?.replayEnv.QUANTA_BENCH_REPLAY_TRAJECTORY).toBe(prepared.localCassettePath)
    expect(out?.replayEnv.QUANTA_BENCH_REPLAY_ON_MISS).toBe("record-and-passthrough")
    // The materialized cassette is byte-equal to the concatenated segment log.
    const onDisk = readFileSync(prepared.localCassettePath, "utf8")
    expect(onDisk).toBe(expectedConcat)
    expect(onDisk).toContain('"turn":"a"')
    expect(onDisk).toContain('"turn":"b"')
  })

  test("passes the correct resumeKey (campaign/instance) to the store factory", async () => {
    const { store } = await seededStore({ segments: ["x"], receipt: receipt() })
    let seenKey: string | undefined
    await prepareResume(RESUME_ON_ENV, INSTANCE, {
      makeStore: (_cfg, key) => {
        seenKey = key
        return store
      },
    })
    expect(seenKey).toBe(`${CAMPAIGN}/${INSTANCE}`)
  })
})

describe("prepareResume — FAIL-CLOSED (broken cassette ⇒ fresh, never partial)", () => {
  test("degraded receipt ⇒ undefined (NOT eligible)", async () => {
    const { store } = await seededStore({
      segments: ["x"],
      receipt: receipt({ degraded: true }),
    })
    expect(await prepareResume(RESUME_ON_ENV, INSTANCE, { makeStore: () => store })).toBeUndefined()
  })

  test("absent receipt ⇒ undefined (NOT eligible)", async () => {
    const { store } = await seededStore({ segments: ["x"], receipt: undefined })
    expect(await prepareResume(RESUME_ON_ENV, INSTANCE, { makeStore: () => store })).toBeUndefined()
  })

  test("concat() throws (corrupt log) ⇒ undefined — NOT a partial replay", async () => {
    const { store } = await seededStore({
      segments: ["x"],
      receipt: receipt(),
      concatThrows: true,
    })
    expect(await prepareResume(RESUME_ON_ENV, INSTANCE, { makeStore: () => store })).toBeUndefined()
  })

  test("a store-factory throw (S3 read failure) ⇒ undefined, never throws", async () => {
    const out = await prepareResume(RESUME_ON_ENV, INSTANCE, {
      makeStore: () => {
        throw new Error("aws creds boom")
      },
    })
    expect(out).toBeUndefined()
  })
})

/* ── WIRING-PROOF: lost-instance requeue carries the replay env to the box ──── */

import { buildForwardedBenchEnv } from "@/apps/bench/remote/box-session"
import type { PoolChunk } from "@/apps/bench/remote/pool/types"
import { resumeForwardEnvFor } from "@/apps/bench/remote/pool/worker"
import { resumeReplayBoxEnv } from "../resume-launch"

const singleInstanceChunk: PoolChunk = {
  runId: "lost-1",
  datasetPath: "/tmp/lost-1.jsonl",
  instanceIds: [INSTANCE],
}

describe("wiring-proof — worker resumeForwardEnvFor (relaunch forward prefix)", () => {
  test("resume active + single-instance chunk ⇒ forward prefix carries resume knobs", () => {
    const prefix = resumeForwardEnvFor(singleInstanceChunk, RESUME_ON_ENV)
    expect(prefix).toContain("QUANTA_BENCH_RESUME=")
    expect(prefix).toContain("QUANTA_BENCH_RESUME_S3_BUCKET=")
    expect(prefix).toContain(`QUANTA_BENCH_INSTANCE_ID=`)
    expect(prefix).toContain("django__django-11138")
    // The worker forwards KNOBS, NOT a local cassette path (box downloads it).
    expect(prefix).not.toContain("QUANTA_BENCH_REPLAY_TRAJECTORY")
  })

  test("resume OFF ⇒ EMPTY forward prefix (fresh requeue byte-identical)", () => {
    expect(resumeForwardEnvFor(singleInstanceChunk, {})).toBe("")
  })

  test("enabled but no bucket ⇒ EMPTY (fail-closed, fresh)", () => {
    expect(resumeForwardEnvFor(singleInstanceChunk, { QUANTA_BENCH_RESUME: "on" })).toBe("")
  })

  test("multi-instance chunk ⇒ EMPTY (resume is pinned chunk-size=1)", () => {
    const multi: PoolChunk = {
      runId: "lost-multi",
      datasetPath: "/tmp/lost-multi.jsonl",
      instanceIds: [INSTANCE, "other__inst-2"],
    }
    expect(resumeForwardEnvFor(multi, RESUME_ON_ENV)).toBe("")
  })

  test("chunk with NO instanceIds ⇒ EMPTY (no single resume key)", () => {
    const noIds: PoolChunk = { runId: "lost-none", datasetPath: "/tmp/lost-none.jsonl" }
    expect(resumeForwardEnvFor(noIds, RESUME_ON_ENV)).toBe("")
  })
})

describe("wiring-proof — relaunch env after a LOST instance", () => {
  test("resume active+eligible ⇒ box env carries replay keys + S3 download knobs", () => {
    // The box DOWNLOADS its own cassette from S3 (it has aws creds + the resume
    // env), so the worker forwards the resume knobs rather than a local file.
    const boxEnv = resumeReplayBoxEnv({
      campaignId: CAMPAIGN,
      instanceId: INSTANCE,
      bucket: "my-bucket",
      region: "us-east-1",
    })
    expect(boxEnv.QUANTA_BENCH_RESUME).toBe("on")
    expect(boxEnv.QUANTA_BENCH_RESUME_S3_BUCKET).toBe("my-bucket")
    expect(boxEnv.QUANTA_BENCH_CAMPAIGN_ID).toBe(CAMPAIGN)
    expect(boxEnv.QUANTA_BENCH_INSTANCE_ID).toBe(INSTANCE)
    // The box-side prepareResume sets REPLAY_TRAJECTORY itself after download, so
    // the box also needs the on-miss policy to diverge live after the cassette.
    expect(boxEnv.QUANTA_BENCH_REPLAY_ON_MISS).toBe("record-and-passthrough")

    // The forwarded prefix must SURVIVE the box-session guard (no local replay
    // path ⇒ no throw) and carry the resume knobs into the box command.
    const forwarded = buildForwardedBenchEnv({ ...boxEnv } as NodeJS.ProcessEnv)
    expect(forwarded).toContain("QUANTA_BENCH_RESUME=")
    expect(forwarded).toContain("QUANTA_BENCH_INSTANCE_ID=")
    expect(forwarded).toContain("QUANTA_BENCH_CAMPAIGN_ID=")
  })

  test("resume OFF ⇒ box env carries NO replay/resume keys (fresh path byte-identical)", () => {
    const boxEnv = resumeReplayBoxEnv(undefined)
    expect(boxEnv).toEqual({})
    const forwarded = buildForwardedBenchEnv({ ...boxEnv } as NodeJS.ProcessEnv)
    expect(forwarded).not.toContain("QUANTA_BENCH_REPLAY")
    expect(forwarded).not.toContain("QUANTA_BENCH_RESUME")
    expect(forwarded).not.toContain("QUANTA_BENCH_INSTANCE_ID")
  })
})
