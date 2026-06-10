/**
 * R6 ratchet (jun-10 silent-failure audit, finding #7) — `stopAll()` WIRING
 * PROOF (house precedent: reader-count / zero-unwired guards).
 *
 * THE LEAK THIS GUARDS — both side-agent daemon registries (`@/side-agent`
 * in-process + the §4.3 process-backed one) ship a host-only `stopAll()` for
 * session shutdown, but it had ZERO production call sites: `cleanupFinishedSession`
 * disposed every OTHER resource (subagents, browser, appshot, skill-MCP, bg
 * shells) yet never the side-agent daemons — so un-unref'd wake intervals kept
 * burning REAL LLM tokens past session end, and forked children orphaned under
 * `QUANTA_SIDE_AGENT_PROCESS`.
 *
 * This is NOT a regex style ratchet — it is a reader-count wiring proof:
 *   (a) `.stopAll(` has ≥1 CALL SITE somewhere in src (measured 0 on the day of
 *       the audit — the test was born RED), and
 *   (b) the call is ANCHORED at the session-teardown chokepoint
 *       (`src/agent/loop/session-lifecycle.ts`, `cleanupFinishedSession`) — the
 *       one place every finished session flows through.
 *
 * RED-ON-INJECTION — deleting the `stopAll()` call from `cleanupFinishedSession`
 * turns BOTH assertions red again.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const SRC_ROOT = join(import.meta.dir, "../../src")

/** The session-teardown chokepoint the call must be anchored at. */
const CHOKEPOINT = "agent/loop/session-lifecycle.ts"

/** A real CALL SITE: `<expr>.stopAll(` or optional-chained `<expr>.stopAll?.(`.
 *  Method DEFINITIONS (`stopAll(): number {`) and prose mentions (`stopAll`)
 *  have no leading dot and do not match. */
const CALL_SITE = /\.stopAll(\?\.)?\s*\(/

/** Strip line + block comments so a comment that merely MENTIONS the call can
 *  never satisfy (or trip) the guard. Conservative: `//` preceded by `:` (URLs
 *  like `https://`) is kept. */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/gm, "$1")

/** True when `full` (a `.ts` file) holds a real `.stopAll(` call site. The
 *  defining slice (`src/side-agent/**`) does not count as a PRODUCTION reader:
 *  its registry methods/types declare `stopAll` (and its internals may
 *  self-reference). */
const isCallSiteFile = (full: string, rel: string): boolean =>
  !rel.startsWith("side-agent/") && CALL_SITE.test(stripComments(readFileSync(full, "utf8")))

const collectCallSiteFiles = (): string[] =>
  (readdirSync(SRC_ROOT, { recursive: true }) as string[]).filter(
    (rel) =>
      rel.endsWith(".ts") &&
      !rel.includes("node_modules") &&
      isCallSiteFile(join(SRC_ROOT, rel), rel),
  )

describe("side-agent stopAll() wiring proof (R6 ratchet)", () => {
  const callSites = collectCallSiteFiles()

  test("stopAll() has ≥1 production call site in src (reader count ≥ 1)", () => {
    // Audit-day measurement: 0 — every other session resource is disposed at
    // teardown, side-agent daemons were not. ≥1 caller proves the registry's
    // shutdown verb is actually reachable from production code.
    expect(callSites.length).toBeGreaterThanOrEqual(1)
  })

  test(`the call is anchored at the session-teardown chokepoint (${CHOKEPOINT})`, () => {
    expect(callSites).toContain(CHOKEPOINT)
  })
})
