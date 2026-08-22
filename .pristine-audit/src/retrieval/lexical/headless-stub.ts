/**
 * ADR-0260 — deterministic stub for tests.
 *
 * Never spawns a real process. Returns the closed `LexicalSearch` port
 * with byte-identical-across-runs behaviour by re-using the SAME BM25
 * scoring engine the production `bm25-impl` adapter uses (via the
 * shared `tokenizeUtf8`). The stub is independently constructible —
 * two `headlessLexicalStub()` calls give two isolated instances.
 *
 * Caller-injectable failure mode (`failWith`) lets the hellgate drive
 * every arm of `LexicalError` without a real subprocess; caller-injectable
 * `degradeReason` lets it verify the index-result shape.
 *
 * Production callers MUST NOT wire this stub.
 */

import { err, ok, type Result } from "@/shared"
import { createBm25LexicalSearch } from "./bm25-impl"
import type { LexicalDoc, LexicalIndexResult, LexicalQueryOptions, LexicalSearch } from "./port"
import type { LexicalDegradeReason, LexicalError, LexicalHit } from "./types"

export interface HeadlessLexicalStubOptions {
  /** Surface this on the FIRST `index` result — mirrors the ripgrep
   *  adapter's degrade contract. */
  readonly degradeReason?: LexicalDegradeReason
  /** When set, EVERY `query` resolves with this error. Lets the
   *  hellgate exercise the failure arms without a real subprocess. */
  readonly failWith?: LexicalError
}

export const headlessLexicalStub = (opts: HeadlessLexicalStubOptions = {}): LexicalSearch => {
  const inner = createBm25LexicalSearch()
  let indexedOnce = false
  return {
    async index(
      docs: ReadonlyArray<LexicalDoc>,
    ): Promise<Result<LexicalIndexResult, LexicalError>> {
      const base = await inner.index(docs)
      if (!base.ok) return base
      const first = !indexedOnce
      indexedOnce = true
      if (first && opts.degradeReason !== undefined) {
        return ok({ ...base.value, degradeReason: opts.degradeReason })
      }
      return base
    },

    async query(
      q: string,
      k: number,
      queryOpts?: LexicalQueryOptions,
    ): Promise<Result<ReadonlyArray<LexicalHit>, LexicalError>> {
      if (opts.failWith !== undefined) return err(opts.failWith)
      return inner.query(q, k, queryOpts)
    },

    clear(): void {
      inner.clear()
      indexedOnce = false
    },

    size(): number {
      return inner.size()
    },
  }
}
