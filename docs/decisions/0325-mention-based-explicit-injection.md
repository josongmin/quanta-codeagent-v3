# ADR-0325 — Mention-based explicit context injection

- Status: **Superseded by ADR-0418** (the 3-kind enum + sync resolver port
  are replaced by a 5-kind enum `skill|plugin|app|file|symbol` + an async
  resolver port; the legacy 3-kind subset stays behaviourally identical).
- Status (historical): Accepted (slice landed, default-OFF; wire-up deferred)
- Date: 2026-05-27
- Related: ADR-0320 (typed history event store — consumed via
  `@/memory/typed-event`), ADR-0321 (snapshot-diff producer — sibling
  channel that ALSO splices into per-turn messages, but for state
  transitions rather than user mentions), ADR-0080 (ContextProvider
  trust-ladder), ADR-0314 (mention-filter trust-scope — independent;
  this slice produces, that slice filters).
- Codex absorption: `codex-rs/core/src/session/turn.rs:436-575`
  (`build_skills_and_plugins`).

## Context

Codex's per-turn pipeline includes a procedure that parses explicit
mentions out of the user message — `@skill`, `plugin://`, and app
mentions — resolves each against its registry (skill bundle, plugin
manifest, app catalog), and emits the resolved bodies into the
conversation history as typed `ResponseItem`s. The model then sees a
persistent, replayable record of the activations the user verbatim
asked for. This is ORTHOGONAL to Codex's `record_context_updates_...`
which detects passive state diffs (cwd / mode / model swap).

`quanta` already has the sibling diff channel: ADR-0321 emits typed
events from snapshot deltas, and ADR-0320 provides the typed-history
store. What is MISSING is the user-mention producer — the explicit
half. Today, a user typing `@code-review`, `plugin://github`, or
`@@chrome` is just inert text; the harness does not resolve the
mention, does not inject the resolved body, and does not record the
activation.

The two channels are deliberately distinct:

- **Automatic (ADR-0321)**: passive state diffs. One event when state
  changes, otherwise silent. Tail-positioned `<system-reminder>` stays
  ephemeral; the diff envelopes are persistent.
- **Explicit (this ADR)**: user-typed mentions. One event per resolved
  mention per turn. Spliced as `<mention>` envelopes between
  `baseMessages` and the trailing reminder (same insertion point as
  ADR-0321).

Both channels coexist; this ADR does NOT replace the ephemeral
reminder tail and does NOT replace the diff channel.

## Decision

Land a `src/agent/mention-injection/` slice with four layers:

### Layer 1 — `parser.ts` (pure)

`parseMentions(userInputText: string): readonly ParsedMention[]`

Mention syntax (FROZEN by this ADR):

