# ADR-0421 — Fast-apply fallback wired into `apply_patch` (closes ADR-0417 §A2 apply-wire)

**Status:** Accepted (2026-05-29)
**Slices:** `src/tool/apply-patch.ts` (fallback retry branch, additive) + new `src/tool/apply-patch-fallback-wire.ts` (pure error→kind classifiers) + new `ToolContext.fastApplyFallback?` seam + duck-typed mirror in `src/tool/types.ts` + 1 hellgate (`tests/unit/apply-patch-fast-apply-wire-hellgate.test.ts`, 18 cases) + 1 feature-catalog row.
**Default-OFF (byte-identical):** port absent on `ToolContext` ⇒ the V4A failure throws immediately, NO fallback attempt — exactly the pre-ADR path (RFC §1.2).

## Context

ADR-0417 shipped `src/agent/fast-apply-fallback/` (`FastApplyFallbackPort.attempt({failure, sourceFile?, sourceContent?}, signal?)`) as a PURE PORT with no consumer, and an inert `AgentConfig.fastApplyFallback?` slot. Its §Wire deferred the A2 consumer because `apply-patch.ts` was a hot file (sibling worktrees + user in-flight on `loop.ts`/`prompt-pipeline.ts`).

This wave wires ONLY the fast-apply fallback into `apply-patch.ts`. The effort-classifier prompt-hook wire (ADR-0417 §A1) stays deferred — `loop.ts` / `prompt-pipeline.ts` are NOT touched here (the user is actively editing `loop.ts` for ADR-0418 mention work).

## Decision

The `apply_patch` tool today THROWS its canonical typed errors (`PatchParseError` / `PatchApplyError` / `PatchAnchorNotFoundError` / `FsJailViolationError`) straight to the dispatch seam. The wire wraps that throw with at-most-ONE fallback retry.

### Seam — `ToolContext.fastApplyFallback?`

A new OPTIONAL, duck-typed `FastApplyFallbackSeam` on `ToolContext` (structural mirror of `FastApplyFallbackPort`, so `@/tool` never imports `@/agent` — RFC §3.1; biome enforces). The dispatch seam (composition root in `@/agent`, a SEPARATE follow-up) wires the concrete port from `AgentConfig.fastApplyFallback`. The mirror's `errorKind` literal union (`anchor_not_found | apply_error | parse_error`) pins parity with the producer.

### Control flow (`apply-patch.ts`)

- **Port absent** ⇒ `parseAndApply(input.patch, port)` throws its typed error directly (no `try`/`catch`, byte-identical legacy path).
- **Port present** ⇒ `parseAndApply` is wrapped in a `try`. On a caught error:
  1. `classifyFastApplyError(err)` maps the V4A error class to the closed `errorKind`, or `null` for non-recoverable errors. `FsJailViolationError` + any non-patch error ⇒ `null` (a re-emitted patch cannot escape a SECURITY boundary, so no side-conversation is spent on it — the error surfaces immediately).
  2. An already-aborted `ctx.signal` short-circuits (no I/O, no dispatch) ⇒ original error.
  3. `failingTargetPath(err)` pulls `.path` off anchor/apply errors so the wire reads the failing file's current bytes through the already-constructed `PatchFileSystemPort` (best-effort: an unreadable target omits the snapshot). Parse errors have no bound target ⇒ no snapshot.
  4. `fallback.attempt({ failure: {patch, errorKind, errorMessage}, sourceFile?, sourceContent? }, ctx.signal)` — guarded by a `try`/`catch` so a port that breaks its no-throw contract cannot mask the real failure.
  5. `ok:true` + non-null `newPatch` ⇒ re-run `parseAndApply` ONCE with `newPatch`. A retry that ALSO fails surfaces the ORIGINAL error (never the retry's). `ok:false` / aborted / thrown / no-patch ⇒ original error.
- On a successful first apply OR a successful retry, the terminal `result` is `ok:true`. A rescued result appends ` (recovered via fast-apply fallback, model <modelUsed>)` to the output so the trajectory records the recovery.

### Invariants

- **NO infinite loop:** at most ONE `attempt` call and at most ONE retry per tool invocation.
- **NO-THROW seam:** a fallback that throws/rejects is swallowed; the original typed error always wins.
- **Observability preserved:** the patch slice's OTel emission (ADR-0028 `quanta.patch.op` / `quanta.patch.fuzzy_match_tier`, wired inside `applier.ts` per f659b877) is untouched — `apply-patch.ts` still passes no observer and stays free of `@/observability`.

## Consequences

- **Blast-radius minimal:** `apply-patch.ts` diff is additive (the happy path + no-port path are byte-identical); `loop.ts` / `prompt-pipeline.ts` / `src/agent/fast-apply-fallback/*` / `src/patch/*` / `src/agent/types.ts` are all untouched.
- **TDD:** the hellgate was RED (12/18 failing — the fallback-dependent cases) before the wire, GREEN (18/18) after. The 6 port-absent cases passed at RED, proving the default-OFF path was already byte-identical.
- **No heuristics:** error classification is `instanceof` on the closed patch-error classes; the retry count is a hard `1`. No fuzzy repair (per [[no-heuristics-only-validated]]).

## Wire (still deferred — follow-up ADR)

- The composition-root adapter that maps the real `RoleModelResolver` + `dispatchSideConversation` onto `RoleResolverLike` / `SideConversationLike` (ADR-0417), and the dispatch seam that threads `AgentConfig.fastApplyFallback` onto `ToolContext.fastApplyFallback`. Until that lands, the slot stays inert and the tool path is byte-identical.
- ADR-0417 §A1 effort-classifier prompt-hook (`loop.ts` / `prompt-pipeline.ts`) — explicitly out of scope this wave.
