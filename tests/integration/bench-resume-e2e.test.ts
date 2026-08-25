/**
 * KEYSTONE end-to-end SEAM test for bench spot-resume.
 *
 * Every PIECE of this feature is unit-tested in isolation (the recorder tee,
 * the segment store, the receipt gate, prepareResume's fail-closed branches,
 * the replay/recording LLM ports). What is NOT proven anywhere else is their
 * COMPOSITION — that a real recording run lands BOTH locally and durably, that
 * a reclaimed box (only S3 left) can be turned back into a replayable cassette,
 * and that re-issuing the recorded requests skips the LLM entirely (miss=0).
 * That whole-flow "does the feature actually work" proof is THIS file.
 *
 * THE FLOW (record → durable → reclaim → resume → continue with NO re-call):
 *   1. RECORD   — drive the real recorder (maybeTeeResumeRecording) over a FAKE
 *                 in-memory durable backend and a deterministic stub LLMPort.
 *                 Interactions must land in the LOCAL jsonl AND as S3 segments,
 *                 with a non-degraded receipt {degraded:false, latestSeq:N}.
 *   2. RECLAIM  — discard the local jsonl + the live port (the "box"); keep ONLY
 *                 what reached the fake durable backend (segments + receipt),
 *                 exactly as a reclaimed spot box leaves behind only what hit S3.
 *   3. RESUME   — prepareResume(env, instanceId, {makeStore}) reads the eligible
 *                 receipt, concat()s the segments into a local cassette, and
 *                 returns replayEnv with QUANTA_BENCH_REPLAY_TRAJECTORY +
 *                 QUANTA_BENCH_REPLAY_ON_MISS=record-and-passthrough.
 *   4. REPLAY+CONTINUE — a replayLlmPort over the downloaded cassette (with a
 *                 COUNTING live fallback per record-and-passthrough) re-issues
 *                 the SAME recorded requests: every recorded turn is a cassette
 *                 HIT (fallback called 0 times), and a NEW request beyond the
 *                 cassette falls through to live (passthrough). This is the core
 *                 value prop: resume skips the already-done LLM work.
 *
 * DETERMINISM NOTE (load-bearing): this test issues IDENTICAL request bytes for
 * record vs replay. The match policy is content-hash "exact", so a hit requires
 * the messages/system/tools/etc. to be byte-stable across the record and replay
 * passes. We make that true by construction here (same in-memory request
 * objects). In a REAL cross-box resume this stability is NOT free: it depends on
 * the chunk-size=1 + deterministic stable-workdir assumption gated in
 * `sandbox.ts` (a wandering temp path or non-deterministic tool ordering would
 * change the request bytes and turn every "hit" into a live miss). This test
 * deliberately does NOT exercise that flag — it isolates the resume SEAM, not
 * cross-box request determinism.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resumeKey } from "@/apps/bench/resume/identity"
import { teeResumeReplayStore } from "@/apps/bench/resume/recorder"
import { prepareResume } from "@/apps/bench/resume/resume-launch"
import { type ResumeStore, resumeStore } from "@/apps/bench/resume/store"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { jsonlReplayStore, recordingLlmPort, replayLlmPort, s3ReplayStore } from "@/llm/replay"
import {
  isResumeEligible,
  type RemoteBackend,
  type ResumeSecurityReceipt,
  readReceipt,
  segmentStore,
  writeReceipt,
} from "@/shared/remote-store"
import { nth, present } from "../_helpers/expect-present"

// ── Fakes ────────────────────────────────────────────────────────────────────

/**
 * Map-backed fake {@link RemoteBackend} — the same pattern established in
 * `src/shared/remote-store/__tests__/remote-store.test.ts`. Honors the not-found
 * contract (get ⇒ undefined, never throws) and records every put so we can
 * assert exactly what reached "S3". THIS is the only durable state that survives
 * the simulated box reclaim.
 */
interface FakeBackend extends RemoteBackend {
  readonly puts: { path: string; body: string }[]
  readonly store: Map<string, string>
}

