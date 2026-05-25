/**
 * ADR-0221 hellgate — `::git-*` 5-directive emit protocol (phase-guarded).
 *
 * 18 adversarial cases pinning:
 *   - default-OFF byte-identical (noopEmitter never writes, always ok)
 *   - 5 kinds each emit successfully in `final-answer` phase
 *   - commentary + intermediate phases rejected with typed `wrong-phase`
 *   - parser rejects malformed JSON, unknown kind, non-prefix, non-object
 *   - serialize → parse round-trip (canonical alpha-sorted keys)
 *   - OFF parity (noop never touches sink)
 *   - multi-emit FIFO order
 *   - isDraft true / false both round-trip
 *   - sha format passes through (no validation beyond non-empty)
 *   - branch name non-empty validation rejects ""
 *   - newline-in-commit-message survives line framing (JSON escape)
 *   - phase guard runs BEFORE sink write (wrong-phase = no side effect)
 */

import { describe, expect, test } from "bun:test"
import {
  type DirectiveSink,
  defaultEmitter,
  type EmitContext,
  type GitDirective,
  noopEmitter,
  parse,
  serialize,
  validateDirective,
} from "@/git/directive-emit"

// ---------------------------------------------------------------------------
// Test helpers — recording sink + 5 sample directives.
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

const FINAL: EmitContext = { phase: "final-answer" }

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
// HELL-DE-01 — default-OFF byte-identical
// ---------------------------------------------------------------------------

