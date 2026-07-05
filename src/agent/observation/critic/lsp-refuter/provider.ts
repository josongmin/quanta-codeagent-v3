/**
 * LSP-backed OwnerRefuter (jul-6, Stream S1). Design SSOT:
 * `docs/plans/jul-6-observation-providers/README.md` §5.
 *
 * The REAL `OwnerRefuter` (replacing the deterministic FAKE in `../refuter.ts`),
 * backed by the EXISTING LSP nav seam (`LspNavProvider` from `@/agent/lsp-bridge`).
 * `query(edited, ctx)` opens a language server on the edited file, locates the
 * edited symbol via `documentSymbol`, and asks `incomingCalls` whether ANY caller
 * reaches it — returning `GraphFacts` the pure `makeOwnerCritic` classifies into
 * the 3-way `RefuteResult`. This module NEVER produces a verdict; it only reports
 * OBSERVED engine facts (that separation keeps the incompleteness-dominates
 * ordering in one place — the critic).
 *
 * HARD invariants (audit — tests pin all, over an injected fake seam):
 *
 *   1. POSITIVE-PROOF-ONLY refute. The ONLY facts that let the critic emit
 *      `refuted` are `reachableFromEntrypoints:false` + `staticallyComplete:true`.
 *      We set them ONLY when `incomingCalls` RAN and returned `[]` (zero callers)
 *      AND the symbol is NOT a plausible entrypoint / public API. `incomingCalls`
 *      returning `null` (server ran, no answer / unsupported) is NOT proof of no
 *      callers — it is a blind spot ⇒ `staticallyComplete:false`.
 *
 *   2. INCOMPLETENESS DOMINATES. No server, symbol not found, a dynamic-dispatch
 *      marker, a `null` callgraph answer, or a plausible-entrypoint zero-caller
 *      case all yield `inconclusive` (via `staticallyComplete:false` or a `null`
 *      query result) — NEVER `refuted`. Absence of evidence claims nothing.
 *
 *   3. ABSOLUTE-path resolution. Candidate files arrive REPO-RELATIVE; every
 *      session call (and `open`) uses `join(cwd, file)` (learn from the lsp-enrich
 *      ENOENT no-op). Tests key the fake off the joined absolute path to prove it.
 *
 *   4. TIME-BOUNDED. `open()` alone can block up to the 90s warm-pool ready
 *      timeout; a single AbortController fires at `budgetMs` and its signal threads
 *      into EVERY LSP call. A never-ready open is abandoned within budget ⇒
 *      `inconclusive`, never a hang. NEVER throws (any error ⇒ graceful skip).
 *
 * Pure over the injected `navProvider` seam (no env, no real server in tests).
 */

import { isAbsolute, join } from "node:path"
import { lspNavProvider } from "@/agent/lsp-bridge"
import type {
  LspNavProvider,
  LspNavSession,
  NavCallHierarchyEntry,
  NavSymbolInfo,
} from "@/tool/lsp_nav/types"
import type { EditTarget } from "../../critic"
import type { TaskContext } from "../../port"
import type { GraphFacts, OwnerRefuter } from "../refuter"

/** Default time budget for the whole `query` (open + symbol + callgraph). A
 *  refuter that misses the budget yields `inconclusive`, never a hang. */
const DEFAULT_BUDGET_MS = 8_000

/**
 * Names that ARE plausibly reached from outside the statically-visible callgraph
 * (framework entrypoints, dunder protocol methods, CLI mains, test cases). A
 * zero-incoming-calls result on ANY of these is NOT proof of unreachability — the
 * real caller (the framework / the test runner / reflection) is invisible to a
 * static engine, so we treat it as a blind spot (`inconclusive`), NEVER `refuted`.
 * Conservative by design: when unsure, this returns `true` so we do not refute.
 */
const isPlausibleEntrypoint = (name: string): boolean => {
  const n = name.trim()
  if (n.length === 0) return true // no name to reason over ⇒ do not refute
  // Python dunder / lifecycle protocol methods (called by the runtime, not by a
  // visible call site): __init__, __call__, __eq__, __enter__, setUp, ...
  if (/^__.*__$/.test(n)) return true
  if (n === "setUp" || n === "tearDown" || n === "setUpClass" || n === "tearDownClass") return true
  // Test cases are invoked by the test RUNNER (reflection), not a call site.
  if (/^test/i.test(n)) return true
  // CLI / program entrypoints.
  if (n === "main" || n === "run" || n === "handle" || n === "execute") return true
  // Exported-public convention: a Capitalized (class-like) or leading-underscore
  // check is intentionally NOT used to force-refute; only lower-case, non-dunder,
  // non-test, non-main private-looking helpers are refutable when zero-caller.
  return false
}

/** Match a top-level or nested documentSymbol entry by exact name. Depth-first so
 *  a method inside a class is found. Returns the FIRST exact-name match, or null. */
const findSymbol = (symbols: readonly NavSymbolInfo[], name: string): NavSymbolInfo | null => {
  for (const s of symbols) {
    if (s.name === name) return s
    // NavSymbolInfo has no children in this slice mirror; documentSymbol is
    // returned flat (server-flattened). Kept as a guard for shape drift.
  }
  return null
}

/** Facts that make the critic emit `inconclusive` with a specific blind-spot
 *  reason (incompleteness dominates any negative signal). Benign reach/shadow
 *  values — voided by `staticallyComplete:false`. */
const incomplete = (target: EditTarget, reason: string): GraphFacts => ({
  target,
  reachableFromEntrypoints: true,
  shadowedByOverride: false,
  staticallyComplete: false,
  incompletenessReasons: [reason],
})

/** Facts that make the critic emit `refuted`: proven-unreachable with full
 *  visibility. ONLY produced from a RAN, zero-result `incomingCalls` on a
 *  non-entrypoint symbol. */
