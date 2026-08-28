/**
 * Storage-key codec for the sticky-model file (MR-08).
 *
 * `~/.quanta/sticky-model.json` is an UNTRUSTED input: any local process — and
 * the agent's OWN bash tool — can write it, and its contents are rendered raw
 * into the welcome banner, the status line, `/model`'s header and
 * `/sticky-model`'s listing. The VALUE side of that file has been vetted since
 * aug-28 (`isPlausibleModelSlug`), but the KEY side was classified by two string
 * tests only — `key.includes(":")` and `key.startsWith(`${provider}:`)` — which
 * decide SCOPE, never VALIDITY.
 *
 * MEASURED DEFECT (pre-fix). A file holding
 *   `{"anthropic:[2J]0;pwneddefault": "claude-sonnet-4-6"}`
 * passed the boot vetting untouched (the key "contains a colon" and "starts with
 * `anthropic:`", and the VALUE is a perfectly plausible slug). It then seeded the
 * session cell, and `/sticky-model` with no arguments printed it verbatim
 * (`/sticky-model: ${mode} = ${modelId}`) — clearing the operator's screen and
 * setting the terminal title from a JSON key. A bare `[31mdefault` key took
 * the legacy branch and did the same. Key LENGTH was unbounded too, so a
 * megabyte-long key rode into every display.
 *
 * THE FIX, and why it is a codec and not a regex. A storage key is not
 * "free-form text that looks safe"; it is a pair drawn from two CLOSED unions —
 * {@link AGENT_PROMPT_MODES} (the prompt-mode SSOT) and {@link LLM_PROVIDERS}
 * (the provider SSOT). Validating against the SSOT arrays rather than a
 * hand-written character class means a mode or vendor added upstream is accepted
 * here the day it lands, instead of silently becoming "invalid" and dropping a
 * real user preference on the floor. A regex would have to be edited in lock-step
 * with two unions in two other slices, and nothing would fail when it was not.
 *
 * The VALUE side is deliberately NOT re-implemented here: `isPlausibleModelSlug`
 * (`@/llm/model-catalog`) remains the one check for model ids. This module
 * answers exactly one question — "is this string a key this store could have
 * written, and if so, which one?".
 *
 * LEAF MODULE. Imports only the two SSOTs (`@/shared`'s mode array and
 * `@/llm/provider-types`, which itself imports nothing). NOTHING from `@/apps` —
 * a shared model-routing authority is being built in another lane and will
 * consume this codec, so it must stay importable from anywhere below the
 * surfaces.
 */

import { LLM_PROVIDERS, type LlmProvider } from "@/llm/provider-types"
import type { LLMProvider } from "@/shared/errors"
import { AGENT_PROMPT_MODES } from "@/shared/turn-policy-types"
import type { AgentMode } from "../prompt"

/**
 * Hard cap on a storage key's length, checked BEFORE any union comparison.
 *
 * The union checks already bound a VALID key (`chatgpt-oauth:architect` is 23
 * chars, the longest constructible today), so this cap only ever fires on
 * garbage. It exists so that garbage is rejected in O(1) on the length field
 * rather than after normalizing / comparing a megabyte-long attacker-chosen
 * string against two arrays, and so the rejection LOG has a bounded thing to say
 * about it. 64 leaves ~3x headroom for a future long vendor name.
 */
export const STICKY_MODEL_KEY_MAX_LENGTH = 64

/**
 * What a raw storage key turned out to be.
 *
 * `scoped` is the canonical shape {@link stickyModelKeyOf} writes today
 * (`<provider>:<mode>`); `legacy` is the bare mode every pick written before the
 * provider joined the key looks like on disk (still accepted on READ, and in
 * scope for whatever provider reads it); `invalid` carries an operator-facing
 * reason that NEVER contains the offending key — the caller logs a length and a
 * digest instead (see `summarizeUntrustedId`).
 */
export type StickyModelStorageKey =
  | { readonly kind: "scoped"; readonly provider: LlmProvider; readonly mode: AgentMode }
  | { readonly kind: "legacy"; readonly mode: AgentMode }
  | { readonly kind: "invalid"; readonly reason: string }

