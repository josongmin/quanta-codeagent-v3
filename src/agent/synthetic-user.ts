import type { Message } from "@/llm"

export type SyntheticUserMessageKind =
  | "same-turn-recovery"
  | "hook-context"
  | "context-change"
  | "mention-injection"
  | "focus-chain"
  /* aug-23 §10.3 — the audit found ~8 harness injectors appending untagged
     `role:"user"` messages, which compaction then summarized as human speech.
     Kinds stay lowercase-hyphen: bench resume canonicalization matches
     `[a-z-]+` on the kind segment. */
  | "turn-budget"
  | "tool-nudge"
  | "resume"
  | "peer-mail"
  | "conversation-summary"
  | "identity-reminder"

export const SYNTHETIC_USER_MESSAGE_ID_PREFIX = "quanta:synthetic-user:"

export const makeSyntheticUserMessage = (
  kind: SyntheticUserMessageKind,
  content: ReadonlyArray<Message["content"][number]>,
): Message => ({
  id: `${SYNTHETIC_USER_MESSAGE_ID_PREFIX}${kind}:${crypto.randomUUID()}`,
  // §17 packet S — provenance on the MESSAGE, not only in the id. The id keeps
  // its kind segment (bench-resume canonicalization matches on it, and legacy
  // sessions are read back through it), but `origin` is what makes provenance
  // survive on a message that has no id.
  origin: "harness",
  role: "user",
  content: [...content],
})

/** Harness-authored message?
 *
 *  `origin` FIRST: it is the authority, and it works for messages that are
 *  id-less (a compaction summary) or that were given a plain `m{k}` id on save.
 *  The id prefix is the LEGACY fallback — a session written before `origin`
 *  existed carries no other mark, and must keep working. */
export const isSyntheticUserMessage = (message: Message | undefined): boolean => {
  if (message === undefined) return false
  if (message.origin === "harness") return true
  return typeof message.id === "string" && message.id.startsWith(SYNTHETIC_USER_MESSAGE_ID_PREFIX)
}
