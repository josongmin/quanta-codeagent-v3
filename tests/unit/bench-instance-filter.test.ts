/**
 * RED-first hellgate for the `--instance` filter semantics (self-audit 2026-06-16).
 *
 * BUG: full-remote builds `--instance ${ids.join(",")}` for a subset, but the
 * bench `run` filter was a single substring match (`id.includes(filter)`), so a
 * comma-joined multi-id value matched NOTHING (no id contains a literal comma)
 * → silent empty grade after a full provision/install cycle.
 *
 * FIX: `--instance` is a comma-separated list of substrings; an id matches if it
 * contains ANY part. Single value (no comma) stays plain substring match
 * (byte-identical back-compat).
 */
import { describe, expect, test } from "bun:test"
import type { Instance } from "../../src/apps/bench/types"
import { matchesInstanceFilter, selectInstances } from "../../src/runner/batch/core"

describe("matchesInstanceFilter", () => {
  test("single substring = plain match (back-compat)", () => {
    expect(matchesInstanceFilter("psf__requests-5414", "requests")).toBe(true)
    expect(matchesInstanceFilter("psf__requests-5414", "django")).toBe(false)
    // exact id
    expect(matchesInstanceFilter("psf__requests-5414", "psf__requests-5414")).toBe(true)
  })

  test("comma list = OR of substrings (the multi-instance fix)", () => {
    const f = "psf__requests-5414,django__django-12345"
    // TEETH: the OLD single-substring filter returned false here (no id contains
    // the literal comma-joined string) — both ids must now match.
    expect(matchesInstanceFilter("psf__requests-5414", f)).toBe(true)
    expect(matchesInstanceFilter("django__django-12345", f)).toBe(true)
    expect(matchesInstanceFilter("sympy__sympy-99999", f)).toBe(false)
  })

  test("trims whitespace and ignores empty parts", () => {
    expect(matchesInstanceFilter("a-1", " a-1 , b-2 ")).toBe(true)
    expect(matchesInstanceFilter("b-2", " a-1 , b-2 ")).toBe(true)
    // all-empty filter ⇒ matches everything (no-op)
    expect(matchesInstanceFilter("anything", " , ,")).toBe(true)
  })
})

describe("selectInstances honors comma-OR", () => {
  const mk = (id: string): Instance =>
    ({ id, repo: "r", baseCommit: "c", problemStatement: "p" }) as unknown as Instance

  test("comma filter selects BOTH ids (old behavior selected zero)", () => {
    const all = [mk("psf__requests-5414"), mk("django__django-12345"), mk("sympy__sympy-1")]
    const sel = selectInstances(all, "psf__requests-5414,django__django-12345", null)
    expect(sel.map((i) => i.id).sort()).toEqual(
      ["django__django-12345", "psf__requests-5414"].sort(),
    )
  })
})