/** Membership test against the prompt-mode SSOT. Not a regex, by design — see
 *  the file header. */
const isAgentMode = (s: string): s is AgentMode =>
  (AGENT_PROMPT_MODES as readonly string[]).includes(s)

/** Membership test against the provider SSOT. `LLM_PROVIDERS` is the array whose
 *  lock-step with the `LlmProvider` union is already compile-time enforced in
 *  `@/llm/provider-types`, so this codec inherits that guard rather than keeping
 *  a third copy of the vendor list. */
const isProvider = (s: string): s is LlmProvider => (LLM_PROVIDERS as readonly string[]).includes(s)

/**
 * Parse one raw key from the on-disk map.
 *
 * PURE + NO-THROW: every input, hostile or not, lands in one of the three
 * variants. The split is on the FIRST colon because that is exactly how
 * {@link stickyModelKeyOf} composes the key, and neither union member contains a
 * colon — so `a:b:c` is a provider `a` with a mode `b:c`, both of which fail
 * their union check, which is the correct verdict.
 */
export const parseStickyModelStorageKey = (raw: string): StickyModelStorageKey => {
  if (raw.length === 0) return { kind: "invalid", reason: "empty key" }
  if (raw.length > STICKY_MODEL_KEY_MAX_LENGTH) {
    return { kind: "invalid", reason: `key exceeds ${STICKY_MODEL_KEY_MAX_LENGTH} chars` }
  }
  const sep = raw.indexOf(":")
  if (sep === -1) {
    return isAgentMode(raw)
      ? { kind: "legacy", mode: raw }
      : { kind: "invalid", reason: "bare key is not a known agent mode" }
  }
  const provider = raw.slice(0, sep)
  const mode = raw.slice(sep + 1)
  if (!isProvider(provider)) return { kind: "invalid", reason: "unknown provider segment" }
  if (!isAgentMode(mode)) return { kind: "invalid", reason: "unknown mode segment" }
  return { kind: "scoped", provider, mode }
}

/**
 * Is `key` in scope for a session running under `provider`?
 *
 * The scope rule this codec preserves, spelled once so the boot vetting and the
 * routing authority being built in the neighbouring lane cannot answer it
 * differently:
 *   - a SCOPED key applies only to its OWN provider (a pick made under anthropic
 *     must not seed an openai session — `tryCreateLLM` validates the CREDENTIAL,
 *     never the slug, so a cross-provider pick produces a real-looking port that
 *     fails at the wire on every turn);
 *   - a LEGACY bare key applies to ANY provider (it predates the provider
 *     segment; dropping it would orphan every pick written before aug-28);
 *   - an INVALID key applies to nothing.
 *
 * A session with NO provider (`undefined`) can only honour legacy keys — it has
 * nothing to compare a scoped key's provider against.
 */
export const isStickyModelKeyInScope = (
  key: StickyModelStorageKey,
  provider: string | undefined,
): boolean => {
  if (key.kind === "invalid") return false
  if (key.kind === "legacy") return true
  return provider !== undefined && key.provider === provider
}

// ─── Compile-time drift guard ───────────────────────────────────────────────
// The provider that actually gets WRITTEN into a sticky key is the session's
// `Provider` (`@/llm/factory` → `LLMProvider` in `@/shared/errors`, the 3
// call-tested vendors). This codec validates against the WIDER `LlmProvider`
// SSOT because that union is the one with a runtime array + its own
// exhaustiveness assertion. The Assert below proves the containment those two
// facts rest on: every vendor a session can be running under is a member of the
// union this codec accepts. Add a vendor to `LLMProvider` without adding it to
// `LlmProvider`/`LLM_PROVIDERS` and this file fails to build — instead of that
// vendor's persisted picks silently becoming "invalid keys" and being dropped at
// boot with a warn nobody reads.
type _Assert<T extends true> = T
type _SessionProvidersAreParseable = _Assert<LLMProvider extends LlmProvider ? true : false>
/** Referenced so `noUnusedLocals` keeps the guard above live. */
export type _StickyModelKeyProviderDriftGuard = _SessionProvidersAreParseable
