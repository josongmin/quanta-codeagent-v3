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
import { assertScanPopulation } from "./_shared/scan-population"
import { stripComments } from "./_shared/strip-comments"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const SRC_AGENT = join(REPO_ROOT, "src", "agent")
const ALLOWED_OWNER = join(SRC_AGENT, "deny-reason-wire.ts")

const ignoredAgentDirectory = (name: string): boolean =>
  name === "__tests__" || name === "node_modules" || name.startsWith(".")

const isAgentSourceFile = (name: string): boolean =>
  name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".hellgate.test.ts")

const collectAgentTs = (): string[] => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredAgentDirectory(entry.name)) walk(full)
        continue
      }
      if (entry.isFile() && isAgentSourceFile(entry.name)) out.push(full)
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
    // Both claims, and the disk is probed independently of the walk under test:
    // deriving the expectation from `collectAgentTs()` would make a lost subtree
    // vanish from both sides of the comparison.
    assertScanPopulation(collectAgentTs(), SRC_AGENT, {
      id: "tests/unit/deny-reason-authority-ratchet-hellgate.test.ts#SRC-AGENT",
    })
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
