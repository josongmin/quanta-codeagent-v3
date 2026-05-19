import { describe, expect, test } from "bun:test"
import type { RunContext } from "@/shared"
import {
  type DegradedData,
  isTrajectoryEvent,
  type LlmUsageData,
  makeEvent,
  type PatchData,
  REDACTION_POLICY,
  redactValue,
  type SandboxData,
  type ToolResultData,
  TRAJECTORY_SCHEMA,
  type TrajectoryEvent,
  type VerifyData,
} from "@/shared"

const CTX: RunContext = { runId: "run-1", instanceId: "inst-1", attempt: 0, turn: 2 }

describe("TRAJECTORY_SCHEMA", () => {
  test("is the registry literal", () => {
    expect(TRAJECTORY_SCHEMA).toBe("quanta.trajectory.v1")
  })
})

describe("makeEvent", () => {
  test("stamps schema/v/producer/redaction defaults", () => {
    const ev = makeEvent(0, "session_start", CTX, { foo: "bar" })
    expect(ev.schema).toBe("quanta.trajectory.v1")
    expect(ev.v).toBe(1)
    expect(ev.seq).toBe(0)
    expect(ev.kind).toBe("session_start")
    expect(ev.ctx).toEqual(CTX)
    expect(ev.producer.name).toBe("quanta")
    expect(typeof ev.producer.version).toBe("string")
    expect(ev.producer.version.length).toBeGreaterThan(0)
    expect(ev.producer.gitSha).toBeUndefined()
    expect(ev.redaction.policy).toBe(REDACTION_POLICY)
    expect(typeof ev.redaction.applied).toBe("boolean")
    expect(typeof ev.ts).toBe("number")
    expect(ev.data).toEqual({ foo: "bar" })
  })

  test("honors injected ts/clock and optional span/pricing fields", () => {
    const ev = makeEvent(
      7,
      "llm_usage",
      CTX,
      { model: "gpt-4o" },
      {
        ts: 1_700_000_000_000,
        monotonicNs: 42,
        spanId: "span-a",
        parentSpanId: "span-root",
        pricingVersion: "pricing.v1",
        redactionApplied: true,
      },
    )
    expect(ev.ts).toBe(1_700_000_000_000)
    expect(ev.monotonicNs).toBe(42)
    expect(ev.spanId).toBe("span-a")
    expect(ev.parentSpanId).toBe("span-root")
    expect(ev.pricingVersion).toBe("pricing.v1")
    expect(ev.redaction.applied).toBe(true)
  })

  test("redacts data payload by default", () => {
    const ev = makeEvent(1, "tool_call", CTX, { OPENAI_API_KEY: "sk-abcdefgh1234" })
    expect(ev.data.OPENAI_API_KEY).toBe("***REDACTED***")
    expect(ev.redaction.applied).toBe(true)
  })

  test("produces an event that passes its own validator", () => {
    const ev = makeEvent(3, "turn_start", CTX, {})
    expect(isTrajectoryEvent(ev)).toBe(true)
  })
})

describe("isTrajectoryEvent", () => {
  const valid = makeEvent(0, "session_start", CTX, {})

  test("accepts a valid event", () => {
    expect(isTrajectoryEvent(valid)).toBe(true)
  })

  test("rejects non-objects", () => {
    expect(isTrajectoryEvent(null)).toBe(false)
    expect(isTrajectoryEvent(undefined)).toBe(false)
    expect(isTrajectoryEvent("x")).toBe(false)
    expect(isTrajectoryEvent(42)).toBe(false)
  })

  test("rejects wrong schema literal", () => {
    expect(isTrajectoryEvent({ ...valid, schema: "quanta.trajectory.v2" })).toBe(false)
  })

  test("rejects wrong v", () => {
    expect(isTrajectoryEvent({ ...valid, v: 2 })).toBe(false)
  })

  test("rejects missing seq", () => {
    const { seq: _drop, ...rest } = valid
    expect(isTrajectoryEvent(rest)).toBe(false)
  })

  test("rejects missing redaction", () => {
    const { redaction: _drop, ...rest } = valid
    expect(isTrajectoryEvent(rest)).toBe(false)
  })

  test("rejects malformed redaction", () => {
    expect(isTrajectoryEvent({ ...valid, redaction: { policy: "x" } })).toBe(false)
  })

  test("rejects missing producer", () => {
    const { producer: _drop, ...rest } = valid
    expect(isTrajectoryEvent(rest)).toBe(false)
  })

  test("rejects unknown kind", () => {
    expect(isTrajectoryEvent({ ...valid, kind: "not_a_kind" })).toBe(false)
  })

  test("rejects non-object data", () => {
    expect(isTrajectoryEvent({ ...valid, data: "nope" })).toBe(false)
  })
})

