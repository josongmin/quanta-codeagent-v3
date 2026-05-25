/**
 * Hellgate for `src/runtime/os-sandbox/llm-error-bridge.ts`
 * (ADR-0237 slice C).
 *
 * Pins the `sandbox_error` layer-owned LLMErrorKind arm. 14 hard cases in
 * five blocks:
 *
 *   A. default-OFF byte-identical                       (HELL-A1..A3)
 *   B. throw-mode conversion (degraded → LLMError)      (HELL-B4..B7)
 *   C. result-with-llm-error mode                       (HELL-C8..C10)
 *   D. non-firing conditions (success / explicit off)   (HELL-D11..D13)
 *   E. degrade-reason variety (bwrap / landlock / seatbelt / spawn-failed)
 *                                                        (HELL-E14)
 *
 * Hermetic: hand-rolled in-memory fake `OsSandbox`. NO real binary spawn,
 * NO real Seatbelt / Landlock / Bubblewrap.
 */

import { describe, expect, test } from "bun:test"
import type {
  OsSandbox,
  SandboxAvailability,
  SandboxedSpawnResult,
  SandboxedSpawnSpec,
  SandboxPolicy,
} from "@/runtime/os-sandbox"
import {
  isSandboxDegradedFailure,
  type SandboxResultWithLlmError,
  sandboxResultToLlmError,
  withSandboxLlmErrorEmit,
} from "@/runtime/os-sandbox"
import { LLMError } from "@/shared"

/* ------------------------------------------------------------------ */
/* hand-rolled fake OsSandbox                                          */
/* ------------------------------------------------------------------ */

const makeSandbox = (cfg: {
  result?: SandboxedSpawnResult
  resultByCommand?: (cmd: ReadonlyArray<string>) => SandboxedSpawnResult
  availability?: SandboxAvailability
}): OsSandbox => ({
  async spawn(spec: SandboxedSpawnSpec, _policy: SandboxPolicy): Promise<SandboxedSpawnResult> {
    if (cfg.resultByCommand) return cfg.resultByCommand(spec.command)
    return cfg.result ?? successResult()
  },
  async availability(): Promise<SandboxAvailability> {
    return cfg.availability ?? { backend: "seatbelt", warnings: [] }
  },
})

const successResult = (): SandboxedSpawnResult => ({
  exitCode: 0,
  stdout: "ok",
  stderr: "",
  sandboxApplied: true,
})

const degradedResult = (reason: string, exitCode = 0): SandboxedSpawnResult => ({
  exitCode,
  stdout: "",
  stderr: `degraded: ${reason}`,
  sandboxApplied: false,
  degradeReason: reason,
})

const explicitOffResult = (): SandboxedSpawnResult => ({
  exitCode: 0,
  stdout: "ok",
  stderr: "",
  sandboxApplied: false,
  // NO degradeReason — caller explicitly asked for off / danger-full-access.
})

const sampleSpec: SandboxedSpawnSpec = {
  command: ["/bin/echo", "hi"],
  cwd: "/tmp",
}

const onPolicy: SandboxPolicy = { profile: "read-only" }

const tryAwait = async <T>(p: Promise<T>): Promise<{ value: T } | { error: unknown }> => {
  try {
    return { value: await p }
  } catch (e) {
    return { error: e }
  }
}

/* ------------------------------------------------------------------ */
/* A. default-OFF byte-identical                                       */
/* ------------------------------------------------------------------ */

