/**
 * GOAL-01 — objective authority BOUNDARY ratchet.
 *
 * The raw `ObjectiveAuthority` protocol (`asObjectiveAuthority(` /
 * `.prepare({`) is a composition-root capability. Ordinary consumers receive a
 * narrow read port or an actor-fixed capability, never the raw authority. This
 * ratchet pins the CURRENT set of production call sites as a one-directional
 * ceiling: a NEW file that reaches for the raw protocol is RED until it is
 * either routed through a capability or explicitly allowlisted with a reason
 * (GOAL-02 shrinks this list as capabilities land).
 *
 * Non-vacuous by construction:
 *   - every allowlisted file must STILL contain a real call (a stale entry is
 *     RED, so the list cannot rot into a permit for nothing);
 *   - a synthetic forbidden call injected into the scanner is NAMED.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { assertScanPopulation } from "../_shared/scan-population"
import { stripComments } from "../_shared/strip-comments"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const SRC_DIR = join(REPO_ROOT, "src")

/** A raw-protocol reach: recovering the authority from a port, or issuing a
 *  bound command directly. `prepare({` with the object literal excludes
 *  unrelated `prepare(` helpers elsewhere in the repo. */
const RAW_PROTOCOL = /asObjectiveAuthority\(|\.prepare\(\{/

/** Files that legitimately hold the raw protocol today (GOAL-01 baseline).
 *  Repo-relative, POSIX separators. Shrink only. */
const ALLOWED: ReadonlySet<string> = new Set<string>([
  // library home (authority.ts DEFINES the protocol; capabilities.ts is the
  // ONE composition seam that recovers it and binds actors)
  "src/objective/capabilities.ts",
  "src/objective/criteria/verifier.ts",
  // persistence adapters need the authority-only surface (knownThreadIds / restoreDomain)
  "src/runner/assemble/session-authorities/build-objective.ts",
  "src/host/runtime/objective-store-wire.ts",
])

const posix = (p: string): string => p.split(/[\\/]/).join("/")

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".test.ts"))
      yield p
  }
}

interface Scan {
  readonly unauthorized: readonly string[]
  readonly stale: readonly string[]
}

/** Pure detector over a (path, source) stream — reused by the injection test. */
const scan = (
  files: Iterable<{ readonly rel: string; readonly src: string }>,
  allowed: ReadonlySet<string>,
): Scan => {
  const unauthorized: string[] = []
  const seen = new Set<string>()
  for (const { rel, src } of files) {
    const hit = RAW_PROTOCOL.test(stripComments(src))
    if (!hit) continue
    seen.add(rel)
    if (!allowed.has(rel)) unauthorized.push(rel)
  }
  const stale = [...allowed].filter((f) => !seen.has(f))
  return { unauthorized, stale }
}

const realFiles = function* (): Generator<{ rel: string; src: string }> {
  for (const abs of walk(SRC_DIR)) {
    yield { rel: posix(relative(REPO_ROOT, abs)), src: readFileSync(abs, "utf8") }
  }
}

describe("GOAL-01 — objective authority boundary ratchet", () => {
  test("no production file outside the allowlist reaches the raw authority protocol", () => {
    const { unauthorized } = scan(realFiles(), ALLOWED)
    if (unauthorized.length > 0) {
      throw new Error(
        `Raw ObjectiveAuthority protocol outside the composition allowlist (use ObjectiveReadPort / an actor-fixed capability):\n${unauthorized
          .map((f) => `  ${f}`)
          .join("\n")}`,
      )
    }
    expect(unauthorized).toEqual([])
  })

  test("every allowlisted file still holds a real call (anti-vacuum floor)", () => {
    const files = [...walk(SRC_DIR)]
    assertScanPopulation(files, SRC_DIR, {
      id: "tests/unit/objective/authority-boundary-ratchet.test.ts#SRC",
    })
    const { stale } = scan(realFiles(), ALLOWED)
    expect(stale).toEqual([])
    expect(ALLOWED.size).toBeGreaterThanOrEqual(3)
  })

  test("red-on-injection: a synthetic consumer reaching for the protocol is NAMED", () => {
    const injected = [
      ...realFiles(),
      {
        rel: "src/agent/loop/injected-consumer.ts",
        src: 'const a = asObjectiveAuthority(port)\nconst p = a.prepare({ threadId, actor: "system", mutation })\n',
      },
    ]
    expect(scan(injected, ALLOWED).unauthorized).toEqual(["src/agent/loop/injected-consumer.ts"])
  })

  test("red-on-injection: a comment-only mention does not count as a call", () => {
    const injected = [
      ...realFiles(),
      {
        rel: "src/agent/loop/prose-only.ts",
        src: "// see asObjectiveAuthority( in the bridge\n/* never call .prepare({ here */\nexport const x = 1\n",
      },
    ]
    expect(scan(injected, ALLOWED).unauthorized).toEqual([])
  })
})