const provenUnreachable = (target: EditTarget): GraphFacts => ({
  target,
  reachableFromEntrypoints: false,
  shadowedByOverride: false,
  staticallyComplete: true,
})

/** Facts that make the critic emit `not_refuted`: reached & plausible, no proof
 *  of wrongness (still NOT an endorsement). */
const notRefutable = (target: EditTarget): GraphFacts => ({
  target,
  reachableFromEntrypoints: true,
  shadowedByOverride: false,
  staticallyComplete: true,
})

/**
 * Ask the callgraph whether any caller reaches the symbol at its declaration
 * site, and turn that into engine facts. Conservative:
 *   - `null` (server ran, no answer / call-hierarchy unsupported) ⇒ NOT proof of
 *     no callers ⇒ incomplete (blind spot).
 *   - `[]` (ran, zero callers) on a plausible entrypoint ⇒ the real caller is
 *     invisible (runtime / reflection) ⇒ incomplete.
 *   - `[]` on a private, non-entrypoint helper ⇒ proven unreachable ⇒ refutable.
 *   - non-empty ⇒ reached ⇒ not refutable.
 */
const factsFromCallgraph = (
  target: EditTarget,
  symbol: NavSymbolInfo,
  incoming: NavCallHierarchyEntry[] | null,
): GraphFacts => {
  if (incoming === null) {
    return incomplete(target, "call hierarchy unavailable for the edited symbol")
  }
  if (incoming.length > 0) return notRefutable(target)
  // Zero callers found. This is a PROOF of unreachability ONLY when the symbol is
  // not something the runtime / a framework / the test runner calls invisibly.
  if (isPlausibleEntrypoint(symbol.name)) {
    return incomplete(
      target,
      `edited symbol '${symbol.name}' is a plausible entrypoint/protocol method; ` +
        "zero static callers does not prove unreachability",
    )
  }
  return provenUnreachable(target)
}

/**
 * Open a session, locate the edited symbol, query its callgraph, and return the
 * engine facts (or `null` when the engine has no facts for that target). NEVER
 * throws — a dead server / parse miss / abort ⇒ a graceful `inconclusive` fact or
 * `null`. The session is always stopped.
 */
const queryOnce = async (
  edited: EditTarget,
  cwd: string,
  provider: LspNavProvider,
  signal: AbortSignal,
): Promise<GraphFacts | null> => {
  // Candidate files arrive REPO-RELATIVE; the language server needs an ABSOLUTE
  // path (opening a relative path is the lsp-enrich ENOENT that silently no-op'd).
  const absFile = isAbsolute(edited.file) ? edited.file : join(cwd, edited.file)

  // `signal` (fires at budgetMs) bounds `open()` itself — otherwise a not-ready
  // server blocks up to the 90s warm-pool ready timeout.
  const session: LspNavSession | null = await provider.open(absFile, cwd, signal).catch(() => null)
  // No server for this file ⇒ engine unavailable ⇒ cannot claim anything.
  if (session === null) return incomplete(edited, "no language server for the edited file")

  try {
    // No symbol to refute against ⇒ nothing to reason over. When the target is a
    // whole file (`symbol` undefined) the engine has no per-symbol callgraph
    // handle ⇒ `null` (critic maps absence-of-facts to `inconclusive`).
    if (edited.symbol === undefined || edited.symbol.trim().length === 0) return null

    const symbols = await session.documentSymbol(absFile, signal).catch(() => null)
    // documentSymbol null (server ran, no answer) or aborted ⇒ blind spot.
    if (symbols === null) {
      if (signal.aborted) return incomplete(edited, "static analysis timed out")
      return incomplete(edited, "document symbols unavailable for the edited file")
    }
    const symbol = findSymbol(symbols, edited.symbol)
    // Symbol not found by the engine ⇒ NO facts for this target ⇒ `null`
    // (absence of evidence, mapped to `inconclusive` — NEVER `refuted`).
    if (symbol === null) return null

    // Query the callgraph AT the symbol's declaration selection position.
    const incoming = await session
      .incomingCalls(absFile, symbol.selectionRange.start, signal)
      .catch(() => null)
    if (incoming === null && signal.aborted) return incomplete(edited, "static analysis timed out")
    return factsFromCallgraph(edited, symbol, incoming)
  } finally {
    await session.stop().catch(() => undefined)
  }
}

/**
 * Build the LSP-backed `OwnerRefuter`. Compose with `makeOwnerCritic` (from
 * `../owner-critic.ts`) to get the 3-way `OwnerCritic`:
 *
 *     makeOwnerCritic(lspOwnerRefuter(cwd))
 *
 * `navProvider` is injected in tests (a fake session battery); production uses
 * `lspNavProvider()` from the LSP bridge. `budgetMs` bounds the whole query.
 */
export const lspOwnerRefuter = (
  cwd: string,
  navProvider?: LspNavProvider,
  budgetMs: number = DEFAULT_BUDGET_MS,
): OwnerRefuter => {
  const provider = navProvider ?? lspNavProvider()
  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : DEFAULT_BUDGET_MS

  return {
    query: async (edited: EditTarget, _ctx: TaskContext): Promise<GraphFacts | null> => {
      // HARD time bound: fire one controller at `budget` and thread its signal
      // into every LSP call. A slow/never-ready server is abandoned within
      // budget (⇒ inconclusive), never waited out. Never throws.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), budget)
      try {
        return await queryOnce(edited, cwd, provider, controller.signal)
      } catch {
        // Any unexpected error ⇒ graceful blind spot (never propagate a throw
        // into the observe-only repair-phase wire).
        return incomplete(edited, "static analysis failed")
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
