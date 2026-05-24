# ADR-0185: File-write — swap self-rolled atomic temp+rename for `write-file-atomic`

- Status: Accepted (sibling adapter; ADR-0155 self-impl is KEPT for zero-dep
  callers and as the reference for `warning: "non-atomic-fallback"` EXDEV
  surfacing — both adapters ship side-by-side under the same port)
- Date: 2026-05-25
- Related: ADR-0152 (LSP atomic write — original temp+rename mechanics),
  ADR-0155 (`FileWriteStrategy` port + sequential/atomic adapters), ADR-0143
  (LSP `applyWorkspaceEdit` Phase 1 sequential baseline)
- SOTA reference: **`write-file-atomic@8`** (https://github.com/npm/write-file-atomic) —
  150K weekly downloads, maintained by GitHub/npm, ISC, 200 LOC of carefully
  audited atomic-write logic with a `signal-exit` hook for crash cleanup.

## Context

ADR-0152 stood up `LspClient.applyWorkspaceEdit`'s 2-phase commit posture
in-class; ADR-0155 hexagonalized it as `atomicFileWriteStrategy` behind the
`FileWriteStrategy` port (`src/lsp/adapters/file-write-atomic.ts`, ~230 LOC).
The self-impl handles:

- temp path generation (`<path>.<tempPrefix>-<rand>` where `rand =
  crypto.randomBytes(8).toString("hex")`)
- 2-phase commit (Phase A: write all temps; Phase B: rename all)
- Phase-A rollback (unlink prepared temps if any temp write fails)
- EXDEV (cross-FS rename) fallback to `copyFile + unlink` with `warning:
  "non-atomic-fallback"` flag

The user principle is explicit: **"외부에 잘 만들어진 거 있으면 외부 거 써."**
`write-file-atomic` is the canonical npm primitive for this exact task —
sha1-derived temp names (no collision), write+fsync+rename in a try/finally
with `signal-exit`-driven temp cleanup on process abort, per-absolute-path
serialization queue, mode/chown preservation by default. We re-implemented a
narrower, less-hardened version of the same primitive.

Negative invariants we are NOT violating:
- Public `FileWriteStrategy` port stays byte-identical. Both adapters return
  the same `FileWriteOutcome` discriminated union in input order.
- The self-impl adapter (`file-write-atomic.ts`) stays on disk — its 16-case
  hellgate keeps passing unchanged. Zero-dep callers, the EXDEV `warning`
  flag, and the explicit Phase-A rollback semantics remain available.
- `LspClient.applyWorkspaceEdit` integration in `base.ts` is unchanged.
  Operators wiring the lib adapter pass it explicitly via
  `LspClientCtorOpts.fileWriteStrategy`.

## Decision

A sibling adapter `src/lsp/adapters/file-write-atomic-lib.ts` (~100 LOC + a
~30-LOC ambient `write-file-atomic.d.ts`) that delegates per-file atomic
writes to `write-file-atomic@8`:

```
src/lsp/adapters/
  file-write-strategy.ts        — UNCHANGED. Port + types.
  file-write-sequential.ts      — UNCHANGED. Best-effort fallback.
  file-write-atomic.ts          — UNCHANGED. Self-impl 2-phase commit.
  file-write-atomic-lib.ts      — NEW. write-file-atomic-backed sibling.
  write-file-atomic.d.ts        — NEW. Ambient types (lib ships none).
```

Strategy identity:

| field | self-impl                | lib                          |
|-------|--------------------------|------------------------------|
| name  | `atomic-temp-rename`     | `atomic-temp-rename-lib`     |
| temps | `<p>.<prefix>-<hex8>`    | `<p>.<sha1-of-pid+invo>`     |
| EXDEV | `warning` on outcome     | opaque inside lib (no flag)  |
| signal| checked per-entry        | checked per-entry (same)     |

Per-file isolation (LIB-2 hellgate): when entry K fails, entries K+1..N are
STILL ATTEMPTED — the lib's per-call try/catch produces one outcome per input
entry, mirroring the self-impl's Phase B behavior.

Options surfaced via `AtomicLibStrategyOpts`:
- `mode?: number` — chmod octal; defaults to existing file's mode (lib
  `stat`s the target) or `0o666` for new files.
- `fsync?: boolean` — lib default `true` (durability over throughput).

`exactOptional`-friendly: the options object is built conditionally (the
field is OMITTED, not set to `undefined`, when the caller did not pass it),
so `WriteFileOptions` typed without `| undefined` accepts the call.

## Hellgate

13 cases in `tests/unit/lsp-atomic-write-lib-hellgate.test.ts` proving parity
with the self-impl's invariants:

