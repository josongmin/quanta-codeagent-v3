/**
 * Multi-Auth Fleet (jun-20) — T-1 contract.
 *
 * One OAuth account is one rate-limit budget. The bench fleet historically read
 * a SINGLE `QUANTA_BENCH_AUTH_FILE`, so every concurrent box/chunk shared one
 * token and starved each other into sustained 429 (`generation_error`). The
 * `AuthSource` type lets bench entrypoints resolve EITHER the legacy single
 * account OR a multi-account pool, without any other layer learning about pools.
 *
 * This file is the contract only. It schedules nothing and reads no token bytes.
 */

/** One ChatGPT-OAuth account in a pool manifest. `authFile` points at the
 *  on-disk credential; its CONTENTS are never read by the resolver (dry-run must
 *  stay token-blind) — only the path is carried until launch time. */
export interface AuthPoolEntry {
  /** Stable operator-facing handle (e.g. `acct-a`). Unique within a manifest. */
  readonly label: string
  /** Path to this account's `chatgpt.json`. Read lazily at launch, never here. */
  readonly authFile: string
  /** Max concurrent agent loops this ONE account can sustain before throttling. */
  readonly maxParallel: number
  /** Optional cap on simultaneously-active boxes pinned to this account. */
  readonly maxBoxes?: number
  /** Base cooldown (seconds) applied to THIS account on a 429 (per-account). */
  readonly cooldownBaseSec?: number
  /** Relative scheduling weight among ready accounts. Defaults to 1. */
  readonly weight?: number
  /** Operator kill-switch — a disabled account is never leased. */
  readonly disabled?: boolean
}

/** What every bench entrypoint resolves auth to. `single` is byte-identical to
 *  the legacy path; `pool` carries the validated accounts. */
export type AuthSource =
  | { readonly kind: "single"; readonly authFile: string }
  | { readonly kind: "pool"; readonly accounts: readonly AuthPoolEntry[] }
