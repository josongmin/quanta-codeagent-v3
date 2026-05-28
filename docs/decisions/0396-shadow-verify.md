# ADR-0396 — Shadow Verify (apply-before-show in a scratch overlay)

**Status:** Accepted (2026-05-28)
**Slice:** `src/agent/shadow-verify/` (new — `types.ts` + `runner.ts` + `index.ts`) + hellgate.
**Wave:** 1 of 2 — PORT + RUNNER with INJECTED dependencies + fakes.
**Default-OFF:** Yes — nothing imports or wires this slice yet. It is a pure
new island reachable only from its own hellgate. Wave 2 supplies the real
adapters and the loop / LLM-tool wiring.

## Context

Multi-file edits change the user's experience more by **pre-apply
verification** than by the proposal text itself. A proposal that "looks
right" can still break the build, fail the linter, or break a targeted test.
The highest-leverage UX move is to apply the edit to a **scratch overlay**
(never the real workspace), run the relevant checks there, and surface the
failing diagnostics annotated against the patch — so the agent can say "I
fixed it AND here is exactly where it breaks" *before* touching real files.

This is the verifier-prover discipline applied to edits: the verification
runs against a disposable copy, and the user's working tree is untouched
regardless of outcome.

## Decision

Define a closed **`ShadowVerifyPort`** and a dependency-injected runner that
orchestrates three injected collaborators. The slice owns ONLY the
orchestration policy; it never performs git, filesystem, or process I/O
itself.

### Port contract

- `ShadowCheck = "lint" | "typecheck" | "test"`
- `ShadowVerifyRequest { patch; checks; testTarget? }` — `patch` is opaque
  (V4A or unified diff), handed straight to the applier dep.
- `ShadowDiagnostic { file; line; col?; severity; message; source }`
- `ShadowVerifyResult { ok; applied; diagnostics }` —
  `ok = applied && no error-severity diagnostic`.

### Injected dependencies (slice fence)

The runner is built by `createShadowVerify({ scratch, applier, checker })`:

- `ShadowScratchPort.open(signal?)` → `{ handle; dispose() }` — an isolated
  scratch overlay with an opaque handle.
- `ShadowApplyPort.apply(handle, patch, signal?)` → `{ ok; error? }`.
- `ShadowCheckPort.run(handle, check, testTarget, signal?)` →
  `readonly ShadowDiagnostic[]`.

These are satisfied by **fakes in tests**. This slice NEVER imports the real
impls; Wave 2 adds a real git-worktree scratch provider, a V4A applier
adapter, and an LSP-diagnostics checker adapter.

### Runner behavior (pinned by the hellgate)

1. **Pre-aborted signal** → return `{ok:false, applied:false}` with a single
   "aborted" error diag; nothing is opened, applied, or checked.
2. **Open** the scratch overlay. If `open` throws, return an error diag
   directly — nothing was opened, so there is nothing to dispose.
3. **Apply** the patch:
   - clean (`ok:true`) → run each requested check, aggregate diagnostics in
     check order.
   - not-ok / applier throws → a single error-severity diagnostic whose
     `source` is the **first requested check** (defaulting to `"lint"` when
     `checks` is empty); `applied:false`; no checks run.
4. **`ok = applied && no error-severity diagnostic`** — `warning` / `info`
   diagnostics are surfaced but do NOT fail.
5. **ALWAYS dispose** the scratch handle in a `finally`. A dispose failure is
   swallowed (it must never mask the result).
6. **NO-THROW to the caller.** Every dep call is wrapped; a thrown dep error
   becomes an error-severity diagnostic. The `signal` is threaded to
   `open` / `apply` / `run`, and an abort raised mid-flight short-circuits the
   remaining checks.

## Consequences

- **Default-OFF / byte-identical:** no existing file is modified; the slice
  is dead weight until Wave 2 wires it, so every legacy path is unchanged.
- **Slice fence:** no imports from `@/agent` core, `@/apps`, `@/lsp`,
  `@/tool`, `@/patch`, `@/runtime`. The runner is pure orchestration over
  injected ports — fully unit-testable with fakes and no I/O.
- **No-leak proof:** the hellgate counts `dispose` calls and asserts exactly
  one on the happy path and on the checker-throws path, and zero when `open`
  itself fails.

## Not in this wave (deliberate hold → Wave 2)

- Real git-worktree scratch provider (`ShadowScratchPort` adapter).
- Real V4A / unified-diff applier adapter (`ShadowApplyPort`).
- Real LSP-diagnostics + targeted-test runner adapter (`ShadowCheckPort`).
- Loop / LLM-tool wiring + result rendering (annotate diagnostics against the
  proposed patch in the surface).

## Testing

`tests/unit/shadow-verify-hellgate.test.ts` — 22 adversarial cases
(HELL-SV-01…20): happy path, apply-failure source attribution, severity
gating (error fails / warning+info pass), checker-throws → error diag,
applier-throws, open-throws (no dispose-leak), dispose-throws swallowed,
dispose-count no-leak (happy + throw paths), multi-check aggregation, empty
checks, pre-abort + mid-flight abort, `testTarget` forwarding to the `test`
check only, handle forwarding to applier + every checker, flat ordered
diagnostics, any-error-wins, and signal propagation to all three deps.