describe("RFC-0002 §5.2 new kinds — isTrajectoryEvent + data contract", () => {
  test("session_start, recovery, enriched tool_result pass isTrajectoryEvent", () => {
    const sessionStart = makeEvent(0, "session_start", CTX, {})
    const recovery = makeEvent(1, "recovery", CTX, { reason: "backoff", detail: "429" })
    const toolResult = makeEvent(2, "tool_result", CTX, {
      name: "bash",
      ok: false,
      exitCode: 1,
      durationMs: 12,
      stdoutTail: "out",
      stderrTail: "err",
      fullLogPath: "/tmp/x.log",
    } satisfies ToolResultData)
    expect(isTrajectoryEvent(sessionStart)).toBe(true)
    expect(isTrajectoryEvent(recovery)).toBe(true)
    expect(isTrajectoryEvent(toolResult)).toBe(true)
    expect(sessionStart.kind).toBe("session_start")
    expect(recovery.kind).toBe("recovery")
    expect(toolResult.kind).toBe("tool_result")
  })

  test("ToolResultData: durationMs required; exitCode/fullLogPath optional-but-typed", () => {
    // Minimal: only the always-present fields (no exitCode/fullLogPath).
    const minimal = {
      name: "read",
      ok: true,
      durationMs: 0,
      stdoutTail: "body",
      stderrTail: "",
    } satisfies ToolResultData
    expect(minimal.durationMs).toBe(0)
    expect("exitCode" in minimal).toBe(false)
    expect("fullLogPath" in minimal).toBe(false)

    const full = {
      name: "bash",
      ok: false,
      exitCode: 2,
      durationMs: 99,
      stdoutTail: "o",
      stderrTail: "e",
      fullLogPath: "/tmp/r.log",
    } satisfies ToolResultData
    expect(full.exitCode).toBe(2)
    expect(full.fullLogPath).toBe("/tmp/r.log")

    const ev: TrajectoryEvent = makeEvent(0, "tool_result", CTX, full)
    expect(ev.kind).toBe("tool_result")
  })
})

describe("redactValue", () => {
  test("masks a raw API key string", () => {
    expect(redactValue("sk-abcdefgh12345678")).toBe("***REDACTED***")
  })

  test("masks ghp_ github token", () => {
    expect(redactValue("ghp_0123456789abcdefghijABCDEF")).toBe("***REDACTED***")
  })

  test("masks an object whose key is OPENAI_API_KEY", () => {
    const out = redactValue({ OPENAI_API_KEY: "hunter2", model: "gpt-4o" }) as Record<
      string,
      unknown
    >
    expect(out.OPENAI_API_KEY).toBe("***REDACTED***")
    expect(out.model).toBe("gpt-4o")
  })

  test("masks a Bearer token substring nested in data", () => {
    const out = redactValue({
      headers: { authorization: "Bearer abc.def.ghi" },
      depth: { more: ["plain", "Bearer zzzyyyxxx"] },
    }) as { headers: Record<string, unknown>; depth: { more: unknown[] } }
    expect(out.headers.authorization).toBe("***REDACTED***")
    expect(out.depth.more[0]).toBe("plain")
    expect(out.depth.more[1]).toBe("***REDACTED***")
  })

  test("masks a PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"
    expect(redactValue(pem)).toBe("***REDACTED***")
  })

  test("masks AWS access key id", () => {
    expect(redactValue("AKIAIOSFODNN7EXAMPLE")).toBe("***REDACTED***")
  })

  test("masks any key matching the secret-name pattern", () => {
    const out = redactValue({
      DB_PASSWORD: "p",
      AUTHORIZATION: "Basic x",
      SERVICE_TOKEN: "t",
      stripe_secret: "s",
    }) as Record<string, unknown>
    expect(out.DB_PASSWORD).toBe("***REDACTED***")
    expect(out.AUTHORIZATION).toBe("***REDACTED***")
    expect(out.SERVICE_TOKEN).toBe("***REDACTED***")
    expect(out.stripe_secret).toBe("***REDACTED***")
  })

  test("does NOT mangle ordinary fields", () => {
    const input = {
      model: "gpt-4o",
      inputTokens: 12,
      ok: true,
      nested: { name: "edit", tail: "wrote file" },
      list: [1, 2, "hello world"],
      nullish: null,
    }
    expect(redactValue(input)).toEqual(input)
  })

  test("REDACTION_POLICY is a stable non-empty string", () => {
    expect(typeof REDACTION_POLICY).toBe("string")
    expect(REDACTION_POLICY.length).toBeGreaterThan(0)
  })

  test("preserves array structure and primitives", () => {
    expect(redactValue([1, "ok", false])).toEqual([1, "ok", false])
    expect(redactValue(123)).toBe(123)
    expect(redactValue(true)).toBe(true)
    expect(redactValue(null)).toBe(null)
  })
})

describe("per-kind data interface shapes (type-level)", () => {
  test("each documented data shape compiles via satisfies", () => {
    const usage = {
      model: "gpt-4o",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      costUsd: 0.001,
    } satisfies LlmUsageData
    const usageNullCost = {
      model: "x",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
    } satisfies LlmUsageData
    const toolResult = {
      name: "bash",
      ok: false,
      exitCode: 1,
      durationMs: 12,
      stdoutTail: "out",
      stderrTail: "err",
      fullLogPath: "/tmp/x.log",
    } satisfies ToolResultData
    const patch = {
      diffPath: "/tmp/p.diff",
      filesChanged: 2,
      hunks: 3,
      applyStatus: "applied",
    } satisfies PatchData
    const sandbox = {
      repoCommit: "abc",
      baseCommit: "def",
      worktreeDirty: false,
      runtime: { bun: "1.1.0", node: "22", python: "3.12" },
      envPolicyVersion: "env.v1",
    } satisfies SandboxData
    const verify = {
      command: "pytest",
      exitCode: 1,
      passed: false,
      failedTests: ["t1"],
      logTail: "fail",
      reportPath: "/tmp/r.json",
    } satisfies VerifyData
    const degraded = {
      component: "recorder",
      reason: "disk full",
      droppedEvents: 4,
    } satisfies DegradedData

    expect(usage.costUsd).toBe(0.001)
    expect(usageNullCost.costUsd).toBeNull()
    expect(toolResult.ok).toBe(false)
    expect(patch.applyStatus).toBe("applied")
    expect(sandbox.runtime.bun).toBe("1.1.0")
    expect(verify.failedTests).toEqual(["t1"])
    expect(degraded.droppedEvents).toBe(4)

    const ev: TrajectoryEvent = makeEvent(0, "llm_usage", CTX, usage)
    expect(ev.kind).toBe("llm_usage")
  })
})
