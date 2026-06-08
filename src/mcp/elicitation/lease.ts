/** Track C (ADR-0197 follow-up) — single-flight lease over an
 *  {@link ElicitationPrompter}.
 *
 *  Problem: when several concurrent tool calls each trigger elicitation for
 *  the SAME logical need (e.g. two tools on the same server both need the same
 *  credential), the naive wiring prompts the user N times for one answer.
 *  Cursor solves this with `leaseElicitationRequest`: one in-flight prompt per
 *  logical key; every other caller awaits the SAME outcome.
 *
 *  Design choice — Promise-coalescing map, NOT the {@link OAuthRefreshLockPort}.
 *  We deliberately reuse a coalescing map keyed by `(serverId, leaseKey)`
 *  rather than the existing lock port even though both give mutual exclusion.
 *  Rationale:
 *    - The lock port's contract is `tryAcquire → "acquired" | "would-wait"`.
 *      A "would-wait" loser only learns *that* someone else holds the lock —
 *      it has NO channel to receive the winner's prompt RESULT. To share the
 *      outcome you would have to bolt a second result-store beside the lock
 *      and poll/notify it, reinventing exactly the Promise the map already
 *      holds. Single-flight is fundamentally a *shared-future* problem, and a
 *      Promise IS the shared future — losers `await` the winner's Promise and
 *      get its value for free, with no polling, no second store, no TTL race.
 *    - The lock's TTL/stale-reaping machinery is meaningful across processes
 *      (two CLIs racing an OAuth refresh). Elicitation is intrinsically
 *      single-process and single-session — the prompt happens on THIS
 *      process's stdin/TUI — so cross-process leasing is not just unneeded,
 *      it is wrong (you cannot show a prompt on another process's terminal).
 *  The lock primitive remains the right tool for OAuth refresh; it is the
 *  wrong shape here. (Per no-heuristics discipline: we pick the primitive
 *  whose contract matches, not the one that is merely nearby.)
 *
 *  Closed-port: this module exports a class whose `forContext` returns an
 *  object satisfying the {@link ElicitationPrompter} surface, so it drops in
 *  anywhere a prompter is expected (decorator pattern). Default behaviour with
 *  a single caller is byte-identical to calling the wrapped prompter directly.
 */

import type { ElicitationPrompter, ElicitationResult } from "./port"
import type {
  BooleanRequest,
  EnumRequest,
  IntegerRequest,
  MultiSelectEnumRequest,
  NumberRequest,
  SingleSelectEnumRequest,
  StringRequest,
  UrlRequest,
} from "./schemas"

/** Derive the logical lease key for a request. Two requests that coalesce MUST
 *  produce the same key. The default keys on `(serverId, title|prompt)` — the
 *  same server asking the same titled question is the canonical "same logical
 *  need". Callers can override with an explicit `leaseKey` when they have a
 *  stronger correlation id (e.g. an auth scope). */
export interface LeaseContext {
  /** Stable id of the MCP server originating the request. */
  readonly serverId: string
  /** Optional explicit correlation key. When omitted the request's
   *  `title ?? prompt` is used. */
  readonly leaseKey?: string | undefined
}

/** Anything carrying the fields we key on. All seven request shapes satisfy
 *  this structurally (they all have `prompt` and optional `title`). */
interface KeyableRequest {
  readonly prompt: string
  readonly title?: string | undefined
}

const composeKey = (ctx: LeaseContext, req: KeyableRequest): string => {
  const logical = ctx.leaseKey ?? req.title ?? req.prompt
  // `\x00` is a safe separator: a NUL cannot appear in a JSON string field
  // sourced from the wire (the line codec frames on `\n` and rejects control
  // chars implicitly), so `serverId` and `logical` can never collide across
  // the boundary.
  return `${ctx.serverId}\x00${logical}`
}

/** Wrap a prompter so concurrent calls sharing a lease key are coalesced into
 *  a single underlying prompt. Build one bound prompter per inbound logical
 *  request via {@link ElicitationLeasePool.forContext}. */
export class ElicitationLeasePool {
  private readonly inner: ElicitationPrompter
  /** key → in-flight Promise. Cleared the moment the underlying prompt
   *  settles (success OR failure), so a later request for the same key
   *  re-prompts rather than replaying a stale answer. */
  private readonly inflight = new Map<string, Promise<ElicitationResult<unknown>>>()

  constructor(inner: ElicitationPrompter) {
    this.inner = inner
  }

  /** Coalesce `run` under `key`. The first caller runs it; concurrent callers
   *  with the same key await the same Promise. Settlement (either arm) frees
   *  the key. */
  private coalesce<T>(
    key: string,
    run: () => Promise<ElicitationResult<T>>,
  ): Promise<ElicitationResult<T>> {
    const existing = this.inflight.get(key)
    if (existing !== undefined) return existing as Promise<ElicitationResult<T>>
    const p = run().finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, p as Promise<ElicitationResult<unknown>>)
    return p
  }

  /** A prompter bound to one lease context. Each method coalesces on
   *  `(serverId, leaseKey | title | prompt)`. */
  forContext(ctx: LeaseContext): ElicitationPrompter {
    return {
      promptString: (req: StringRequest, signal?: AbortSignal) =>
        this.coalesce(composeKey(ctx, req), () => this.inner.promptString(req, signal)),
      promptNumber: (req: NumberRequest, signal?: AbortSignal) =>
        this.coalesce(composeKey(ctx, req), () => this.inner.promptNumber(req, signal)),
      promptInteger: (req: IntegerRequest, signal?: AbortSignal) =>
        this.coalesce(composeKey(ctx, req), () => this.inner.promptInteger(req, signal)),
      promptBoolean: (req: BooleanRequest, signal?: AbortSignal) =>
        this.coalesce(composeKey(ctx, req), () => this.inner.promptBoolean(req, signal)),
      promptEnum: (req: EnumRequest, signal?: AbortSignal) =>
        this.coalesce(composeKey(ctx, req), () => this.inner.promptEnum(req, signal)),
      promptMultiEnum: (req: MultiSelectEnumRequest, signal?: AbortSignal) =>
        this.coalesce(composeKey(ctx, req), () => this.inner.promptMultiEnum(req, signal)),
      promptSingleEnum: (req: SingleSelectEnumRequest, signal?: AbortSignal) =>
        this.coalesce(composeKey(ctx, req), () => this.inner.promptSingleEnum(req, signal)),
      promptUrl: (req: UrlRequest, signal?: AbortSignal) =>
        this.coalesce(composeKey(ctx, req), () => this.inner.promptUrl(req, signal)),
    }
  }
}
