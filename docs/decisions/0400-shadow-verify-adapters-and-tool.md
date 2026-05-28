# ADR-0400 — Shadow Verify real adapters + `shadow_verify` LLM tool (Wave 2)

**Status:** Accepted (2026-05-28)
**Slice:** `src/agent/shadow-verify-adapters/` (NEW — `scratch-worktree.ts` + `apply-v4a.ts` + `check-lsp-test.ts` + `index.ts`), `src/tool/shadow-verify/` (NEW), `src/agent/tier1/shadow-verify.ts` (NEW) + 2 hellgate batteries.
**Wave:** 2 of 2 — REAL adapters + LLM tool registration. Wave 1 (ADR-0396) shipped the closed port + DI runner.
**Default-OFF:** Yes — `AgentConfig.shadowVerify` absent ⇒ the tier-1 builder returns `[]` and the loop is byte-identical to the pre-ADR path.

## Context

Wave 1 (ADR-0396) sealed the `ShadowVerifyPort` contract and shipped a
dependency-injected runner whose three collaborators
(`ShadowScratchPort` / `ShadowApplyPort` / `ShadowCheckPort`) were satisfied
only by fakes in tests. The slice deliberately stayed an unreachable island —
no real adapter existed, and the model could not call the verifier.

Wave 2 closes that gap on three axes simultaneously:

1. **Real scratch overlay** — back the `ShadowScratchPort` with the
   existing `@/runtime/worktree-fork.createPersistentWorktree` so each
   `open()` mints a fresh, uuid-tagged git worktree forked off the host
   `HEAD`. `dispose()` removes the worktree + the branch.
2. **Real applier** — back the `ShadowApplyPort` with `@/patch`'s V4A
   pipeline (`parsePatch` → `applyPatch(patch, fs)`). The injected
   `PatchFileSystemPort` is a thin path-bounded adapter rooted at the
   scratch handle (no `@/storage` jail — the scratch tree is itself the
   sandbox).
3. **Real checker** — back the `ShadowCheckPort` with `@/lsp`'s existing
   pyright + typescript adapters (lint / typecheck) and a shell-backed
   `bun test` runner (test). LSP unavailability and shell failure both
   collapse to error-severity diagnostics rather than throws.

The model-facing surface is the `shadow_verify` LLM tool: `pre-approval-ok`
HITL tier (read-only against the real workspace), `isReadOnly: true`,
`isConcurrencySafe: false`. Output is a deterministic
`applied: yes|no` / `ok: yes|no` / one-line-per-diagnostic rendering.

## Decision

### New slice `@/agent/shadow-verify-adapters` (composition-root layer)

The wave-1 `@/agent/shadow-verify` slice CANNOT import `@/runtime`,
`@/patch`, or `@/lsp` (slice fence). The new sibling
`@/agent/shadow-verify-adapters` slice is the assembler that wires those
host capabilities into the closed port. It exports three factories +
a one-shot bag builder:

- `createScratchWorktreePort(repoRoot)` — `ShadowScratchPort` over
  `createPersistentWorktree` / `removeWorktree`. The returned `handle` IS
  the absolute worktree path; the apply / check adapters read it
  back verbatim.
- `createV4AApplyPort()` — `ShadowApplyPort` over `parsePatch` +
  `applyPatch`. A path-bounded `PatchFileSystemPort` rooted at the handle
  is sealed inside this module. NO-THROW: every grammar / anchor / apply
  error projects onto `{ ok: false, error }`.
- `createLspTestCheckPort()` — `ShadowCheckPort` dispatching `lint` /
  `typecheck` to LSP diagnostics (pyright / typescript-language-server,
  graceful skip when the binary is missing) and `test` to `runShell("bun
  test [target]", { cwd: handle })`. NO-THROW at the port boundary.
- `createShadowVerifyAdapters(repoRoot)` — returns the three-port bag in
  the shape `createShadowVerify(deps)` expects.

### New slice `@/tool/shadow-verify` (LLM-facing tool)

