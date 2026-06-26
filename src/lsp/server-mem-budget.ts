/** LSP server memory budget — cap a Node-based language server's V8 heap so it
 *  can never OOM the host.
 *
 *  pyright-langserver and typescript-language-server are Node programs spawned
 *  over stdio (`@/lsp/adapters/base` `start()`). They inherit the parent env and
 *  run with no old-space heap cap; on a large repo (django/matplotlib/sklearn)
 *  pyright's Node heap balloons, and with bench concurrency + warm-pool-retained
 *  servers the combined RSS OOM-killed a 64GB box (kernel exit 137; an earlier
 *  conf=4 run saw pyright exit 247 = Node's own OOM). Appending
 *  `--max-old-space-size=<MB>` to NODE_OPTIONS makes V8 bound its own heap.
 *  Non-Node servers (clangd / gopls / rust-analyzer) ignore NODE_OPTIONS, so the
 *  cap is harmless to set everywhere — no host should be OOM-able by a language
 *  server.
 */

/** Default heap cap (MB) applied when {@link resolveLspMemBudgetMb} sees no
 *  explicit `QUANTA_LSP_MEM_BUDGET_MB`. Generous: a single pyright rarely needs
 *  >4GB even on the largest repos, and a 64GB box has ample headroom for a few
 *  capped servers — so this prevents the box-OOM without operator action while
 *  staying safe for interactive CLI nav. Flat literal so the magic-number scan
 *  does not trip. */
export const DEFAULT_LSP_MEM_BUDGET_MB = 4_096

const MAX_OLD_SPACE_FLAG = "--max-old-space-size"

/** Build the env passed to `Bun.spawn` for an LSP server, capping the Node V8
 *  old-space heap at `budgetMb` MB.
 *
 *  - `budgetMb` undefined / <= 0 ⇒ the parent env is returned UNCHANGED
 *    (byte-identical, the explicit opt-out path).
 *  - otherwise ⇒ a COPY of the parent env with `--max-old-space-size=<budgetMb>`
 *    APPENDED to any existing `NODE_OPTIONS`.
 *
 *  CLOBBER DECISION: if the parent `NODE_OPTIONS` ALREADY contains a
 *  `--max-old-space-size` flag, it is LEFT UNTOUCHED — the operator wins. We do
 *  not append a second (conflicting / duplicate) flag; an operator who pinned a
 *  heap size deliberately chose it.
 */
export function buildLspServerEnv(
  parentEnv: Readonly<Record<string, string | undefined>>,
  budgetMb: number | undefined,
): Record<string, string | undefined> {
  if (budgetMb === undefined || !Number.isFinite(budgetMb) || budgetMb <= 0) {
    return parentEnv as Record<string, string | undefined>
  }
  const existing = parentEnv.NODE_OPTIONS
  if (existing && existing.includes(MAX_OLD_SPACE_FLAG)) {
    // Operator already pinned a heap size — respect it, change nothing.
    return parentEnv as Record<string, string | undefined>
  }
  const cap = `${MAX_OLD_SPACE_FLAG}=${Math.floor(budgetMb)}`
  const nodeOptions = existing && existing.length > 0 ? `${existing} ${cap}` : cap
  return { ...parentEnv, NODE_OPTIONS: nodeOptions }
}

/** Resolve the LSP heap budget (MB) from `QUANTA_LSP_MEM_BUDGET_MB`.
 *
 *  - unset / empty / non-numeric / negative ⇒ {@link DEFAULT_LSP_MEM_BUDGET_MB}
 *    (4096; DEFAULT-ON so the OOM is prevented without operator action).
 *  - `0` ⇒ `0` (the explicit opt-out — no cap, env passed through unchanged).
 *  - a positive integer ⇒ that value.
 *
 *  Garbage never yields NaN/uncapped: a parse failure falls back to the safe
 *  default rather than silently disabling the cap.
 */
export function resolveLspMemBudgetMb(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.QUANTA_LSP_MEM_BUDGET_MB
  if (raw === undefined || raw.trim() === "") return DEFAULT_LSP_MEM_BUDGET_MB
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_LSP_MEM_BUDGET_MB
  if (parsed === 0) return 0
  if (parsed < 0) return DEFAULT_LSP_MEM_BUDGET_MB
  return parsed
}
