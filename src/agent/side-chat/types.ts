/**
 * Side-chat shapes (ADR-0244).
 *
 * `SideChatId` is a string newtype (UUID v4 minted by the manager) — kept as
 * a plain string for ergonomic Map keys / JSON serialisation.
 *
 * `SideChatMessage` is the message shape recorded inside a side chat's own
 * isolated list. It deliberately does NOT alias `@/llm.Message`: this slice
 * owns its own simple `{ role, text }` shape so the parent's `messages[]`
 * (which IS `@/llm.Message`) cannot accidentally cross-pollute via shared
 * references.
 *
 * `SideChatState` is a closed 2-arm union — `assertNever` (HELL-SC-14)
 * seals the exhaustive switch surface.
 *
 * `SideChatError` is a closed 6-arm union; adding a code forces every
 * consumer's switch to fail compile until updated.
 *
 * Plane-clean: imports nothing — pure shapes.
 */

/** New-type alias for the manager-minted UUID v4. */
export type SideChatId = string

/** Recorded message inside a side chat's isolated list. NOT `@/llm.Message`
 *  on purpose — see the file header. */
export interface SideChatMessage {
  readonly role: "user" | "assistant"
  readonly text: string
  /** Epoch-ms timestamp at record time (from the injected clock). */
  readonly recordedAt: number
}

/** Closed 2-arm lifecycle state. */
export type SideChatState = "active" | "stopped"

/** Canonical literal tuple — feeds runtime guards and tests so the union
 *  does not silently drift from the type. */
export const ALL_SIDE_CHAT_STATES = [
  "active",
  "stopped",
] as const satisfies readonly SideChatState[]

/** Closed 6-arm error union. Adding a code requires updating every
 *  consumer's switch (compile error on the missing arm). */
export type SideChatError =
  | { readonly code: "unknown-id"; readonly message: string }
  | { readonly code: "not-active"; readonly message: string }
  | { readonly code: "aborted"; readonly message: string }
  | { readonly code: "invalid-prompt"; readonly message: string }
  | { readonly code: "invalid-parent"; readonly message: string }
  | { readonly code: "capacity-exceeded"; readonly message: string }

/** Canonical literal tuple — feeds runtime guards and tests so the union
 *  does not silently drift from the type. */
export const ALL_SIDE_CHAT_ERROR_CODES = [
  "unknown-id",
  "not-active",
  "aborted",
  "invalid-prompt",
  "invalid-parent",
  "capacity-exceeded",
] as const satisfies readonly SideChatError["code"][]
// Two-way drift guards (satisfies = array⊆union; Assert = union⊆array). A new
// SideChatState/SideChatError arm missing from its tuple is a build error.
type _AssertSide<T extends true> = T
export type _SideChatStateDriftGuard = _AssertSide<
  SideChatState extends (typeof ALL_SIDE_CHAT_STATES)[number] ? true : false
>
export type _SideChatErrorDriftGuard = _AssertSide<
  SideChatError["code"] extends (typeof ALL_SIDE_CHAT_ERROR_CODES)[number] ? true : false
>
