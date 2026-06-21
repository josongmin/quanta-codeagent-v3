import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import "@/runner/knobs/knobs"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { __resetKnobOverrides } from "@/shared/knob-overrides"
import type { StreamPort } from "@/stream"
import { buildConfig } from "../../src/apps/bench/eval/driver"
import type { Instance } from "../../src/apps/bench/types"

/**
 * Hellgate: the gap-B spec-fidelity steer is surfaced in the always-present
 * swebench directive ONLY when (a) the `spec-fidelity-steer` knob is ON and
 * (b) the issue declares a concrete expected output (extractIssueDeclaredExpected
 * ≠ undefined). Fail-closed: a knob-ON instance WITHOUT a declared output gets no
 * steer (so co-change cases are never nudged toward minimality).
 *
 * Red-on-injection:
 *  - drop the `specSteerLine` append in buildConfig ⇒ SF-1 RED.
 *  - couple it to the knob only (ignore the extractor) ⇒ SF-2 RED (fires with no spec).
 *  - flip the knob default ON ⇒ SF-3 RED (byte-identical baseline lost).
 */
const SPEC_MARK = "treat that exact stated output as the authoritative specification"
const ENV_KEYS = [
  "QUANTA_BENCH_PRESET",
  "QUANTA_BENCH_SOTA",
  "QUANTA_KNOBS_PRESET",
  "QUANTA_BENCH_SPEC_FIDELITY_STEER",
  "QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL",
  "QUANTA_BENCH_RCA_TARGET_GATES",
] as const

let saved: Map<string, string | undefined>
beforeEach(() => {
  saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  __resetKnobOverrides()
})
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetKnobOverrides()
})

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}
const stubStream: StreamPort = { emit() {} }
const swebenchInstance = (problem: string): Instance => ({
  id: "p-1",
  repoPath: "/tmp/x",
  problemStatement: problem,
  testCmd: "true",
  swebench: { instanceId: "x__1", repo: "x/x", baseCommit: "deadbeef" },
})
const userText = (problem: string): string => {
  const ac = new AbortController()
  const cfg = buildConfig(
    swebenchInstance(problem),
    { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 },
    "/tmp/sb",
    ac.signal,
    stubStream,
  )
  const block = cfg.messages[0]?.content[0]
  return block && block.type === "text" ? block.text : ""
}

// An issue that DECLARES a concrete expected output (extractor returns a value).
const WITH_SPEC = "The function should return `42` for empty input; right now it crashes."
// An issue with NO declared output (extractor returns undefined).
const NO_SPEC = "Fix the intermittent crash in the parser when the input is malformed."
const CONFUSING_EXCEPTION_MESSAGE =
  "TimeSeries: misleading exception when required column check fails.\n\n" +
  "Expected behavior\nAn exception that informs the users required columns are missing.\n\n" +
  "Actual behavior\nThe actual exception message is confusing:\n" +
  "`ValueError: TimeSeries object is invalid - expected 'time' as the first columns but found 'time'`"
const BACKEND_FAMILY_ISSUE =
  "Database functions with timezone conversions behave differently across SQLite, MySQL, and Oracle backends."
const SINGLE_POSTGRES_BACKEND_ISSUE =
  "PostgreSQL database backend dbshell handling should respect os.environ."
const SUBPROCESS_ENV_ISSUE =
  "dbshell/runshell does not respect os.environ because subprocess.run receives an empty environment."

