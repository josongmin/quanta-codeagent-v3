/**
 * B4 SECURITY HELLGATE (aug-10) — `@thread:` lineage scope (the jul-15
 * sibling-leak class). `mention-source-deps.ts` resolves `@thread:<id>` against
 * the FULL `listSessions()` — so a task mentioning a SIBLING or unrelated
 * thread's id leaked that thread's metadata summary (title/cwd/branch/source).
 * `@subagent` was already lineage-safe by construction (repo-role registry); the
 * `@thread:` port was NOT lineage-scoped.
 *
 * THE load-bearing test: a `@thread:` mention from thread A must NOT resolve a
 * thread B outside A's lineage (sibling / unrelated), but MUST resolve A's own
 * ancestors / descendants (the fork chain over `SessionMeta.forkedFromId`).
 *
 * RED-ON-INJECTION: delete the `if (!scope.has(id)) return null` gate in
 * `threadSummaryFor` (or drop `selfThreadId` so the scope is computed over an
 * unknown caller) and the SIBLING-REFUSED cases below flip to RESOLVED — the
 * leak returns and this hellgate goes RED. Metadata-only, default-ON when wired,
 * so the gate is the only thing standing between a task and arbitrary
 * cross-lineage session enumeration.
 *
 * Drives the REAL resolver seam — `buildMentionResolverOwners` →
 * `buildDefaultMentionResolver` → `buildInjectionFragments` — AND the pure
 * `computeLineageIds` predicate directly (so a bypass in either layer is caught).
 */

import { describe, expect, test } from "bun:test"
import { buildInjectionFragments, parseMentions } from "@/agent/mention-injection"
import { buildDefaultMentionResolver } from "@/agent/mention-runner"
import type { ThreadSummary } from "@/agent/plugin-app-resolver"
import {
  buildMentionProviderListers,
  buildMentionResolverOwners,
  computeLineageIds,
  type MentionLiveSources,
} from "../mention-source-deps"

const cwd = "/tmp/b4-lineage"

/**
 * A fork forest:
 *
 *   root ──┬── A (caller)
 *          │     └── A1 (descendant of A)
 *          │           └── A11 (deep descendant of A)
 *          └── B (SIBLING of A — same parent `root`, NOT in A's lineage)
 *                └── B1 (descendant of the sibling — also out of A's lineage)
 *
 *   unrelated (no parent, its own root — never in A's lineage)
 *
 * A's lineage = { A, root (ancestor), A1, A11 (descendants) }.
 * OUT of scope  = { B, B1 (sibling subtree), unrelated }.
 */
const forest: readonly ThreadSummary[] = [
  { id: "root", title: "Root thread", cwd: "/w" },
  { id: "A", title: "Caller thread", cwd: "/w", forkedFromId: "root" },
  { id: "A1", title: "Child of A", cwd: "/w", forkedFromId: "A" },
  { id: "A11", title: "Grandchild of A", cwd: "/w", forkedFromId: "A1" },
  { id: "B", title: "Sibling thread", cwd: "/w/secret", forkedFromId: "root" },
  { id: "B1", title: "Child of sibling", cwd: "/w/secret", forkedFromId: "B" },
  { id: "unrelated", title: "Unrelated thread", cwd: "/elsewhere" },
]

const sourcesFor = (selfThreadId: string | undefined): MentionLiveSources => ({
  sessions: async () => forest,
  ...(selfThreadId !== undefined ? { selfThreadId } : {}),
})

const resolveThread = async (id: string, self: string | undefined): Promise<string | null> => {
  const resolver = buildDefaultMentionResolver({
    cwd,
    env: {},
    ...buildMentionResolverOwners(sourcesFor(self)),
  })
  const frags = await buildInjectionFragments(parseMentions(`@thread:${id}`), resolver)
  return frags[0]?.bodyText ?? null
}

// ── computeLineageIds — the pure predicate (bypass-proof) ────────────────────

