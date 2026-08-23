# ADR-0546 — Harness provenance lives on the message (`origin`), not inside its id

Status: Accepted (2026-08-24)
Slice: `src/llm/types.ts` · `src/agent/synthetic-user.ts` · `src/agent/compaction/harness-speech.ts` · `src/agent/compaction.ts`
Feature: `harness-provenance-on-message` (feature-catalog §1-agent-loop)
Related: the aug-23 Grok Build review §10.3 (harness speech reaching the summarizer as `[user]`) · ADR — `makeSyntheticUserMessage` / `SYNTHETIC_USER_MESSAGE_ID_PREFIX`

## Context

`makeSyntheticUserMessage` marked a harness-authored `role:"user"` message by encoding the kind **into the id** (`quanta:synthetic-user:<kind>:<uuid>`), and `isSyntheticUserMessage` read it back by prefix.

That works only for messages the harness both authors **and** gives an id to. The compaction summaries are neither. All three summary sites built the message inline — the local variable was literally named `synthetic` — with no id and no marker of any kind:

- `compaction.ts` reactive squeeze — `<continuation summary>`
- `compaction.ts` proactive — `<conversation summary>`
- `compaction.ts` background — `<continuation summary>`

So the harness's own output re-entered the transcript indistinguishable from human speech, and the consequence was self-inflicted and concrete: **the next compaction summarized the previous compaction's summary as if the user had written it.** `SUMMARY_SYSTEM` instructs the summarizer to preserve "security-relevant instructions or constraints the user stated… verbatim", so a synthesized summary could be canonized as a user constraint. `/rewind` offered it as a turn to undo. Memory recall anchored on it.

Encoding provenance in the id also couples it to identity in a way that fails in the other direction: a message that must stay id-less cannot carry it, and any path that assigns ids by a different rule (`assignMessageIds` stamping `m{k}`) would erase it.

## Decision

Separate the two jobs. `id` is **identity**. Provenance moves to an optional, local-only `Message.origin?: "harness"`.

- `makeSyntheticUserMessage` sets **both**, so new sessions never need the fallback.
- `isSyntheticUserMessage` reads `origin` first and falls back to the id prefix, so a session written before this change keeps working.
- The three inline summary constructions are replaced by one builder, `buildCompactionSummaryMessage`. Three inline constructions were three chances to forget the marker; one builder is one place that cannot.

The builder lives in `compaction/harness-speech.ts` rather than `compaction.ts`: that file sits just under the 1000-line god-module ceiling, and adding the builder there pushed it to 1004.

**Wire purity** is structural, not conventional: the codecs map `role` + `content` only, so `origin` is unreachable from a provider payload. Pinned by a test that asserts the built Anthropic request contains neither the key nor the value.

## Consequences

- Zero false positives is the load-bearing control. Mislabelling human speech as harness output would silently drop the user's own words from recall and from the summary's "preserve verbatim" instruction — a worse failure than the one being fixed. The paired controls assert a genuine user message carries no provenance, including one whose text merely *mentions* a summary header.
- Verified end-to-end through the real `renderMessagesForSummary`: a prior summary renders as `[harness]` while the human turn stays `[user]`. Removing `origin` from the builder puts it back to `[user]`.
- `origin` is deliberately a single literal (`"harness"`), not the full `SyntheticUserMessageKind`. The kind still lives in the id for the producers that mint one; nothing downstream branches on kind today, and a wider local field would be shipped-but-unread.
