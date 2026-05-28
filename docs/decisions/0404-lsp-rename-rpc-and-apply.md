# ADR-0404 — `lsp_rename` — `textDocument/rename` RPC + atomic apply

Status: Accepted — 2026-05-28
Supersedes: none
Extends: ADR-0015 (LSP nav RPCs + `prepareRename`), ADR-0141
(`RenameApplyPort` + `lsp_rename_apply` tool), ADR-0152
(`applyWorkspaceEdit` 2-phase temp+rename atomic commit)

## Context

ADR-0141 shipped the **consumer half** of an LSP-driven rename:
`RenameApplyPort` (canonical port in `src/lsp/ports/rename-apply-port.ts`),
its slice-isolated duck mirror, and the `lspRenameApplyTool`
(`lsp_rename_apply` — mutating, `hitlTier: always-confirm`). That tool was
fully unit-tested but **never functional**: the `LspClient` had no
`textDocument/rename` RPC (only `prepareRename`, which merely PROBES whether
the cursor sits on a renameable identifier), and no adapter wired a real
`RenameApplyPort` to the client. The tool was also absent from every
registration surface, so it was unreachable.

The existing `applyWorkspaceEdit` (ADR-0152) already commits a
`WorkspaceEdit` via a 2-phase temp+rename atomic write. The missing legs were:
(1) the rename RPC itself, (2) an adapter joining RPC→apply, (3) bridge +
registration wiring.

## Decision

Complete the rename path by adding the three missing legs, reusing
`applyWorkspaceEdit` and the existing tool verbatim.

### 1. `LspClient.computeRename` (`src/lsp/adapters/base.ts`)

A new wire method mirroring the nav-RPC posture exactly:

```typescript
async computeRename(
  filePath: string,
  pos: Pos,
  newName: string,
  signal?: AbortSignal,
): Promise<RenameWorkspaceEdit | null>
```

- Lazy-opens the document (`ensureOpen`, idempotent).
- Issues `textDocument/rename` via `callOrNullOnUnsupported`, so a server
  lacking the rename capability surfaces as `null` (not a throw) — same
  contract as `definition`/`references`.
- Normalizes the wire `WorkspaceEdit` (legacy `changes` map OR newer
  `documentChanges` array — `documentChanges` wins per LSP spec) to the
  `RenameWorkspaceEdit` port shape via a new `toRenameWorkspaceEdit` mapper
  (structural sibling of the existing `toCodeActionWorkspaceEdit`, typed to
  the rename port to avoid an `as`-cast across the two families).
- `null` server payload ⇒ `null`; empty edit (neither field) ⇒
  `{ changes: [] }` (symbol unused — the tool treats it as a no-op).

`prepareRename` / `applyWorkspaceEdit` / `diagnostics` are **unmodified**.

### 2. `DefaultRenameApplyAdapter` (`src/lsp/adapters/default-rename-apply.ts`, new)

The default `RenameApplyPort` adapter — exact mirror of
`DefaultCodeActionAdapter`:

```typescript
class DefaultRenameApplyAdapter implements RenameApplyPort {
  computeRename(file, line, col, newName, signal) →
    client.computeRename(file, { line, character: col }, newName, signal)
  applyEdit(edit, signal) →
    client.applyWorkspaceEdit(edit, undefined, signal)   // ADR-0152 reuse
}
```

Plane-clean: imports only `../ports/rename-apply-port`. Constructor takes a
duck-typed subset of `LspClient` so fakes satisfy it without subclassing.

### 3. Bridge wiring + registration (`src/agent/lsp-bridge.ts`)

A stateful `RenameApplyPort` factory (`lspRenameApplyPort(cwd)`) opens the
file's language server lazily on `computeRename`, holds the client, and the
matching `applyEdit` reuses + stops it (`finally`). When `computeRename`
yields no edit (null / empty), the held client is stopped immediately because
the tool will not call `applyEdit`. The tool is `isConcurrencySafe: false`, so
the single held slot can never race. `lspNavToolList()` now returns **9 tools**
(8 read-only nav + `lsp_rename_apply`), so the existing `QUANTA_LSP_TOOLS=full`
gate (CLI `internal.ts`, knob `runner/knobs/knobs/lsp.ts`, bench driver) covers
rename with no new flag.

## Default-OFF / byte-identical

- The tool is registered ONLY through `lspNavToolList()`, which is appended to
  the registry ONLY when `QUANTA_LSP_TOOLS=full`. With the knob unset the tool
  surface is byte-identical (rename absent ⇒ default-OFF).
- `computeRename` is a pure addition to `LspClient` — no existing method
  changes behavior.
- Degrade-gracefully: a `.ts`/`.py` file with no server on PATH ⇒ provider
  returns `null` ⇒ `computeRename` returns `null` ⇒ the tool emits a clean
  `ok:false` "rename not available", never throws or hangs.

## HITL / safety

Owned by the unchanged `lspRenameApplyTool` (ADR-0141): `isReadOnly: false`,
`isConcurrencySafe: false`, `hitlTier: always-confirm` (the operator ALWAYS
confirms before any file is touched; cannot be skipped by acceptEdits /
pre-approval). The 2-phase atomic commit (ADR-0152) guarantees Phase-1 failure
leaves NO original mutated.

## Test coverage

26 new cases across 3 hellgate files:

- `lsp-rename-rpc-hellgate.test.ts` (9) — wire method / didOpen-once /
  `changes`-map + `documentChanges` normalization / documentChanges-wins /
  empty-edit / server-null / `-32601`→null / non-unsupported propagates.
- `lsp-default-rename-apply-hellgate.test.ts` (4) — compute forwards
  pos+newName + normalizes / null→null / `applyEdit` drives the multi-file
  2-phase atomic write end-to-end / Phase-1 write failure ⇒ no commit.
- `lsp-rename-bridge-hellgate.test.ts` (4) — `lspNavToolList()` includes
  `lsp_rename_apply` (9 tools) / mutating+always-confirm metadata /
  unavailable-server ⇒ clean `ok:false` (no throw, no hang).

The "applyEdit drives the real 2-phase atomic write" + "Phase-1 failure ⇒ no
commit" cases are the crucial correctness signal: they prove the rename path
inherits ADR-0152's atomicity rather than re-implementing the write.

## Non-goals

- Resource-level workspace ops (create/rename/delete file) — `RenameWorkspaceEdit`
  models only per-document `changes`; the RPC ignores `documentChanges` resource
  entries (intentional follow-up, same as ADR-0152).
- A separate read-only `lsp_rename` preview tool — `lsp_rename_preview` already
  exists (ADR-0015, `prepareRename`); this ADR completes the **applying** path.
- Per-call `cwd` injection into the rename port — the port is built with
  `process.cwd()` (the workspace root) at registration, matching how the nav
  provider roots its servers; the tool's path argument is absolute + jailed.
