/**
 * R6 ratchet (jun-10 silent-failure audit, finding #7) — `stopAll()`
 * TEXTUAL-PRESENCE / ANCHOR ratchet.
 *
 * HONESTY SCOPE — read this before trusting the green. This guard proves only
 * the LEXICAL facts below; it is NOT a runtime-reachability proof and never
 * exercises `cleanupFinishedSession`:
 *   (a) `.stopAll(` textually appears as a CALL SITE (`.stopAll(` / `.stopAll?.(`,
 *       not a method DEFINITION or a prose mention) at least once in src
 *       (measured 0 the day of the audit — this ratchet was born RED), AND
 *   (b) one such call site is in the session-teardown chokepoint file
 *       (`src/agent/loop/session-lifecycle.ts`), AND
 *   (c) — cheap anti-dead-branch sanity — that chokepoint file holds no literal
 *       always-false branch opener (`if (false`, `if (0)`, `while (false`), so
 *       the textually-present call cannot be silently parked in an obviously
 *       dead lexical block. This is a COARSE lexical heuristic, not a control-
 *       flow proof: it would not catch a runtime-dead branch (`if (cond)` where
 *       `cond` is always false at runtime), nor an `&& false` tail.
 *
 * THE LEAK THIS ANCHORS — both side-agent daemon registries (`@/side-agent`
 * in-process + the §4.3 process-backed one) ship a host-only `stopAll()` for
 * session shutdown, but it had ZERO production call sites: `cleanupFinishedSession`
 * disposed every OTHER resource (subagents, browser, appshot, skill-MCP, bg
 * shells) yet never the side-agent daemons — so un-unref'd wake intervals kept
 * burning REAL LLM tokens past session end, and forked children orphaned under
 * `QUANTA_SIDE_AGENT_PROCESS`.
 *
 * RUNTIME REACHABILITY IS OWNED ELSEWHERE — the behavioral proof that session
 * end actually CLEARS the armed wake interval / KILLS the forked child (real
 * leaf effects over leaf-injected fakes, idempotence, no-throw) lives in the
 * sibling hellgate `tests/unit/side-agent-stopall-session-end-hellgate.test.ts`.
 * If `.stopAll(` ever moves into a runtime-dead branch this anchor stays green
 * but that hellgate goes RED — keep both.
 *
 * RED-ON-INJECTION — deleting the `stopAll()` call from `cleanupFinishedSession`
 * turns assertions (a) and (b) red again (it is the only src call site).
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { assertScanPopulation } from "./_shared/scan-population"
import { stripComments } from "./_shared/strip-comments"

const SRC_ROOT = join(import.meta.dir, "../../src")

/** The session-teardown chokepoint the call must be anchored at. */
const CHOKEPOINT = "agent/loop/session-lifecycle.ts"

/** A real CALL SITE: `<expr>.stopAll(` or optional-chained `<expr>.stopAll?.(`.
 *  Method DEFINITIONS (`stopAll(): number {`) and prose mentions (`stopAll`)
 *  have no leading dot and do not match. */
const CALL_SITE = /\.stopAll(\?\.)?\s*\(/

/** Literal always-false branch openers. A `.stopAll(` parked behind any of
 *  these in the chokepoint would be lexically dead while still satisfying the
 *  textual-presence assertions — this coarse guard catches that specific case
 *  (it does NOT model runtime-valued conditions). */
const DEAD_BRANCH_OPENER = /\b(?:if|while)\s*\(\s*(?:false|0)\s*[)&]/

/** Strip line + block comments so a comment that merely MENTIONS the call can
 *  never satisfy (or trip) the guard. Conservative: `//` preceded by `:` (URLs
 *  like `https://`) is kept. */
// The shared scanner. The local one blanked a phantom span, so an `if (false)`
// wrapped in two string constants hid a real teardown regression — the side-agent
// daemons leaking on every session end, with this guard green. MEASURED.

/** True when `full` (a `.ts` file) holds a real `.stopAll(` call site. The
 *  defining slice (`src/side-agent/**`) does not count as a PRODUCTION reader:
 *  its registry methods/types declare `stopAll` (and its internals may
 *  self-reference). */
const isCallSiteFile = (full: string, rel: string): boolean =>
  !rel.startsWith("side-agent/") && CALL_SITE.test(stripComments(readFileSync(full, "utf8")))

const sourceFiles = (): string[] =>
  (readdirSync(SRC_ROOT, { recursive: true }) as string[]).filter(
    (rel) => rel.endsWith(".ts") && !rel.includes("node_modules"),
  )

const collectCallSiteFiles = (files: readonly string[]): string[] =>
  files.filter((rel) => isCallSiteFile(join(SRC_ROOT, rel), rel))

describe("side-agent stopAll() textual-presence + anchor ratchet (R6)", () => {
  const files = sourceFiles()
  const callSites = collectCallSiteFiles(files)

  test("`.stopAll(` textually appears as a call site in src (anchor count ≥ 1)", () => {
    assertScanPopulation(
      files.map((file) => join(SRC_ROOT, file)),
      SRC_ROOT,
      {
        id: "tests/unit/side-agent-stopall-wiring-guard.test.ts#SRC",
        collectable: (name) => name.endsWith(".ts"),
      },
    )
    // Audit-day measurement: 0 — every other session resource is disposed at
    // teardown, side-agent daemons were not. ≥1 textual call site keeps the
    // registry's shutdown verb from silently losing its only caller. Runtime
    // reachability is proven by the session-end behavioral hellgate.
    expect(callSites.length).toBeGreaterThanOrEqual(1)
  })

  test(`a call site is textually anchored at the teardown chokepoint (${CHOKEPOINT})`, () => {
    expect(callSites).toContain(CHOKEPOINT)
  })

  test("the chokepoint call site is not parked in a literal always-false branch", () => {
    const chokepointSrc = stripComments(readFileSync(join(SRC_ROOT, CHOKEPOINT), "utf8"))
    // Sanity: the call we anchored above is really present in this exact file.
    expect(CALL_SITE.test(chokepointSrc)).toBe(true)
    // Coarse anti-dead-branch guard — no `if (false`/`if (0`/`while (false`
    // opener anywhere in the teardown chokepoint. NOT a control-flow proof.
    expect(DEAD_BRANCH_OPENER.test(chokepointSrc)).toBe(false)
  })
})
