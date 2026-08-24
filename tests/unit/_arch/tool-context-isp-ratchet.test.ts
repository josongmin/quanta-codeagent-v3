/**
 * Architecture ratchet — a tool declares the ROLE view it needs, not the bag.
 *
 * `ToolContext` carries every seam any tool can reach: shell escalation, the git
 * write guard, the plan mutator, the reviewer agent that SPAWNS A CHILD AGENT.
 * `tool-context.ts` derives role views from it (`Pick<ToolContext, …>`) so that
 * "which seams may a tool in this role touch" is a compile-time fact rather than
 * a convention — and the views are the only thing that makes a read-class tool
 * gaining `ctx.reviewerAgent` a type error instead of a silent capability grant.
 *
 * They were nearly unused: 119 modules under `src/tool` declared the bare bag,
 * and 82 of those dereferenced NOTHING outside the core five
 * (`cwd`/`signal`/`depth`/`turnId`/`toolCallId`). Those 82 now say
 * `CoreToolContext`. This pins that, one-directionally.
 *
 * ## What is pinned, and why it is a COUNT
 *
 * Not "every module must use a view" — a tool that genuinely needs the shell or
 * edit seams should say so, and several legitimately declare the bag while using
 * one or two extra seams. What must not happen is the population of
 * core-only-but-bag-typed modules GROWING again, which is how the views died the
 * first time. So the ceiling is on exactly that population.
 *
 * The scan is deliberately crude in the safe direction: it counts a module as
 * core-only when no `ctx.<seam>` / destructure of `ctx` names anything outside
 * the core five. A module that reaches a seam through an alias reads as core-only
 * and is UNDER-counted, which can only make the ceiling harder to satisfy, never
 * easier.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const TOOL_DIR = join(REPO_ROOT, "src/tool")

/** The seams `CoreToolContext` carries. Kept in sync by the paired test below. */
const CORE_SEAMS = new Set(["cwd", "signal", "depth", "turnId", "toolCallId"])

/**
 * Core-only-but-bag-typed modules. 0 after the aug-24 narrowing; it may only go
 * DOWN. A new tool that needs nothing but the core five should be written
 * `ctx: CoreToolContext` — the point of the views is that the narrow type is the
 * default, not a reward for remembering.
 */
const CORE_ONLY_BAG_CEILING = 0

const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry !== "__tests__") out.push(...walk(p))
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) {
      out.push(p)
    }
  }
  return out
}

/** Seam names a module reads off its context, by property access or destructure. */
export const seamsUsed = (source: string): ReadonlySet<string> => {
  const used = new Set<string>()
  for (const m of source.matchAll(/(?:ctx|context)\.([a-zA-Z_][A-Za-z0-9_]*)/g)) {
    used.add(m[1] as string)
  }
  for (const m of source.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*(?:ctx|context)\b/g)) {
    for (const piece of (m[1] as string).split(",")) {
      const name = piece.trim().split(":")[0]?.trim()
      if (name !== undefined && name !== "") used.add(name)
    }
  }
  return used
}

/** Declares the bare bag AND touches nothing outside the core five. */
export const isCoreOnlyBagTyped = (source: string): boolean => {
  if (!/(?:ctx|context): ToolContext(?![A-Za-z0-9_])/.test(source)) return false
  const used = seamsUsed(source)
  if (used.size === 0) return false
  for (const seam of used) if (!CORE_SEAMS.has(seam)) return false
  return true
}

describe("tool-context ISP ratchet", () => {
  const files = walk(TOOL_DIR)

  test("no module declares the 39-seam bag while using only the core five", () => {
    expect(files.length).toBeGreaterThan(200) // anti-vacuity: the walk found the tree
    const offenders = files
      .filter((f) => isCoreOnlyBagTyped(readFileSync(f, "utf8")))
      .map((f) => f.slice(REPO_ROOT.length + 1))
      .sort()
    expect(
      offenders.length,
      offenders.length === 0
        ? ""
        : `these declare \`ToolContext\` but touch only ${[...CORE_SEAMS].join("/")} — ` +
            `say \`CoreToolContext\` instead:\n  ${offenders.join("\n  ")}`,
    ).toBeLessThanOrEqual(CORE_ONLY_BAG_CEILING)
  })

  test("the role views are REACHED (they died once by being unreferenced)", () => {
    const body = files
      .filter((f) => !f.endsWith("tool-context.ts") && !f.endsWith("src/tool/types.ts"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n")
    // `AgentIdentityToolContext` and `ReviewerToolContext` are here because
    // their predecessor is the cautionary tale: a single `SubagentToolContext`
    // bundled the identity seams WITH `reviewerAgent`, and had zero consumers
    // for a measurable reason — no module under `src/tool` reads `reviewerAgent`
    // and an identity seam in the same file, so the view described a role nobody
    // plays. Splitting it gave each half real consumers; this keeps them.
    for (const view of [
      "CoreToolContext",
      "ShellToolContext",
      "EditToolContext",
      "AgentIdentityToolContext",
      "ReviewerToolContext",
    ]) {
      expect(new RegExp(`\\b${view}\\b`).test(body), `${view} has no consumer`).toBe(true)
    }
  })

  test("red-on-injection: the detector names a synthetic offender", () => {
    // Drives the predicate directly, so the pin above cannot pass for free once
    // the repo is clean — the mechanism is proven on inputs, not on the tree.
    expect(isCoreOnlyBagTyped("const f = (ctx: ToolContext) => ctx.cwd + ctx.signal")).toBe(true)
    // INNOCENT: reaches a non-core seam, so the bag is the honest declaration.
    expect(isCoreOnlyBagTyped("const f = (ctx: ToolContext) => ctx.gitWriteGuard")).toBe(false)
    // INNOCENT: already narrowed.
    expect(isCoreOnlyBagTyped("const f = (ctx: CoreToolContext) => ctx.cwd")).toBe(false)
    // INNOCENT: destructure of a non-core seam is seen too.
    expect(isCoreOnlyBagTyped("const f = (ctx: ToolContext) => { const { toolDiff } = ctx }")).toBe(
      false,
    )
  })
})
