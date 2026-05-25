/**
 * Hellgate for `src/agent/per-tool-checkpoint/rollback-llm-error-bridge.ts`
 * (ADR-0237 slice B).
 *
 * Pins the `thread_rollback_failed` layer-owned LLMErrorKind arm. 15 hard
 * cases in five blocks:
 *
 *   A. default-OFF byte-identical                       (HELL-A1..A3)
 *   B. throw-mode conversion (3 methods × failure)      (HELL-B4..B7)
 *   C. outcome-with-llm-error mode                      (HELL-C8..C10)
 *   D. success path passthrough (every method)          (HELL-D11..D13)
 *   E. error-code mapping precision                     (HELL-E14..E15)
 *
 * Hermetic: hand-rolled in-memory fake `ThreeWayRestorePort`. NO real
 * `ShadowOdb`, NO real `ConversationCheckpointStore`.
 */

import { describe, expect, test } from "bun:test"
import {
  type RestoreErrorCode,
  type RestoreOptions,
  type RestoreOutcome,
  rollbackOutcomeToLlmError,
  type ThreeWayRestorePort,
  withRollbackLlmErrorEmit,
} from "@/agent/per-tool-checkpoint"
import type { RollbackOutcomeWithError } from "@/agent/per-tool-checkpoint/rollback-llm-error-bridge"
import { LLMError } from "@/shared"

/* ------------------------------------------------------------------ */
/* hand-rolled fake ThreeWayRestorePort                                */
/* ------------------------------------------------------------------ */

const successOutcome = (tag: string, leg: "files" | "task" | "both"): RestoreOutcome => ({
  ok: true,
  message: `${leg} restored from tag ${tag}`,
  tag,
})

const failOutcome = (
  tag: string,
  errorCode: RestoreErrorCode,
  message = "boom",
  originalCode?: string,
): RestoreOutcome => ({
  ok: false,
  errorCode,
  message,
  tag,
  ...(originalCode !== undefined ? { originalCode } : {}),
})