| ID    | Invariant                                                            |
|-------|----------------------------------------------------------------------|
| LIB-1 | happy 3 files → all `ok`; final content matches; name is `*-lib`     |
| LIB-2 | unwritable file 2 → `[ok, failed, ok]`; per-file isolation           |
| LIB-3 | pre-flight abort → ALL `failed`; reason `/abort/i`; no FS write       |
| LIB-4 | mid-batch abort → 1st pre-batch lands; remaining `failed: abort`     |
| LIB-5 | empty batch → empty outcomes; no FS reach                            |
| LIB-6 | no temp leftover post-success                                        |
| LIB-7 | no temp leftover post-failure (lib's try/finally cleanup)            |
| LIB-8 | `fsync: false` plumbed; write still lands                            |
| LIB-9 | `mode: 0o600` plumbed; observable via `fs.stat`                      |
| LIB-10| concurrent batches on DIFFERENT files → both succeed                  |
| LIB-11| 1 MiB content → succeeds; exact byte round-trip                       |
| LIB-12| overwrite existing → atomic replace; mode inherited (0o644)          |
| LIB-13| `failed.reason` is a non-empty string (caller-readable diagnostic)   |

Parity with the existing 16-case `lsp-atomic-write-hellgate.test.ts` (slices
A/B/C — strategy-level): the 13 strategy-level cases there continue to pass
unchanged; the 3 base-integration cases (D13/D14/D15) were already failing
pre-slice on `main` (in-flight user work on `LspClient.applyWorkspaceEdit`)
and are NOT touched by this slice.

## Alternatives rejected

- **`fs-extra`.** Ships a full FS suite (ensureDir, copy, move, …) plus its
  own atomic write under `outputFile`. ~10x the surface area for one helper.
  Heavier dep tree.
- **`atomic-file-rw`.** Less-maintained (last publish > 2 years), similar
  API, ~3K weekly downloads. `write-file-atomic` is the canonical primitive.
- **Pull `proper-lockfile` + roll the rename ourselves.** Adds a lock layer
  we don't need (same-process per-path serialization is enough for our use
  case — the LSP applyWorkspaceEdit is intra-process).
- **Drop the self-impl entirely; force lib-only.** Breaks the negative
  invariants above (zero-dep callers, EXDEV `warning` flag, explicit Phase-A
  rollback semantics). Sibling-adapter posture matches ADR-0172
  (`c8-source.ts` sibling to `v8-source.ts` / `ast-source.ts`).
- **Use the lib's sync (`.sync`) variant.** All our LSP/apply paths are
  already async; sync would deadlock the event loop on large batches.

## SOTA realignment

Per the 2026-05-23 four-way audit (`agent-loop-4way-comparison`), atomic
file writes in agent flows are NOT exposed as a comparison axis — every
competitor does direct fs writes. The slice is internal hardening (LSP
applyWorkspaceEdit + future destructive-write surfaces). Our unique axis
(typed `FileWriteStrategy` port behind LSP) is unchanged.

## Subtle decisions

- **Lib has NO `signal` parameter.** We honor `AbortSignal` cooperatively
  at the per-entry boundary (mirrors `sequentialFileWriteStrategy`). Once a
  call enters the lib's write+fsync+rename pipeline we cannot cancel it —
  same property as the self-impl.
- **EXDEV is opaque.** `write-file-atomic` does NOT itself fall back to
  copy+delete on EXDEV (the lib will throw); we surface this as a generic
  `failed` outcome rather than the self-impl's `warning: "non-atomic-fallback"`
  flag. Callers that NEED that signal stay on the self-impl. (Most LSP
  edits are same-FS so EXDEV is rare in practice.)
- **Temp names are sha1-based.** No collision under parallel batches or
  worker_threads (lib hashes `__filename + pid + threadId + invocation`).
  `tempPrefix` opt is NOT exposed — callers that need a custom prefix for
  sweep-by-name use the self-impl.
- **Lib serializes same-path writes internally.** Two concurrent
  `applyBatch` calls both targeting `/tmp/x.txt` queue at the lib level.
  Different paths still parallel (LIB-10 proves it).
- **Mode auto-inheritance.** Lib `stat`s the existing target and inherits
  its mode unless `opts.mode` is supplied (LIB-12 confirms). New files get
  `0o666 & ~umask` (Node default).

## Follow-up

- **Batch atomicity across files is NOT provided by either adapter.** Both
  commit file-by-file; partial commit on Phase-B failure is the documented
  trade-off. If we ever need true all-or-nothing across N files, that's a
  separate ADR — likely a shadow-ODB-style staging area + atomic swap, NOT
  achievable with POSIX `rename(2)` alone on N independent paths.
- **Default for `LspClient`?** Today both adapters are explicit opt-in via
  `fileWriteStrategy`. After a corpus calibration window (same posture as
  ADR-0172's c8 follow-up), consider flipping `LspClient`'s default to the
  lib variant for new code paths — the self-impl stays available for callers
  that rely on the EXDEV `warning` flag.
- **No `src/lsp/adapters/index.ts` re-export yet.** This directory has no
  barrel today; each consumer imports the adapter file directly. Adding a
  barrel is a separate refactor scope.
