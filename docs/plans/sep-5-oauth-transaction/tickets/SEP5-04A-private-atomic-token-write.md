# SEP5-04A — private atomic token-file commit

**Priority:** P1
**Status:** LANDED
**Depends on:** SEP5-00
**Finding coverage:** D11

## Goal

Replace fixed `${path}.tmp` credential writes with one auth-owned primitive that
is collision-safe, mode-safe, and durable. Preserve ChatGPT and MCP token schemas
as adapters.

## Placement

`@/auth` cannot value-import `@/storage` under the machine denylist. Put the
credential-specific primitive under `src/auth/`; `@/host` may consume it at the
MCP composition seam. Do not add a boundary carve-out.

## Proposed contract

```ts
export interface PrivateAtomicWriteDeps {
  readonly randomBytes?: (size: number) => Uint8Array
  readonly sync?: PrivateFileSyncPort
}

export const writePrivateFileAtomic = async (
  path: string,
  content: string,
  deps: PrivateAtomicWriteDeps = {},
): Promise<void> => {
  // mkdir parent with 0700 posture where newly created
  // open same-dir unique temp with flags "wx" and mode 0600
  // write full content, sync temp, rename, best-effort sync parent
  // unlink temp on pre-commit failure; never log content
}
```

Do not reuse `storage/atomic-write.ts` through an illegal import. Mirroring its
random-temp/fsync algorithm inside the credential owner is intentional fence
duplication; schema serialization must remain outside the primitive.

## Write set

| File | Change |
|---|---|
| `src/auth/private-file-atomic.ts` | New credential-specific writer and injected sync/random seams |
| `src/auth/index.ts` | Export only the narrow writer/dependency types required by host composition |
| `src/auth/chatgpt-oauth/token-store.ts` | Serialize `TokenRecord`, then call private writer |
| `src/host/mcp-composition.ts` | Replace fixed-temp MCP token write with private writer |
| `tests/unit/auth/private-file-atomic.test.ts` | Real-FS mode, collision, failure-order tests |
| `tests/unit/auth/chatgpt-token-store-concurrency.test.ts` | Two writers/readers against one final path |
| `tests/unit/host/mcp-token-store-atomic.test.ts` | MCP schema and mode parity |

## Commit protocol

1. Resolve an explicit final path; never accept a directory as the target.
2. Create the parent without changing permissions of an existing directory.
3. Create `<path>.quanta-token-<random>` in the same directory using exclusive
   creation and mode `0600`.
4. Write the complete UTF-8 payload including the final newline.
5. `fsync` and close the temp file.
6. Rename temp to final.
7. Best-effort `fsync` the parent directory.
8. On any failure before rename, close and unlink only the resolved temp file.
9. Do not unlink a temp after an ambiguous rename failure unless final ownership
   is known.

## RED rails

- Two concurrent writes to one final path must never share a temp pathname.
- A reader observes either the complete old record or one complete new record,
  never partial JSON.
- Temp-file sync failure performs zero rename calls.
- Existing final file remains intact on pre-rename failure.
- New and replaced credential files are `0600` on POSIX.
- Error text, file names, and logs contain no access or refresh token bytes.

## Test and ratchet implementation

- `private-file-atomic.test.ts` uses a per-test `mkdtemp` directory and the real
  filesystem. Launch at least 32 writers behind one barrier, each with a unique
  valid JSON record, while a reader loops until settlement. Every successful
  read must parse and equal one complete old/new record.
- Inject deterministic `randomBytes`, open, write, sync-file, close, rename,
  sync-directory, and unlink seams. Cover failures at open, write, file-sync,
  and rename; assert the ordered call trace and exact final/temp state.
- Require unique temp path count to equal writer count and assert every final
  mode is `0600` on POSIX. Skip only the mode assertion on platforms where mode
  semantics are unavailable; collision and completeness never skip.
- Mutation A restores fixed `${path}.tmp`; the 32-writer barrier must produce a
  collision or invalid read. Mutation B allows rename after injected file-sync
  failure; `renameCalls === 0` must fail. Mutation C uses non-exclusive open;
  duplicate-temp ownership must fail.
- Scan errors and captured diagnostics for all fabricated access/refresh token
  values. Cleanup the exact test temp directory in `finally`; leaked temp files
  fail before cleanup.
- `chatgpt-token-store-concurrency.test.ts` and
  `host/mcp-token-store-atomic.test.ts` must invoke their public schema adapters,
  proving production wiring rather than calling only the writer helper.

## Proof rails

```sh
bun test tests/unit/auth/private-file-atomic.test.ts
bun test tests/unit/auth/chatgpt-token-store-concurrency.test.ts
bun test tests/unit/host/mcp-token-store-atomic.test.ts
bun test tests/unit/auth/t07-refresh-hellgate.test.ts
rg -n '\$\{path\}\.tmp|\.tmp`' src/auth/chatgpt-oauth/token-store.ts src/host/mcp-composition.ts
bun run typecheck
bun run lint:debt
```

## Definition of done

- Fixed token temp names are gone.
- ChatGPT and MCP final schemas remain byte-compatible except for safe commit
  mechanics.
- Concurrent real-FS tests prove complete records and private mode.
- The auth slice fence remains unchanged.

## Stop conditions

- The change attempts to import `@/storage` from `@/auth`.
- The helper accepts or logs structured token objects instead of opaque bytes.
- Durability is claimed without a fault-injected sync/rename ordering test.
