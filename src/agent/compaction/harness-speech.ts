/**
 * Harness-speech attribution for compaction (aug-23 priority 1).
 *
 * The audit in `docs/analysis/aug-23-grok-build-review.md` §10.3 proved by
 * execution that compaction presents harness-authored messages to the
 * summarizer as if the human said them: `renderForSummary` consults only
 * `m.role`, and every harness utterance in this codebase is a `role:"user"`
 * message. Driving the real injectors produced FIVE `[user]` turns of which ONE
 * was a human. Because `SUMMARY_SYSTEM` instructs the summarizer to preserve
 * "security-relevant instructions or constraints the user stated… verbatim", a
 * harness reminder can be canonized into the summary as a user constraint.
 *
 * The audit also showed that TAGGING ALONE DOES NOT FIX IT — messages already
 * carrying a `makeSyntheticUserMessage` id reached the summarizer as `[user]`
 * because nothing downstream read the marker. So the consumer changes here.
 *
 * Lives in its own module rather than inside `compaction.ts`: that file sits at
 * 986 lines against a god-module ceiling of 1000, and the repo's
 * approaching-ceiling ratchet band [900,999] is currently full (24/24). Adding
 * lines there would trip CI; this is the split the ratchet asks for.
 */

import { isSyntheticUserMessage } from "@/agent/synthetic-user"
import type { Message } from "@/llm"

/** Attribution label for one message in the summarizer transcript.
 *
 *  `harness` marks a message the AGENT RUNTIME authored (a reminder, a nudge, a
 *  recovery prompt). It rides the wire as `role:"user"` because that is the
 *  only role the message list has — the distinction is carried out-of-band on
 *  the id, which is exactly what this reads. */
export const summaryRoleOf = (message: Message): string =>
  isSyntheticUserMessage(message) ? "harness" : message.role

/** True when the message should NOT count as a turn the human took.
 *
 *  Used by the keep-window: harness reminders are interleaved by the runtime,
 *  so counting them would silently shrink how much real conversation survives
 *  a compaction. */
export const isHarnessAuthored = (message: Message | undefined): boolean =>
  isSyntheticUserMessage(message)

/**
 * §17 packet S — the ONE builder for a compaction summary message.
 *
 * All three summary sites (reactive squeeze, proactive, background) used to
 * construct this inline. The local variable was even named `synthetic`, but the
 * message carried no marker of any kind, so the harness's own output re-entered
 * the transcript indistinguishable from human speech: the NEXT compaction
 * summarized the PREVIOUS summary as the user's words, `/rewind` offered it as
 * a turn to undo, and memory recall anchored on it.
 *
 * Three inline constructions were three chances to forget the marker; one
 * builder is one place that cannot. `origin` (not an id) carries the
 * provenance, because a summary is a synthesized replacement for a whole prefix
 * and has no identity of its own to mint — and because provenance encoded in an
 * id dies the moment `assignMessageIds` is not the thing that wrote it.
 */
export const buildCompactionSummaryMessage = (header: string, summary: string): Message => ({
  role: "user",
  origin: "harness",
  content: [{ type: "text", text: `${header}\n${summary}` }],
})