describe("gap-B spec-fidelity steer prompt wiring", () => {
  test("SF-1: knob ON + issue declares an expected output ⇒ steer present", () => {
    process.env.QUANTA_BENCH_SPEC_FIDELITY_STEER = "1"
    expect(userText(WITH_SPEC)).toContain(SPEC_MARK)
  })

  test("SF-2: knob ON but NO declared output ⇒ steer ABSENT (fail-closed)", () => {
    process.env.QUANTA_BENCH_SPEC_FIDELITY_STEER = "1"
    expect(userText(NO_SPEC)).not.toContain(SPEC_MARK)
  })

  test("SF-3: knob OFF (unset) + declared output ⇒ steer ABSENT (default-OFF byte-identical)", () => {
    expect(userText(WITH_SPEC)).not.toContain(SPEC_MARK)
  })

  test("SF-4: expected/actual ON + confusing exception message ⇒ message-format steer present", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL = "1"
    expect(userText(CONFUSING_EXCEPTION_MESSAGE)).toContain("Fix the existing message construction")
    expect(userText(CONFUSING_EXCEPTION_MESSAGE)).toContain("multi-item lists or prefixes")
    expect(userText(CONFUSING_EXCEPTION_MESSAGE)).toContain("same prefix length")
    expect(userText(CONFUSING_EXCEPTION_MESSAGE)).toContain("not by adding a narrow")
    expect(userText(CONFUSING_EXCEPTION_MESSAGE)).toContain("unquoted placeholders")
    expect(userText(CONFUSING_EXCEPTION_MESSAGE)).not.toContain("required_columns")
  })

  test("SF-5: expected/actual OFF + same exception issue ⇒ message-format steer absent", () => {
    expect(userText(CONFUSING_EXCEPTION_MESSAGE)).not.toContain(
      "Fix the existing message construction",
    )
  })

  test("SF-6: expected/actual ON + multi-backend issue ⇒ owner-family steer present", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL = "1"
    expect(userText(BACKEND_FAMILY_ISSUE)).toContain("treat them as one owner-family")
    expect(userText(BACKEND_FAMILY_ISSUE)).toContain("single-backend patch is incomplete")
    expect(userText(BACKEND_FAMILY_ISSUE)).toContain("SQL call arity")
    expect(userText(BACKEND_FAMILY_ISSUE)).toContain("registered Python UDF arity")
    expect(userText(BACKEND_FAMILY_ISSUE)).not.toContain("never return raw")
    expect(userText(BACKEND_FAMILY_ISSUE)).not.toContain(`"'%s'" % tzname`)
  })

  test("SF-7: expected/actual ON + subprocess env issue ⇒ execution-boundary steer present", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL = "1"
    expect(userText(SUBPROCESS_ENV_ISSUE)).toContain("trace BOTH the producer")
    expect(userText(SUBPROCESS_ENV_ISSUE)).toContain("drop inherited environment")
    expect(userText(SUBPROCESS_ENV_ISSUE)).toContain("normalize that to None")
    expect(userText(SUBPROCESS_ENV_ISSUE)).not.toContain("producer-only or base-only patches fail")
  })

  test("SF-7b: RCA target gates append known-miss specifics only when explicitly enabled", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL = "1"
    process.env.QUANTA_BENCH_RCA_TARGET_GATES = "1"
    expect(userText(CONFUSING_EXCEPTION_MESSAGE)).toContain("RCA target gate")
    expect(userText(CONFUSING_EXCEPTION_MESSAGE)).toContain("required_columns")
    expect(userText(BACKEND_FAMILY_ISSUE)).toContain("never return raw")
    expect(userText(BACKEND_FAMILY_ISSUE)).toContain(`"'%s'" % tzname`)
    expect(userText(SUBPROCESS_ENV_ISSUE)).toContain("single patch must change both")
    expect(userText(SUBPROCESS_ENV_ISSUE)).toContain("producer-only or base-only patches fail")
  })

  test("SF-8: targeted issue steers stay absent when expected/actual is OFF", () => {
    expect(userText(BACKEND_FAMILY_ISSUE)).not.toContain("treat them as one owner-family")
    expect(userText(SUBPROCESS_ENV_ISSUE)).not.toContain("trace BOTH the producer")
  })

  test("SF-9: postgres/postgresql aliases do not fake a multi-backend family", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL = "1"
    expect(userText(SINGLE_POSTGRES_BACKEND_ISSUE)).not.toContain("treat them as one owner-family")
  })
})