- `shadowVerifyTool(port)` — the `shadow_verify` LLM tool.
- Input schema:

  ```typescript
  z.object({
    patch: z.string().min(1),
    checks: z.array(z.enum(["lint", "typecheck", "test"])).min(1),
    test_target: z.string().optional(),
  })
  ```

- Output (text): the deterministic rendering
  `applied: yes|no\nok: yes|no\n<diagnostic lines>` (or `no diagnostics`
  trailer when empty). Each diagnostic line is
  `file:line[:col] [severity] message (source)`.
- HITL tier: `pre-approval-ok` (read-only against the host workspace).
- `isReadOnly: true`, `isConcurrencySafe: false` (worktree race
  avoidance).
- Slice fence: `@/tool/shadow-verify` MUST NOT `import type` from
  `@/agent` (RFC §3.1). The wave-1 producer types are mirrored INLINE as
  duck-typed `ShadowVerifyPortMirror` / `ShadowDiagnosticMirror` /
  `ShadowVerifyResultMirror`. Structural equivalence is the
  assignment-time check (the tier-1 builder constructs the producer port
  and passes it to `shadowVerifyTool`, so a drift between producer and
  mirror is a `tsc` error at the call site). Same pattern
  `@/tool/delegate` already uses for `DelegationPort` (ADR-0393).

### Tier-1 builder + `AgentConfig` slot

- `AgentConfig.shadowVerify?: ShadowVerifyPort` (new optional slot).
- `buildShadowVerifyBlock(config)` — returns `[shadowVerifyTool(port)]`
  when the slot is wired; `[]` otherwise.
- `FeaturesConfig` Pick union: `"shadowVerify"` added.
- `features.ts` call site: `extraTools.push(...buildShadowVerifyBlock(config))`
  placed AFTER `buildForkSessionBlock` and BEFORE `buildSubagentBgBlock`
  (logical grouping next to the other shadow-related blocks; different
  region from any wave-2 W-2B objective work).

## Consequences

- **Default-OFF / byte-identical:** when `AgentConfig.shadowVerify` is
  absent, the tier-1 builder returns `[]` and the registry is unchanged.
- **Slice fence:** `@/agent/shadow-verify-adapters/` is the only place
  that crosses into `@/runtime`, `@/patch`, and `@/lsp` for this slice;
  the wave-1 `@/agent/shadow-verify/` slice remains sealed.
- **NO-THROW at port boundary:** every internal failure (LSP server
  missing, patch invalid, test command failing, path escape attempt)
  collapses to an error-severity `ShadowDiagnostic` BEFORE returning. The
  wave-1 runner's outer try/catch is still in place as defence in depth.
- **Scratch ALWAYS disposed:** the `dispose()` returned by `open()`
  removes the worktree + branch. Wave-1 runner calls it in a `finally` and
  swallows any throw, so a partial cleanup never masks the result.
- **Real workspace is never written:** every side effect lives inside
  the disposable worktree. The host repo is untouched regardless of
  outcome — this is the whole point of the apply-before-show discipline.

## TDD

- `tests/unit/shadow-verify-adapters-hellgate.test.ts` — 15 cases
  (HELL-SVA-01..15) covering scratch lifecycle, V4A applier success /
  malformed / anchor-missing / path-escape / ENOENT, end-to-end real
  adapters happy + malformed + pre-aborted, LSP graceful skip, test
  runner missing.
- `tests/unit/shadow-verify-tool-hellgate.test.ts` — 12 cases
  (HELL-SVT-01..12) covering tier-1 registration (absent vs present),
  tool posture (read-only / not-concurrency-safe / HITL tier), zod
  schema (empty patch + empty checks rejection), execute happy path
  (progress + result + test_target forwarding), pre-aborted signal
  short-circuit, output rendering (applied / ok / diag line format).

## Negative invariants

- The model MUST NOT be able to drive `shadow_verify` into a host-tree
  write. Path escapes in the patch are rejected by the V4A applier's
  scratch-rooted `PatchFileSystemPort` (HELL-SVA-07/15).
- LSP / test failure MUST collapse to a diagnostic, NEVER a thrown
  exception (HELL-SVA-10/11).
- Pre-aborted signal MUST NOT create a worktree (HELL-SVA-14).
