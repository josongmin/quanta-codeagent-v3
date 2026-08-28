/**
 * T07 UC4 — core-decoupling ratchet.
 *
 * The VS Code `chatSessions` integration is a SURFACE (`surfaces/vscode/`). The
 * quanta core (`src/`) must never gain a VS Code dependency: the editor adapter
 * consumes session.v1, not the other way round. This ratchet goes RED if any
 * file under `src/` imports the `vscode` module or references a VS Code
 * proposed-API symbol — exactly the leak `mode-presets/ide.ts` warns about
 * ("the editor adapter lives outside this repo").
 *
 * It is the inverse of `surface-coupling-ratchet.test.ts` (which guards
 * cross-imports BETWEEN src/apps surfaces); this one guards the core from a
 * single named external surface.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import {
  assertWalkFloor,
  extractImports,
  listSliceTsFiles,
  readWalkedFiles,
  type WalkCoverage,
} from "../../_arch/slice-boundary-scanner"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const SRC_DIR = join(REPO_ROOT, "src")

// Module specifiers that pull in the VS Code extension host API.
const VSCODE_MODULE = /^vscode(\/.*)?$/
// Symbols unique to the chatSessions proposed API + the editor glue. These are
// distinctive enough that a hit in core is a genuine leak, not a false match.
const VSCODE_SYMBOLS = [
  "registerChatSessionItemProvider",
  "ChatSessionItemProvider",
  "provideChatSessionItems",
  "chatSessionsProvider",
  "languageModelProxy",
] as const

const toPosix = (p: string): string => p.replaceAll("\\", "/")

/**
 * Single filesystem walk + single read per file, computed ONCE at module load.
 * (Re-walking all of src/ per test blew the 5s timeout.)
 *
 * MODULE SCOPE IS THE HAZARD, and this file was the measured victim of it. A
 * throw out here is an "Unhandled error between tests": bun never registers the
 * describe block, so EVERY arm in the file silently ceases to exist instead of
 * one arm failing. Reproduced against this exact shape — enumerate, delete one
 * file, read — and the result was `0 pass, 1 error` with all three arms gone.
 *
 * Two changes close it:
 *   · `readWalkedFiles` skips a file that vanished BETWEEN the walk and the
 *     read (walk-derived paths only — the `provider.ts` constant read in the
 *     self-check below still throws if it is missing, which is the point).
 *   · Anything else that goes wrong out here is CAPTURED, not thrown, and
 *     re-thrown inside each arm — so a module-scope failure fails the arms
 *     loudly instead of deleting them.
 */
type Scan = {
  readonly moduleOffenders: readonly string[]
  readonly symbolOffenders: readonly string[]
  readonly coverage: WalkCoverage
}

const scanResult: { ok: true; value: Scan } | { ok: false; error: unknown } = (() => {
  try {
    const moduleOffenders: string[] = []
    const symbolOffenders: string[] = []
    const enumerated = listSliceTsFiles(SRC_DIR, false)
    const { files, coverage } = readWalkedFiles(SRC_DIR, enumerated, false)
    for (const { file, src: source } of files) {
      const rel = toPosix(relative(REPO_ROOT, file))
      for (const { spec, line } of extractImports(source)) {
        if (VSCODE_MODULE.test(spec)) moduleOffenders.push(`${rel}:${line} -> import "${spec}"`)
      }
      for (const symbol of VSCODE_SYMBOLS) {
        if (source.includes(symbol)) symbolOffenders.push(`${rel} -> ${symbol}`)
      }
    }
    return { ok: true as const, value: { moduleOffenders, symbolOffenders, coverage } }
  } catch (error) {
    return { ok: false as const, error }
  }
})()

/**
 * The scan, or a loud failure — plus THE FLOOR, asserted before any arm is
 * allowed to conclude "clean".
 *
 * The floor is not `we read > 0 files`. That survives losing an entire slice:
 * if `src/agent/**` disappeared from the read set, a bare count over ~4,000
 * other files still looks healthy and the ratchet reports green over an
 * unscanned subtree. `assertWalkFloor` checks per TOP-LEVEL SUBTREE of `src/`,
 * from both sides — every slice dir on disk that holds scannable files must
 * appear in the enumeration, and every enumerated slice must contribute at
 * least one file that was actually read.
 */
const scanned = (arm: string): Scan => {
  if (!scanResult.ok) throw scanResult.error
  assertWalkFloor(scanResult.value.coverage, `core-no-vscode-leak — ${arm}`)
  return scanResult.value
}

describe("T07 UC4 — core has zero VS Code coupling", () => {
  test("no src/ file imports the `vscode` module", () => {
    const scan = scanned("vscode module import")
    if (scan.moduleOffenders.length > 0) {
      throw new Error(
        [
          "VS Code module import detected in core `src/`.",
          "The chatSessions editor integration is a SURFACE (surfaces/vscode/);",
          "it consumes session.v1 — core must never import `vscode`.",
          "",
          ...scan.moduleOffenders.map((o) => `- ${o}`),
        ].join("\n"),
      )
    }
    expect(scan.moduleOffenders).toEqual([])
  })

  test("no src/ file references a VS Code chatSessions proposed-API symbol", () => {
    expect(scanned("proposed-API symbol").symbolOffenders).toEqual([])
  })

  test("FLOOR: the scan covered every slice subtree under src/, not merely some files", () => {
    const { coverage } = scanned("floor")
    // Non-vacuity, stated positively: a real, populated, MULTI-SUBTREE read set.
    expect(coverage.read.length).toBeGreaterThan(0)
    expect(coverage.readSubtrees.size).toBeGreaterThan(1)
    // And the two directions `assertWalkFloor` enforces, pinned here so the
    // guard's own coverage is visible evidence rather than an internal detail.
    const unread = [...coverage.enumeratedSubtrees.keys()].filter(
      (s) => (coverage.readSubtrees.get(s) ?? 0) === 0,
    )
    expect(unread, "these slice subtrees were enumerated but nothing in them was read").toEqual([])
  })

  test("self-check: the adapter and provider DO live under surfaces/vscode (guard is wired to the right tree)", () => {
    // Anti-vacuity: prove the symbols the ratchet hunts for actually exist in
    // the surface — otherwise the ratchet above could be green simply because
    // the feature was never built / was moved, and we'd never notice.
    const provider = readFileSync(
      join(REPO_ROOT, "surfaces", "vscode", "src", "provider.ts"),
      "utf8",
    )
    expect(provider.includes("registerChatSessionItemProvider")).toBe(true)
    expect(provider).toMatch(/from ["']vscode["']/)
  })
})
