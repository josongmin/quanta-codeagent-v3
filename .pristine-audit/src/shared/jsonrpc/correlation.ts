/**
 * JSON-RPC request-id correlation.
 *
 * Branded `RequestId` so call sites cannot accidentally pass a raw number.
 * The generator is deterministic and seedable so tests can assert exact ids;
 * NO `Math.random()` and NO `Date.now()` go into id generation. That keeps
 * recorded traces byte-identical replayable (ADR-0023 invariant) when the
 * caller supplies a fixed seed.
 *
 * Counter wrap-around: we use a Number monotonically incremented from `seed`.
 * Number.MAX_SAFE_INTEGER (2^53 - 1) is the ceiling — well above any
 * realistic call volume in a session, but we still throw loudly on overflow
 * rather than silently wrapping (which would risk id collisions).
 */
import type { JsonRpcId } from "./envelope"

/** Branded request-id type. `number` because spec §4 allows it and our
 *  default generator produces integers; callers relaying a string id can
 *  brand it with `brandRequestId(...)` at the boundary instead of going
 *  through the numeric generator. `null` is excluded because it cannot key
 *  a correlation table safely. */
declare const requestIdBrand: unique symbol
type BrandableRequestId = Exclude<JsonRpcId, null>
export type RequestId = BrandableRequestId & { readonly [requestIdBrand]: "JsonRpcRequestId" }

export interface RequestIdGenerator {
  /** Mint the next id. Deterministic given the seed; never collides until
   *  the integer space exhausts (in which case the next call throws). */
  next(): RequestId
  /** Peek the next-to-be-issued value WITHOUT advancing. Useful for tests. */
  peek(): RequestId
  /** Current internal counter (= value of the last id returned by `next()`,
   *  or `seed - 1` before the first call). Test-only. */
  current(): number
}

const MAX_ID = Number.MAX_SAFE_INTEGER

/** Construct a generator seeded at `seed` (default 1). The first call to
 *  `next()` returns `seed`; subsequent calls return `seed + 1`, `seed + 2`,
 *  and so on. */
export const createRequestIdGenerator = (seed = 1): RequestIdGenerator => {
  if (!Number.isInteger(seed)) {
    throw new TypeError(`createRequestIdGenerator: seed must be an integer (got ${seed})`)
  }
  if (seed < 0) {
    throw new RangeError(`createRequestIdGenerator: seed must be >= 0 (got ${seed})`)
  }
  if (seed > MAX_ID) {
    throw new RangeError(
      `createRequestIdGenerator: seed exceeds MAX_SAFE_INTEGER (${seed} > ${MAX_ID})`,
    )
  }
  let counter = seed - 1
  return {
    next(): RequestId {
      if (counter >= MAX_ID) {
        throw new RangeError(`RequestId generator exhausted (reached MAX_SAFE_INTEGER=${MAX_ID})`)
      }
      counter += 1
      return counter as unknown as RequestId
    },
    peek(): RequestId {
      const candidate = counter + 1
      if (candidate > MAX_ID) {
        throw new RangeError(
          `RequestId generator exhausted (peek beyond MAX_SAFE_INTEGER=${MAX_ID})`,
        )
      }
      return candidate as unknown as RequestId
    },
    current(): number {
      return counter
    },
  }
}

/** Process-wide default generator. Seeded at 1 so the first id is 1.
 *  Tests SHOULD construct their own generator via `createRequestIdGenerator`
 *  rather than relying on the shared default — the default is for production
 *  where ids must be unique across the process lifetime. */
const defaultGenerator = createRequestIdGenerator(1)

/** Mint the next id from the process-wide default generator. */
export const nextRequestId = (): RequestId => defaultGenerator.next()

/** Cast an externally-supplied id (e.g. relayed from a peer) to the branded
 *  type WITHOUT bumping the counter. Use sparingly — the call site is
 *  asserting that the id is unique within its correlation table. */
export const brandRequestId = <T extends BrandableRequestId>(id: T): T & RequestId =>
  id as T & RequestId
