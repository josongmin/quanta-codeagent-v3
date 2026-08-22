/**
 * RFC jun-6 — DEFAULT-OFF byte-identity hellgate + the `sandbox_blocked`
 * LLMError bridge (sibling to the degrade `sandbox_error` bridge).
 *
 *   - Knob unset ⇒ `runtimeConfig().sandboxEscalation === false` and
 *     `sandboxEscalationMax === undefined`. A platform result-mapping point
 *     that gates on the knob therefore NEVER consults the classifier, so a
 *     sandboxed nonzero exit carries NO `denialReason` — byte-identical to the
 *     pre-RFC result shape (a plain failure).
 *   - `isSandboxBlockedFailure` fires ONLY on `sandboxApplied:true` + a
 *     `denialReason` (NOT on the degrade case), and `sandboxBlockToLlmError`
 *     builds the `sandbox_blocked` kind.
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  classifySandboxDenial,
  isSandboxBlockedFailure,
  isSandboxDegradedFailure,
  type SandboxedSpawnResult,
  sandboxBlockToLlmError,
} from "@/runtime/os-sandbox"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"

afterEach(() => {
  __resetRuntimeConfig()
})

describe("sandbox-escalation — default-OFF byte identity", () => {
  test("knob unset ⇒ sandboxEscalation false + max undefined", () => {
    delete process.env.QUANTA_SANDBOX_ESCALATION
    delete process.env.QUANTA_SANDBOX_ESCALATION_MAX
    __resetRuntimeConfig()
    const cfg = runtimeConfig()
    expect(cfg.sandboxEscalation).toBe(false)
    expect(cfg.sandboxEscalationMax).toBeUndefined()
  })

  test("knob ON (=1) ⇒ sandboxEscalation true", () => {
    process.env.QUANTA_SANDBOX_ESCALATION = "1"
    __resetRuntimeConfig()
    expect(runtimeConfig().sandboxEscalation).toBe(true)
    delete process.env.QUANTA_SANDBOX_ESCALATION
  })

  test("a sandbox-blocked result with NO denialReason set (OFF path) is byte-identical to a plain failure", () => {
    // Simulating the OFF path: the result-mapping point did NOT call the
    // classifier, so denialReason is absent. The shape is exactly the legacy
    // SandboxedSpawnResult.
    const offResult: SandboxedSpawnResult = {
      exitCode: 1,
      stdout: "",
      stderr: "Sandbox: bash(1) deny(1) file-write-data /x",
      sandboxApplied: true,
    }
    expect("denialReason" in offResult).toBe(false)
    expect(isSandboxBlockedFailure(offResult)).toBe(false)
    // The classifier WOULD detect it — proving the discriminant only exists
    // when the gated mapping point chooses to invoke it.
    expect(classifySandboxDenial(offResult, "seatbelt")?.confidence).toBe("high")
  })
})

describe("sandbox_blocked LLMError bridge — sibling to the degrade bridge", () => {
  test("isSandboxBlockedFailure fires ONLY on applied + denialReason (not on degrade)", () => {
    const blocked: SandboxedSpawnResult = {
      exitCode: 1,
      stdout: "",
      stderr: "",
      sandboxApplied: true,
      denialReason: { kind: "sandbox-blocked", signal: "seccomp-sigsys", confidence: "high" },
    }
    const degraded: SandboxedSpawnResult = {
      exitCode: 1,
      stdout: "",
      stderr: "",
      sandboxApplied: false,
      degradeReason: "native-binding-unavailable",
    }
    expect(isSandboxBlockedFailure(blocked)).toBe(true)
    expect(isSandboxBlockedFailure(degraded)).toBe(false)
    // And the degrade detector does NOT fire on a block.
    expect(isSandboxDegradedFailure(blocked)).toBe(false)
    expect(isSandboxDegradedFailure(degraded)).toBe(true)
  })

  test("sandboxBlockToLlmError builds the sandbox_blocked kind (distinct from sandbox_error)", () => {
    const blocked: SandboxedSpawnResult = {
      exitCode: 126,
      stdout: "",
      stderr: "",
      sandboxApplied: true,
      denialReason: { kind: "sandbox-blocked", signal: "exit-126", confidence: "high" },
    }
    const err = sandboxBlockToLlmError(blocked)
    expect(err.kind).toBe("sandbox_blocked")
    expect(err.message).toContain("exit-126")
    expect(err.message).toContain("high")
  })
})
