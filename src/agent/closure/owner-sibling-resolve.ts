/**
 * WS2 — owner-sibling resolver. The deterministic feeder that fills
 * `FaultEvidenceInput.ownerResolved` (audit verdict C: previously NONE populated
 * it, so a parent/child override site never reached the candidate set and the
 * T-601 escalation gate was permanently starved).
 *
 * APPROACH — grep-based co-change (not LSP go-to-implementation). A real-pyright
 * smoke on django #14315 proved `implementation()` does NOT resolve Python method
 * overrides (pyright's go-to-implementation is abstract/protocol-centric), so the
 * LSP path was inert despite green mocks. Instead: for each top-K stage-1 owner
 * that DEFINES an issue symbol, find the OTHER files that define the SAME symbol
 * (`def <sym>` / `class <sym>`) — the sibling override sites. On #14315,
 * localizing `base/client.py` (which defines `settings_to_cmd_args_env`) surfaces
 * `postgresql/client.py` + the other backend clients that override it.
 *
 * BLIND: issue symbols + stage-1 ranking + repo SOURCE only (ripgrep over .py).
 * Never reads FAIL_TO_PASS / test_patch / grader report. BOUNDED: maxFiles ×
 * symbols, capped results. The definer lookup is injectable (`listDefiners`,
 * default = ripgrep) so the resolver is unit-testable without a working tree.
 */

import { spawnSync } from "node:child_process"

export interface OwnerSiblingArgs {
  /** Stage-1 ranked candidates (score-desc). Top `maxFiles` are probed. */
  readonly stage1Files: readonly { file: string; score: number }[]
  /** The issue/problem text. Anchors are the symbols a localized owner DEFINES
   *  that the issue actually MENTIONS (word-boundary) — so `runshell` in prose
   *  anchors even when `extractSymbols` (backtick-only) returns nothing. */
  readonly issueText: string
  /** Sandbox root — ripgrep search root + URI/path relativization. */
  readonly cwd: string
  /** Read a sandbox-relative source file; `null` when absent/unreadable. */
  readonly readSource: (relFile: string) => string | null
  readonly signal?: AbortSignal
  /** Max stage-1 files to probe (cost bound). Default 3. */
  readonly maxFiles?: number
  /** Cap on returned sibling rows (cost bound). Default 8. */
  readonly maxResults?: number
  /** DI: sandbox-relative files that DEFINE `symbol`. Default = ripgrep over the
   *  cwd. Injected by tests to run without a working tree. */
  readonly listDefiners?: (symbol: string) => readonly string[]
}

export interface OwnerSibling {
  readonly file: string
  readonly forSymbol: string
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const DEF_RE = /^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)|^[ \t]*class[ \t]+(\w+)/gm

/**
 * Symbol names DEFINED in `source` (`def`/`async def`/`class`). Dunder names
 * (`__init__`, …) are excluded — they're ubiquitous and would over-expand.
 */
export const defsInSource = (source: string): string[] => {
  const out = new Set<string>()
  for (const m of source.matchAll(DEF_RE)) {
    const name = m[1] ?? m[2]
    if (name && !name.startsWith("__")) out.add(name)
  }
  return [...out]
}

/** Word-boundary mention (so `runshell` in prose anchors, but `env` doesn't
 *  match inside `environment`). */
const issueMentions = (issueText: string, symbol: string): boolean =>
  new RegExp(`\\b${escapeRe(symbol)}\\b`).test(issueText)

const relFromPath = (path: string, cwd: string): string => {
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`
  return path.startsWith(base) ? path.slice(base.length) : path
}

/** Default definer lookup: ripgrep `def <sym>` / `class <sym>` over .py files. */
const ripgrepDefiners =
  (cwd: string) =>
  (symbol: string): readonly string[] => {
    const sym = escapeRe(symbol)
    const pattern = `^\\s*(async\\s+)?def\\s+${sym}\\b|^\\s*class\\s+${sym}\\b`
    const res = spawnSync(
      "rg",
      ["-l", "--no-messages", "--type", "py", pattern, cwd],
      // status 1 = no match (fine); a timeout/spawn error ⇒ empty (graceful).
      { encoding: "utf8", timeout: 8_000 },
    )
    if (res.error || typeof res.stdout !== "string") return []
    return res.stdout
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((p) => relFromPath(p, cwd))
  }

/**
 * Resolve owner siblings for the closure session: the other files that define a
 * symbol the localized owner also defines (override co-change sites).
 */
export const resolveOwnerSiblings =
  () =>
  async (args: OwnerSiblingArgs): Promise<OwnerSibling[]> => {
    const maxFiles = args.maxFiles ?? 3
    const maxResults = args.maxResults ?? 8
    const definers = args.listDefiners ?? ripgrepDefiners(args.cwd)
    const out: OwnerSibling[] = []
    const seen = new Set<string>()

    const stage1Top = args.stage1Files.slice(0, maxFiles)
    const stage1Set = new Set(stage1Top.map((f) => f.file))

    for (const sf of stage1Top) {
      if (out.length >= maxResults || args.signal?.aborted === true) break
      const source = args.readSource(sf.file)
      if (source === null) continue
      // Anchors = symbols this owner DEFINES that the issue text MENTIONS. Both
      // conditions matter: "defines" keeps it to the owner's surface, "mentions"
      // keeps it to what the bug is actually about (no over-expansion on every
      // method). This is why `extractSymbols` (backtick-only) being empty on
      // #14315 doesn't matter — `runshell` is in the prose and defined in base.
      const anchors = defsInSource(source).filter((sym) => issueMentions(args.issueText, sym))
      for (const sym of anchors) {
        if (out.length >= maxResults) break
        for (const file of definers(sym)) {
          // sibling only: not the owner itself, not an already-localized file.
          if (file === "" || file === sf.file || stage1Set.has(file)) continue
          const key = `${file}|${sym}`
          if (seen.has(key)) continue
          seen.add(key)
          out.push({ file, forSymbol: sym })
          if (out.length >= maxResults) break
        }
      }
    }
    return out
  }
