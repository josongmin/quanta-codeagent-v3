/**
 * ADR-0325 — Persistent-injection message builder for explicit mentions.
 *
 * Sibling shape to ADR-0321's `buildPersistentInjectionMessages` (in
 * `src/agent/context-change/inject.ts`). Each fragment produces ONE
 * user-role {@link Message} wrapped in a purpose-specific tag:
 *
 *   skill  ⇒  `<mention kind="skill" target="X">…</mention>`
 *   plugin ⇒  `<mention kind="plugin" target="X">…</mention>`
 *   app    ⇒  `<mention kind="app" target="X">…</mention>`
 *
 * The `kind` and `target` attributes are part of the wrapper LINE and
 * are NOT user-controllable post-validation: `kind` is a closed enum
 * and `target` is constrained to ASCII kebab-case by the parser. So a
 * forged attribute value cannot inject markup.
 *
 * Security:
 *   - Body funnels through {@link embedUntrusted} so a body containing
 *     `</mention>` cannot terminate the wrapper.
 *   - Wrapper tag is `mention` (NOT `skill-activation` — that lives in
 *     ADR-0321's diff inject channel). Both channels coexist by tag
 *     namespace.
 *
 * Pure: no clock read, no I/O. Order-preserving. NO-THROW.
 */

import type { Message } from "@/llm"
import { makeSyntheticUserMessage } from "../synthetic-user"
import { embedUntrusted } from "../untrusted"
import type { InjectionFragment } from "./types"

/** Build the body INSIDE the `<mention>` envelope. Layout matches the
 *  ADR-0321 inject envelope (key: value per line) so the model reads
 *  the two channels with the same parser. */
const buildBody = (fragment: InjectionFragment): string => {
  return [
    `kind: ${fragment.kind}`,
    `target: ${fragment.target}`,
    `span: ${fragment.originSpan.start}-${fragment.originSpan.end}`,
    "---",
    fragment.bodyText,
  ].join("\n")
}

/** Build one user-role `Message` from a single fragment. */
const buildOne = (fragment: InjectionFragment): Message => {
  const body = buildBody(fragment)
  return makeSyntheticUserMessage("mention-injection", [
    { type: "text", text: embedUntrusted("mention", body) },
  ])
}

/**
 * Build a persistent-injection message list from a list of
 * {@link InjectionFragment}s. Pure / NO-THROW / order-preserving.
 *
 * Caller is responsible for splicing the result into the per-turn
 * `messages[]` between `baseMessages` and the trailing
 * `<system-reminder>` (same insertion point as ADR-0321). The wire-up
 * itself is a follow-up ADR (this slice stays default-OFF).
 *
 * Empty `fragments` ⇒ `[]` (NOT a single empty message).
 */
export const buildMentionInjectionMessages = (
  fragments: readonly InjectionFragment[],
): Message[] => {
  if (fragments.length === 0) return []
  return fragments.map(buildOne)
}
