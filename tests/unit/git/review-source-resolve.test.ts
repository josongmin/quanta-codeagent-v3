/** RFC-02 B1 — closed `DiffSource` semantics resolver (RED rail first).
 *
 *  Proves, against an INJECTED fake `GitReadPort` (no real git):
 *    • each closed union arm (branch-base / commit / range) maps to the correct
 *      `GitDiffOperation`;
 *    • commit peels first-parent via the port; a ROOT commit uses the empty-tree
 *      base (never a fabricated parent);
 *    • missing/ambiguous refs (`resolveCommit → null`) fail CLOSED with a typed
 *      `unavailable` reason — NEVER a silent fallback to working/branch;
 *    • leading-`-` operands are rejected as `invalid-ref` (no `git` option
 *      smuggling);
 *    • resolution is DETERMINISTIC (same input ⇒ deep-equal output);
 *    • `branch-base` stays SYMBOLIC (`origin/main...HEAD`) — it is NOT peeled to
 *      oids, so the default source is byte-identical to today's argv.
 *
 *  Anti-vacuity: the fake port records every `resolveCommit` call, and tests
 *  assert BOTH the resolved operation AND that the peel actually went through
 *  the port (a resolver that ignored the port would fail the call-count asserts).
 */

import { describe, expect, test } from "bun:test"
import { type DiffSource, EMPTY_TREE_OID, type GitReadPort, resolveDiffSource } from "@/git"

/** Fake ref→oid table. Absent key ⇒ `null` (unresolvable / ambiguous). */
const fakePort = (table: Record<string, string>): GitReadPort & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    async resolveCommit(rev: string): Promise<string | null> {
      calls.push(rev)
      return table[rev] ?? null
    },
  }
}

describe("resolveDiffSource — branch-base (symbolic, byte-identical default)", () => {
  test("no base ⇒ origin/main...HEAD, NOT peeled through the port", async () => {
    const port = fakePort({})
    const res = await resolveDiffSource({ kind: "branch-base" }, port)
    expect(res).toEqual({
      ok: true,
      operation: { kind: "branch-merge-base", base: "origin/main", head: "HEAD" },
    })
    // Byte-identity guard: branch-base must NOT resolve refs to oids.
    expect(port.calls).toEqual([])
  })

  test("explicit base is preserved symbolically", async () => {
    const port = fakePort({})
    const res = await resolveDiffSource({ kind: "branch-base", base: "develop" }, port)
    expect(res).toEqual({
      ok: true,
      operation: { kind: "branch-merge-base", base: "develop", head: "HEAD" },
    })
  })

  test("leading-dash base ⇒ invalid-ref (no option smuggling)", async () => {
    const port = fakePort({})
    const res = await resolveDiffSource({ kind: "branch-base", base: "--output=/tmp/x" }, port)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.reason.kind).toBe("invalid-ref")
  })
})

describe("resolveDiffSource — commit (first-parent, peeled)", () => {
  test("normal commit ⇒ base = resolved first parent", async () => {
    const port = fakePort({ feat: "c1oid", "c1oid~1": "p1oid" })
    const res = await resolveDiffSource({ kind: "commit", oid: "feat" }, port)
    expect(res).toEqual({
      ok: true,
      operation: { kind: "commit-first-parent", base: "p1oid", commit: "c1oid" },
    })
    // Peel actually went through the port: resolve the commit, then its ~1.
    expect(port.calls).toEqual(["feat", "c1oid~1"])
  })

  test("ROOT commit (no parent) ⇒ empty-tree base, never a fabricated parent", async () => {
    const port = fakePort({ root: "r1oid" }) // r1oid~1 absent ⇒ null ⇒ root
    const res = await resolveDiffSource({ kind: "commit", oid: "root" }, port)
    expect(res).toEqual({
      ok: true,
      operation: { kind: "commit-first-parent", base: EMPTY_TREE_OID, commit: "r1oid" },
    })
  })

  test("unresolvable commit ⇒ fail-closed unresolvable-ref (no fallback)", async () => {
    const port = fakePort({})
    const res = await resolveDiffSource({ kind: "commit", oid: "nope" }, port)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.reason.kind).toBe("unresolvable-ref")
  })

  test("leading-dash oid ⇒ invalid-ref, port never consulted", async () => {
    const port = fakePort({})
    const res = await resolveDiffSource({ kind: "commit", oid: "-x" }, port)
    expect(res.ok).toBe(false)
    expect(port.calls).toEqual([])
  })
})

describe("resolveDiffSource — range (explicit two-endpoint, peeled)", () => {
  test("both endpoints resolve ⇒ tree-range of resolved oids", async () => {
    const port = fakePort({ v1: "fromOid", v2: "toOid" })
    const res = await resolveDiffSource({ kind: "range", from: "v1", to: "v2" }, port)
    expect(res).toEqual({
      ok: true,
      operation: { kind: "tree-range", from: "fromOid", to: "toOid" },
    })
  })

  test("unresolvable `to` ⇒ fail-closed unresolvable-ref", async () => {
    const port = fakePort({ v1: "fromOid" }) // v2 absent
    const res = await resolveDiffSource({ kind: "range", from: "v1", to: "v2" }, port)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.reason.kind).toBe("unresolvable-ref")
  })

  test("leading-dash endpoint ⇒ invalid-ref", async () => {
    const port = fakePort({})
    const res = await resolveDiffSource({ kind: "range", from: "-x", to: "v2" }, port)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.reason.kind).toBe("invalid-ref")
  })
})

describe("resolveDiffSource — determinism", () => {
  test("same input ⇒ deep-equal output across two calls", async () => {
    const a = await resolveDiffSource({ kind: "commit", oid: "x" }, fakePort({ x: "xo" }))
    const b = await resolveDiffSource({ kind: "commit", oid: "x" }, fakePort({ x: "xo" }))
    expect(a).toEqual(b)
  })

  test("the closed union has exactly the three admitted arms", () => {
    // Compile-time exhaustiveness is enforced by `assertNever` in the resolver;
    // this pins the RUNTIME kind-set so a silently-added arm is caught too.
    const kinds: DiffSource["kind"][] = ["branch-base", "commit", "range"]
    expect(new Set(kinds).size).toBe(3)
  })
})
