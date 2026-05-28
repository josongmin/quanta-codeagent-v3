# ADR-0398 — Atomic write + sha256 hash precondition for `edit` / `write`

**Status:** Accepted (2026-05-28)
**Slice:** `src/storage/atomic-write.ts` (new leaf) + `src/storage/service.ts` (port extension) + `src/tool/edit/index.ts` (gate + commit route) + `src/tool/types.ts` (`stale_precondition` failure mode) + hellgate.
**Default-OFF:** Yes — pure opt-in via the new `expected_hash` schema field. Absent ⇒ byte-identical to the pre-ADR `edit` path. The new `FileSystemPort.writeFileAtomic` is OPTIONAL; legacy in-memory test ports without it keep working.

## Context

The `edit` tool reads a file, computes the new content, and calls `fs.writeFile(path, content)`. Two real failure modes leak through this path today:

1. **Stale context.** An agent edits content it READ in turn `T-3`; meanwhile the user (or another agent / hook / pre-commit auto-format) has changed the file. The edit either lands on stale assumptions (silent semantic drift) or hits an `old_string not found` (loud, but the file has already drifted in non-obvious ways).

2. **Partial-write on crash.** `Bun.write` / `node:fs` writes are NOT crash-atomic. A power loss / signal during the syscall can leave a half-written file. The `@/lsp` slice already solved this for the LSP rename batch path via `atomicFileWriteStrategy` (ADR-0155), but the edit tool's commit path bypassed it.

The two concerns share one fix: gate the commit on a freshness signal AND replace the destructive `writeFile` with a temp+rename that is either fully applied or fully aborted.

## Decision

Two orthogonal changes, both **opt-in** so the rollout is a pure superset:

### 1. `expected_hash` precondition (sha256 hex)

Extend the `edit` tool schema with `expected_hash?: string`. When supplied:

1. Read the file as before.
2. Compute `sha256Hex(currentBytes)`.
3. If `actual !== expected` → yield a typed `failure` and skip the write:
   ```ts
   { mode: "stale_precondition"; path; expectedHash; actualHash }
   ```
   Both hashes appear in `output` so the model sees the divergence text and in `failure` so any downstream router (Codex-style retry, Cursor-style banner) can branch without regex-sniffing.
4. If they match → proceed exactly as before, with the commit routed through the new atomic adapter (see §2).

Absent the field, the legacy code path is byte-identical. No hashing, no port-method lookup, no behavior change.

### 2. `writeFileAtomic` storage adapter (2-phase temp+rename)

New leaf `src/storage/atomic-write.ts`:

```
Phase A: write to `<path>.quanta-tmp-<hex>`        (original untouched)
Phase B: rename(temp, path)                         (POSIX atomic on same FS)
     EXDEV → copyFile(temp, path) + unlink(temp)   (cross-FS fallback)
```

Algorithm matches the per-file portion of `@/lsp/adapters/file-write-atomic.ts` (ADR-0155). Cannot import that module — `@/storage` MUST NOT depend on `@/lsp` (biome slice fence). Re-declaring the algorithm in a 60-LOC leaf is the slice-clean adapter the prompt asked for. The lsp module's body is unchanged.

Exposed via the storage barrel as `writeFileAtomic` (raw helper) and as an OPTIONAL `FileSystemPort.writeFileAtomic` method (so existing in-memory test ports — which only implement the 4 legacy methods — keep type-checking unchanged). The `defaultFileSystemPort` wires the real adapter through `resolvePath` (jail-aware).

## Hash convention

`sha256Hex(content)` — the canonical hex digest used by every other hash-bearing port in this codebase (`@/llm/system-prompt-cache/hash.ts`, `@/llm/cache-control-audit/hash.ts`, `@/llm/replay/recording-llm.ts`). 64 lowercase hex characters; UTF-8 input, no normalization. Re-exported from `@/storage` (not re-imported from `@/llm`) to keep the slice fence clean — a tool computing the precondition does not need to reach into `@/llm` for one line of crypto.

The model can compute the same digest from any standard library: `sha256` of the file's UTF-8 bytes, lowercase hex. There is no version field, no salt, no truncation.

## Default-OFF / byte-identical proof

- The schema field is `expected_hash: z.string().optional()`. Absent ⇒ skip the hash branch (single `if (input.expected_hash !== undefined)` guard).
- The atomic commit is gated on `input.expected_hash !== undefined && fs.writeFileAtomic !== undefined`. Either side false ⇒ legacy `fs.writeFile`.
- `FileSystemPort.writeFileAtomic` is `?: ...` so adding it to the interface does NOT widen any existing port literal. The hellgate's `makeRecordingLegacyPort` proves a 4-method port still compiles + passes.
- `ToolFailure` gains a new arm but every existing switch / classifier inspected (`@/llm/retry/codex-spec-router`, `@/agent/error-routing/default-classifier`, `@/agent/prompt-rules/index`) switches on a DIFFERENT closed enum (`LLMErrorKind` / `AgentMode`). Adding an arm to `ToolFailure` is a non-breaking widening.

## Hellgate

`tests/unit/edit-atomic-precondition-hellgate.test.ts` — 7 cases:

1. Default-OFF: no `expected_hash` ⇒ legacy `writeFile`, recording port records it.
2. Matching hash ⇒ atomic write, recording port records `writeFileAtomic`.
3. Mismatching hash ⇒ `failure.mode: "stale_precondition"` + ZERO writes recorded + file untouched.
4. Mismatching hash output mentions both hashes (model-visible diff).
5. Hash precondition on a port without `writeFileAtomic` ⇒ still gates; falls back to `writeFile` on match.
6. Default-OFF still uses `writeFile` even when the port DOES implement atomic (proves the rollout is opt-in, not opportunistic).
7. Real-FS `writeFileAtomic`: phase-A failure (parent is a regular file, not a dir) ⇒ original untouched, temp absent, target absent.

A separate sha256-vector test pins `sha256Hex("") == e3b0…b855` and `sha256Hex("abc") == ba78…15ad` against the FIPS 180-4 specification vectors so any future rewrite of the helper cannot silently drift the digest model code is reading.

## Consequences

- Tool authors that propose an edit they want guarded against drift compute `sha256Hex(read_result)` themselves and thread it as `expected_hash`. The retry surface is symmetric to `old_string` — `stale_precondition` says "re-read and retry", `not_found` says "re-read and pick a different anchor".
- `apply_patch` and `lsp_rename_apply` keep their own atomicity strategies (batch-shaped via `FileWriteStrategy` / `PatchFileSystemPort`). This ADR is scoped to the single-file `edit` commit path; extending `write` is a one-line follow-up if a use case appears.
- The `expected_hash` channel is the natural seam for the future "verifier-prover" gate (ADR-0396 shadow-verify): when verify replays an edit in the scratch overlay, it can require the precondition hash on the way back to the real workspace.

## Not in scope

- Hashing schemes other than sha256 (sha-1 is too weak for an authority gate; blake3 is faster but absent from `node:crypto` so it would force a new dependency).
- Truncation conventions ("first N hex chars"). The model can always pass the full digest; we accept full-length only to avoid a partial-hash collision surface.
- The `write` (full overwrite) tool. Adding `expected_hash` there is the obvious follow-up but requires deciding how to spell "expected_hash on a brand-new file" (current value: empty?). Deferred.