const fakeBackend = (): FakeBackend => {
  const store = new Map<string, string>()
  const puts: { path: string; body: string }[] = []
  return {
    store,
    puts,
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

/**
 * Deterministic stub LLMPort: every stream() yields a fixed event sequence
 * derived from the FIRST user text block, so a given request always produces
 * the same recorded events (the record-side "live" model).
 */
const stubLlm = (): LLMPort => ({
  model: "stub-model",
  stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const firstUserText =
      input.messages.find((m) => m.role === "user")?.content.find((b) => b.type === "text") ?? null
    const tag = firstUserText !== null && firstUserText.type === "text" ? firstUserText.text : "?"
    async function* run(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", delta: `reply-to:${tag}` }
      yield { type: "message_stop", stop_reason: "end_turn" }
    }
    return run()
  },
})

/**
 * Counting live fallback used on the REPLAY side. The whole value-prop assertion
 * is that this is NEVER invoked for a recorded turn (a hit serves from the
 * cassette). It IS invoked exactly once for the NEW (passthrough) request.
 */
const countingLlm = (): { port: LLMPort; calls: () => number } => {
  let calls = 0
  return {
    calls: () => calls,
    port: {
      model: "live-fallback-model",
      stream(input: StreamInput): AsyncIterable<StreamEvent> {
        calls++
        const firstUserText =
          input.messages.find((m) => m.role === "user")?.content.find((b) => b.type === "text") ??
          null
        const tag =
          firstUserText !== null && firstUserText.type === "text" ? firstUserText.text : "?"
        async function* run(): AsyncIterable<StreamEvent> {
          yield { type: "text_delta", delta: `LIVE-reply-to:${tag}` }
          yield { type: "message_stop", stop_reason: "end_turn" }
        }
        return run()
      },
    },
  }
}

/** Minimal exact-match request keyed by a single user text block. tools=[] +
 *  no system ⇒ the "exact" content hash is stable across record/replay. */
const req = (text: string): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  tools: [],
})

const drain = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

// ── Shared env (resume ACTIVE: gate on + bucket configured) ──────────────────

const CAMPAIGN = "spot-resume-e2e"
const INSTANCE = "django__django-12345"
const KEY = resumeKey({ campaignId: CAMPAIGN, instanceId: INSTANCE })
const SECURITY: ResumeSecurityReceipt = {
  schema: "quanta.resume-security.v1",
  bucket: "fake-bucket",
  keyPrefix: KEY,
  kmsKeyArn: "arn:aws:kms:us-east-1:123:key/k",
  principalArn: "arn:aws:iam::123:role/resume",
  retentionDays: 7,
  prefixLeastPrivilege: true,
  publicAccessBlocked: true,
  verifiedAt: "2026-08-25T00:00:00Z",
}

const activeEnv = (): Record<string, string | undefined> => ({
  QUANTA_BENCH_RESUME: "on",
  QUANTA_BENCH_RESUME_S3_BUCKET: "fake-bucket",
  QUANTA_BENCH_CAMPAIGN_ID: CAMPAIGN,
  QUANTA_BENCH_INSTANCE_ID: INSTANCE,
  QUANTA_BENCH_RESUME_KMS_KEY_ARN: SECURITY.kmsKeyArn,
  QUANTA_BENCH_RESUME_PRINCIPAL_ARN: SECURITY.principalArn,
  QUANTA_BENCH_RESUME_MAX_RETENTION_DAYS: "7",
})

