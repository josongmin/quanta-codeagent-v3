/**
 * ADR-0205 hellgate — `::git-*` directive emit protocol.
 *
 * 15 adversarial cases pinning:
 *   - default-OFF byte-identical (no-op emitter is silent)
 *   - round-trip equivalence for every kind
 *   - canonical alpha-sorted JSON keys
 *   - typed parse-failure modes (no throws)
 *   - stderr-only channel discipline
 *   - shape validation (isDraft boolean, stage paths frozen)
 *   - line-framing safety (newline in commit message escaped)
 *   - emit FIFO order
 */

import { describe, expect, test } from "bun:test"
import {
  type DirectiveSink,
  defaultStdoutEmitter,
  type GitDirective,
  type GitDirectiveEmitter,
  noopEmitter,
  parse,
  serialize,
} from "@/agent/git-directives"

// ---------------------------------------------------------------------------
// HELL-GD-01 — no-op emitter is silent for all 5 kinds
// ---------------------------------------------------------------------------

describe("ADR-0205 default-OFF (HELL-GD-01)", () => {
  test("noopEmitter.emit produces zero side effects across all 5 kinds", () => {
    const directives: readonly GitDirective[] = [
      { kind: "create-branch", name: "feat/x" },
      { kind: "stage", paths: ["a.ts"] },
      { kind: "commit", sha: "abc123", message: "feat: x" },
      { kind: "push", remote: "origin", branch: "main" },
      { kind: "create-pr", url: "https://example/pr/1", isDraft: false },
    ]
    // Record process.stderr.write + process.stdout.write to confirm no
    // side effects whatsoever (even though noopEmitter is decoupled from
    // process streams, this guards future implementations from regressing).
    const errWrites: string[] = []
    const outWrites: string[] = []
    const origErr = process.stderr.write.bind(process.stderr)
    const origOut = process.stdout.write.bind(process.stdout)
    process.stderr.write = ((chunk: string): boolean => {
      errWrites.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    process.stdout.write = ((chunk: string): boolean => {
      outWrites.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      for (const d of directives) noopEmitter.emit(d)
    } finally {
      process.stderr.write = origErr
      process.stdout.write = origOut
    }
    expect(errWrites).toEqual([])
    expect(outWrites).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// HELL-GD-02..06 — round-trip per kind
// ---------------------------------------------------------------------------

describe("ADR-0205 round-trip (HELL-GD-02..06)", () => {
  test("HELL-GD-02 create-branch", () => {
    const d: GitDirective = { kind: "create-branch", name: "feat/abc-123" }
    const result = parse(serialize(d))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(d)
  })

  test("HELL-GD-03 stage", () => {
    const d: GitDirective = { kind: "stage", paths: ["src/a.ts", "src/b.ts"] }
    const result = parse(serialize(d))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.kind).toBe("stage")
      if (result.value.kind === "stage") expect([...result.value.paths]).toEqual([...d.paths])
    }
  })

  test("HELL-GD-04 commit", () => {
    const d: GitDirective = {
      kind: "commit",
      sha: "deadbeef1234",
      message: "fix: thing",
    }
    const result = parse(serialize(d))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(d)
  })

  test("HELL-GD-05 push", () => {
    const d: GitDirective = { kind: "push", remote: "origin", branch: "main" }
    const result = parse(serialize(d))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(d)
  })

  test("HELL-GD-06 create-pr", () => {
    const d: GitDirective = {
      kind: "create-pr",
      url: "https://github.com/o/r/pull/42",
      isDraft: true,
    }
    const result = parse(serialize(d))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(d)
  })
})

// ---------------------------------------------------------------------------
// HELL-GD-07 — canonical alpha-sorted keys (snapshot)
// ---------------------------------------------------------------------------

describe("ADR-0205 canonical key order (HELL-GD-07)", () => {
  test("all 5 kinds serialize with alphabetically-sorted JSON keys", () => {
    // Each directive's payload (everything but `kind`) must be a JSON object
    // whose top-level keys appear in alphabetical order in the wire form.
    expect(serialize({ kind: "create-branch", name: "x" })).toBe('::git-create-branch{"name":"x"}')
    expect(serialize({ kind: "stage", paths: ["a", "b"] })).toBe('::git-stage{"paths":["a","b"]}')
    // commit: message < sha alphabetically — message first
    expect(serialize({ kind: "commit", sha: "abc", message: "m" })).toBe(
      '::git-commit{"message":"m","sha":"abc"}',
    )
    // push: branch < remote — branch first
    expect(serialize({ kind: "push", remote: "origin", branch: "main" })).toBe(
      '::git-push{"branch":"main","remote":"origin"}',
    )
    // create-pr: isDraft < url — isDraft first
    expect(serialize({ kind: "create-pr", url: "u", isDraft: false })).toBe(
      '::git-create-pr{"isDraft":false,"url":"u"}',
    )
  })

  test("payload-object construction order is irrelevant — sort enforces canonical wire", () => {
    // Even if the underlying directive object lists fields in non-alpha order,
    // the serialized wire must still be alpha-sorted. (Discriminated unions
    // are constructed by callers — we can't control declaration order.)
    const d: GitDirective = { sha: "x", message: "m", kind: "commit" } as GitDirective
    expect(serialize(d)).toBe('::git-commit{"message":"m","sha":"x"}')
  })
})

// ---------------------------------------------------------------------------
// HELL-GD-08 — non-directive prefix
// ---------------------------------------------------------------------------

describe("ADR-0205 parser rejects non-directive (HELL-GD-08)", () => {
  test("plain text returns not-a-directive (no throw)", () => {
    const r = parse("hello world")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("not-a-directive")
  })

  test("close-but-no-prefix variants rejected", () => {
    expect(parse(":git-commit{}").ok).toBe(false)
    expect(parse(" ::git-commit{}").ok).toBe(false) // leading space
    expect(parse("git-commit{}").ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// HELL-GD-09 — malformed JSON
// ---------------------------------------------------------------------------

describe("ADR-0205 parser handles malformed JSON (HELL-GD-09)", () => {
  test("broken JSON body returns malformed-directive (no throw)", () => {
    const r = parse("::git-commit{not json}")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("malformed-directive")
  })

  test("missing brace returns malformed-directive", () => {
    const r = parse("::git-commit")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("malformed-directive")
  })
})

// ---------------------------------------------------------------------------
// HELL-GD-10 — unknown kind
// ---------------------------------------------------------------------------

describe("ADR-0205 parser rejects unknown kind (HELL-GD-10)", () => {
  test("unknown kind returns unknown-kind (no throw)", () => {
    const r = parse("::git-flarble{}")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("unknown-kind")
      if (r.error.kind === "unknown-kind") expect(r.error.received).toBe("flarble")
    }
  })
})

// ---------------------------------------------------------------------------
// HELL-GD-11 — stderr-only channel discipline
// ---------------------------------------------------------------------------

describe("ADR-0205 defaultStdoutEmitter writes to stderr (HELL-GD-11)", () => {
  test("emit lands on process.stderr, NOT process.stdout", () => {
    const errWrites: string[] = []
    const outWrites: string[] = []
    const origErr = process.stderr.write.bind(process.stderr)
    const origOut = process.stdout.write.bind(process.stdout)
    process.stderr.write = ((chunk: string): boolean => {
      errWrites.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    process.stdout.write = ((chunk: string): boolean => {
      outWrites.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      const emitter = defaultStdoutEmitter()
      emitter.emit({ kind: "commit", sha: "abc", message: "m" })
    } finally {
      process.stderr.write = origErr
      process.stdout.write = origOut
    }
    expect(outWrites).toEqual([])
    expect(errWrites.length).toBe(1)
    expect(errWrites[0]).toBe('::git-commit{"message":"m","sha":"abc"}\n')
  })

  test("custom sink injected for tests bypasses process streams", () => {
    const writes: string[] = []
    const sink: DirectiveSink = {
      write(chunk: string): boolean {
        writes.push(chunk)
        return true
      },
    }
    const emitter = defaultStdoutEmitter(sink)
    emitter.emit({ kind: "create-branch", name: "feat/x" })
    expect(writes).toEqual(['::git-create-branch{"name":"feat/x"}\n'])
  })
})

// ---------------------------------------------------------------------------
// HELL-GD-12 — isDraft must be boolean
// ---------------------------------------------------------------------------

describe("ADR-0205 parser validates create-pr.isDraft (HELL-GD-12)", () => {
  test('isDraft="yes" string rejected with shape-mismatch', () => {
    const r = parse('::git-create-pr{"isDraft":"yes","url":"u"}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("shape-mismatch")
  })

  test("isDraft:1 number rejected with shape-mismatch", () => {
    const r = parse('::git-create-pr{"isDraft":1,"url":"u"}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("shape-mismatch")
  })

  test("isDraft:true / false both accepted", () => {
    const a = parse('::git-create-pr{"isDraft":true,"url":"u"}')
    const b = parse('::git-create-pr{"isDraft":false,"url":"u"}')
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// HELL-GD-13 — stage paths frozen on parse
// ---------------------------------------------------------------------------

describe("ADR-0205 stage paths frozen on parse (HELL-GD-13)", () => {
  test("parsed paths array rejects mutation", () => {
    const r = parse('::git-stage{"paths":["a","b"]}')
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === "stage") {
      expect(Object.isFrozen(r.value.paths)).toBe(true)
      // Mutation MUST throw (strict mode) or be silently dropped (sloppy);
      // either way the final length is 2.
      expect(() => {
        ;(r.value as unknown as { paths: string[] }).paths.push("c")
      }).toThrow()
      expect(r.value.paths.length).toBe(2)
    }
  })
})

// ---------------------------------------------------------------------------
// HELL-GD-14 — newline in commit message survives round-trip
// ---------------------------------------------------------------------------

describe("ADR-0205 newline in commit message (HELL-GD-14)", () => {
  test("commit.message with embedded \\n round-trips and does not break line framing", () => {
    const d: GitDirective = {
      kind: "commit",
      sha: "abc",
      message: "line one\nline two",
    }
    const line = serialize(d)
    // Wire form MUST be a single physical line (no embedded raw newlines).
    expect(line.includes("\n")).toBe(false)
    // The escaped \n is present as the 2-char escape sequence.
    expect(line.includes("\\n")).toBe(true)
    const r = parse(line)
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === "commit") {
      expect(r.value.message).toBe("line one\nline two")
    }
  })

  test("control chars (tab, backslash, quote) also survive", () => {
    const d: GitDirective = {
      kind: "commit",
      sha: "x",
      message: 'tab\there\\back"quote',
    }
    const line = serialize(d)
    expect(line.includes("\n")).toBe(false)
    const r = parse(line)
    expect(r.ok).toBe(true)
    if (r.ok && r.value.kind === "commit") {
      expect(r.value.message).toBe('tab\there\\back"quote')
    }
  })
})

// ---------------------------------------------------------------------------
// HELL-GD-15 — emit FIFO order
// ---------------------------------------------------------------------------

describe("ADR-0205 emit preserves FIFO order (HELL-GD-15)", () => {
  test("5 rapid emits land in input order on the sink", () => {
    const writes: string[] = []
    const sink: DirectiveSink = {
      write(chunk: string): boolean {
        writes.push(chunk)
        return true
      },
    }
    const emitter: GitDirectiveEmitter = defaultStdoutEmitter(sink)
    const directives: readonly GitDirective[] = [
      { kind: "create-branch", name: "feat/x" },
      { kind: "stage", paths: ["a.ts"] },
      { kind: "commit", sha: "111", message: "first" },
      { kind: "commit", sha: "222", message: "second" },
      { kind: "push", remote: "origin", branch: "feat/x" },
    ]
    for (const d of directives) emitter.emit(d)
    expect(writes).toEqual([
      '::git-create-branch{"name":"feat/x"}\n',
      '::git-stage{"paths":["a.ts"]}\n',
      '::git-commit{"message":"first","sha":"111"}\n',
      '::git-commit{"message":"second","sha":"222"}\n',
      '::git-push{"branch":"feat/x","remote":"origin"}\n',
    ])
  })
})
