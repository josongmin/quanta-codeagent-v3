# SEP5-04B — ChatGPT cross-process refresh transaction

**Priority:** P1
**Status:** IMPLEMENTED IN WORKTREE — CAS hardening commit pending
**Depends on:** SEP5-04A
**Finding coverage:** D2; excludes D30's intentional MCP fresh-auth mutex

## Goal

Make token refresh one transaction across processes: acquire, re-read, refresh
only if still expired, atomically persist, release. Preserve the current
process-local single-flight and in-memory fallback on persistence failure.

## Current gap

`RefreshCoordinator` deduplicates only within one process. `FileBasedLock` and
`LockFileStorePort` exist, but no production concrete store is wired to the
ChatGPT adapter. Two processes can refresh the same rotating refresh token and
both write the same token file.

## Proposed contract

```ts
export interface RefreshTransactionDeps {
  readonly lock: OAuthRefreshLockPort
  readonly readCurrent: () => Promise<TokenRecord | null>
  readonly persist: (next: TokenRecord) => Promise<void>
  readonly refresh: (current: TokenRecord) => Promise<TokenRecord>
  readonly nowMs: () => number
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly holderId: string
  readonly signal?: AbortSignal
}

export const refreshTokenTransaction = async (
  key: string,
  deps: RefreshTransactionDeps,
): Promise<TokenRecord> => {
  // bounded acquire/backoff
  // re-read after acquisition
  // return fresh disk value if another holder already rotated
  // refresh + persist while held
  // release in finally only when this holder acquired
}
```

## Lock store

Add a production Node implementation of `LockFileStorePort` in `@/auth`:

- exclusive create uses `open(path, "wx", 0o600)` and maps `EEXIST` to
  `"exists"`;
- overwrite is allowed only for stale/corrupt recovery selected by
  `FileBasedLock`;
- release checks holder identity before deleting;
- lock file names are derived from a hash of the refresh key, never raw token;
- TTL exceeds the bounded HTTP refresh deadline and is not silently infinite.

## Write set

| File | Change |
|---|---|
| `src/auth/node-lock-file-store.ts` | Concrete exclusive/private lock store |
| `src/auth/chatgpt-oauth/refresh-transaction.ts` | Cross-process transaction state machine |
| `src/auth/chatgpt-oauth/refresh.ts` | Keep HTTP exchange and in-process coordinator; delegate transactional orchestration |
| `src/auth/chatgpt-oauth/token-store.ts` | Expose the narrow read/persist functions consumed by the transaction |
| `src/llm/adapters/chatgpt-oauth.ts` | Replace read→refresh→write sequence with injected transaction |
| ChatGPT OAuth composition/factory files | Construct one file lock from the resolved Quanta home and inject it |
| `src/apps/bench/remote/fresh-auth.ts` | Same transaction; last ChatGPT persist-without-lock production caller |
| `tests/unit/auth/chatgpt-refresh-transaction.test.ts` | Independent-holder concurrency and failure battery |
| `tests/integration/chatgpt-refresh-cross-process.test.ts` | Real child-process same-token-file proof |

## State machine

```text
ensureFreshToken
  ├─ memory fallback fresh -> return
  ├─ disk token fresh      -> return
  └─ expired
      -> process-local single-flight
      -> acquire cross-process lock with bounded backoff
      -> re-read disk
         ├─ fresh -> return it; do not call issuer
         └─ expired -> refresh issuer -> atomic persist -> return
      -> finally release owned lock
```

`would-wait` is not success and must not return the original expired token. The
loser waits/retries or fails with a typed bounded timeout.

## RED rails

- Two independent coordinators with the same file store call the issuer twice.
- Removing the post-lock re-read makes the concurrency test red.
- A loser returns the expired pre-lock token.
- Refresh, persist, abort, or timeout leaves a live lock owned by the process.
- One holder can release another holder's lock.
- Lock path or diagnostic contains raw refresh-token bytes.
- A persist failure discards the successful in-memory token for the current
  process; existing fallback semantics must remain.

