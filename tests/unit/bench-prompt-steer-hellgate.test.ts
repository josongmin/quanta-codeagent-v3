/**
 * Hellgate (real composition + gate-OFF baseline + red-on-injection) for the two
 * bench prompt steers that are wired ONLY inside the real bench config builder:
 *
 *   - bench-simplicity-steer  (DEFAULT-ON):  QUANTA_BENCH_SIMPLICITY=0 restores
 *     the pre-absorption baseline (steer dropped from the SWE-bench prompt).
 *   - bench-find-refs-steer   (DEFAULT-OFF): QUANTA_BENCH_FIND_REFS=1 appends the
 *     ripgrep find_references steer; unset ⇒ byte-identical (absent).
 *
 * This drives the REAL `buildConfig` (apps→runner driver) end-to-end: env →
 * `benchPostureFromState`/gate reads → `composeBaseText` → the assembled
 * user-message prompt. We assert on the prompt text the builder actually emits,
 * not on an isolated posture boolean — so a regression that stops folding either
 * steer into the prompt (or flips its default) reds this test.
 *
 * Red-on-injection:
 *   - simplicity default flips OFF ⇒ "default-ON ⇒ present" RED.
 *   - simplicity gate ignored      ⇒ "=0 ⇒ absent" RED.
 *   - find-refs default flips ON   ⇒ "unset ⇒ absent" RED.
 *   - find-refs gate ignored       ⇒ "=1 ⇒ present" RED.
 *   - non-swebench leak            ⇒ "custom corpus ⇒ no steer" RED.
 */
import { describe, expect, test } from "bun:test"
import { FIND_REFS_STEER } from "@/agent/localize-phase-guard"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { StreamPort } from "@/stream"
import { buildConfig } from "../../src/apps/bench/eval/driver"
import type { Instance } from "../../src/apps/bench/types"

// A stable substring of the (un-exported) SIMPLICITY_STEER const in driver.ts.
const SIMPLICITY_ANCHOR = "Prefer the SIMPLEST mechanism that already exists"

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}
const stubStream: StreamPort = { emit() {} }

const mkInstance = (swebench = true): Instance => ({
  id: "x__1",
  repoPath: "/tmp/x",
  problemStatement: "Fix the bug in src/foo.py.",
  testCmd: "true",
  ...(swebench ? { swebench: { instanceId: "x__1", repo: "x/x", baseCommit: "deadbeef" } } : {}),
})

const promptText = (instance: Instance): string => {
  const ac = new AbortController()
  const cfg = buildConfig(
    instance,
    { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 },
    "/tmp/sb",
    ac.signal,
    stubStream,
  )
  const block = cfg.messages[0]?.content[0]
  return block && block.type === "text" ? block.text : ""
}

const withEnv = (vars: Record<string, string | undefined>, fn: () => void): void => {
  const prev = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    prev.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    fn()
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe("bench-simplicity-steer (DEFAULT-ON)", () => {
  test("unset ⇒ simplicity steer present in the SWE-bench prompt", () => {
    withEnv({ QUANTA_BENCH_SIMPLICITY: undefined, QUANTA_BENCH_LEAN_PROMPT: undefined }, () => {
      expect(promptText(mkInstance())).toContain(SIMPLICITY_ANCHOR)
    })
  })

  test("QUANTA_BENCH_SIMPLICITY=0 ⇒ steer dropped (pre-absorption baseline)", () => {
    withEnv({ QUANTA_BENCH_SIMPLICITY: "0", QUANTA_BENCH_LEAN_PROMPT: undefined }, () => {
      const t = promptText(mkInstance())
      // Non-vacuity: the prompt is REAL (carries the task), the steer is just gone —
      // not an empty/broken prompt that would pass `not.toContain` trivially.
      expect(t).toContain("Fix the bug in src/foo.py")
      expect(t).not.toContain(SIMPLICITY_ANCHOR)
    })
  })

  test("non-swebench instance ⇒ no steer leak (custom corpus unaffected)", () => {
    withEnv({ QUANTA_BENCH_SIMPLICITY: undefined }, () => {
      const t = promptText(mkInstance(false))
      expect(t).toContain("Fix the bug in src/foo.py")
      expect(t).not.toContain(SIMPLICITY_ANCHOR)
    })
  })
})

describe("bench-find-refs-steer (DEFAULT-OFF)", () => {
  test("unset ⇒ find_references steer absent (byte-identical baseline)", () => {
    withEnv({ QUANTA_BENCH_FIND_REFS: undefined }, () => {
      const t = promptText(mkInstance())
      expect(t).toContain("Fix the bug in src/foo.py")
      expect(t).not.toContain(FIND_REFS_STEER)
    })
  })

  test("QUANTA_BENCH_FIND_REFS=1 ⇒ find_references steer appended to the prompt", () => {
    withEnv({ QUANTA_BENCH_FIND_REFS: "1", QUANTA_BENCH_LEAN_PROMPT: undefined }, () => {
      expect(promptText(mkInstance())).toContain(FIND_REFS_STEER)
    })
  })

  test("non-swebench instance ⇒ steer absent even when gated on", () => {
    withEnv({ QUANTA_BENCH_FIND_REFS: "1" }, () => {
      const t = promptText(mkInstance(false))
      expect(t).toContain("Fix the bug in src/foo.py")
      expect(t).not.toContain(FIND_REFS_STEER)
    })
  })
})
