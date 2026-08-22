/**
 * ADR-0232 hellgate — per-turn git-directive collector (phase-aware wire).
 *
 * 18 adversarial cases pinning:
 *
 *   HELL-DC-01 — noopCollector: record() is no-op, flush() returns [], length=0
 *   HELL-DC-02 — record() buffers; flush() drains in FIFO order
 *   HELL-DC-03 — 5 directive kinds round-trip through collector → emitter
 *   HELL-DC-04 — flush() emits with phase="final-answer" (not intermediate)
 *   HELL-DC-05 — empty buffer flush is a no-op (emitter never touched)
 *   HELL-DC-06 — multi-record order preserved across flush
 *   HELL-DC-07 — collector resets between turns (flush empties buffer)
 *   HELL-DC-08 — flush with noopEmitter still drains buffer (length → 0)
 *   HELL-DC-09 — includeIntermediate=true: record() ALSO emits eagerly + buffers
 *   HELL-DC-10 — includeIntermediate=false (default): record() buffers ONLY
 *   HELL-DC-11 — flush() return shape matches submitted count + order
 *   HELL-DC-12 — wrong-phase / shape errors surface in flush() return values
 *   HELL-DC-13 — emitter that throws (contract violation) does NOT crash flush()
 *   HELL-DC-14 — length reflects buffered count between record + flush
 *   HELL-DC-15 — re-entrant emit (sink records back) does not double-drain
 *   HELL-DC-16 — includeIntermediate eager-emit failure does NOT prevent buffer
 *   HELL-DC-17 — 2-turn lifecycle: record → flush → record → flush is independent
 *   HELL-DC-18 — directive identity preserved (no defensive copy mutation)
 */

import { describe, expect, test } from "bun:test"
import {
  buildGitDirectiveCollector,
  type DirectiveEmitterPort,
  type DirectiveSink,
  defaultEmitter,
  type EmitContext,
  type EmitError,
  type GitDirective,
  noopCollector,
  noopEmitter,
} from "@/git/directive-emit"
import type { Result } from "@/shared"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const recordingSink = (): { sink: DirectiveSink; writes: string[] } => {
  const writes: string[] = []
  return {
    sink: {
      write(chunk: string): boolean {
        writes.push(chunk)
        return true
      },
    },
    writes,
  }
}

/** Recording emitter that captures every (directive, ctx) pair. Useful for
 *  asserting that the collector passes phase="final-answer". */
const recordingEmitter = (): {
  port: DirectiveEmitterPort
  calls: Array<{ directive: GitDirective; ctx: EmitContext }>
} => {
  const calls: Array<{ directive: GitDirective; ctx: EmitContext }> = []
  return {
    port: {
      emit(directive: GitDirective, ctx: EmitContext): Result<void, EmitError> {
        calls.push({ directive, ctx })
        return { ok: true, value: undefined }
      },
    },
    calls,
  }
}

const CREATE_BRANCH: GitDirective = { kind: "create-branch", name: "feat/x" }
const STAGE: GitDirective = { kind: "stage", files: ["a.ts", "b.ts"] }
const COMMIT: GitDirective = { kind: "commit", sha: "abc1234", message: "feat: x" }
const PUSH: GitDirective = { kind: "push", ref: "refs/heads/feat/x", force: false }
const CREATE_PR: GitDirective = {
  kind: "create-pr",
  url: "https://github.com/o/r/pull/1",
  isDraft: true,
}
const ALL_KINDS: readonly GitDirective[] = [CREATE_BRANCH, STAGE, COMMIT, PUSH, CREATE_PR] as const

// ---------------------------------------------------------------------------
// HELL-DC-01 — noopCollector contract
// ---------------------------------------------------------------------------