## Test and ratchet implementation

- The unit test creates two independent transaction/coordinator instances that
  share only the fake lock/store. A barrier holds the issuer response until both
  have observed the expired record; require issuer calls = 1 and both results =
  the persisted winner token.
- The integration test starts one parent-owned localhost token endpoint with an
  atomic request counter, then launches two Bun child fixtures with the same
  token path and lock directory. Require two successful child results, one
  endpoint request, identical winner token, valid final JSON, and no lock file.
- Fault rows cover acquire timeout, caller abort, issuer failure, persist
  failure, corrupt/stale lock recovery, and release failure. Each has a bounded
  settlement deadline and asserts whether the lock must remain or be removed by
  ownership rules.
- Mutation A removes the post-acquire re-read; endpoint/issuer count must become
  2. Mutation B maps `would-wait` to success; the loser must return an expired
  token and fail. Mutation C releases unconditionally; a foreign-holder fixture
  must lose its lock and fail.
- Anti-vacuum floors are two independent holders/processes, one shared final
  path, one shared lock namespace, and one counting endpoint. A same-instance
  `Promise.all` test cannot satisfy the cross-process row.
- Child processes receive fabricated tokens only, inherit a scrubbed minimum
  environment, and are tree-killed in `finally` using the existing process-tree
  test utility pattern.

## Proof rails

```sh
bun test tests/unit/oauth-refresh-lock-hellgate.test.ts
bun test tests/unit/auth/chatgpt-refresh-transaction.test.ts
bun test tests/unit/auth/t07-refresh-hellgate.test.ts
bun test tests/integration/chatgpt-refresh-cross-process.test.ts
rg -n 'refreshToken\(' src/llm src/apps src/host
bun run typecheck
bun run lint:debt
```

## Definition of done

- One issuer refresh occurs for two concurrent processes sharing a token file.
- The loser returns the atomically persisted winner token.
- Every exit path has bounded settlement and ownership-safe release.
- Existing transient/auth error classification and memory fallback are intact.
- MCP OAuth's outer `inFlightToken` remains unchanged; it owns fresh interactive
  authorization and is not this ticket's duplicate.

## Stop conditions

- The design omits the post-acquire disk re-read.
- The lock key includes a token in plaintext.
- A test uses two calls against the same process-local coordinator and labels it
  cross-process proof.

## Closeout update — 2026-09-06

The original file-lock implementation still had read/overwrite and read/delete
TOCTOU windows. The closeout changes the auth-owned store contract itself:

- `LockFileStorePort` now exposes `writeExclusive` and exact-body
  `compareAndSwap`; unconditional overwrite/delete are removed;
- stale/corrupt takeover, same-holder renewal, and release all succeed only if
  the body observed by the caller is still current;
- `createNodeLockFileStore` serializes CAS with a private exclusive claim and
  commits replacement through the existing private atomic-file authority;
- holder IDs are minted per transaction with a monotonic suffix, preventing
  same-process/same-millisecond aliasing;
- auth owns one abortable backoff implementation; bench and LLM adapters no
  longer carry duplicate sleeps, and listener cleanup covers elapsed and abort
  exits.

The new `tests/unit/auth/node-lock-file-store.test.ts` proves exclusive create,
0600 mode, successful CAS, stale-expected rejection, delete CAS, and competing
CAS single-winner behavior against the real filesystem. Transaction tests add
same-clock holder uniqueness, abort-registration race settlement, and ownership
safe release. The cross-process integration fixture writes through the
production token store, requires one issuer request for two Bun processes,
identical winner tokens, valid final JSON, and no residual lock.

**Current receipt:** related OAuth suites passed (`46 pass, 0 fail` after the
silent-failure rail was included); the wider 23-file SEP5 bundle passed
`273/273`. Auth, LLM, integration, and tool slice fences passed `39/39`.
The final clean synthetic snapshot
`16a9349d22d90fac8a0838354084235ee9e05fb7` passed all 21 `test:ci` gates.
Implementation is not branch-delivered until committed.
