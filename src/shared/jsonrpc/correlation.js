const MAX_ID = Number.MAX_SAFE_INTEGER;
/** Construct a generator seeded at `seed` (default 1). The first call to
 *  `next()` returns `seed`; subsequent calls return `seed + 1`, `seed + 2`,
 *  and so on. */
export const createRequestIdGenerator = (seed = 1) => {
    if (!Number.isInteger(seed)) {
        throw new TypeError(`createRequestIdGenerator: seed must be an integer (got ${seed})`);
    }
    if (seed < 0) {
        throw new RangeError(`createRequestIdGenerator: seed must be >= 0 (got ${seed})`);
    }
    if (seed > MAX_ID) {
        throw new RangeError(`createRequestIdGenerator: seed exceeds MAX_SAFE_INTEGER (${seed} > ${MAX_ID})`);
    }
    let counter = seed - 1;
    return {
        next() {
            if (counter >= MAX_ID) {
                throw new RangeError(`RequestId generator exhausted (reached MAX_SAFE_INTEGER=${MAX_ID})`);
            }
            counter += 1;
            return counter;
        },
        peek() {
            const candidate = counter + 1;
            if (candidate > MAX_ID) {
                throw new RangeError(`RequestId generator exhausted (peek beyond MAX_SAFE_INTEGER=${MAX_ID})`);
            }
            return candidate;
        },
        current() {
            return counter;
        },
    };
};
/** Process-wide default generator. Seeded at 1 so the first id is 1.
 *  Tests SHOULD construct their own generator via `createRequestIdGenerator`
 *  rather than relying on the shared default — the default is for production
 *  where ids must be unique across the process lifetime. */
const defaultGenerator = createRequestIdGenerator(1);
/** Mint the next id from the process-wide default generator. */
export const nextRequestId = () => defaultGenerator.next();
/** Cast an externally-supplied id (e.g. relayed from a peer) to the branded
 *  type WITHOUT bumping the counter. Use sparingly — the call site is
 *  asserting that the id is unique within its correlation table. */
export const brandRequestId = (n) => n;
