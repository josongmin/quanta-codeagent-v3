/**
 * Fast-apply fallback types (ADR-0417, absorption gap A2).
 *
 * When `apply_patch` fails to land a V4A patch (anchor drift, malformed diff),
 * a single FOCUSED side-conversation attempt asks a fast executor model to
 * re-emit the patch given the prior failure reason (+ optional source file
 * snapshot). This is the apply-patch fallback Codex/Cursor run before giving
 * the failure back to the main loop.
 *
 * Slice discipline (RFC §1.2 + biome boundaries):
 *   - Types + `@/shared` only. The two collaborators are DUCK-TYPED here
 *     (`RoleResolverLike` / `SideConversationLike`) so this slice has NO
 *     import edge to `@/llm` (role-model-override) or `@/agent/loop` /
 *     `@/tool/apply-patch`. The composition root adapts the real
 *     `RoleModelResolver` + `dispatchSideConversation` onto these shapes when
 *     the consumer wire lands (deferred — see ADR-0417 §Wire).
 *   - NO-THROW at the port boundary: any dep failure collapses to
 *     `{ ok:false, newPatch:null, rationale }`.
 */

/** Why `apply_patch` rejected the patch. Closed 3-variant enum mirroring the
 *  apply-patch failure surface (anchor not found / generic apply error /
 *  parse error). */
export interface FastApplyFailure {
  readonly patch: string
  readonly errorKind: "anchor_not_found" | "apply_error" | "parse_error"
  readonly errorMessage: string
}

/** The outcome of ONE fallback attempt. `ok:true` ⇒ `newPatch` is a fresh
 *  V4A patch block the caller may re-attempt; `ok:false` ⇒ `newPatch` is
 *  null and `rationale` explains why (always nonempty). `modelUsed` records
 *  which model the side-conversation ran against (when an attempt was made). */
export interface FastApplyAttemptResult {
  readonly ok: boolean
  readonly newPatch: string | null
  readonly rationale: string
  readonly modelUsed?: string
}

/** Duck-typed slice of `@/llm` `RoleModelResolver` — only `resolve` is
 *  needed. Adapter at the composition root forwards to the real resolver. */
export interface RoleResolverLike {
  resolve(role: "executor" | "default", defaultModel: string): string
}

/** Duck-typed slice of the side-conversation dispatcher. The adapter at the
 *  composition root maps this onto `dispatchSideConversation(req, resolver)`
 *  with a host-chosen LLM port. */
export interface SideConversationLike {
  dispatch(req: {
    prompt: string
    model: string
    budget?: { maxTokens?: number }
  }): Promise<{ ok: boolean; text: string }>
}

/** The fast-apply fallback port. `attempt` is NO-THROW. */
export interface FastApplyFallbackPort {
  attempt(
    input: { failure: FastApplyFailure; sourceFile?: string; sourceContent?: string },
    signal?: AbortSignal,
  ): Promise<FastApplyAttemptResult>
}

export interface FastApplyFallbackDeps {
  readonly roleResolver: RoleResolverLike
  readonly sideConversation: SideConversationLike
  readonly defaultModel: string
}

/* ────────────────────────────────────────────────────────────────────────────
 * jun-7-misc 06 (ADR ≥0497) — model-based fast-apply MERGE rung.
 *
 * A SECOND, sibling port to {@link FastApplyFallbackPort}. Where the re-emit
 * port above asks a model to re-author a V4A *patch* (which must itself
 * re-anchor), the MERGE port asks a dedicated apply model to fold a terse/lazy
 * edit sketch (`// ... existing code ...` elisions, Cursor 3.5.33's apply IO
 * shape) directly into the full original file and return the MERGED full file —
 * no second round of diff anchoring.
 *
 * It is an OPTIONAL rung, inserted AFTER fuzzy and BEFORE the V4A re-emit. The
 * merge is a *proposal*, never a blind write: the consumer verifies the merged
 * bytes and routes them through the SAME gated commit/diff path as any edit,
 * fail-closing to the existing ladder on any error or verification miss.
 *
 * Slice discipline is identical to the re-emit port: types + `@/shared` only,
 * collaborators duck-typed, NO-THROW at the port boundary (every dep failure
 * collapses to `{ ok:false, merged:null, rationale }`).
 * ──────────────────────────────────────────────────────────────────────────── */

/** The outcome of ONE merge attempt. `ok:true` ⇒ `merged` is the full merged
 *  file the caller MAY accept (after its own verification + the normal edit
 *  gate); `ok:false` ⇒ `merged` is null and `rationale` explains why (always
 *  nonempty). `modelUsed` records which apply model ran (when an attempt was
 *  made). The port NEVER decides acceptance — it only proposes. */
export interface FastApplyMergeResult {
  readonly ok: boolean
  readonly merged: string | null
  readonly rationale: string
  readonly modelUsed?: string
}

/** The fast-apply MERGE port. `apply` is NO-THROW: it takes the original file
 *  + a terse edit sketch and returns the merged full file (REWRITE flavor).
 *  The apply model is OPERATOR-CONFIGURED (`QUANTA_FAST_APPLY_MODEL`) and
 *  resolved as the `"apply"` role — NEVER the main agent model (that would
 *  defeat the cost win). */
export interface FastApplyPort {
  apply(
    input: { original: string; editSketch: string; path?: string },
    signal?: AbortSignal,
  ): Promise<FastApplyMergeResult>
}

/** Duck-typed slice of `@/llm` `RoleModelResolver` for the merge rung — the
 *  apply model is resolved under the `"apply"` role (distinct from the re-emit
 *  rung's `"executor"`). The composition-root adapter forwards to the real
 *  resolver; a role MISS returns `applyModel` (the operator-set id) so the
 *  apply call NEVER silently falls back to the main model. */
export interface ApplyRoleResolverLike {
  resolve(role: "apply", applyModel: string): string
}

export interface FastApplyMergeDeps {
  readonly roleResolver: ApplyRoleResolverLike
  readonly sideConversation: SideConversationLike
  /** Operator-chosen apply-model id (`QUANTA_FAST_APPLY_MODEL`). REQUIRED — the
   *  wire only constructs the port when this is present, so there is no default
   *  here (no fall-through to the main model). */
  readonly applyModel: string
}