describe("HELL-A: default-OFF byte-identical", () => {
  test("HELL-A1: knobs absent → returns inner verbatim", () => {
    const inner = makeSandbox({})
    const port = withSandboxLlmErrorEmit(inner, undefined)
    expect(port).toBe(inner)
  })

  test("HELL-A2: emitFailureAsLlmError:false → returns inner verbatim", () => {
    const inner = makeSandbox({})
    const port = withSandboxLlmErrorEmit(inner, { emitFailureAsLlmError: false })
    expect(port).toBe(inner)
  })

  test("HELL-A3: OFF mode → degraded result flows raw (no LLMError, no llmError augmentation)", async () => {
    const inner = makeSandbox({ result: degradedResult("bwrap-missing", 127) })
    const port = withSandboxLlmErrorEmit(inner, { emitFailureAsLlmError: false })
    const r = await port.spawn(sampleSpec, onPolicy)
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBe("bwrap-missing")
    expect((r as SandboxResultWithLlmError).llmError).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* B. throw-mode conversion                                            */
/* ------------------------------------------------------------------ */

describe("HELL-B: throw-mode converts degraded result to LLMError('sandbox_error')", () => {
  test("HELL-B4: bubblewrap-missing → throws LLMError(kind:sandbox_error)", async () => {
    const inner = makeSandbox({
      result: degradedResult("linux-bwrap-missing — install bubblewrap", 127),
    })
    const port = withSandboxLlmErrorEmit(inner, {
      emitFailureAsLlmError: true,
      mode: "throw",
    })
    const r = await tryAwait(port.spawn(sampleSpec, onPolicy))
    expect("error" in r).toBe(true)
    const e = (r as { error: unknown }).error
    expect(e).toBeInstanceOf(LLMError)
    const llm = e as LLMError
    expect(llm.kind).toBe("sandbox_error")
    expect(llm.message).toContain("linux-bwrap-missing")
  })

  test("HELL-B5: sandbox-exec-missing (seatbelt) → throws LLMError(kind:sandbox_error)", async () => {
    const inner = makeSandbox({
      result: degradedResult("sandbox-exec-missing"),
    })
    const port = withSandboxLlmErrorEmit(inner, {
      emitFailureAsLlmError: true,
      mode: "throw",
    })
    const r = await tryAwait(port.spawn(sampleSpec, onPolicy))
    const llm = (r as { error: LLMError }).error
    expect(llm).toBeInstanceOf(LLMError)
    expect(llm.kind).toBe("sandbox_error")
    expect(llm.message).toContain("sandbox-exec-missing")
  })

  test("HELL-B6: spawn-failed → throws LLMError(kind:sandbox_error)", async () => {
    // Spawn failure is documented as a sandbox_error (the agent cannot
    // tell "binary missing" from "policy rejected" without re-parsing stderr,
    // which is forbidden).
    const inner = makeSandbox({
      result: degradedResult("spawn-failed", 127),
    })
    const port = withSandboxLlmErrorEmit(inner, {
      emitFailureAsLlmError: true,
      // default mode = throw
    })
    const r = await tryAwait(port.spawn(sampleSpec, onPolicy))
    const llm = (r as { error: LLMError }).error
    expect(llm.kind).toBe("sandbox_error")
  })

  test("HELL-B7: cause carries the original result (downstream sub-classification)", async () => {
    const original = degradedResult("profile-uncompilable")
    const inner = makeSandbox({ result: original })
    const port = withSandboxLlmErrorEmit(inner, {
      emitFailureAsLlmError: true,
      mode: "throw",
    })
    const r = await tryAwait(port.spawn(sampleSpec, onPolicy))
    const llm = (r as { error: LLMError }).error
    expect(llm.cause).toEqual({ result: original })
  })
})

/* ------------------------------------------------------------------ */
/* C. result-with-llm-error mode                                       */
/* ------------------------------------------------------------------ */

describe("HELL-C: result-with-llm-error mode augments instead of throwing", () => {
  test("HELL-C8: degraded result returns sandboxApplied:false + llmError populated", async () => {
    const inner = makeSandbox({ result: degradedResult("bwrap-missing") })
    const port = withSandboxLlmErrorEmit(inner, {
      emitFailureAsLlmError: true,
      mode: "result-with-llm-error",
    })
    const r = (await port.spawn(sampleSpec, onPolicy)) as SandboxResultWithLlmError
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBe("bwrap-missing")
    expect(r.llmError).toBeInstanceOf(LLMError)
    expect(r.llmError?.kind).toBe("sandbox_error")
  })

  test("HELL-C9: success result does NOT carry llmError even in augment mode", async () => {
    const inner = makeSandbox({}) // default → success
    const port = withSandboxLlmErrorEmit(inner, {
      emitFailureAsLlmError: true,
      mode: "result-with-llm-error",
    })
    const r = (await port.spawn(sampleSpec, onPolicy)) as SandboxResultWithLlmError
    expect(r.sandboxApplied).toBe(true)
    expect(r.llmError).toBeUndefined()
  })

  test("HELL-C10: explicit-off result does NOT carry llmError even in augment mode", async () => {
    // sandboxApplied:false but degradeReason ABSENT ⇒ NOT a fire-eligible
    // outcome (caller asked for `profile:"off"` or `"danger-full-access"`).
    const inner = makeSandbox({ result: explicitOffResult() })
    const port = withSandboxLlmErrorEmit(inner, {
      emitFailureAsLlmError: true,
      mode: "result-with-llm-error",
    })
    const r = (await port.spawn(sampleSpec, onPolicy)) as SandboxResultWithLlmError
    expect(r.sandboxApplied).toBe(false)
    expect(r.degradeReason).toBeUndefined()
    expect(r.llmError).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* D. non-firing conditions                                            */
/* ------------------------------------------------------------------ */

describe("HELL-D: non-firing conditions (success / explicit-off / empty reason)", () => {
  test("HELL-D11: sandboxApplied:true → never fires (throw mode)", async () => {
    const inner = makeSandbox({}) // default → success
    const port = withSandboxLlmErrorEmit(inner, {
      emitFailureAsLlmError: true,
      mode: "throw",
    })
    const r = await port.spawn(sampleSpec, onPolicy)
    expect(r.sandboxApplied).toBe(true)
    expect(r.exitCode).toBe(0)
  })

  test("HELL-D12: explicit-off (no degradeReason) → never fires", () => {
    expect(isSandboxDegradedFailure(explicitOffResult())).toBe(false)
  })

  test("HELL-D13: empty-string degradeReason → never fires", () => {
    const r: SandboxedSpawnResult = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      sandboxApplied: false,
      degradeReason: "",
    }
    expect(isSandboxDegradedFailure(r)).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* E. degrade-reason variety                                           */
/* ------------------------------------------------------------------ */

describe("HELL-E: degrade-reason variety (every documented reason → sandbox_error)", () => {
  const reasons: ReadonlyArray<string> = [
    "linux-bwrap-missing — install bubblewrap (apt/dnf/pacman)",
    "sandbox-exec-missing",
    "profile-uncompilable",
    "spawn-failed",
    "unsupported-platform:win32",
  ]

  test("HELL-E14: every documented degrade-reason maps to sandbox_error", () => {
    for (const reason of reasons) {
      const r = degradedResult(reason)
      expect(isSandboxDegradedFailure(r)).toBe(true)
      const err = sandboxResultToLlmError(r)
      expect(err).toBeInstanceOf(LLMError)
      expect(err.kind).toBe("sandbox_error")
      expect(err.message).toContain(reason)
    }
  })
})
