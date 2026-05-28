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
