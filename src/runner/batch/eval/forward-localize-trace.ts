/**
 * T3 — forward-localize consumer trace (jun-24 scaffold SOTA absorption).
 *
 * The `deeper_localize` adaptive route's lever. Backward localization (grep / CHA
 * from the issue text) finds where a symbol is DEFINED; it can miss the CONSUMERS
 * that break when the producer changes (the 14315 shape: edit `postgresql/client`,
 * never localize the shared base client that calls it). Forward-localize closes
 * that gap: take the symbols the PRIOR candidate actually edited, trace them to
 * their call-sites via the injected reference resolver, and surface those consumer
 * files as ADDITIONAL owner candidates for the next generation pass.
 *
 * Two layers: {@link forwardLocalizeConsumers} is PURE + deterministic over an
 * injected `findReferences` port (unit-testable, no fs); {@link traceForwardLocalizeOwners}
 * is the thin IO wrapper the driver calls (rg-resolves symbols, then runs the
 * pure core). The returned files are CANDIDATES only: T1 static-edge /
 * public-contract validation must still implicate a site before it can become a
 * hard `requiredFiles` entry, so forward-localize can never manufacture an
 * answer-key owner. Bounded by `maxFiles` / `maxSymbols`.
 */

import { diffTouchedSymbols } from "./diff-touched-symbols"
import { execArgv } from "./exec"
import { isPythonTestFile, normalizeRepoPath } from "./impacted-test-discovery"
import { filesFromPatch } from "./selection-paths"

const DEFAULT_MAX_FORWARD_FILES = 8

export const forwardLocalizeConsumers = (args: {
  /** The prior candidate's unified diff — the source of edited symbols. */
  readonly patch: string
  /** Resolve a symbol to the repo-relative files that REFERENCE (call/use) it. */
  readonly findReferences: (symbol: string) => readonly string[]
  /** Files already localized (owner candidates); never re-emitted. */
  readonly alreadyLocalized: Iterable<string>
  readonly maxFiles?: number
}): readonly string[] => {
  const symbols = diffTouchedSymbols(args.patch)
  if (symbols.length === 0) return []
  const max = args.maxFiles ?? DEFAULT_MAX_FORWARD_FILES
  const seen = new Set<string>()
  for (const f of args.alreadyLocalized) seen.add(normalizeRepoPath(f))
  const out: string[] = []
  for (const symbol of symbols) {
    for (const ref of args.findReferences(symbol)) {
      const file = normalizeRepoPath(ref)
      // Consumers only: skip the producer's own files (already localized) and any
      // test file (a test that calls the symbol is not a fix site).
      if (file === "" || seen.has(file) || isPythonTestFile(file)) continue
      seen.add(file)
      out.push(file)
      if (out.length >= max) return out
    }
  }
  return out
}

/** Only bare identifiers are safe to feed to `rg -w` (no regex metacharacters). */
const FORWARD_SYMBOL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Max files kept per symbol from `rg -l` before the final `maxFiles` cap, so a
 *  common symbol's huge match list cannot balloon the intermediate map. */
const PER_SYMBOL_FILE_CAP = 40

/**
 * IO wrapper (driver-facing): resolve the prior candidate's edited symbols to
 * their consumer files in the sandbox via `rg -l -w`, then run the pure
 * {@link forwardLocalizeConsumers}. Bounded to `maxSymbols` ripgrep calls; the
 * caller may pass the FULL prior localized owner surface as `alreadyLocalized`
 * so the widen step only surfaces genuinely new consumers. Absent ⇒ fall back
 * to the producer's touched files. Any rg failure for a symbol contributes
 * nothing (best-effort widening, never throws).
 */
export const traceForwardLocalizeOwners = async (args: {
  readonly patch: string
  readonly sandbox: string
  readonly timeoutMs: number
  readonly alreadyLocalized?: Iterable<string>
  readonly maxSymbols?: number
  readonly maxFiles?: number
}): Promise<readonly string[]> => {
  if (args.patch.trim() === "") return []
  const symbols = diffTouchedSymbols(args.patch).filter((s) => FORWARD_SYMBOL_RE.test(s))
  if (symbols.length === 0) return []
  const map: Record<string, readonly string[]> = {}
  for (const symbol of symbols.slice(0, args.maxSymbols ?? 6)) {
    const r = await execArgv(
      ["rg", "--no-messages", "-l", "-t", "py", "-w", symbol, "."],
      args.sandbox,
      args.timeoutMs,
    ).catch(() => null)
    if (r !== null && r.code === 0) {
      // Cap per-symbol file lists: a very common symbol (`get`, `value`) in a big
      // repo can match hundreds of files. The final owner set is bounded by
      // `maxFiles` in forwardLocalizeConsumers, but cap here too so a huge rg
      // result never balloons the intermediate map.
      map[symbol] = r.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .slice(0, PER_SYMBOL_FILE_CAP)
    }
  }
  return forwardLocalizeConsumers({
    patch: args.patch,
    findReferences: (symbol) => map[symbol] ?? [],
    alreadyLocalized: args.alreadyLocalized ?? filesFromPatch(args.patch),
    ...(args.maxFiles !== undefined ? { maxFiles: args.maxFiles } : {}),
  })
}