const tmpDirs: string[] = []
const mkTmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "bench-resume-e2e-"))
  tmpDirs.push(d)
  return d
}
afterEach(() => {
  // Best-effort cleanup; the OS tmp reaper also handles these.
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describe("bench spot-resume KEYSTONE e2e (record → durable → reclaim → resume → continue)", () => {
  it("records to BOTH local jsonl + S3 segments, then replays every recorded turn as a HIT (miss=0) and passes a NEW request through to live", async () => {
    // ── 1. RECORD ────────────────────────────────────────────────────────────
    // The "box": a local trajectory jsonl (primary, authoritative) tee'd to a
    // durable S3 segment store (secondary) — composed exactly as the real
    // `maybeTeeResumeRecording` composes them, but with the fake backend so no
    // real S3/aws is touched.
    const backend = fakeBackend()
    const localDir = mkTmp()
    const localTrajectory = join(localDir, "bench-trajectory.jsonl")

    const primary = jsonlReplayStore({ path: localTrajectory })
    const durableSegments = segmentStore(backend, KEY)
    const secondary = s3ReplayStore({ store: durableSegments })

    const recordStore = teeResumeReplayStore({
      primary,
      secondary,
      key: KEY,
      campaignId: CAMPAIGN,
      instanceId: INSTANCE,
      writeReceipt: (r) => writeReceipt(backend, KEY, r),
      securityReceipt: async () => SECURITY,
    })

    const recordingPort = recordingLlmPort({ inner: stubLlm(), store: recordStore })

    // Three deterministic recorded turns (the "already-done LLM work").
    const recordedRequests = [req("turn-1"), req("turn-2"), req("turn-3")]
    const recordedEventsByTurn: StreamEvent[][] = []
    for (const r of recordedRequests) {
      recordedEventsByTurn.push(await drain(recordingPort.stream(r)))
    }

    // Local jsonl got all 3 (one line each).
    const localLines = readFileSync(localTrajectory, "utf-8").trim().split("\n")
    expect(localLines).toHaveLength(3)

    // S3 got 3 event segments + a receipt object — durable mirror landed.
    const eventSegPaths = backend.puts
      .map((p) => p.path)
      .filter((p) => p.startsWith(`${KEY}/events/`))
    expect(new Set(eventSegPaths).size).toBe(3)

    // The receipt is non-degraded and points at all 3 recorded turns.
    const receipt = await readReceipt(backend, KEY)
    expect(receipt).toBeDefined()
    expect(receipt?.degraded).toBe(false)
    expect(receipt?.latestSeq).toBe(3)
    expect(isResumeEligible(receipt)).toBe(true)

    // Cross-check: the durable segments concat to byte-identical lines as the
    // local jsonl (the two stores recorded the SAME records).
    const concatenated = await durableSegments.concat()
    expect(concatenated.split("\n")).toEqual(localLines)

    // ── 2. RECLAIM (simulate) ────────────────────────────────────────────────
    // Discard the box: forget the local jsonl path and the live recording port.
    // Only `backend` (segments + receipt) survives — exactly what a reclaimed
    // spot box leaves behind in S3.
    const durableSnapshot = new Map(backend.store) // what reached "S3"
    expect([...durableSnapshot.keys()].some((k) => k === `${KEY}/resume-state.json`)).toBe(true)

    // The fresh box has a brand-new backend pre-loaded with ONLY the S3 state.
    const reclaimedBackend: FakeBackend = (() => {
      const be = fakeBackend()
      for (const [k, v] of durableSnapshot) be.store.set(k, v)
      return be
    })()

    // ── 3. RESUME ────────────────────────────────────────────────────────────
    // prepareResume exposes a `makeStore` test seam (resume-launch.ts:60). We
    // inject a ResumeStore over the reclaimed durable backend so no real S3 is
    // hit; the workDir seam pins where the materialized cassette lands.
    const resumeWorkDir = mkTmp()
    const makeStore = (_cfg: { bucket: string; region?: string }, key: string): ResumeStore => {
      // Compose the real resumeStore but with a runAws that is never reached —
      // we override the backend entirely by going through segmentStore directly.
      // Simpler + faithful: build a ResumeStore whose layers point at the
      // reclaimed backend (mirrors store.ts composition with an injected backend).
      const segs = segmentStore(reclaimedBackend, key)
      const replay = s3ReplayStore({ store: segs })
      return {
        backend: reclaimedBackend,
        segments: segs,
        replayStore: replay,
        writeReceipt: (r) => writeReceipt(reclaimedBackend, key, r),
        readReceipt: () => readReceipt(reclaimedBackend, key),
        securityReceipt: async () => SECURITY,
      }
    }
    void resumeStore // referenced for documentation parity; real composition above

    const prepared = await prepareResume(activeEnv(), INSTANCE, {
      makeStore,
      workDir: resumeWorkDir,
      log: () => {},
    })

    expect(prepared).toBeDefined()
    if (prepared === undefined) throw new Error("unreachable")
    expect(prepared.replayEnv.QUANTA_BENCH_REPLAY_ON_MISS).toBe("record-and-passthrough")
    expect(prepared.replayEnv.QUANTA_BENCH_REPLAY_TRAJECTORY).toBe(prepared.localCassettePath)

    // The downloaded cassette equals the concatenated durable segments exactly.
    const downloaded = readFileSync(prepared.localCassettePath, "utf-8")
    expect(downloaded).toBe(concatenated)
    expect(downloaded.trim().split("\n")).toEqual(localLines)

    // ── 4. REPLAY + CONTINUE ─────────────────────────────────────────────────
    // Build the replay port over the downloaded cassette with a COUNTING live
    // fallback, per record-and-passthrough. Re-issue the SAME recorded requests.
    const live = countingLlm()
    const cassetteStore = jsonlReplayStore({ path: prepared.localCassettePath })
    const replayPort = replayLlmPort({
      store: cassetteStore,
      onMiss: "record-and-passthrough",
      fallback: live.port,
    })

    let misses = 0
    for (let i = 0; i < recordedRequests.length; i++) {
      const events = await drain(replayPort.stream(nth(recordedRequests, i, "recordedRequests")))
      // A HIT replays the recorded events verbatim — NOT the LIVE-prefixed ones.
      expect(events).toEqual(nth(recordedEventsByTurn, i, "recordedEventsByTurn"))
      const isHit = events.some(
        (e) => e.type === "text_delta" && e.delta === `reply-to:turn-${i + 1}`,
      )
      if (!isHit) misses++
    }

    // CORE VALUE PROP: every recorded turn was served from the cassette ⇒ the
    // live fallback was NEVER called for those turns. miss == 0.
    expect(misses).toBe(0)
    expect(live.calls()).toBe(0)

    // ── PASSTHROUGH: a NEW request beyond the cassette falls through to live ──
    const newEvents = await drain(replayPort.stream(req("turn-4-NEW")))
    expect(live.calls()).toBe(1) // exactly the one new request hit live
    expect(newEvents).toEqual([
      { type: "text_delta", delta: "LIVE-reply-to:turn-4-NEW" },
      { type: "message_stop", stop_reason: "end_turn" },
    ])

    // record-and-passthrough also EXTENDS the cassette: the new turn was recorded.
    const afterLoad = await cassetteStore.load()
    expect(afterLoad).toHaveLength(4)
  })

  it("NEGATIVE control: a DEGRADED receipt ⇒ prepareResume returns undefined ⇒ a FRESH run (no replay)", async () => {
    // Record one healthy turn, then FORCE the receipt degraded (as a secondary
    // S3 error would during a real run) — the durable state is now ineligible.
    const backend = fakeBackend()
    const localDir = mkTmp()
    const primary = jsonlReplayStore({ path: join(localDir, "t.jsonl") })
    const durableSegments = segmentStore(backend, KEY)
    const secondary = s3ReplayStore({ store: durableSegments })
    const store = teeResumeReplayStore({
      primary,
      secondary,
      key: KEY,
      campaignId: CAMPAIGN,
      instanceId: INSTANCE,
      writeReceipt: (r) => writeReceipt(backend, KEY, r),
      securityReceipt: async () => SECURITY,
    })
    await drain(recordingLlmPort({ inner: stubLlm(), store }).stream(req("turn-1")))

    // Overwrite the receipt with a degraded one (the fail-closed marker).
    const healthy = await readReceipt(backend, KEY)
    expect(healthy?.degraded).toBe(false)
    await writeReceipt(backend, KEY, { ...present(healthy, "healthy receipt"), degraded: true })
    expect(isResumeEligible(await readReceipt(backend, KEY))).toBe(false)

    const makeStore = (_cfg: { bucket: string; region?: string }, key: string): ResumeStore => {
      const segs = segmentStore(backend, key)
      return {
        backend,
        segments: segs,
        replayStore: s3ReplayStore({ store: segs }),
        writeReceipt: (r) => writeReceipt(backend, key, r),
        readReceipt: () => readReceipt(backend, key),
        securityReceipt: async () => SECURITY,
      }
    }

    const prepared = await prepareResume(activeEnv(), INSTANCE, { makeStore, log: () => {} })
    // Fail-CLOSED: a degraded receipt is NEVER half-replayed ⇒ undefined ⇒ fresh.
    expect(prepared).toBeUndefined()
  })

  it("NEGATIVE control: resume OFF (gate unset) ⇒ prepareResume returns undefined without touching the store", async () => {
    // Byte-identical default-OFF posture: no makeStore should even be consulted.
    let storeBuilt = false
    const makeStore = (): ResumeStore => {
      storeBuilt = true
      throw new Error("makeStore must NOT be called when resume is OFF")
    }
    const prepared = await prepareResume(
      { QUANTA_BENCH_INSTANCE_ID: INSTANCE }, // gate unset ⇒ resume inactive
      INSTANCE,
      { makeStore, log: () => {} },
    )
    expect(prepared).toBeUndefined()
    expect(storeBuilt).toBe(false)
  })
})