describe("B4 — computeLineageIds (fork-chain lineage predicate)", () => {
  test("self ∪ ancestors ∪ descendants — exactly A's lineage, no sibling", () => {
    const scope = computeLineageIds(forest, "A")
    expect([...scope].sort()).toEqual(["A", "A1", "A11", "root"])
    // Sibling subtree + unrelated are OUT.
    expect(scope.has("B")).toBe(false)
    expect(scope.has("B1")).toBe(false)
    expect(scope.has("unrelated")).toBe(false)
  })

  test("caller at the ROOT ⇒ its whole subtree, still excludes the sibling subtree", () => {
    const scope = computeLineageIds(forest, "root")
    // root's descendants = A,A1,A11 AND B,B1 (both forked from root). unrelated is out.
    expect(scope.has("unrelated")).toBe(false)
    expect(scope.has("A11")).toBe(true)
  })

  test("FAIL-CLOSED — absent selfId ⇒ EMPTY scope (no leak)", () => {
    expect(computeLineageIds(forest, undefined).size).toBe(0)
    expect(computeLineageIds(forest, "").size).toBe(0)
  })

  test("FAIL-CLOSED — selfId names no thread in the list ⇒ EMPTY scope", () => {
    expect(computeLineageIds(forest, "ghost").size).toBe(0)
  })

  test("cycle-safe — a self-referential / looped fork chain terminates", () => {
    const looped: readonly ThreadSummary[] = [
      { id: "x", title: "x", forkedFromId: "y" },
      { id: "y", title: "y", forkedFromId: "x" },
    ]
    const scope = computeLineageIds(looped, "x")
    expect([...scope].sort()).toEqual(["x", "y"])
  })
})

// ── Resolver seam — sibling refused, in-lineage allowed ──────────────────────

describe("B4 — @thread: resolver is lineage-scoped (THE security test)", () => {
  test("SIBLING REFUSED — A @thread:B ⇒ null (no metadata leak of the sibling)", async () => {
    const body = await resolveThread("B", "A")
    // RED-ON-INJECTION: remove the scope gate and this becomes the sibling's body.
    expect(body).toBeNull()
  })

  test("SIBLING SUBTREE REFUSED — A @thread:B1 ⇒ null", async () => {
    expect(await resolveThread("B1", "A")).toBeNull()
  })

  test("UNRELATED REFUSED — A @thread:unrelated ⇒ null", async () => {
    expect(await resolveThread("unrelated", "A")).toBeNull()
  })

  test("SELF ALLOWED — A @thread:A ⇒ resolves A's own summary", async () => {
    const body = await resolveThread("A", "A")
    expect(body).toContain("thread: Caller thread")
    expect(body).toContain("id: A")
  })

  test("ANCESTOR ALLOWED — A @thread:root ⇒ resolves the parent", async () => {
    const body = await resolveThread("root", "A")
    expect(body).toContain("id: root")
  })

  test("DESCENDANT ALLOWED — A @thread:A1 and deep A11 ⇒ resolve", async () => {
    expect(await resolveThread("A1", "A")).toContain("id: A1")
    expect(await resolveThread("A11", "A")).toContain("id: A11")
  })

  test("FAIL-CLOSED — no selfThreadId ⇒ even an existing id resolves null", async () => {
    // The unscoped path would have resolved this; fail-closed refuses ALL.
    expect(await resolveThread("A", undefined)).toBeNull()
    expect(await resolveThread("root", undefined)).toBeNull()
  })

  test("METADATA-ONLY — an in-lineage body never carries the fork-parent id", async () => {
    // forkedFromId is a SCOPING input, not a rendered field: the body must not
    // enumerate the parent id (no widening of the metadata surface).
    const body = await resolveThread("A", "A")
    expect(body).not.toContain("root")
    expect(body).not.toContain("forkedFrom")
  })
})

// ── Provider (autocomplete) enumeration — never suggest a sibling ────────────

describe("B4 — @thread: autocomplete enumeration is lineage-scoped", () => {
  const listThreadIds = async (self: string | undefined): Promise<string[]> => {
    const listers = await buildMentionProviderListers(sourcesFor(self), {})
    const entries = listers.listThreads?.() ?? []
    return entries.map((e) => e.insertName ?? e.name).sort()
  }

  test("A enumerates ONLY its lineage — sibling B / B1 / unrelated never suggested", async () => {
    expect(await listThreadIds("A")).toEqual(["A", "A1", "A11", "root"])
  })

  test("FAIL-CLOSED — no selfThreadId ⇒ zero thread candidates", async () => {
    expect(await listThreadIds(undefined)).toEqual([])
  })
})
