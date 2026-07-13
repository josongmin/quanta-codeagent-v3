/**
 * FAIL-OPEN DRIFT-GUARD for the sub-agent spawn capability gate (RFC jul-13 §4.2).
 *
 * The nesting control withholds spawn tools from a leaf by an EARLY-RETURN gate
 * `if (!spawnToolsAvailable(config)) return …` at the head of every tier1 block
 * builder that mints an LLM-facing spawn tool (subagent / subagent-batch / team /
 * delegate). The fail-open risk is structural: a NEW block builder that spins a
 * child agent loop but FORGETS the gate would silently offer spawn tools to a
 * leaf. The runtime reject in subagent-runner.ts is still the authoritative
 * boundary (a forged spawn is denied there), so a missed gate is a
 * least-privilege / token leak, not an RCE — but it is exactly the kind of
 * regression a source-scan ratchet exists to catch the instant it lands.
 *
 * This is a STATIC ratchet, written per the AGENTS.md "non-vacuity is mandatory"
 * convention:
 *   1. it matches a CALL pattern `spawnToolsAvailable(` / `createSubagentRunner(`,
 *      never a bare identifier — an `import { spawnToolsAvailable }` that is never
 *      called does NOT satisfy the gate,
 *   2. it has an anti-vacuum floor (asserts it actually scanned the tier1 dir and
 *      found the known gates + a known internal runner), so a glob/regex drift
 *      that matches nothing cannot pass vacuously,
 *   3. it proves red-on-injection: the audit is a pure predicate run over BOTH the
 *      real tier1 sources (expect zero violations) AND synthetic injected files
 *      (expect a violation for exactly the offending file).
 *
 * The one legitimate exemption — `reviewer-subagent.ts` — is allowlisted WITH a
 * machine-checked justification: it is not an LLM-facing spawn tool (it is the
 * internal ReviewerPort guardian adapter) and it hard-restricts its child to a
 * read-only tool filter, so the child cannot itself recurse. The allowlist entry
 * is only honored when that restriction is still present in the source (§ test 4),
 * so the exemption cannot be silently reused for a file that drops the filter.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const TIER1_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/agent/tier1")

/** A tier1 source file spins a child agent loop iff it CALLS one of these spawn
 *  entry points (call pattern, not a bare import). `createSubagentRunner(` is the
 *  direct runner; the LLM-facing spawn builders additionally gate with
 *  `spawnToolsAvailable(`. */
