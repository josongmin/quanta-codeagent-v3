# SEP6 P2 closeout register

**Status:** COMPLETE — no active P2 rows

**Audit baseline HEAD:** `0b14f5cf4f05ffaecf2fa1595bd2d7ba27f2b0dd`

## N12

### DAP frame resource ceilings — complete

`src/tool/debug/dap-codec.ts` now owns fixed 64 KiB header and 32 MiB body
limits. Endless headers and oversized declarations cannot grow retained state
without bound. Recovery locates a later canonical header or clears the bounded
state; a following valid frame decodes exactly once.

Proof: `tests/unit/tool/debug/dap-codec.test.ts`, plus DAP client, TCP transport,
driver, and `debug_inspect` focused tests (`62 pass, 0 fail`). The header-cap
case is discriminating: closing an oversized leading header would emit `{}` in
the old unbounded implementation but emits nothing in the bounded decoder.

## S8

### Mention first-line projection parity — complete

`src/shared/mention-text.ts` is the fence-legal, dependency-free owner of the
first-line policy: cut at LF/CRLF and trim boundary whitespace. All seven
resolver, autocomplete, and host inventory consumers call it; local
`firstLineOf` owners are removed.

Proof: `tests/unit/mention-first-line-parity-hellgate.test.ts` pins value cases,
discovers the exact seven live consumers through the TypeScript AST (comments,
strings, and unused imports do not count), and includes red-on-injection
mutations for both a deleted call and a comment-only fake call.
Resolver/host/CLI-focused batch: `73 pass, 0 fail`.

## S9

### Permission lock timeout fail-closed — complete

`src/permission/json-state-file/engine.ts` now stops before snapshot/reread/temp
write/rename when `acquireLock` returns false and returns
`{durable:false, reason:"cross-process lock unavailable"}`. Existing disk bytes
remain unchanged, live state remains authoritative, and the newest failed write
stays dirty so the same generation can be retried after contention clears.

Proof:

- deterministic timeout/stale-lock rail:
  `tests/unit/permission/json-state-file-lock-clock-hellgate.test.ts`;
- real two-process permission denial/grant rail:
  `tests/unit/permission/permission-store-concurrent-write-e2e-hellgate.test.ts`;
- real two-process trust grant/revoke rail:
  `tests/unit/permission/trust-scope-concurrent-grant-e2e-hellgate.test.ts`;
- interleaving merge rail: `tests/unit/bugbash-fix-permission-race.test.ts`.

Combined focused result: `16 pass, 0 fail`.

## Campaign receipt

The exact final overlay passed `bun run test:ci` in a clean detached
verification worktree over 3,852 discovered test files; all 21 gates were green.
The shared checkout's unrelated dirty state was preserved. There are no active
P2 rows.
