/**
 * ADR-0260 — closed `LexicalSearch` port.
 *
 * Four operations:
 *   - `index(docs)` — install the corpus the engine will retrieve over.
 *   - `query(q, k)` — return up to k hits, sorted by score desc.
 *   - `clear()`     — drop the corpus + any cached state. Sync.
 *   - `size()`      — corpus doc count (sync; never spawns or reads).
 *
 * Split-port keeps three adapters independently substitutable:
 *   - production BM25 wires `createBm25LexicalSearch()`,
 *   - production ripgrep wires `createRipgrepLexicalSearch({ root, spawner })`,
 *   - tests wire `headlessLexicalStub()` for determinism.
 */

import type { Result } from "@/shared"
import type { LexicalDegradeReason, LexicalError, LexicalHit } from "./types"

export interface LexicalDoc {
  readonly id: string
  readonly text: string
  readonly metadata?: Readonly<Record<string, string>>
}

export interface LexicalQueryOptions {
  readonly signal?: AbortSignal
}

export interface LexicalIndexResult {
  readonly docs: number
  readonly tokens: number
  readonly degradeReason?: LexicalDegradeReason
}

export interface LexicalSearch {
  index(docs: ReadonlyArray<LexicalDoc>): Promise<Result<LexicalIndexResult, LexicalError>>
  query(
    q: string,
    k: number,
    opts?: LexicalQueryOptions,
  ): Promise<Result<ReadonlyArray<LexicalHit>, LexicalError>>
  clear(): void
  size(): number
}
