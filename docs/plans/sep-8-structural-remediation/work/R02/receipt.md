# R02 receipt — file transactions

Status: **implemented**. Lock primitive **not blocked** (Darwin flock spike + child kill/live-holder rails). I-stage applied agent/CLI/host trust `commit`. Not W7 `verified`.

Lane: W3-B. Closed on local `main` as part of W3 closeout.

## Primitive

POSIX `flock(2)` via `bun:ffi` (`libSystem.B.dylib` / libc). No npm native. Hold fd; CLOEXEC when the platform constant exists; release does **not** unlink; no age steal; nested reentrancy forbidden; concurrent waiters serialize.

Colocated copies (library fence): `src/auth/file-transaction/`, `src/permission/json-state-file/posix-flock.ts`, `src/migration/external-config/{posix-flock,exclusive-lock}.ts`.

## Findings

| ID | Result |
|---|---|
| F-03 | ledger flock + leftover pathname recoverable; timeout → `recordDisposition` false |
| F-04 | `.cas` wx removed; `${key}.txlock` flock; leftover `.cas` does not wedge; in-process CAS single winner; ChatGPT refresh uses this store |
| F-09 | age steal + release unlink removed; leftover flockable; live holder not stolen; SIGKILL then reacquire |
| F-10 | settings+hooks share `${settings.json}.lock`; two OS processes union keys |
| F-11 | element validator; `{entries:[null]}` fail-soft; original bytes not rewritten on load; unreadable ledger refuses persist |
| F-12 | `commit(mutations)` only; agent adapter lock+reread+merge; two OS processes keep both grants; malformed JSON `commit` throws and preserves original bytes (`trust-persist.ts`) |
| F-13 | `writeBytesAtomic` same-dir temp/sync/rename; EXDEV copy gone; memory append under lock; **F-13.2** two OS processes union distinct `raw_memories.md` blocks; `persistMemory` treats only ENOENT/ENOTDIR as empty (other read errors throw; `persistItemGuarded` absorbs as warning) |

## God-code

`persist.ts` 914 → **791** (left 900–999). Split `persist-sync.ts` / `persist-atomic.ts`. Allowlist not grown.

## Tests

Owner `tests/unit/sep8-remediation/r02` + lock/CAS/persist/trust hellgates + sticky-model flock follow-up. GREEN.

## Out of scope

- Windows flock
- Mixed pre-W3 wx binary vs post-W3 flock on the same `~/.quanta` (W0.4 operator rule)
- Revoke-resurrection
- `persistMcp` unlocked (F-10 original is settings/hooks)