describe("ADR-0232 noopCollector (HELL-DC-01)", () => {
  test("record() is no-op, flush() returns empty, length=0", () => {
    for (const d of ALL_KINDS) noopCollector.record(d)
    const out = noopCollector.flush()
    expect(out).toEqual([])
    expect(noopCollector.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-02 — record() buffers; flush() drains in FIFO order
// ---------------------------------------------------------------------------

describe("ADR-0232 record+flush FIFO (HELL-DC-02, HELL-DC-06)", () => {
  test("5 records emit in submission order", () => {
    const { port, calls } = recordingEmitter()
    const collector = buildGitDirectiveCollector(port)
    for (const d of ALL_KINDS) collector.record(d)
    expect(collector.length).toBe(5)
    const results = collector.flush()
    expect(results).toHaveLength(5)
    expect(calls).toHaveLength(5)
    for (let i = 0; i < ALL_KINDS.length; i++) {
      const expectedKind = ALL_KINDS[i]?.kind
      expect(calls[i]?.directive.kind).toBe(expectedKind)
    }
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-03 — 5 kinds round-trip through collector → real defaultEmitter
// ---------------------------------------------------------------------------

describe("ADR-0232 5-kind end-to-end via defaultEmitter (HELL-DC-03)", () => {
  test("each kind produces one wire line in submission order", () => {
    const { sink, writes } = recordingSink()
    const emitter = defaultEmitter(sink)
    const collector = buildGitDirectiveCollector(emitter)
    for (const d of ALL_KINDS) collector.record(d)
    const results = collector.flush()
    expect(results).toHaveLength(5)
    expect(writes).toHaveLength(5)
    for (let i = 0; i < ALL_KINDS.length; i++) {
      const w = writes[i] ?? ""
      const expected = ALL_KINDS[i]?.kind ?? ""
      expect(w.startsWith(`::git-${expected}`)).toBe(true)
      expect(w.endsWith("\n")).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-04 — flush() always emits with phase="final-answer"
// ---------------------------------------------------------------------------

describe("ADR-0232 flush phase invariant (HELL-DC-04)", () => {
  test("every emit call from flush carries phase='final-answer'", () => {
    const { port, calls } = recordingEmitter()
    const collector = buildGitDirectiveCollector(port)
    collector.record(COMMIT)
    collector.record(PUSH)
    collector.flush()
    for (const c of calls) {
      expect(c.ctx.phase).toBe("final-answer")
    }
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-05 — empty flush is a no-op
// ---------------------------------------------------------------------------

describe("ADR-0232 empty flush is no-op (HELL-DC-05)", () => {
  test("flush on empty buffer never touches the emitter", () => {
    const { port, calls } = recordingEmitter()
    const collector = buildGitDirectiveCollector(port)
    const r = collector.flush()
    expect(r).toEqual([])
    expect(calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-07 — collector resets between flushes
// ---------------------------------------------------------------------------

describe("ADR-0232 collector resets between turns (HELL-DC-07, HELL-DC-17)", () => {
  test("two record+flush cycles are independent (no carry-over)", () => {
    const { port, calls } = recordingEmitter()
    const collector = buildGitDirectiveCollector(port)
    // Turn 1
    collector.record(COMMIT)
    expect(collector.length).toBe(1)
    collector.flush()
    expect(collector.length).toBe(0)
    expect(calls).toHaveLength(1)
    // Turn 2
    collector.record(PUSH)
    expect(collector.length).toBe(1)
    collector.flush()
    expect(calls).toHaveLength(2)
    expect(calls[0]?.directive.kind).toBe("commit")
    expect(calls[1]?.directive.kind).toBe("push")
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-08 — flush with noopEmitter still drains
// ---------------------------------------------------------------------------

describe("ADR-0232 noop-emitter still drains (HELL-DC-08)", () => {
  test("buffer empties even when emitter is noop", () => {
    const collector = buildGitDirectiveCollector(noopEmitter)
    collector.record(COMMIT)
    collector.record(PUSH)
    expect(collector.length).toBe(2)
    const r = collector.flush()
    expect(collector.length).toBe(0)
    // Each call returns ok (noopEmitter contract).
    expect(r).toHaveLength(2)
    for (const x of r) expect(x.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-09 — includeIntermediate=true: record ALSO emits eagerly
// ---------------------------------------------------------------------------

describe("ADR-0232 includeIntermediate eager emit (HELL-DC-09)", () => {
  test("record emits immediately AND buffers for flush", () => {
    const { port, calls } = recordingEmitter()
    const collector = buildGitDirectiveCollector(port, { includeIntermediate: true })
    collector.record(COMMIT)
    // Eager emit happened during record.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.directive.kind).toBe("commit")
    expect(calls[0]?.ctx.phase).toBe("final-answer")
    // Buffer still has the entry queued for flush.
    expect(collector.length).toBe(1)
    // flush re-emits the buffered entry (intentional — single canonical
    // event stream out of flush; the eager path is the SUPPLEMENTAL surface).
    collector.flush()
    expect(calls).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-10 — includeIntermediate default OFF: record buffers only
// ---------------------------------------------------------------------------

describe("ADR-0232 includeIntermediate default OFF (HELL-DC-10)", () => {
  test("record only buffers; flush is the sole emit path", () => {
    const { port, calls } = recordingEmitter()
    const collector = buildGitDirectiveCollector(port) // no opts
    collector.record(COMMIT)
    expect(calls).toEqual([])
    expect(collector.length).toBe(1)
    collector.flush()
    expect(calls).toHaveLength(1)
  })

  test("includeIntermediate=false explicit ⇒ buffers only", () => {
    const { port, calls } = recordingEmitter()
    const collector = buildGitDirectiveCollector(port, { includeIntermediate: false })
    collector.record(STAGE)
    expect(calls).toEqual([])
    collector.flush()
    expect(calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-11 — flush return shape matches submitted count + order
// ---------------------------------------------------------------------------

describe("ADR-0232 flush return shape (HELL-DC-11)", () => {
  test("each result is a typed Result<void, EmitError>", () => {
    const { port } = recordingEmitter()
    const collector = buildGitDirectiveCollector(port)
    collector.record(CREATE_BRANCH)
    collector.record(STAGE)
    const r = collector.flush()
    expect(r).toHaveLength(2)
    expect(r[0]?.ok).toBe(true)
    expect(r[1]?.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-12 — wrong-phase / shape errors surface in flush return
// ---------------------------------------------------------------------------

describe("ADR-0232 emitter errors propagate (HELL-DC-12)", () => {
  test("invalid-directive error from defaultEmitter surfaces as Result.err", () => {
    const { sink, writes } = recordingSink()
    const emitter = defaultEmitter(sink)
    const collector = buildGitDirectiveCollector(emitter)
    // Malformed: empty branch name triggers validate rejection.
    collector.record({ kind: "create-branch", name: "" })
    const r = collector.flush()
    expect(r).toHaveLength(1)
    expect(r[0]?.ok).toBe(false)
    if (r[0] && !r[0].ok) expect(r[0].error.kind).toBe("invalid-directive")
    // Sink was never written to (validation runs before serializer).
    expect(writes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-13 — emitter contract violation (throw) does NOT crash flush
// ---------------------------------------------------------------------------

describe("ADR-0232 throwing emitter caught (HELL-DC-13)", () => {
  test("flush returns typed error instead of propagating throw", () => {
    const throwing: DirectiveEmitterPort = {
      emit(): Result<void, EmitError> {
        throw new Error("boom")
      },
    }
    const collector = buildGitDirectiveCollector(throwing)
    collector.record(COMMIT)
    // MUST NOT throw.
    const r = collector.flush()
    expect(r).toHaveLength(1)
    expect(r[0]?.ok).toBe(false)
    if (r[0] && !r[0].ok) {
      expect(r[0].error.kind).toBe("invalid-directive")
      if (r[0].error.kind === "invalid-directive") {
        expect(r[0].error.reason).toContain("boom")
      }
    }
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-14 — length reflects buffered count
// ---------------------------------------------------------------------------

describe("ADR-0232 length accessor (HELL-DC-14)", () => {
  test("length tracks record + flush cycle precisely", () => {
    const { port } = recordingEmitter()
    const collector = buildGitDirectiveCollector(port)
    expect(collector.length).toBe(0)
    collector.record(COMMIT)
    expect(collector.length).toBe(1)
    collector.record(PUSH)
    expect(collector.length).toBe(2)
    collector.flush()
    expect(collector.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-15 — re-entrant emit (sink records back into collector)
// ---------------------------------------------------------------------------

describe("ADR-0232 re-entrant emit (HELL-DC-15)", () => {
  test("emitter that synchronously records back is processed in next flush, not this one", () => {
    const { port: recPort, calls } = recordingEmitter()
    // Wrap so first emit triggers a re-entrant record.
    let collectorRef: ReturnType<typeof buildGitDirectiveCollector> | null = null
    let reentered = false
    const reentrantPort: DirectiveEmitterPort = {
      emit(directive, ctx) {
        if (!reentered && directive.kind === "commit") {
          reentered = true
          collectorRef?.record(PUSH)
        }
        return recPort.emit(directive, ctx)
      },
    }
    collectorRef = buildGitDirectiveCollector(reentrantPort)
    collectorRef.record(COMMIT)
    const first = collectorRef.flush()
    // First flush drains exactly 1 (the COMMIT). The re-entrant PUSH is
    // buffered for the NEXT flush — the splice-then-iterate discipline
    // prevents double-drain in a single pass.
    expect(first).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(collectorRef.length).toBe(1) // re-entrant PUSH waiting
    // Second flush picks up the re-entrant entry.
    const second = collectorRef.flush()
    expect(second).toHaveLength(1)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.directive.kind).toBe("push")
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-16 — includeIntermediate eager-emit failure does not prevent buffer
// ---------------------------------------------------------------------------

describe("ADR-0232 eager-emit failure does not break buffer (HELL-DC-16)", () => {
  test("throwing eager emit ⇒ buffer still has entry for next flush", () => {
    const flaky: DirectiveEmitterPort = {
      emit(): Result<void, EmitError> {
        throw new Error("eager-only flake")
      },
    }
    const collector = buildGitDirectiveCollector(flaky, { includeIntermediate: true })
    // MUST NOT throw despite flaky eager emit.
    collector.record(COMMIT)
    expect(collector.length).toBe(1)
    // Flush will hit the same flake but surface it as typed Result.err.
    const r = collector.flush()
    expect(r).toHaveLength(1)
    expect(r[0]?.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-17 — 2-turn lifecycle independence (already partly in HELL-DC-07)
// ---------------------------------------------------------------------------

describe("ADR-0232 2-turn lifecycle (HELL-DC-17)", () => {
  test("between-turn state isolation: each turn's flush surfaces only its own records", () => {
    const { port, calls } = recordingEmitter()
    const collector = buildGitDirectiveCollector(port)
    // Turn A: 3 records.
    collector.record(CREATE_BRANCH)
    collector.record(STAGE)
    collector.record(COMMIT)
    const turnA = collector.flush()
    expect(turnA).toHaveLength(3)
    expect(calls).toHaveLength(3)
    // Turn B: 2 records — must not see Turn A entries.
    collector.record(PUSH)
    collector.record(CREATE_PR)
    const turnB = collector.flush()
    expect(turnB).toHaveLength(2)
    expect(calls).toHaveLength(5)
    expect(calls[3]?.directive.kind).toBe("push")
    expect(calls[4]?.directive.kind).toBe("create-pr")
  })
})

// ---------------------------------------------------------------------------
// HELL-DC-18 — directive identity preserved through buffer
// ---------------------------------------------------------------------------

describe("ADR-0232 directive identity preserved (HELL-DC-18)", () => {
  test("buffer does not deep-copy or mutate the input directive", () => {
    const { port, calls } = recordingEmitter()
    const collector = buildGitDirectiveCollector(port)
    const original: GitDirective = { kind: "stage", files: ["x.ts", "y.ts"] }
    collector.record(original)
    collector.flush()
    expect(calls).toHaveLength(1)
    // The exact same object reference is forwarded (no defensive deep-clone).
    expect(calls[0]?.directive).toBe(original)
  })
})
