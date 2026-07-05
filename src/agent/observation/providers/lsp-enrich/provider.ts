/**
 * lsp-enrich PROVIDER (jul-6). Design SSOT:
 * `docs/plans/jul-6-observation-providers/README.md` (catalog `lsp-prefetch`, §4).
 *
 * An `ObservationProvider` (kind "localization") backed by the EXISTING LSP nav
 * seam (`LspNavProvider` from `@/agent/lsp-bridge`). For each already-localized
 * candidate file it opens a language server, harvests `documentSymbol` →
 * symbol-refined `OwnerHint`s, and (best-effort) a `hover` signature →
 * `ContractHint`. It PRE-resolves this before the loop so the agent spends fewer
 * turns re-discovering structure. No semantica, no env, no prompt-text change.
 *
 * HARD invariants (audit-derived — do NOT relax):
 *   - A1 overtrust: a bare `documentSymbol` owner is `medium` at most; the
 *     provider NEVER ships `strength: "high"` off structure with no hover
 *     evidence.
 *   - hallucination fence: an emitted `owner.file` is ALWAYS the candidate file
 *     the session was opened on — never the symbol's own `uri` (a server may
 *     tag a symbol with a foreign document); and always a member of the
 *     provided `candidateFiles`.
 *   - `evidence` reflects the ACTUAL harvested fact (`lsp: <kind> <name>` /
 *     the hover signature), never a data-free template.
 *   - null-not-noise / graceful-degradation: if NOTHING is harvested (every
 *     server null, or no symbols anywhere) `produce` returns `null` — the
 *     smoke / no-LSP fallback path — never an empty-owners fragment.
 *   - budget-bounded (`maxOwners` cap, `maxMillis` clock) and NEVER throws (a
 *     dead server / parse miss / abort ⇒ graceful skip, like `evidenceLspStatic`).
 *   - Pure over the injected `navProvider` seam (unit tests inject a fake); the
 *     production provider is the ONLY default (no env reads here).
 */

import { isAbsolute, join } from "node:path"
import { lspNavProvider } from "@/agent/lsp-bridge"
import type { LspNavProvider, LspNavSession, NavHover, NavSymbolInfo, NavSymbolKind } from "@/tool"
import type { ContractHint, EvidenceStrength, ObservationFragment, OwnerHint } from "../../fragment"
import type { ObservationProvider, ProviderBudget, TaskContext } from "../../port"

/** Catalog id (`DEFAULT_SOURCE_AUTHORITY` in the pipeline ranks this above the
 *  LLM localizer, below static def-use). */
const PROVIDER_ID = "lsp-prefetch"

/** Cap the number of candidate files we spin a server up for — latency guard,
 *  independent of the owner cap. Localization already narrowed to a handful. */
const MAX_FILES = 6

/** Symbol kinds worth surfacing as an owner. A def/site the agent edits is a
 *  function / method / class / constructor — NOT a loose variable/constant/field
 *  (those are noise as localization owners). */
const OWNER_KINDS: ReadonlySet<NavSymbolKind> = new Set<NavSymbolKind>([
  "function",
  "method",
  "class",
  "constructor",
  "interface",
  "struct",
])

/** First non-empty, trimmed line of a hover payload — the signature line servers
 *  put up top (`def f(...) -> T`, `function f(...)`, `fn f(...)`). `null` when the
 *  hover has no usable content (⇒ no fabricated ContractHint). */
const signatureLine = (hover: NavHover): string | null => {
  for (const raw of hover.contents.split("\n")) {
    const line = raw.trim()
    // Skip markdown fences (```python) — the real signature is the line inside.
    if (line.length > 0 && !line.startsWith("```")) return line
  }
  return null
}

/** Map a harvested symbol → an OwnerHint keyed off the OPENED candidate file
 *  (never the symbol's uri — hallucination fence). `evidence` is the real
 *  `lsp: <kind> <name>` fact. `strength` is `medium` (structural, not proof —
 *  A1: never `high` off a bare documentSymbol). */
const symbolToOwner = (file: string, s: NavSymbolInfo): OwnerHint => {
  const strength: EvidenceStrength = "medium"
  return {
    file,
    symbol: s.name,
    strength,
    evidence: `lsp: ${s.kind} ${s.name}`,
    source: PROVIDER_ID,
  }
}

/** Harvest one file's symbols + (best-effort) one contract. NEVER throws: each
 *  session call is catch-guarded, the session is always stopped. Returns the
 *  owners it could confirm and any parseable contract. */
