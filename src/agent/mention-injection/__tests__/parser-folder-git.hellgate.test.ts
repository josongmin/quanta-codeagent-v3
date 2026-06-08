/**
 * §10.3 — `@folder` + `@git` mention kinds (Cursor `@Folders` + `@git` parity).
 *
 * ADR-0418 is SUPERSEDED for the kind enum: the closed set becomes 7-way
 * (`skill | plugin | app | file | symbol | folder | git`). Two new routes are
 * added to the deterministic §4 cascade WITHOUT disturbing the existing five:
 *
 *   - A path that ENDS WITH `/` is a FOLDER (priority 2a, before file). Cursor
 *     surfaces `@Folders` as a distinct mention so the model gets a directory
 *     listing rather than a (nonsensical) file read.
 *   - The reserved literal `@git` (optionally `@git:status` / `@git:diff` /
 *     `@git:log`) is the GIT context provider (priority 1.5, before skill).
 *     This is the only reserved word — a `git`-named skill is unreachable by
 *     bare `@git`, which is the intended Cursor/Codex behaviour.
 *
 * Byte-identity: any input WITHOUT a trailing-slash path and WITHOUT a `@git`
 * token parses byte-identically to the pre-§10.3 5-kind cascade (proven in the
 * existing parser-file-symbol hellgate, untouched here).
 */
import { describe, expect, test } from "bun:test"
import { parseMentions } from "../parser"

describe("§10.3 @folder — trailing-slash path", () => {
  test("@docs/decisions/ ⇒ folder (was file pre-§10.3)", () => {
    const out = parseMentions("look in @docs/decisions/")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("folder")
    expect(out[0]?.target).toBe("docs/decisions/")
  })

  test("@src/ ⇒ folder (single component + trailing slash)", () => {
    const out = parseMentions("@src/")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("folder")
    expect(out[0]?.target).toBe("src/")
  })

  test("@src/agent/loop.ts (no trailing slash) stays file", () => {
    const out = parseMentions("@src/agent/loop.ts")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
  })

  test("@./ ⇒ folder (cwd)", () => {
    const out = parseMentions("@./")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("folder")
    expect(out[0]?.target).toBe("./")
  })

  test("span.end - span.start === raw.length for a folder mention", () => {
    const out = parseMentions("see @docs/decisions/ here")
    expect(out).toHaveLength(1)
    const m = out[0]
    expect((m?.span.end ?? 0) - (m?.span.start ?? 0)).toBe(m?.raw.length ?? -1)
  })
})

describe("§10.3 @git — reserved git context literal", () => {
  test("@git ⇒ git, target 'status' (default subcommand)", () => {
    const out = parseMentions("review @git changes")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("git")
    expect(out[0]?.target).toBe("status")
    expect(out[0]?.raw).toBe("@git")
  })

  test("@git:diff ⇒ git, target 'diff'", () => {
    const out = parseMentions("@git:diff")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("git")
    expect(out[0]?.target).toBe("diff")
    expect(out[0]?.raw).toBe("@git:diff")
  })

  test("@git:log ⇒ git, target 'log'", () => {
    const out = parseMentions("@git:log")
    expect(out[0]?.kind).toBe("git")
    expect(out[0]?.target).toBe("log")
  })

  test("@git:status ⇒ git, target 'status'", () => {
    const out = parseMentions("@git:status")
    expect(out[0]?.kind).toBe("git")
    expect(out[0]?.target).toBe("status")
  })

  test("an UNKNOWN @git:subcommand is NOT a git mention (closed enum)", () => {
    // `@git:bogus` falls through; `git` (lowercase, no dot/slash) would be a
    // skill but the `:bogus` tail terminates the kebab => `git` skill remains.
    const out = parseMentions("@git:bogus")
    // The `@git` prefix is the kebab `git` (skill); `:bogus` is a terminator.
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("skill")
    expect(out[0]?.target).toBe("git")
  })

  test("@github (longer kebab) is NOT @git — stays skill 'github'", () => {
    const out = parseMentions("@github")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("skill")
    expect(out[0]?.target).toBe("github")
  })

  test("email-style left boundary still rejects foo@git", () => {
    expect(parseMentions("foo@git")).toEqual([])
  })

  // §10.3 right-boundary hardening — `@git` matches ONLY at a true terminator.
  // A path / identifier continuation char after `git` falls through to the
  // file/skill cascade (so `@git/x` is a path, not the git provider).
  test("@git/x ⇒ file (slash continuation, NOT git)", () => {
    const out = parseMentions("@git/x")
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("git/x")
  })

  test("@git/ ⇒ folder (NOT git)", () => {
    const out = parseMentions("@git/")
    expect(out[0]?.kind).toBe("folder")
  })

  test("@git.foo ⇒ file (dot continuation, NOT git)", () => {
    const out = parseMentions("@git.foo")
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.target).toBe("git.foo")
  })

  test("@git, then ⇒ git (comma is a real terminator)", () => {
    const out = parseMentions("@git, then")
    expect(out[0]?.kind).toBe("git")
    expect(out[0]?.target).toBe("status")
  })
})

describe("§10.3 mixed ordering + dedup", () => {
  test("folder, git, file, symbol, skill preserve textual order", () => {
    const out = parseMentions("@src/ @git @a.ts @Foo @review")
    expect(out.map((m) => m.kind)).toEqual(["folder", "git", "file", "symbol", "skill"])
  })

  test("duplicate @git dedups (FIRST occurrence kept)", () => {
    const out = parseMentions("@git and again @git")
    expect(out).toHaveLength(1)
    expect(out[0]?.span.start).toBe(0)
  })

  test("@git:diff and @git:status are distinct git mentions", () => {
    const out = parseMentions("@git:diff then @git:status")
    expect(out).toHaveLength(2)
    expect(out.map((m) => m.target)).toEqual(["diff", "status"])
  })
})