/** Make a port whose every method returns the given outcome (per method). */
const makePort = (cfg: {
  files?: RestoreOutcome
  task?: RestoreOutcome
  both?: RestoreOutcome
}): ThreeWayRestorePort => ({
  async restoreFiles(tag: string, _opts?: RestoreOptions): Promise<RestoreOutcome> {
    return cfg.files ?? successOutcome(tag, "files")
  },
  async restoreTask(tag: string, _opts?: RestoreOptions): Promise<RestoreOutcome> {
    return cfg.task ?? successOutcome(tag, "task")
  },
  async restoreBoth(tag: string, _opts?: RestoreOptions): Promise<RestoreOutcome> {
    return cfg.both ?? successOutcome(tag, "both")
  },
})

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
    const inner = makePort({})
    const port = withRollbackLlmErrorEmit(inner, undefined)
    expect(port).toBe(inner)
  })

  test("HELL-A2: emitRollbackFailureAsLlmError:false → returns inner verbatim", () => {
    const inner = makePort({})
    const port = withRollbackLlmErrorEmit(inner, { emitRollbackFailureAsLlmError: false })
    expect(port).toBe(inner)
  })

  test("HELL-A3: OFF mode → failure outcomes flow as RestoreOutcome (no LLMError)", async () => {
    // even when an inner method returns ok:false, OFF mode returns it as a
    // plain outcome (the bridge is identity).
    const inner = makePort({
      files: failOutcome("t1", "shadow-rewind-failed", "rewind broke", "rewind-failed"),
    })
    const port = withRollbackLlmErrorEmit(inner, { emitRollbackFailureAsLlmError: false })
    const out = await port.restoreFiles("t1")
    expect(out.ok).toBe(false)
    expect(out.errorCode).toBe("shadow-rewind-failed")
    // CRITICAL: no llmError augmentation when bridge is OFF.
    expect((out as RollbackOutcomeWithError).llmError).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* B. throw-mode conversion                                            */
/* ------------------------------------------------------------------ */

describe("HELL-B: throw-mode converts failure to LLMError('thread_rollback_failed')", () => {
  test("HELL-B4: restoreFiles failure → throws LLMError(kind:thread_rollback_failed)", async () => {
    const inner = makePort({
      files: failOutcome("t-files", "shadow-rewind-failed", "rewind broke", "merge-in-progress"),
    })
    const port = withRollbackLlmErrorEmit(inner, {
      emitRollbackFailureAsLlmError: true,
      mode: "throw",
    })
    const r = await tryAwait(port.restoreFiles("t-files"))
    expect("error" in r).toBe(true)
    const e = (r as { error: unknown }).error
    expect(e).toBeInstanceOf(LLMError)
    const llm = e as LLMError
    expect(llm.kind).toBe("thread_rollback_failed")
    expect(llm.message).toContain("t-files")
    expect(llm.message).toContain("shadow-rewind-failed")
    expect(llm.message).toContain("merge-in-progress")
  })

  test("HELL-B5: restoreTask failure → throws LLMError(kind:thread_rollback_failed)", async () => {
    const inner = makePort({
      task: failOutcome("t-task", "task-snapshot-missing", "no snapshot"),
    })
    const port = withRollbackLlmErrorEmit(inner, {
      emitRollbackFailureAsLlmError: true,
      mode: "throw",
    })
    const r = await tryAwait(port.restoreTask("t-task"))
    expect("error" in r).toBe(true)
    const llm = (r as { error: LLMError }).error
    expect(llm).toBeInstanceOf(LLMError)
    expect(llm.kind).toBe("thread_rollback_failed")
    expect(llm.message).toContain("task-snapshot-missing")
  })

  test("HELL-B6: restoreBoth failure → throws LLMError(kind:thread_rollback_failed)", async () => {
    const inner = makePort({
      both: failOutcome("t-both", "tag-not-found", "no such tag"),
    })
    const port = withRollbackLlmErrorEmit(inner, {
      emitRollbackFailureAsLlmError: true,
      // mode default → "throw"
    })
    const r = await tryAwait(port.restoreBoth("t-both"))
    expect("error" in r).toBe(true)
    const llm = (r as { error: LLMError }).error
    expect(llm.kind).toBe("thread_rollback_failed")
    expect(llm.message).toContain("tag-not-found")
  })

  test("HELL-B7: cause carries the original outcome (downstream sub-classification)", async () => {
    const original = failOutcome("t-x", "shadow-odb-not-configured", "no odb")
    const inner = makePort({ files: original })
    const port = withRollbackLlmErrorEmit(inner, {
      emitRollbackFailureAsLlmError: true,
      mode: "throw",
    })
    const r = await tryAwait(port.restoreFiles("t-x"))
    const llm = (r as { error: LLMError }).error
    expect(llm.cause).toEqual({ outcome: original })
  })
})

/* ------------------------------------------------------------------ */
/* C. outcome-with-llm-error mode                                      */
/* ------------------------------------------------------------------ */

describe("HELL-C: outcome-with-llm-error mode augments instead of throwing", () => {
  test("HELL-C8: failure outcome returns ok:false + llmError populated", async () => {
    const inner = makePort({
      files: failOutcome("t-c8", "shadow-rewind-failed", "rewind broke"),
    })
    const port = withRollbackLlmErrorEmit(inner, {
      emitRollbackFailureAsLlmError: true,
      mode: "outcome-with-llm-error",
    })
    const out = (await port.restoreFiles("t-c8")) as RollbackOutcomeWithError
    expect(out.ok).toBe(false)
    expect(out.errorCode).toBe("shadow-rewind-failed")
    expect(out.llmError).toBeInstanceOf(LLMError)
    expect(out.llmError?.kind).toBe("thread_rollback_failed")
  })

  test("HELL-C9: each of the 3 methods supports the outcome-with-llm-error mode", async () => {
    const inner = makePort({
      files: failOutcome("a", "shadow-rewind-failed"),
      task: failOutcome("b", "task-snapshot-missing"),
      both: failOutcome("c", "tag-not-found"),
    })
    const port = withRollbackLlmErrorEmit(inner, {
      emitRollbackFailureAsLlmError: true,
      mode: "outcome-with-llm-error",
    })
    const a = (await port.restoreFiles("a")) as RollbackOutcomeWithError
    const b = (await port.restoreTask("b")) as RollbackOutcomeWithError
    const c = (await port.restoreBoth("c")) as RollbackOutcomeWithError
    expect(a.llmError?.kind).toBe("thread_rollback_failed")
    expect(b.llmError?.kind).toBe("thread_rollback_failed")
    expect(c.llmError?.kind).toBe("thread_rollback_failed")
  })

  test("HELL-C10: success outcomes do NOT carry llmError even in outcome mode", async () => {
    const inner = makePort({}) // all defaults → success
    const port = withRollbackLlmErrorEmit(inner, {
      emitRollbackFailureAsLlmError: true,
      mode: "outcome-with-llm-error",
    })
    const out = (await port.restoreFiles("t-ok")) as RollbackOutcomeWithError
    expect(out.ok).toBe(true)
    expect(out.llmError).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* D. success path passthrough                                         */
/* ------------------------------------------------------------------ */

describe("HELL-D: success outcomes pass through every method without conversion", () => {
  test("HELL-D11: restoreFiles success passthrough (throw mode)", async () => {
    const inner = makePort({})
    const port = withRollbackLlmErrorEmit(inner, {
      emitRollbackFailureAsLlmError: true,
      mode: "throw",
    })
    const out = await port.restoreFiles("t-d11")
    expect(out.ok).toBe(true)
    expect(out.tag).toBe("t-d11")
  })

  test("HELL-D12: restoreTask success passthrough (throw mode)", async () => {
    const inner = makePort({})
    const port = withRollbackLlmErrorEmit(inner, { emitRollbackFailureAsLlmError: true })
    const out = await port.restoreTask("t-d12")
    expect(out.ok).toBe(true)
    expect(out.tag).toBe("t-d12")
  })

  test("HELL-D13: restoreBoth success passthrough (throw mode)", async () => {
    const inner = makePort({})
    const port = withRollbackLlmErrorEmit(inner, { emitRollbackFailureAsLlmError: true })
    const out = await port.restoreBoth("t-d13")
    expect(out.ok).toBe(true)
    expect(out.tag).toBe("t-d13")
  })
})

/* ------------------------------------------------------------------ */
/* E. error-code mapping precision (every code → same kind)            */
/* ------------------------------------------------------------------ */

describe("HELL-E: every RestoreErrorCode maps to thread_rollback_failed kind", () => {
  const allCodes: ReadonlyArray<RestoreErrorCode> = [
    "tag-not-found",
    "shadow-odb-not-configured",
    "conversation-store-not-configured",
    "task-snapshot-missing",
    "shadow-rewind-failed",
  ]

  test("HELL-E14: all 5 RestoreErrorCode arms collapse to thread_rollback_failed", () => {
    for (const code of allCodes) {
      const out = failOutcome("t", code, `msg-${code}`)
      const err = rollbackOutcomeToLlmError(out)
      expect(err.kind).toBe("thread_rollback_failed")
      expect(err.message).toContain(code)
    }
  })

  test("HELL-E15: outcome with originalCode surfaces it in the message", () => {
    const out = failOutcome("t", "shadow-rewind-failed", "rewind broke", "merge-in-progress")
    const err = rollbackOutcomeToLlmError(out)
    expect(err.message).toContain("merge-in-progress")
  })
})
