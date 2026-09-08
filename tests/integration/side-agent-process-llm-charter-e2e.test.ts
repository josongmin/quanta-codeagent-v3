/**
 * D1 HELLGATE e2e — the OS-process side-agent CHILD runs a REAL LLM-backed
 * bounded agent pass (NOT the deterministic stub).
 *
 * Hermetic (no API keys): the child drives a REAL subagent loop whose LLMPort is
 * the project's REPLAY adapter, fed a cassette recorded the robust way (drive the
 * SAME child charter path once with `recordingLlmPort` wrapping a SCRIPTED
 * LLMPort, dump the cassette, then replay it). Recording guarantees the
 * StreamInput the loop emits matches on replay.
 *
 * RED-ON-INJECTION (the teeth): the surfaced finding MUST carry the model-derived
 * sentinel (`sentinel-7f3a` / `FOUND: stale lockfile`) AND MUST NOT carry the
 * deterministic stub's signature (`inheritedEnvKeys=` / `deterministic bounded
 * pass`). If the child ignored replay and ran the stub (or degraded), the
 * sentinel is absent ⇒ this test FAILS. Before the impl exists, the production
 * worker only knows the deterministic pass ⇒ this test is RED.
 *
 * The fork path is REAL: `createProcessSideAgentDaemonRegistry` over the REAL
 * `nodeProcessForkPort`, mirroring `side-agent-process-os-fork-e2e.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { jsonlReplayStore, recordingLlmPort } from "@/llm/replay"
import {
  nodeProcessForkPort,
  sideAgentWorkerModulePath,
} from "../../src/host/runtime/side-agent-fork-port"
import { createProcessSideAgentDaemonRegistry, type SideAgentSpec } from "../../src/side-agent"
// The child composition root under test (STEP 2). Importing it RED-FIRST proves
// the e2e drives the real production path: this module does not exist yet, so the
// recording helper (and thus the test) fails until the impl lands.
import { runCharterPassLLM } from "../../src/side-agent/worker-charter-runner"

// ── The distinctive, MODEL-derived sentinel + the deterministic-stub signature.
const SENTINEL_SUMMARY = "FOUND: stale lockfile in /tmp/x (sentinel-7f3a)"
const SENTINEL_TOKEN = "sentinel-7f3a"
const DETERMINISTIC_SIGNATURE = "inheritedEnvKeys="
const DETERMINISTIC_SIGNATURE_2 = "deterministic bounded pass"

const CHARTER_TASK = "scan /tmp for a stale lockfile and report it"

const FIXTURE = fileURLToPath(
  new URL("../fixtures/side-agent-llm-charter.cassette.jsonl", import.meta.url),
)
const FIXTURE_BYTES = readFileSync(FIXTURE, "utf8")

let CASSETTE_DIR: string
let CASSETTE_PATH: string

/** Real one-shot scheduler (node timers) — mirrors the OS-fork e2e. */
const realScheduler = {
  schedule: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  cancel: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/** Poll until `pred()` or timeout. */
const waitFor = async (pred: () => boolean, timeoutMs = 30_000): Promise<boolean> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return pred()
}

/**
 * A SCRIPTED LLMPort that, on the FIRST turn, emits the sentinel finding as a
 * final text answer (no tool call) so the bounded subagent loop completes in one
 * turn with `finalText` = the sentinel. This stands in for a real model whose
 * output carries a distinctive finding text.
 */
const scriptedSentinelLlm = (): LLMPort => ({
  model: "scripted-sentinel",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", delta: SENTINEL_SUMMARY }
      yield { type: "message_stop", stop_reason: "end_turn" }
    }
    return gen()
  },
})

/**
 * Record the cassette the ROBUST way: drive the REAL child charter path ONCE
 * with `recordingLlmPort` wrapping the scripted LLMPort, so the recorded
 * StreamInput is byte-for-byte what the child's loop emits ⇒ replay hits.
 */
const recordCassette = async (): Promise<void> => {
  const store = jsonlReplayStore({ path: CASSETTE_PATH })
  const recording = recordingLlmPort({ inner: scriptedSentinelLlm(), store })
  const finding = await runCharterPassLLM(
    { task: CHARTER_TASK, maxTurnsPerWake: 2 },
    {},
    { llmPort: recording },
  )
  // Sanity: the in-process recording pass itself produced the model finding.
  if (finding.outcome !== "finding" || !finding.finding.summary.includes(SENTINEL_TOKEN)) {
    throw new Error(
      `recording pass did not surface the sentinel finding (got ${JSON.stringify(finding)})`,
    )
  }
  // Keep the recording run hermetic: the spawned child consumes this temporary
  // cassette, while the committed fixture remains immutable test evidence.
  await store.save(await store.load())
}

beforeAll(async () => {
  CASSETTE_DIR = mkdtempSync(join(tmpdir(), "quanta-sa-llm-charter-"))
  CASSETTE_PATH = join(CASSETTE_DIR, "charter.cassette.jsonl")
  await recordCassette()
})

afterAll(() => {
  expect(readFileSync(FIXTURE, "utf8")).toBe(FIXTURE_BYTES)
  rmSync(CASSETTE_DIR, { recursive: true, force: true })
})

describe("D1 — process side-agent CHILD runs a REAL replayed LLM charter pass", () => {
  const spec = (over: Partial<SideAgentSpec> = {}): SideAgentSpec => ({
    task: CHARTER_TASK,
    trigger: { kind: "interval", everyMs: 60_000 },
    maxWakes: 1,
    maxTurnsPerWake: 2,
    ...over,
  })

  test("forked production worker replays the cassette ⇒ finding is MODEL-derived", async () => {
    // Real registry → real supervisor → real fork → the PRODUCTION worker module.
    // The child env carries the replay cassette path; the child MUST build a real
    // replay-backed subagent and surface the model's sentinel finding.
    const reg = createProcessSideAgentDaemonRegistry({
      fork: nodeProcessForkPort,
      scheduler: realScheduler,
      now: () => Date.now(),
      workerModulePath: sideAgentWorkerModulePath(),
      childEnv: { QUANTA_SIDE_AGENT_LLM_REPLAY: CASSETTE_PATH },
    })
    const id = reg.spawn(spec())

    const got = await waitFor(() => reg.findings().length > 0)
    expect(got).toBe(true)
    const finding = reg.findings()[0]
    expect(finding?.daemonId).toBe(id)

    const blob = `${finding?.summary ?? ""}\n${finding?.detail ?? ""}`
    // TEETH 1 — the finding carries the MODEL sentinel (proves a real replayed
    // LLM pass ran inside the forked child).
    expect(blob).toContain(SENTINEL_TOKEN)
    expect(blob).toContain("FOUND: stale lockfile")
    // TEETH 2 — RED-ON-INJECTION: the finding must NOT carry the deterministic
    // stub's signature. If the child degraded to the stub, these appear ⇒ fail.
    expect(blob).not.toContain(DETERMINISTIC_SIGNATURE)
    expect(blob).not.toContain(DETERMINISTIC_SIGNATURE_2)

    expect(reg.stop(id)).toBe(true)
    await waitFor(() => reg.list()[0]?.status === "stopped", 5000)
    expect(reg.list()[0]?.status).toBe("stopped")
  }, 60_000)
})
