# ADR-0282: Cross-session memory inject (selectForInject → prompt section)

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0068 (2-phase consolidator), ADR-0207 (stage1-store),
  ADR-0281 (auto-trigger — the sibling slice that promotes the rows
  this slice reads), ADR-0166 (conversation seed replay — the
  per-session analogue this slice extends to cross-session).

## Context

ADR-0281 promotes high-signal Stage 1 entries by setting
`selectedForPhase2 = true`. But until *the next session start* reads
those entries and injects them into the system prompt, the promotion
has no observable effect on the next LLM call. Cursor's `Memories`
panel and Codex's session-start memory load both perform this inject;
quanta has the storage but not the read path.

Two concerns must be reconciled:

1. **Byte budget.** The Anthropic prompt-cache breakpoint is precious;
   we cannot dump every promoted Stage 1 entry into the prompt. A
   hard `maxBytes` cap with deterministic truncation (oldest-first
   drop) is required.
2. **Slice boundary.** `src/memory/cross-session/` cannot import
   `@/llm` (per biome override) so the prompt section is returned as
   a structurally compatible block (`{type:"text", text, cache?}`)
   and the composition root translates it to `SystemBlock` at the
   plug site.

Negative invariants we are NOT violating:

- **Byte-identical default-OFF.** Until the composition root reads
  `QUANTA_MEMORY_AUTO=on` AND there is at least one promoted Stage 1
  entry, no `selectForInject` call runs and the system prompt is
  byte-identical.
- **`exactOptionalPropertyTypes: true`.** `InjectOpts.kindFilter`
  is OMIT-semantics; the produced block uses OMIT for `cache?`.
- **Closed-port DIP.** `CrossSessionInjector` is the closed port.
  `DefaultCrossSessionInjector` is the only adapter; alternative
  selection strategies (LLM-scored, recency-weighted) ship as new
  adapters against the same port.
- **Slice boundary.** Lives at `src/memory/cross-session/`. Reads
  from `src/memory/stage1-store/` (existing port) only. NEVER
  imports `@/llm` (structural `MemorySystemBlock` shape instead).
- **Deterministic truncation.** Oldest-first drop (by ascending
  `generatedAt`) when `bytes > maxBytes`. No partial-string slicing
  mid-entry — an entry is either fully in or fully out.

## Decision

Stand up a new sibling slice `src/memory/cross-session/` (5 files)
exposing the closed `CrossSessionInjector` port + default impl +
prompt-section renderer.

```
src/memory/cross-session/
  port.ts             — CrossSessionInjector { selectForInject }
  types.ts            — InjectOpts { maxBytes, kindFilter? },
                        MemorySystemBlock { type:"text", text, cache? }
  default-injector.ts — DefaultCrossSessionInjector (reads stage1Store)
  prompt-section.ts   — renderMemorySection(memories): MemorySystemBlock
  index.ts            — barrel
```

Public surface (`CrossSessionInjector`):

```ts
interface CrossSessionInjector {
  /** Read the stage1 store, filter to selected-for-phase2 +
   *  minUsage, cap by maxBytes (oldest-first drop), return the
   *  resulting frozen entry list. Pure read — no side effects. */
  selectForInject(opts: InjectOpts): readonly Stage1Entry[]
}
```

Public shapes:

```ts
interface InjectOpts {
  /** Hard byte cap on the SUM of `rolloutSummary` lengths returned. */
  readonly maxBytes: number
  /** Optional kind filter — when present, only return entries whose
   *  rolloutSummary begins with one of the listed kinds (e.g.
   *  ["fact","decision"] matches lines starting with those tokens).
   *  Absent ⇒ no kind filter. OMIT semantics. */
  readonly kindFilter?: readonly string[]
}

interface MemorySystemBlock {
  readonly type: "text"
  readonly text: string
  readonly cache?: boolean
}
```

Renderer (`renderMemorySection`):

- Input: the entries returned by `selectForInject` (already capped).
- Output: a `MemorySystemBlock` with the section header
  `## Cross-session memory (auto)` followed by a numbered list of
  `rolloutSummary` strings.
- Empty input ⇒ block with empty `text: ""` (caller filters before
  injecting — the renderer never errors). `cache: true` (stable
  within a session ⇒ cache-friendly).

Semantics (selection):

1. `list({selectedForPhase2: true, minUsage: 1})` (constants — the
   trigger already gated by `minUsageCount`; injector enforces
   `usageCount >= 1` as a defense-in-depth).
2. Drop any entry whose `rolloutSummary` is empty / whitespace-only.
3. Apply `kindFilter` if present (string `startsWith` match against
   the first whitespace-delimited token of `rolloutSummary`).
4. Greedily accumulate by ascending `generatedAt` (oldest-first
   sort) BUT keep only entries whose cumulative bytes ≤ `maxBytes`.
   When the next candidate would overflow, STOP (we do not skip
   over it to try a smaller subsequent entry — deterministic).
5. Return the (frozen) accumulated array.

Boundary cases:

- `maxBytes <= 0` ⇒ return `[]` (empty).
- `maxBytes` exactly equal to a candidate's byte length ⇒ accept it.
- `kindFilter = []` (empty array) ⇒ matches NOTHING (explicit empty
  is a hard filter, NOT "no filter"). Use absent for "no filter".
- All entries filtered out ⇒ return `[]`, renderer emits empty text.

Default-OFF wiring posture:

- No barrel re-export from `@/memory` in this ADR.
- Composition root wires when `QUANTA_MEMORY_AUTO=on`:
  - on session start, call `injector.selectForInject({maxBytes:
    DEFAULT_INJECT_MAX_BYTES})`,
  - call `renderMemorySection(entries)`,
  - prepend the resulting block to the system prompt as a
    cache-friendly SystemBlock (translation: same shape).
- `DEFAULT_INJECT_MAX_BYTES = 8_192` (8 KiB — well under
  `MEMORY_SUMMARY_MAX_BYTES = 4096` cap of the existing
  memory_summary.md aggregate, leaving headroom).

## Hellgate

Shares `tests/unit/memory/auto-trigger-hellgate.test.ts` with ADR-0281.
Cases HELL-MAT-15 through HELL-MAT-18 + HELL-MAT-19, HELL-MAT-22 lock
this slice; see ADR-0281 for the full 22-case table.

## Consequences

- **+ Cross-session knowledge inject** becomes automatic — the
  next session starts with promoted entries already in the prompt.
- **+ Deterministic truncation** (oldest-first drop) keeps the
  prompt cache stable across calls (entries do not shuffle).
- **+ Closed-port selection** — replace lexical kind filter with a
  semantic ranker by writing a new adapter.
- **−** The prompt grows by up to `DEFAULT_INJECT_MAX_BYTES` per
  session start. Acceptable: the cap is hard, the inject is
  cache-friendly, and the operator can disable with one env knob.
- **−** Untrusted-aggregate wrapper around the inject is NOT yet
  applied here — Phase 2's `memory_summary.md` already has it; the
  cross-session inject runs ALONGSIDE that, not inside it. A
  follow-up ADR adds the wrapper if the inject ever carries
  user-generated content beyond the LLM-distilled summary.

## Follow-up

- LLM-judge ranker (sort by `usageCount * importance` rather than
  oldest-first) — separate adapter on the same port.
- Untrusted-aggregate wrapper if/when entries can carry user-written
  fragments (today they are LLM-distilled only).
- Per-kind quota (`maxBytes` per `kindFilter` value) for balanced
  recall when many entries of one kind dominate.
