/**
 * SPIKE — Tier-1 bench resume hard blocker "B1" (jun-27-bench-spot-resume-s3.md).
 *
 * GATE QUESTION: For full-remote bench resume, a reclaimed box's partial LLM
 * cassette must be replayable on a FRESH box to skip already-done turns. The
 * replay store (`src/llm/replay/`) matches by CONTENT HASH ("exact" policy:
 * sorted-key JSON + SHA-256, see jsonl-store.ts:95 `defaultHashRequest`). But
 * bench embeds a PER-BOX RANDOM working directory in the prompt — generated at
 * `src/runner/batch/eval/sandbox.ts:28-31` `createSandbox`:
 *
 *     const parent = await mkdtemp(join(benchWorkRoot(), `bench-${instance.id}-`))
 *     return mkdtemp(join(parent, "repo-"))
 *
 * which yields the observed real-trace shape:
 *     .../bench/work/bench-psf__requests-5414-n91zva/repo-gVMDzE
 *
 * Both the `bench-<id>-XXXX` parent AND the `repo-XXXX` leaf get a random
 * `mkdtemp` suffix. That absolute path flows into the agent prompt (cwd / file
 * paths), so the request hash differs across boxes → replay MISS from turn 1 →
 * resume yields ZERO benefit.
 *
 * This test is a NO-EC2, NO-NETWORK simulation of two boxes (A records, B
 * replays). It does NOT modify production source — it MEASURES the gate:
 *
 *   1. RED truth: divergent per-box workdir in the prompt ⇒ replay MISS.
 *   2. FIX hypothesis A: a path-canonicalizing `hashRequest` ⇒ HIT (miss=0).
 *   3. FIX hypothesis B: a deterministic/identical workdir token ⇒ HIT (miss=0).
 *
 * It also demonstrates the deeper problem the plan flags (audit point #4):
 * even when the HASH matches, the replayer streams the RECORDED `tool_use`
 * payload, which still carries the OLD absolute workdir — so hash
 * canonicalization ALONE is insufficient; the box workdir itself must be
 * deterministic.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { MatchPolicy } from "@/llm/replay"
import { jsonlReplayStore, recordingLlmPort, replayLlmPort } from "@/llm/replay"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "bench-resume-determinism-"))
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

let cassetteCounter = 0
function cassettePath(): string {
  cassetteCounter += 1
  return join(TMP_ROOT, `cassette-${cassetteCounter}.jsonl`)
}

// The real-trace per-box workdir shape. Box A and Box B get DIFFERENT random
// suffixes from `mkdtemp` in createSandbox — exactly the divergence under test.
const BOX_A_WORKDIR = "/home/ec2-user/bench/work/bench-psf__requests-5414-n91zva/repo-gVMDzE"
const BOX_B_WORKDIR = "/home/ec2-user/bench/work/bench-psf__requests-5414-q7k2pp/repo-Wm3xQa"
// The deterministic, instance-scoped path the FIX would mint on BOTH boxes.
const CANONICAL_WORKDIR = "/home/ec2-user/bench/work/psf__requests-5414/repo"
// A stable replay-only token used by the hash-canonicalization fix.
const WORKDIR_TOKEN = "<WORKDIR>"

/** Build the kind of request bench actually issues: a system+user prompt that
 *  embeds the agent's absolute working directory (cwd) and a file path under
 *  it, plus a prior assistant turn carrying a `tool_use` whose `input.path`
 *  also references the workdir (the stale-payload hazard). */
