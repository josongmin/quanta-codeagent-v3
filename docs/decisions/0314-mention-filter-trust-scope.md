# ADR-0314 — Mention filter & trust-scope gating

- **Status**: accepted (2026-05-26)
- **Related**: [[0311-github-actions-trigger-adapter]] (where this filter is wired), [[0313-pr-output-sink-redaction]] (shares the idempotency marker SoT), [[no-heuristics-only-validated]]
- **References**:
  - Cursor BugBot mention vocabulary (`@cursor review`)
  - Codex action default phrase set
  - GitHub `author_association` documented enum (`COLLABORATOR`/`MEMBER`/`OWNER`/...)

## Problem

A trigger that fires on ANY comment containing `@quanta` opens four attack surfaces:

1. Strangers (`author_association = NONE`) wake the agent on a public PR.
2. Bots (dependabot, github-actions itself) wake the agent on routine notifications.
3. Our own posted comments wake us up via the same poll loop (self-loop).
4. Documentation / chat snippets that *show* the mention as code wake the agent (`> example: @quanta review` should not actually trigger).

Each one is a heuristic-only filter waiting to be wrong. We need the answer to be structural.

## Decision

`matchMention(body, phrases)` (pure) + `createMentionFilter(opts)` (sender-aware) with:

- **Word-boundary anchored search** — phrase must be preceded by start-of-line/whitespace AND followed by whitespace/EOL/common punctuation. `foo@quantaxx` does not match; `@quanta, please` does.
- **Code-block exclusion** — fenced ``` / ~~~ block content is skipped (toggles on every fence line); inline `` ` ``-spans on the same line are blanked out with whitespace BEFORE phrase search.
- **Blockquote exclusion** — any line starting with `>` (after trim) is skipped.
- **Self-loop guard** — body containing `<!-- quanta:idempotency=` is unconditionally a non-match (matches what [[0313-pr-output-sink-redaction]] stamps on every outgoing comment).
- **Trust-scope rank** — closed `TrustScope = "public" | "collaborator" | "member" | "owner"`. Default required scope is `"collaborator"`. Sender's scope is resolved from `author_association` (`COLLABORATOR`/`MEMBER`/`OWNER` ⇒ `"collaborator"`+) OR repo-owner identity. Anything below the required rank ⇒ no match.
- **Bot gate** — `sender.type === "Bot"` is rejected unconditionally unless `allowBots: true` is explicitly passed (in which case the trust-scope gate still applies).

Files:
- [[../../src/integrations/github/mention-filter.ts]] — `matchMention` + `createMentionFilter`
- 17 hellgate cases in [[../../tests/unit/integrations/github/mention-filter-trust-scope-hellgate.test.ts]] lock the four-surface model:
  - fenced block (3 cases incl. lang tag)
  - inline span (1)
  - blockquote (2)
  - non-collaborator (2)
  - bot (2)
  - self-loop marker (1)
  - ZWJ / RTL override (2)
  - word-boundary edge (3)
  - phrase-in-code-block × N (1)

## Consequences

- 4-vendor convergence (Codex / Cursor / Claude Code / quanta) on a structural rule set, NOT a regex blacklist — each rule is "exclude this whole class" not "if this string then no".
- The filter is reusable for any future surface that needs to gate on a free-text body (Slack, Discord, MS Teams). The dependency is body-string + `NormalizedSender` only.
- The marker the sink stamps is the marker the filter excludes — single SoT (`<!-- quanta:idempotency=`). Changing it breaks both sides loud (a renamed marker fails 9+17 hellgate tests immediately).

## Negative invariants

- DO NOT add a "smart" mode that picks up implied mentions (e.g. "quanta please" without `@`). [[no-heuristics-only-validated]] applies: a comment without explicit prefix is not a mention.
- DO NOT relax the code-block exclusion to "only triple backtick" — inline single-backtick spans must also be excluded.
- DO NOT default `allowBots: true`. Even useful bots (dependabot review) require an explicit opt-in at the composition root.
- DO NOT compare `author_association` to anything except the closed enum — string-equality on values not in the documented GH enum is silent acceptance.
