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
  role: "user",
  content: [...content],
})

export const isSyntheticUserMessage = (message: Message | undefined): boolean =>
  typeof message?.id === "string" && message.id.startsWith(SYNTHETIC_USER_MESSAGE_ID_PREFIX)