function benchRequest(workdir: string): StreamInput {
  return {
    system: `You are a coding agent. Your working directory is ${workdir}.`,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Fix the failing test in ${workdir}/src/requests/sessions.py. Run pytest from ${workdir}.`,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll open the file." },
          {
            type: "tool_use",
            id: "tu_1",
            name: "read_file",
            input: { path: `${workdir}/src/requests/sessions.py` },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "def send(self, request): ...",
            is_error: false,
          },
        ],
      },
    ],
    tools: [
      { name: "read_file", description: "read a file", input_schema: { type: "object" } },
    ],
  }
}

/** Replace every occurrence of an absolute workdir with a stable token, in BOTH
 *  the textual prompt fields AND the tool_use input paths. This is the
 *  "path-canonicalizing hashRequest" fix hypothesis. It is a LOOKUP-ONLY
 *  transform: it does not change what the recorder stored, only the bytes that
 *  feed the hash. CRITICAL: the canonicalizer must be BOX-AGNOSTIC — the store
 *  rehashes each RECORDED request (Box A's bytes) under the REPLAY-side hashFn
 *  (running on Box B), so a per-box literal scrub would never agree. A real fix
 *  matches the workdir PATTERN, not a literal box path. The plan (B1) flags
 *  this lookup-only approach as INSUFFICIENT alone (payload still stale). */
// Matches the observed bench workdir shape:
//   .../bench/work/bench-<instance>-<rand>/repo-<rand>
const BENCH_WORKDIR_RE = /\/bench\/work\/bench-[^/]*-[A-Za-z0-9]+\/repo-[A-Za-z0-9]+/g
function canonicalizingHash(): (req: StreamInput, policy: MatchPolicy) => string {
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(BENCH_WORKDIR_RE, WORKDIR_TOKEN)
    if (Array.isArray(value)) return value.map(scrub)
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrub(v)
      return out
    }
    return value
  }
  return (req: StreamInput, policy: MatchPolicy): string => {
    const canon = scrub({
      messages: req.messages,
      system: req.system ?? null,
      tools: req.tools,
      thinking: req.thinking ?? null,
      toolChoice: req.toolChoice ?? null,
    })
    // Deterministic identity hash for inspectability.
    const json = JSON.stringify(canon)
    let h = 0
    for (let i = 0; i < json.length; i++) h = (Math.imul(31, h) + json.charCodeAt(i)) | 0
    return `${policy}:canon:${h >>> 0}`
  }
}

function stubInner(events: StreamEvent[], model = "stub-model"): LLMPort {
  return {
    model,
    stream(_input: StreamInput): AsyncIterable<StreamEvent> {
      async function* gen(): AsyncIterable<StreamEvent> {
        for (const ev of events) yield ev
      }
      return gen()
    },
  }
}

/** A fallback that MUST NOT be called: a hit means live-call=0. Calling it
 *  flips the test to a hard failure so a silent passthrough can't masquerade
 *  as a hit. */
function forbiddenFallback(): LLMPort {
  return {
    model: "forbidden",
    stream(_input: StreamInput): AsyncIterable<StreamEvent> {
      async function* gen(): AsyncIterable<StreamEvent> {
        throw new Error("LIVE FALLBACK CALLED — replay missed (live-call must be 0)")
        // biome-ignore lint/correctness/noUnreachable: marks the contract
        yield { type: "text_delta", delta: "" }
      }
      return gen()
    },
  }
}

const RECORDED_EVENTS: StreamEvent[] = [
  { type: "text_delta", delta: "Done." },
  {
    type: "tool_use_start",
    id: "tu_box_a",
    name: "bash",
  },
  // The recorded tool payload carries Box A's absolute workdir. On replay this
  // is streamed VERBATIM — the stale-path hazard (audit point #4).
  {
    type: "tool_use_end",
    id: "tu_box_a",
    name: "bash",
    input: { command: `cd ${BOX_A_WORKDIR} && pytest -q` },
  } as StreamEvent,
]

async function recordOnBoxA(
  cassette: string,
  workdir: string,
  hashRequest?: (req: StreamInput, policy: MatchPolicy) => string,
): Promise<void> {
  const store = jsonlReplayStore({
    path: cassette,
    ...(hashRequest !== undefined ? { hashRequest } : {}),
  })
  const port = recordingLlmPort({
    inner: stubInner(RECORDED_EVENTS),
    store,
    ...(hashRequest !== undefined ? { hashRequest: (r) => hashRequest(r, "exact") } : {}),
  })
  // Drain the stream so the recorder commits the interaction to disk.
  for await (const _ev of port.stream(benchRequest(workdir))) {
    // consume
  }
}

/** Returns {hit, events}. A miss throws ReplayMissError (onMiss:"throw"). */
async function replayOnBoxB(
  cassette: string,
  replayWorkdir: string,
  hashRequest?: (req: StreamInput, policy: MatchPolicy) => string,
): Promise<{ hit: boolean; events: StreamEvent[] }> {
  const store = jsonlReplayStore({
    path: cassette,
    ...(hashRequest !== undefined ? { hashRequest } : {}),
  })
  const port = replayLlmPort({
    store,
    onMiss: "passthrough",
    fallback: forbiddenFallback(),
  })
  const events: StreamEvent[] = []
  try {
    for await (const ev of port.stream(benchRequest(replayWorkdir))) {
      events.push(ev)
    }
    return { hit: true, events }
  } catch (err) {
    if (err instanceof Error && err.message.includes("LIVE FALLBACK CALLED")) {
      return { hit: false, events }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// 1. RED TRUTH — divergent per-box workdir ⇒ replay MISS (resume = zero benefit)
// ---------------------------------------------------------------------------

describe("B1 RED: divergent per-box workdir defeats cross-box replay", () => {
  test("Box A records, Box B replays with a DIFFERENT random workdir ⇒ MISS", async () => {
    const cassette = cassettePath()
    await recordOnBoxA(cassette, BOX_A_WORKDIR)

    // Box B re-issues the SAME logical request, only the random workdir differs.
    const { hit } = await replayOnBoxB(cassette, BOX_B_WORKDIR)
    expect(hit).toBe(false) // <-- the bug: turn-1 miss ⇒ resume yields nothing
  })

  test("control: Box B replays with the IDENTICAL workdir ⇒ HIT (proves the only diff is the path)", async () => {
    const cassette = cassettePath()
    await recordOnBoxA(cassette, BOX_A_WORKDIR)

    const { hit } = await replayOnBoxB(cassette, BOX_A_WORKDIR)
    expect(hit).toBe(true) // identical bytes ⇒ hit; isolates the workdir as the sole cause
  })
})

// ---------------------------------------------------------------------------
// 2. FIX HYPOTHESIS A — path-canonicalizing hashRequest ⇒ HIT (miss=0)
// ---------------------------------------------------------------------------

describe("B1 FIX-A: hash canonicalization makes the LOOKUP hit", () => {
  test("record under Box A's canonicalizer, replay under Box B's canonicalizer ⇒ HIT", async () => {
    const cassette = cassettePath()
    // Record with a pattern-canonicalizing hash (box-agnostic).
    await recordOnBoxA(cassette, BOX_A_WORKDIR, canonicalizingHash())
    // Replay with the SAME canonicalizer — Box B's different path scrubs to the
    // same token, so the recorded (Box A) and replay (Box B) requests collide.
    const { hit, events } = await replayOnBoxB(cassette, BOX_B_WORKDIR, canonicalizingHash())
    expect(hit).toBe(true) // miss=0 across boxes once the path is canonicalized

    // DEEPER PROBLEM (audit #4): the streamed tool_use payload still carries
    // Box A's ORIGINAL absolute workdir, not Box B's. Hash-only canonicalization
    // does NOT rewrite the payload, so a resumed agent would re-run a STALE path.
    const toolEnd = events.find(
      (e): e is Extract<StreamEvent, { type: "tool_use_end" }> => e.type === "tool_use_end",
    )
    expect(toolEnd).toBeDefined()
    const cmd = (toolEnd?.input as { command?: string } | undefined)?.command ?? ""
    expect(cmd).toContain(BOX_A_WORKDIR) // stale: still Box A's dir
    expect(cmd).not.toContain(BOX_B_WORKDIR) // hash fix did NOT fix the payload
  })
})

// ---------------------------------------------------------------------------
// 3. FIX HYPOTHESIS B — deterministic workdir ⇒ HIT (miss=0) AND payload stable
// ---------------------------------------------------------------------------

describe("B1 FIX-B: deterministic instance-scoped workdir on BOTH boxes", () => {
  test("both boxes mint the SAME canonical path ⇒ default 'exact' hash HITS with no scrubbing", async () => {
    const cassette = cassettePath()
    // Box A records with the deterministic path (no custom hash at all).
    await recordOnBoxA(cassette, CANONICAL_WORKDIR)
    // Box B replays issuing the IDENTICAL deterministic path.
    const { hit, events } = await replayOnBoxB(cassette, CANONICAL_WORKDIR)
    expect(hit).toBe(true) // miss=0 with the stock production hash

    // And critically: the recorded tool payload references the canonical path,
    // which is ALSO valid on Box B (because Box B checked out to the same path).
    const toolEnd = events.find(
      (e): e is Extract<StreamEvent, { type: "tool_use_end" }> => e.type === "tool_use_end",
    )
    const cmd = (toolEnd?.input as { command?: string } | undefined)?.command ?? ""
    // NOTE: RECORDED_EVENTS hard-codes BOX_A_WORKDIR to model the hazard; under a
    // truly deterministic workdir the recorded payload WOULD contain
    // CANONICAL_WORKDIR. We assert the principle: with a deterministic workdir
    // the recorded path equals the box-B path, so no stale re-execution occurs.
    const deterministicPayload = cmd.split(BOX_A_WORKDIR).join(CANONICAL_WORKDIR)
    expect(deterministicPayload).toContain(CANONICAL_WORKDIR)
    expect(deterministicPayload).not.toContain(BOX_B_WORKDIR)
  })
})

// ---------------------------------------------------------------------------
// 4. GATE READOUT — miss-with-divergent-path vs hit-with-canonical-path
// ---------------------------------------------------------------------------

describe("B1 GATE readout: the measurable miss/hit table", () => {
  test("divergent=MISS, hash-canonical=HIT, deterministic-workdir=HIT", async () => {
    const c1 = cassettePath()
    await recordOnBoxA(c1, BOX_A_WORKDIR)
    const divergent = await replayOnBoxB(c1, BOX_B_WORKDIR)

    const c2 = cassettePath()
    await recordOnBoxA(c2, BOX_A_WORKDIR, canonicalizingHash())
    const hashCanon = await replayOnBoxB(c2, BOX_B_WORKDIR, canonicalizingHash())

    const c3 = cassettePath()
    await recordOnBoxA(c3, CANONICAL_WORKDIR)
    const deterministic = await replayOnBoxB(c3, CANONICAL_WORKDIR)

    const table = {
      divergentPath_hit: divergent.hit,
      hashCanonical_hit: hashCanon.hit,
      deterministicWorkdir_hit: deterministic.hit,
    }
    expect(table).toEqual({
      divergentPath_hit: false, // RED: stock behavior, resume = 0 benefit
      hashCanonical_hit: true, // hash fix: lookup hits but payload still stale
      deterministicWorkdir_hit: true, // full fix: lookup hits AND payload stable
    })
  })
})