const SPAWN_RUNNER_CALL = /\bcreateSubagentRunner\s*\(/
const GATE_CALL = /\bspawnToolsAvailable\s*\(/

/** The LLM-facing spawn-tool builders that MUST carry the capability gate. Frozen
 *  SSOT: removing a gate (set shrinks) OR renaming a builder without updating this
 *  set turns the floor assertion RED. */
const GATED_SPAWN_BUILDERS = ["subagent.ts", "subagent-batch.ts", "team.ts", "delegate.ts"] as const

/** Files that call a spawn runner but are LEGITIMATELY exempt from the gate,
 *  each with a reason AND a `requires` token that must still be present in the
 *  file for the exemption to hold (so the exemption is not a blank check). */
const INTERNAL_RUNNER_ALLOWLIST: Record<string, { reason: string; requires: RegExp }> = {
  "reviewer-subagent.ts": {
    reason:
      "internal ReviewerPort guardian adapter, NOT an LLM-facing spawn tool; its child is hard-restricted to a read-only tool filter (REVIEWER_TOOL_FILTER = read/grep/glob) so it cannot itself spawn/recurse",
    // The child's tool menu is pinned to read-only; if this restriction is ever
    // removed the exemption is no longer valid and this test must be revisited.
    requires: /REVIEWER_TOOL_FILTER\s*=\s*\[\s*"read"\s*,\s*"grep"\s*,\s*"glob"\s*\]/,
  },
}

interface SourceFile {
  readonly name: string
  readonly content: string
}

interface Violation {
  readonly file: string
  readonly kind: "missing-gate" | "unjustified-allowlist"
  readonly detail: string
}

/**
 * PURE audit predicate — the single surface exercised by BOTH the real-source
 * pass and the red-on-injection self-test. A file that calls a spawn runner must
 * EITHER call the capability gate OR be allowlisted with its `requires` token
 * still present.
 */
const auditSpawnGates = (files: readonly SourceFile[]): Violation[] => {
  const violations: Violation[] = []
  for (const f of files) {
    if (!SPAWN_RUNNER_CALL.test(f.content)) continue // not a spawn-runner file
    if (GATE_CALL.test(f.content)) continue // gated — good
    const exempt = INTERNAL_RUNNER_ALLOWLIST[f.name]
    if (exempt === undefined) {
      violations.push({
        file: f.name,
        kind: "missing-gate",
        detail: `calls createSubagentRunner() without a spawnToolsAvailable(config) gate and is not allowlisted — a new spawn builder must gate leaves out of spawn tools`,
      })
      continue
    }
    if (!exempt.requires.test(f.content)) {
      violations.push({
        file: f.name,
        kind: "unjustified-allowlist",
        detail: `allowlisted on the basis of "${exempt.reason}" but the justifying token is no longer present — re-audit before keeping the exemption`,
      })
    }
  }
  return violations
}

const readTier1 = (): SourceFile[] =>
  readdirSync(TIER1_DIR)
    .filter((n) => n.endsWith(".ts") && !n.endsWith(".d.ts"))
    .map((name) => ({ name, content: readFileSync(resolve(TIER1_DIR, name), "utf8") }))

describe("subagent nesting — spawn-gate fail-open drift guard", () => {
  const files = readTier1()

  test("anti-vacuum floor: the scan actually read the tier1 dir and found the known surfaces", () => {
    // A glob/regex drift that silently matched nothing must not pass vacuously.
    expect(files.length).toBeGreaterThanOrEqual(30)
    // Every declared gated builder is present as a real file.
    const names = new Set(files.map((f) => f.name))
    for (const g of GATED_SPAWN_BUILDERS) expect(names.has(g)).toBe(true)
    // The known internal runner is present (so the allowlist entry is live).
    expect(names.has("reviewer-subagent.ts")).toBe(true)
    // At least the 4 gated builders + the 1 internal runner actually call a spawn
    // runner or the gate — proves the CALL patterns match real code, not nothing.
    const gateCallers = files.filter((f) => GATE_CALL.test(f.content))
    expect(gateCallers.length).toBeGreaterThanOrEqual(GATED_SPAWN_BUILDERS.length)
    const runnerCallers = files.filter((f) => SPAWN_RUNNER_CALL.test(f.content))
    expect(runnerCallers.length).toBeGreaterThanOrEqual(2)
  })

  test("every LLM-facing spawn builder carries the spawnToolsAvailable(config) CALL", () => {
    for (const name of GATED_SPAWN_BUILDERS) {
      const f = files.find((x) => x.name === name)
      if (f === undefined) throw new Error(`gated builder missing from tier1: ${name}`)
      // CALL pattern, not a bare import — a builder that imports but never calls
      // the gate would (correctly) fail this.
      expect(GATE_CALL.test(f.content)).toBe(true)
    }
  })

  test("no fail-open: no tier1 spawn-runner file is missing the gate (or has a stale exemption)", () => {
    const violations = auditSpawnGates(files)
    // Surface the offending files verbatim on failure.
    expect({ violations }).toEqual({ violations: [] })
  })

  test("the only exemption is reviewer-subagent, and its read-only-child justification still holds", () => {
    const reviewer = files.find((f) => f.name === "reviewer-subagent.ts")
    if (reviewer === undefined) throw new Error("reviewer-subagent.ts not found")
    // It genuinely calls the runner (so it WOULD trip the guard without the allowlist)…
    expect(SPAWN_RUNNER_CALL.test(reviewer.content)).toBe(true)
    // …it genuinely lacks the LLM gate (it is not an LLM-facing spawn tool)…
    expect(GATE_CALL.test(reviewer.content)).toBe(false)
    // …and the justifying read-only tool filter is still in place.
    expect(INTERNAL_RUNNER_ALLOWLIST["reviewer-subagent.ts"]?.requires.test(reviewer.content)).toBe(
      true,
    )
  })

  test("RED-ON-INJECTION: a new un-gated spawn builder is flagged (guard is non-vacuous)", () => {
    // 1. A brand-new builder that spins a child loop but forgets the gate → FLAGGED.
    const injectedMissing: SourceFile = {
      name: "shiny-new-spawner.ts",
      content: [
        `import { createSubagentRunner } from "../subagent-runner"`,
        `export const buildShinyBlock = (config) => {`,
        `  const runner = createSubagentRunner(config, {})`,
        `  return [{ name: "shiny_spawn", run: runner }]`,
        `}`,
      ].join("\n"),
    }
    const v1 = auditSpawnGates([...files, injectedMissing])
    expect(v1.map((v) => v.file)).toContain("shiny-new-spawner.ts")
    expect(v1.find((v) => v.file === "shiny-new-spawner.ts")?.kind).toBe("missing-gate")
    // The real files still contribute zero violations even with the injection present.
    expect(v1.filter((v) => v.file !== "shiny-new-spawner.ts")).toEqual([])

    // 2. A file that DOES gate is NOT flagged (control — proves the gate clears it).
    const injectedGated: SourceFile = {
      name: "gated-new-spawner.ts",
      content: [
        `import { createSubagentRunner } from "../subagent-runner"`,
        `import { spawnToolsAvailable } from "@/agent/spawn-depth"`,
        `export const buildGatedBlock = (config) => {`,
        `  if (!spawnToolsAvailable(config)) return []`,
        `  return [{ name: "gated_spawn", run: createSubagentRunner(config, {}) }]`,
        `}`,
      ].join("\n"),
    }
    expect(auditSpawnGates([injectedGated])).toEqual([])

    // 3. A stale exemption (allowlisted file that DROPPED its read-only filter) → FLAGGED.
    const injectedStaleExempt: SourceFile = {
      name: "reviewer-subagent.ts",
      content: [
        `import { createSubagentRunner } from "../subagent-runner"`,
        `// REVIEWER_TOOL_FILTER removed — child is no longer read-only`,
        `export const materializeReviewerAgent = (config) => createSubagentRunner(config, {})`,
      ].join("\n"),
    }
    const v3 = auditSpawnGates([injectedStaleExempt])
    expect(v3).toHaveLength(1)
    expect(v3[0]?.kind).toBe("unjustified-allowlist")
  })
})