- `@skill-name` — `MentionKind = "skill"`
- `plugin://name` — `MentionKind = "plugin"`
- `@@app-name` — `MentionKind = "app"` (double-`@` to disambiguate
  from skill mentions; matches Codex's app-mention convention)

Syntax rules (LOCKED):

1. **Identifier alphabet**: `[a-z][a-z0-9-]*` (ASCII kebab-case;
   lowercase-letter-leading). Unicode names are rejected — see
   Limitations.
2. **Identifier length**: 1-64 chars post-sigil. Longer matches are
   dropped (the parser is a frontend for explicit activation, not free
   text; 64 is generous).
3. **Left-boundary**: the sigil MUST sit at start-of-input OR after a
   non-`\w` byte (JS word-class). This rejects email false positives
   (`foo@bar.com` ⇒ `@` follows `o`, a word char ⇒ NOT a mention).
4. **Right-boundary**: trailing char after the identifier MUST NOT be
   `[a-z0-9-]` (otherwise we'd be reading a prefix of a longer ident).
   End-of-input counts as a boundary.
5. **Dedup**: per `(kind, target)` pair, KEEP THE FIRST occurrence.
6. **Code fences / inline backticks**: NOT treated specially —
   ` ```@skill``` ` IS parsed. Limitation, not a TODO.
7. **Empty target after sigil**: NOT a mention.

NO-THROW: any input (including non-string casts) ⇒ `[]`.

### Layer 2 — `resolver.ts` (closed port + DI consumer)

Closed `MentionResolverPort`:

```typescript
interface MentionResolverPort {
  resolveSkill(target: string): { bodyText: string } | null
  resolvePlugin(target: string): { bodyText: string } | null
  resolveApp(target: string): { bodyText: string } | null
}
```

- Each method returns the rendered body for the mention OR `null` for
  unknown / unresolvable (skip — NO placeholder injected).
- Kind dispatch is HARD: a `skill` mention is NEVER routed to
  `resolvePlugin` even if `resolveSkill` returns null. Preserves user
  intent.
- Adapter authors MUST swallow internal errors and return `null`. The
  port consumer wraps every call in `try/catch` as defense in depth so
  a hostile adapter cannot crash the pipeline.

`buildInjectionFragments(mentions, resolver): readonly InjectionFragment[]`
— pure, order-preserving, NO-THROW.

This ADR does NOT ship a resolver adapter. Adapters
(skill-registry-backed / plugin-manifest-backed / app-catalog-backed)
live in follow-up ADRs.

### Layer 3 — `event-emitter.ts` (ADR-0320 store consumer)

`emitMentionEvents(fragments, store, at, turnId)` writes events into
the ADR-0320 `TypedHistoryEventStore`.

**Variant-coverage decision** (HONEST, documented limitation):

- `skill` fragment ⇒ emit `skill_activation` event with
  `trigger = "user"`. Matches Codex semantics exactly.
- `plugin` fragment ⇒ NO typed event in this ADR. Plugin activation
  does not map to any of the five frozen variants
  (`context_update`/`skill_activation`/`repo_rules_change`/
  `mode_change`/`reasoning_echo`). A new `plugin_activation` variant
  is the proper fix; deferred to a follow-up ADR (variant extension
  is closed-port behaviour requiring its own ADR).
- `app` fragment ⇒ NO typed event in this ADR. Same reason as plugin.

The inject-message channel (Layer 4) handles all three kinds
unchanged — only the typed-history side-channel is variant-limited.

Pure-ish: side-effecting (calls `store.append`) but no clock read,
no I/O of its own. `at` and `turnId` are caller-supplied.

NO-THROW: a partial / hostile store (missing `append`, throwing
`append`) is swallowed. Dropping a typed event is preferable to
aborting a user-visible turn.

### Layer 4 — `inject-messages.ts` (ADR-0321-style inject builder)

`buildMentionInjectionMessages(fragments): Message[]` — pure,
order-preserving, NO-THROW. One `Message` per fragment:

```
<mention>
kind: skill
target: code-review
span: 10-22
---
…bodyText…
</mention>
```

- Wrapper tag is `mention` (NEW namespace — distinct from ADR-0321's
  five per-variant tags).
- `role: "user"` fixed.
- Body funnels through `embedUntrusted` so a body containing a forged
  `</mention>` is defanged and cannot terminate the wrapper.
- Layout (`key: value` lines + `---` separator + body) matches the
  ADR-0321 envelope shape so the model reads both channels with the
  same parser.

## Non-goals

- **Replacing automatic injection**: the ephemeral `<system-reminder>`
  tail and ADR-0321 diff channels stay. This is a new producer.
- **Resolver implementations**: closed port only. Adapters live in
  follow-up ADRs.
- **Slash-command integration**: `/skill code-review` UX is a separate
  concern (slash-command surface, not mention parsing).
- **Variant extension for plugin / app**: the variant-coverage gap is
  EXPLICITLY documented (see Layer 3). A future ADR may add
  `plugin_activation` / `app_activation` to the frozen 5-variant union.
- **Wiring into the agent loop**: the slice is default-OFF; the
  splice point in `src/agent/prompt.ts` is read-only verified
  (between `baseMessages` and the trailing reminder, same as
  ADR-0321), but the actual wire-up is a follow-up ADR.

## Limitations (declared, not TODOs)

1. **ASCII-only identifiers**. A Unicode skill name like `@レビュー`
   is not parsed. Matches Codex (which uses ASCII identifiers in
   skill / plugin / app registries).
2. **Code fences are not skipped**. A mention inside `` ``` `` will
   still parse. Downstream may strip code fences before calling if
   desired.
3. **Plugin / app mentions produce no typed event**. The inject
   message channel still receives them, so the model still sees the
   activation — only the replayable typed-history record is missing
   for those two kinds. Follow-up ADR can extend the variant union.

## Wiring (deferred)

The prompt-build seam is `src/agent/prompt.ts` (read-only verified by
this ADR — not mutated):

- `buildTurnContext` (the per-turn `messages[]` assembler).
- `<system-reminder>` tail is appended last.

The mention-injection messages should be spliced AFTER
`baseMessages` and BEFORE the trailing reminder, sharing the slot
ADR-0321 already designed. A new optional field on `TurnContextInput`
(e.g. `mentionInjectionMessages?: readonly Message[]`) threads the
list from the host; absent / empty ⇒ no splice ⇒ byte-identical to
today.

## Consequences

- **Pro**: explicit user activations are persistent in the
  conversation, replayable across compactions, and visible as typed
  history events for downstream consumers (debug UI, observability,
  cross-session memory).
- **Pro**: parallel structure with ADR-0321 — same insertion point,
  same envelope layout, two producers, one consumer surface.
- **Pro**: default-OFF and resolver-less, so this slice cannot
  destabilize the existing prompt assembly until wire-up.
- **Con**: variant-coverage gap for plugin / app at the typed-history
  layer. Mitigated by the inject-message channel which handles all
  three kinds. Follow-up ADR extends the variant union.
- **Con**: ASCII-only identifiers reject hypothetical localized
  registries. Matches upstream Codex; acceptable.

## Test coverage

- `__tests__/parser.hellgate.test.ts` — 17 cases (A-F groups).
- `__tests__/resolver.hellgate.test.ts` — 8 cases (A-F groups).
- `__tests__/event-emitter.hellgate.test.ts` — 5 cases (A-E groups).
- `__tests__/inject-messages.hellgate.test.ts` — 7 cases (A-E groups).
- Total: 37 tests / 100 expects / 0 fail at landing.
- tsc: 0 errors against this slice.
- biome: 0 errors / 0 warnings against this slice.