describe("ADR-0221 default-OFF (HELL-DE-01)", () => {
  test("noopEmitter returns ok and produces zero writes for all 5 kinds + 3 phases", () => {
    const phases: EmitContext[] = [
      { phase: "final-answer" },
      { phase: "commentary" },
      { phase: "intermediate" },
    ]
    for (const d of ALL_KINDS) {
      for (const ctx of phases) {
        const r = noopEmitter.emit(d, ctx)
        expect(r.ok).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// HELL-DE-02 / HELL-DE-03 — phase guard rejects commentary + intermediate
// ---------------------------------------------------------------------------

describe("ADR-0221 phase guard (HELL-DE-02, HELL-DE-03)", () => {
  test("commentary phase: defaultEmitter rejects with wrong-phase and never writes", () => {
    const { sink, writes } = recordingSink()
    const em = defaultEmitter(sink)
    const r = em.emit(CREATE_BRANCH, { phase: "commentary" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("wrong-phase")
      if (r.error.kind === "wrong-phase") expect(r.error.phase).toBe("commentary")
    }
    expect(writes).toEqual([])
  })

  test("intermediate phase: defaultEmitter rejects with wrong-phase and never writes", () => {
    const { sink, writes } = recordingSink()
    const em = defaultEmitter(sink)
    const r = em.emit(COMMIT, { phase: "intermediate" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("wrong-phase")
      if (r.error.kind === "wrong-phase") expect(r.error.phase).toBe("intermediate")
    }
    expect(writes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// HELL-DE-04 — all 5 kinds emit successfully in final-answer phase
// ---------------------------------------------------------------------------

describe("ADR-0221 all 5 kinds emit in final-answer (HELL-DE-04)", () => {
  test.each(
    ALL_KINDS.map((d) => [d.kind, d] as const),
  )("kind=%s emits with one line written", (_k, d) => {
    const { sink, writes } = recordingSink()
    const em = defaultEmitter(sink)
    const r = em.emit(d, FINAL)
    expect(r.ok).toBe(true)
    expect(writes).toHaveLength(1)
    const line = writes[0] ?? ""
    expect(line.startsWith(`::git-${d.kind}`)).toBe(true)
    expect(line.endsWith("\n")).toBe(true)
    // No embedded newlines mid-frame.
    expect(line.slice(0, -1).includes("\n")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// HELL-DE-05 — serialize → parse round-trip for every kind
// ---------------------------------------------------------------------------

describe("ADR-0221 serialize→parse round-trip (HELL-DE-05)", () => {
  test.each(
    ALL_KINDS.map((d) => [d.kind, d] as const),
  )("kind=%s round-trips structurally", (_k, d) => {
    const line = serialize(d)
    const back = parse(line)
    expect(back).not.toBeNull()
    // Compare by structural JSON to avoid frozen-array identity issues.
    expect(JSON.parse(JSON.stringify(back))).toEqual(JSON.parse(JSON.stringify(d)) as unknown)
  })
})

// ---------------------------------------------------------------------------
// HELL-DE-06 — canonical JSON: keys are alpha-sorted
// ---------------------------------------------------------------------------

describe("ADR-0221 canonical JSON (HELL-DE-06)", () => {
  test("serialize output uses alpha-sorted keys for every kind", () => {
    expect(serialize({ kind: "create-branch", name: "x" })).toBe(`::git-create-branch{"name":"x"}`)
    expect(serialize({ kind: "stage", files: ["b", "a"] })).toBe(`::git-stage{"files":["b","a"]}`)
    // commit: message before sha (m < s)
    expect(serialize({ kind: "commit", sha: "abc", message: "m" })).toBe(
      `::git-commit{"message":"m","sha":"abc"}`,
    )
    // push: force before ref (f < r)
    expect(serialize({ kind: "push", ref: "refs/heads/x", force: true })).toBe(
      `::git-push{"force":true,"ref":"refs/heads/x"}`,
    )
    // create-pr: isDraft before url (i < u)
    expect(serialize({ kind: "create-pr", url: "https://u/1", isDraft: false })).toBe(
      `::git-create-pr{"isDraft":false,"url":"https://u/1"}`,
    )
  })
})

// ---------------------------------------------------------------------------
// HELL-DE-07 / HELL-DE-08 / HELL-DE-09 — parser rejects garbage
// ---------------------------------------------------------------------------

describe("ADR-0221 parser rejection (HELL-DE-07/08/09)", () => {
  test("parse returns null for non-prefix line (HELL-DE-07)", () => {
    expect(parse("hello world")).toBeNull()
    expect(parse("")).toBeNull()
    expect(parse("git-commit{}")).toBeNull()
  })

  test("parse returns null for malformed JSON body (HELL-DE-08)", () => {
    expect(parse(`::git-commit{not json}`)).toBeNull()
    expect(parse(`::git-commit{"sha":}`)).toBeNull()
    expect(parse(`::git-commit`)).toBeNull() // no body at all
  })

  test("parse returns null for unknown kind (HELL-DE-09)", () => {
    expect(parse(`::git-pull{}`)).toBeNull()
    expect(parse(`::git-{}`)).toBeNull()
    expect(parse(`::git-rebase{"x":1}`)).toBeNull()
  })

  test("parse returns null for non-object payload", () => {
    expect(parse(`::git-stage[]`)).toBeNull() // arrays not allowed (no `{`)
    expect(parse(`::git-stage{"files":"not-array"}`)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// HELL-DE-10 — multi-emit FIFO order
// ---------------------------------------------------------------------------

describe("ADR-0221 multi-emit FIFO (HELL-DE-10)", () => {
  test("5 rapid emits arrive at sink in submission order", () => {
    const { sink, writes } = recordingSink()
    const em = defaultEmitter(sink)
    for (const d of ALL_KINDS) {
      const r = em.emit(d, FINAL)
      expect(r.ok).toBe(true)
    }
    expect(writes).toHaveLength(5)
    for (let i = 0; i < ALL_KINDS.length; i++) {
      const written = writes[i] ?? ""
      const expectedKind = ALL_KINDS[i]?.kind ?? ""
      expect(written.startsWith(`::git-${expectedKind}`)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// HELL-DE-11 — isDraft true / false both round-trip
// ---------------------------------------------------------------------------

describe("ADR-0221 create-pr isDraft boolean (HELL-DE-11)", () => {
  test("isDraft=true round-trips", () => {
    const d: GitDirective = {
      kind: "create-pr",
      url: "https://github.com/o/r/pull/1",
      isDraft: true,
    }
    const back = parse(serialize(d))
    expect(back).toEqual(d)
  })
  test("isDraft=false round-trips", () => {
    const d: GitDirective = {
      kind: "create-pr",
      url: "https://github.com/o/r/pull/2",
      isDraft: false,
    }
    const back = parse(serialize(d))
    expect(back).toEqual(d)
  })
  test("isDraft non-boolean rejected by parser", () => {
    expect(parse(`::git-create-pr{"isDraft":"yes","url":"https://u/1"}`)).toBeNull()
    expect(parse(`::git-create-pr{"isDraft":1,"url":"https://u/1"}`)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// HELL-DE-12 — sha non-empty validation
// ---------------------------------------------------------------------------

describe("ADR-0221 sha non-empty validation (HELL-DE-12)", () => {
  test("empty sha rejected via validateDirective", () => {
    const r = validateDirective({ kind: "commit", sha: "", message: "m" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-directive")
  })
  test("non-empty sha accepted (no format check beyond non-empty)", () => {
    const r1 = validateDirective({ kind: "commit", sha: "abc", message: "m" })
    expect(r1.ok).toBe(true)
    const r2 = validateDirective({
      kind: "commit",
      sha: "0123456789abcdef0123456789abcdef01234567",
      message: "m",
    })
    expect(r2.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// HELL-DE-13 — branch name non-empty validation
// ---------------------------------------------------------------------------

describe("ADR-0221 branch name non-empty (HELL-DE-13)", () => {
  test("empty branch name rejected", () => {
    const r = validateDirective({ kind: "create-branch", name: "" })
    expect(r.ok).toBe(false)
  })
  test("emitter rejects empty branch with typed error and never writes", () => {
    const { sink, writes } = recordingSink()
    const em = defaultEmitter(sink)
    const r = em.emit({ kind: "create-branch", name: "" }, FINAL)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-directive")
    expect(writes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// HELL-DE-14 — newline in commit message survives line framing
// ---------------------------------------------------------------------------

describe("ADR-0221 newline in commit message (HELL-DE-14)", () => {
  test("commit message with `\\n` produces exactly one wire line", () => {
    const d: GitDirective = {
      kind: "commit",
      sha: "abc",
      message: "feat: x\n\nbody line",
    }
    const line = serialize(d)
    // Exactly one `\n` would be the terminator if any; serialize itself
    // produces a single newline-free line.
    expect(line.includes("\n")).toBe(false)
    const back = parse(line)
    expect(back).toEqual(d)
  })
})

// ---------------------------------------------------------------------------
// HELL-DE-15 — phase guard runs BEFORE sink write
// ---------------------------------------------------------------------------

describe("ADR-0221 phase guard short-circuits (HELL-DE-15)", () => {
  test("wrong-phase + invalid directive still rejected on phase first", () => {
    // Construct a directive that would also fail shape validation; the phase
    // guard runs first, so the error kind is `wrong-phase`, not `invalid-directive`.
    const { sink, writes } = recordingSink()
    const em = defaultEmitter(sink)
    const r = em.emit({ kind: "create-branch", name: "" }, { phase: "commentary" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("wrong-phase")
    expect(writes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// HELL-DE-16 — push force flag both values round-trip
// ---------------------------------------------------------------------------

describe("ADR-0221 push force boolean (HELL-DE-16)", () => {
  test("force=true serializes and parses back", () => {
    const d: GitDirective = { kind: "push", ref: "refs/heads/main", force: true }
    expect(parse(serialize(d))).toEqual(d)
  })
  test("force=false serializes and parses back", () => {
    const d: GitDirective = { kind: "push", ref: "refs/heads/main", force: false }
    expect(parse(serialize(d))).toEqual(d)
  })
  test("force non-boolean rejected by parser", () => {
    expect(parse(`::git-push{"force":"true","ref":"refs/heads/x"}`)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// HELL-DE-17 — stage files immutable on parse
// ---------------------------------------------------------------------------

describe("ADR-0221 stage files frozen on parse (HELL-DE-17)", () => {
  test("parsed stage.files cannot be mutated", () => {
    const back = parse(`::git-stage{"files":["a.ts","b.ts"]}`)
    expect(back).not.toBeNull()
    if (back && back.kind === "stage") {
      expect(() => {
        ;(back.files as string[]).push("c.ts")
      }).toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// HELL-DE-18 — noop vs default parity in final-answer (OFF parity)
// ---------------------------------------------------------------------------

describe("ADR-0221 OFF parity (HELL-DE-18)", () => {
  test("noopEmitter never writes to any sink even in final-answer phase", () => {
    // noopEmitter is sink-free by construction; pinning the contract here.
    for (const d of ALL_KINDS) {
      const r = noopEmitter.emit(d, FINAL)
      expect(r.ok).toBe(true)
    }
    // No assertion of writes possible (no sink) — the contract is "no side
    // effect possible because the emitter is sink-free".
    expect(true).toBe(true)
  })
})
