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
import { extractImports, listSliceTsFiles } from "../../_arch/slice-boundary-scanner"

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

// Single filesystem walk + single read per file, computed ONCE at module load.
// (Re-walking all of src/ per test blew the 5s timeout.)
const scan = (() => {
  const moduleOffenders: string[] = []
  const symbolOffenders: string[] = []
  for (const file of listSliceTsFiles(SRC_DIR, false)) {
    const source = readFileSync(file, "utf8")
    const rel = toPosix(relative(REPO_ROOT, file))
    for (const { spec, line } of extractImports(source)) {
      if (VSCODE_MODULE.test(spec)) moduleOffenders.push(`${rel}:${line} -> import "${spec}"`)
    }
    for (const symbol of VSCODE_SYMBOLS) {
      if (source.includes(symbol)) symbolOffenders.push(`${rel} -> ${symbol}`)
    }
  }
  return { moduleOffenders, symbolOffenders }
})()

describe("T07 UC4 — core has zero VS Code coupling", () => {
  test("no src/ file imports the `vscode` module", () => {
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
    expect(scan.symbolOffenders).toEqual([])
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