const harvestFile = async (
  file: string,
  absFile: string,
  session: LspNavSession,
  remaining: number,
  signal: AbortSignal,
): Promise<{ owners: OwnerHint[]; contracts: ContractHint[] }> => {
  const owners: OwnerHint[] = []
  const contracts: ContractHint[] = []
  try {
    // Session ops use the ABSOLUTE path the server was opened on; the emitted
    // owner.file stays REPO-RELATIVE (`file`) so it dedups with the agentless
    // owners and renders as a repo path, not a sandbox-absolute one. `signal`
    // keeps documentSymbol/hover under the same maxMillis bound as the open.
    const symbols = await session.documentSymbol(absFile, signal).catch(() => null)
    if (symbols === null) return { owners, contracts }
    // Promote only named symbols of an owner-worthy kind — a nameless symbol
    // would yield a data-free `evidence` ("lsp: function ") and an empty
    // `symbol`, which is noise, not a routing hint.
    const promoted = symbols.filter((s) => OWNER_KINDS.has(s.kind) && s.name.trim().length > 0)
    for (const s of promoted) {
      if (owners.length >= remaining) break
      owners.push(symbolToOwner(file, s))
      // Best-effort contract: hover at the symbol's selection position.
      if (contracts.length === 0) {
        const pos = s.selectionRange.start
        const hover = await session.hover(absFile, pos, signal).catch(() => null)
        const sig = hover !== null ? signatureLine(hover) : null
        if (sig !== null) contracts.push({ signature: sig, adjacent: `${file}:${s.name}` })
      }
    }
  } finally {
    await session.stop().catch(() => undefined)
  }
  return { owners, contracts }
}

/** Open + harvest every candidate file within the owner/time budget. Each open
 *  is guarded (a start failure is a skip, never a throw). Stops early once the
 *  owner cap is hit or the clock is exhausted. */
const harvestAll = async (
  files: readonly string[],
  cwd: string,
  provider: LspNavProvider,
  budget: ProviderBudget,
  signal: AbortSignal,
): Promise<{ owners: OwnerHint[]; contracts: ContractHint[] }> => {
  const deadline = Date.now() + budget.maxMillis
  const owners: OwnerHint[] = []
  const contracts: ContractHint[] = []
  for (const file of files) {
    if (signal.aborted || owners.length >= budget.maxOwners || Date.now() >= deadline) break
    // The language server needs an ABSOLUTE path (candidate files arrive repo-relative);
    // opening a relative path is the observed ENOENT that silently no-op'd the provider.
    const absFile = isAbsolute(file) ? file : join(cwd, file)
    // `signal` (fires at maxMillis) bounds the open itself — otherwise a not-ready
    // server blocks up to the 90s ready-timeout regardless of the deadline check above.
    const session = await provider.open(absFile, cwd, signal).catch(() => null)
    if (session === null) continue
    const got = await harvestFile(file, absFile, session, budget.maxOwners - owners.length, signal)
    owners.push(...got.owners)
    if (contracts.length === 0 && got.contracts.length > 0) contracts.push(...got.contracts)
  }
  return { owners, contracts }
}

/**
 * Build the lsp-enrich provider over a set of already-localized candidate files.
 * `navProvider` is injected in tests (a fake session battery); production uses
 * `lspNavProvider()` from the LSP bridge.
 */
export const lspEnrichProvider = (
  candidateFiles: readonly string[],
  cwd: string,
  navProvider?: LspNavProvider,
): ObservationProvider => {
  const provider = navProvider ?? lspNavProvider()
  const files = candidateFiles.slice(0, MAX_FILES)

  return {
    id: PROVIDER_ID,
    kind: "localization",

    applicable: (ctx: TaskContext): boolean =>
      ctx.capability !== "vision" && candidateFiles.length > 0,

    produce: async (
      _ctx: TaskContext,
      budget: ProviderBudget,
    ): Promise<ObservationFragment | null> => {
      // Non-positive budget ⇒ no room to say anything ⇒ no signal (no throw).
      if (!Number.isFinite(budget.maxOwners) || budget.maxOwners < 1) return null
      if (!Number.isFinite(budget.maxMillis) || budget.maxMillis <= 0) return null

      // HARD time bound (self-audit fix): `open()` alone can block up to the LSP
      // warm-pool ready-timeout (90s) when a server is slow/never-readies. The loop's
      // deadline check does NOT bound the in-flight call, so without an abort signal a
      // default-ON provider would add up to 90s×files to EVERY bench instance. Fire one
      // controller at `maxMillis` and thread its signal into every LSP call — a slow
      // server is abandoned within budget (⇒ null), never waited out.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), budget.maxMillis)
      let owners: OwnerHint[]
      let contracts: ContractHint[]
      try {
        ;({ owners, contracts } = await harvestAll(files, cwd, provider, budget, controller.signal))
      } finally {
        clearTimeout(timer)
      }

      // null-not-noise / graceful-degradation: nothing harvested ⇒ null (the
      // pipeline then falls back to agentless-only). An empty-owners fragment
      // would render as noise — forbidden.
      if (owners.length === 0) return null

      return {
        providerId: PROVIDER_ID,
        owners,
        ...(contracts.length > 0 ? { contracts } : {}),
      }
    },
  }
}
