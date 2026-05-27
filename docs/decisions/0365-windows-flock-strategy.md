# ADR-0365 — Windows strategy for the disk-registry per-session lockfile

Status: Accepted (negative — code change: zero)
Date: 2026-05-27

## Context

ADR-0356 implemented the per-session lockfile using Node's `fs.open(path, "wx", 0o600)`
flag — which on POSIX maps to `O_CREAT | O_EXCL | O_WRONLY` and on
Windows maps to `CreateFileW` with `dwCreationDisposition = CREATE_NEW`.
The atomic exclusive-create is the mutual-exclusion primitive every
multi-writer is racing against.

The brief flagged the question: "Windows lacks `O_EXCL` semantics —
should the slice use `LockFileEx` or another mechanism instead?"

The brief lists three options:

- **A**: Keep `"wx"` as is, accepting that semantics on network
  filesystems (SMB / NFS) are vendor-dependent. Document the limit.
- **B**: Switch to `LockFileEx` (Windows-only) via a native binding.
  Requires either a new direct N-API dependency or a Bun FFI shim.
- **C**: Adopt `proper-lockfile` (or similar npm package) to handle
  the platform split.

Option C is foreclosed by the no-install fence on this sprint. The
real question is A vs B.

## Investigation

`fs.open(path, "wx", mode)` on Node 18+:

- **POSIX**: Maps to `open(path, O_CREAT | O_EXCL | O_WRONLY, mode)`.
  `O_EXCL` is atomic-by-syscall on every Linux + macOS local fs
  (ext4, APFS, btrfs, ZFS, …). On NFSv3 it can degrade silently —
  but NFSv3 cross-machine writes were declared OUT OF SCOPE by
  ADR-0355 (negative) so the slice does not pretend to cover that
  case anyway.
- **Windows (libuv `uv_fs_open`)**: Maps to `CreateFileW` with
  `dwCreationDisposition = CREATE_NEW`. Per Microsoft docs, this
  fails with `ERROR_FILE_EXISTS` (mapped to `EEXIST` in libuv) iff
  the file already exists. The check + create is atomic at the
  kernel level on local NTFS / ReFS volumes — same semantic as
  POSIX `O_EXCL`. On a remote SMB share, modern SMB2/3 servers
  also honor `CREATE_NEW` atomically (per the `SMB2 CREATE`
  protocol spec, the `FILE_CREATE` disposition).

`LockFileEx`-based locking offers a DIFFERENT semantic: a kernel
range lock on an OPEN handle. The lock is released when the holding
process closes the handle (or crashes — Windows kernel reclaims).
Range locks do not require a separate filesystem object the way
exclusive-create does. The trade-off:

- Pro: Range locks survive on filesystems where `CREATE_NEW`
  semantic is weaker (some old SMB1 servers, certain DFS configs).
- Pro: No stale-file detection needed — kernel reclaim is automatic
  on process exit.
- Con: Requires native code (no Node API exposes `LockFileEx`).
  Either a new direct dependency (`proper-lockfile`) or a Bun FFI
  shim (Windows-only `LoadLibrary("kernel32") + LockFileEx`).
- Con: Range-lock semantics are NOT process-local re-entrant — the
  same process opening the same file twice gets blocked on the
  second open. ADR-0356's holder map specifically supports the
  re-entry case for the "two registries in one PID" scenario.
- Con: Cross-platform divergence — POSIX path stays exclusive-create,
  Windows path uses range lock. Bug surface doubles.

The remit of this slice is single-machine multi-process safety
(ADR-0356 §Goals, ADR-0355 negative). On local NTFS / ReFS,
`fs.open(path, "wx")` already delivers that. On SMB, modern SMB2/3
also delivers it. The combinatorial corner — old SMB1 + legacy
Windows server — is far outside the support matrix quanta targets
(macOS + Linux primary; Windows local as a "should work" tier).

## Decision

**Option A** — keep the current `fs.open(path, "wx", 0o600)` mechanism
unchanged. Code change: zero. Documentation: this ADR + an inline
note in the file-lock.ts module header pointing here.

The decision rests on three load-bearing facts:

1. Node's `wx` flag maps to `CreateFileW(CREATE_NEW)` on Windows,
   which IS atomic on every supported volume type quanta targets.
   The mythical "Windows has no `O_EXCL`" is true at the POSIX-API
   level but false at the kernel-semantic level — the same atomic
   exists, just under a different name.
2. The known weak case (NFSv3, exotic SMB1 / DFS) is already in
   ADR-0355's negative scope.
3. Adding native code for a problem that does not exist on the
   supported volume types violates the slice's no-install constraint
   and doubles the bug surface.

The slice IS Windows-correct as written. ADR-0365 records the
investigation so the next time someone asks "should we switch to
`LockFileEx`?" the answer is one ADR-link away.

## Forward path

If a future deployment requires lock semantics on legacy SMB1 / DFS
volumes:

- The `fs.open(path, "wx")` exclusive-create stays the default code
  path.
- A new ADR (sibling slot) introduces an OPTIONAL strategy seam in
  `AcquireSessionLockOpts` — e.g. `lockStrategy?: "exclusive-create"
  | "range-lock"` — with the Windows range-lock adapter behind a
  new `LockFileEx`-based file. The selector defaults to
  `exclusive-create` so existing deployments are byte-identical;
  operators on legacy volumes opt in.
- Until that ADR ships, deployments on legacy Windows network
  volumes should mount via a modern SMB2/3 share (the default for
  Windows Server 2008+) or use a local volume.

## Consequences

### Positive

- Zero code change. ADR-0356 hellgate still passes verbatim.
- No new dependency. The no-install constraint is honoured.
- Single mutual-exclusion algorithm across POSIX + Windows — half
  the bug surface vs an `LockFileEx`-branched implementation.
- Investigation memorialized so the question stays answered.

### Negative

- Deployments on legacy SMB1 / pre-Server-2008 file shares are
  silently incorrect. The disk-mirror will appear to work but two
  writers will interleave appends. Operators on those rare volumes
  must read this ADR to know they are out of support.

### Neutral

- A Windows-specific hellgate is NOT added in this slice — the test
  would have to skip on non-win32 (same `test.skipIf(platform() ===
  "win32")` pattern used inversely in ADR-0356 §K). Since the
  underlying semantic is identical across platforms, the existing
  POSIX hellgate covers the contract.

## References

- ADR-0348 — Disk-persistent session-resource registry
- ADR-0355 — Cross-machine session replication (NEGATIVE — NFS lease
  + multi-machine out of scope)
- ADR-0356 — Multi-process lockfile for the disk-backed session
  registry (the slice this ADR adds context to)
- ADR-0364 — Flock operations telemetry (sibling)
- Microsoft docs: `CreateFileW` `dwCreationDisposition = CREATE_NEW`
- MS-SMB2 protocol spec §2.2.13 (`SMB2 CREATE`) — `FILE_CREATE`
  atomic semantics
- libuv `uv_fs_open` Windows implementation —
  `src/win/fs.c` `fs__open` mapping `O_CREAT|O_EXCL` to
  `CREATE_NEW`.
