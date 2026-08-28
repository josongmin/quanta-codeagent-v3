/**
 * Ratchet — agent-slice deny-reason construction must stay behind
 * `src/agent/deny-reason-wire.ts`.
 *
 * Structural intent:
 * - the agent layer may CONSUME named helpers like `reviewerDenyReason(...)`
 * - but it must not re-introduce fresh `structuredDenyReason(...)` calls with
 *   ad hoc `{layer,pillar}` literals across random seams
 *
 * Without this, authority drifts back into multiple files and the next deny-
 * reason taxonomy change becomes another repo-wide chase.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const SRC_AGENT = join(REPO_ROOT, "src", "agent")
const ALLOWED_OWNER = join(SRC_AGENT, "deny-reason-wire.ts")

const TOKEN = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g

const blank = (m: string): string => m.replace(/[^\n]/g, " ")

const stripComments = (src: string): string =>
  src.replace(TOKEN, (m) => (m.startsWith("//") || m.startsWith("/*") ? blank(m) : m))

/** Does this subtree hold a `.ts` at all? A direct disk probe, deliberately not
 *  reusing the walk under test. */
const hasTsOnDisk = (dir: string): boolean => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name.startsWith(".")) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (hasTsOnDisk(full)) return true
      continue
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) return true
  }
  return false
}

const collectAgentTs = (): string[] => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (
          entry.name === "__tests__" ||
          entry.name === "node_modules" ||
          entry.name.startsWith(".")
        ) {
          continue
        }
        walk(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".hellgate.test.ts")) continue
      out.push(full)
    }
  }
  walk(SRC_AGENT)
  return out.sort()
}

describe("deny-reason authority ratchet", () => {
  test("ANTI-VACUITY: the walk reaches a real, populated `src/agent` tree", () => {
    // This ratchet reports the same value — no offenders — whether the tree is
    // clean or whether `collectAgentTs()` returned nothing. A count alone is not
    // enough either: losing one subtree is invisible to it, measured on the
    // sibling PEP fence. So both are asserted.
    const files = collectAgentTs()
    expect(files.length, "the walk found no agent sources at all").toBeGreaterThan(100)
    const walked = new Set(
      files.map((f) => relative(SRC_AGENT, f).split("/")[0] ?? "").filter((s) => s !== ""),
    )
    // Only subtrees that HOLD collectable source. A directory of `.md`, or one
    // holding nothing this walk collects, is legitimately absent from the
    // enumeration — demanding it would red on a clean tree, and a guard that
    // reds on a clean tree is a guard people disable.
    const onDisk = readdirSync(SRC_AGENT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "__tests__" && !e.name.startsWith("."))
      .map((e) => e.name)
      // Probed INDEPENDENTLY of the walk under test. Deriving this from
      // `collectAgentTs()` would be circular: a walk that loses a subtree loses
      // it from the expectation too, and the check passes vacuously.
      .filter((name) => hasTsOnDisk(join(SRC_AGENT, name)))
    expect(
      onDisk.filter((name) => !walked.has(name)),
      "these subtrees hold agent source on disk but the walk enumerated none of them",
    ).toEqual([])
  })

  test("only deny-reason-wire.ts may construct structuredDenyReason directly inside src/agent", () => {
    const offenders = collectAgentTs().filter((path) => {
      if (path === ALLOWED_OWNER) return false
      return /\bstructuredDenyReason\s*\(/.test(stripComments(readFileSync(path, "utf8")))
    })
    if (offenders.length > 0) {
      const detail = offenders.map((path) => `  - ${relative(REPO_ROOT, path)}`).join("\n")
      throw new Error(
        "Direct structuredDenyReason construction escaped the deny-reason owner seam:\n" +
          `${detail}\n\n` +
          "Route agent-slice callers through src/agent/deny-reason-wire.ts instead.",
      )
    }
    expect(offenders).toEqual([])
  })

  test("sanity: deny-reason-wire.ts still owns the primitive", () => {
    const src = stripComments(readFileSync(ALLOWED_OWNER, "utf8"))
    expect(src).toMatch(/\bstructuredDenyReason\s*\(/)
  })
})
