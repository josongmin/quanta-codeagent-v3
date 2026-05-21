# ADR-0067 — Prompt template SOTA++ (vs Codex / Claude Code parity gaps)

## Status
Accepted (2026-05-21)

## Context
After ADR-0062 (tool-failure ladder) the base prompt covers tool-recovery
and exploration discipline. Side-by-side audit against Codex `browser/
SKILL.md` (L26, L208, L213-214, L217, L471) and Claude Code 1.7196.3
`systemPromptSectionCache` patterns surfaces four remaining gaps where
SOTA agents do something explicit that quanta only does generically — and
the generic version is observably weaker (the live REPL replay leaked
internal terms, asked for clarification before trying, and made
unverified "fixed" claims).

The gaps:

1. **Internal-vocabulary leakage.** Codex L26 / L217 enumerate verbatim
   terms the agent must NEVER expose to users (`Node REPL`, `node_repl`,
   `REPL`, `turn_id`, `runtime`, `retry`, `plugin error`). Our REPL output
   from the live run leaked `turn_id`, `tier`, `HARD_DENY`, `ADR-XXXX`
   into user-facing chat. There is no quanta-side blacklist.
2. **"Don't ask early."** Codex L213-214 says verbatim: "Only ask
   clarifying questions if you really need to. If a user has an
   under-specified prompt, try to fulfill it first before asking for more
   information." quanta's "Bias to action" (`prompt.ts:50-52`) covers
   tool use, not the *don't-clarify-until-you've-tried* posture.
3. **Verification claim discipline.** Existing `Honesty rail` (L190+)
   says "never claim success on an unverified change" but the live REPL
   ran `file_tree_summary` once, declared "I can't provide a detailed
   summary", and the language did not name what was tried, what failed,
   and what would be tried next. The rule needs an explicit positive
   form: "name the command, the exit, and cite the line of output that
   proves it; if you cannot, say 'I did not run X' literally."
4. **Production-code conduct invariants.** The user has stated four
   prohibitions verbatim across this session — 폴백 금지 / 에러삼킴 금지
   / 짜치는 코딩 금지 / 휴리스틱 금지 — and the agent reliably honors
   them when ADR text spells them out (Slice 1~5, Wave A~D all observed
   the invariants). The base prompt does NOT carry them, so a fresh
   session without an ADR brief regresses to ordinary code. Moving the
   four prohibitions into the cached base prompt makes them apply per-
   turn, byte-identical.

## Decision
Add four sections to `buildSystemPrompt()`, each addressing one gap.
All four ride in the `base` cached section of the 4-section preset
(Claude Desktop 1.7196.3 mirror), paying their token cost once per
cache cycle. Wording uses Codex's imperative style (must / never /
forbidden) and quotes the actual surface strings (verbatim Korean
phrases the agent was caught using).

### Four new / strengthened sections

**A. Internal vocabulary (never expose to users)** — new section
between Operating principles and Evidence discipline. Enumerates
twelve internal tokens the agent must paraphrase in user-facing chat.

**B. User intent discipline (don't ask early)** — new section
folded into Operating principles, verbatim absorption of Codex L213-214.
Hard rule: "Run at least one tool call before asking the user to
clarify, unless the prompt is literally impossible (no observable
target)."

**C. Production code conduct (four prohibitions)** — new section
absorbing the user's four prohibitions as base-prompt invariants so
every code-generating turn applies them without an ADR brief.

**D. Verification claims must cite command + output** — strengthening
of the existing Honesty rail (L190+) with the positive form: every
"works / fixed / passing / done" claim must name a command, its exit
code, and a quoted line from its output. The negative form ("never
claim success on unverified") already exists; the gap was the positive
specification of what the *successful* claim must contain.

## Rationale
- **Verbatim absorption beats paraphrase.** Codex L217's verbatim
  blacklist is more effective than a generic "don't expose internal
  terms" rule. We adopt the same shape: name the specific tokens.
- **Imperative > descriptive.** "Never" / "must" / "forbidden" phrasing
  routes through the LLM's policy weights more reliably than "should"
  / "prefer." Codex SKILL.md uses ~120 of these per ~900 lines.
- **Two-channel reinforcement carries over.** ADR-0062 paired prompt
  rules with tool descriptions for the same effect; this ADR extends
  the pattern: production-code prohibitions in prompt **and** in our
  ADR template (so PR review surfaces them too).
- **No code change.** Same byte-identical posture as ADR-0062: the
  agent loop / tool registry / dispatch seam are untouched. Only the
  LLM behavior changes.

## Trade-offs
- Base prompt grows ~40 lines (~500 tokens). Cached once per session
  cycle in the 4-section preset's `base` section, so per-turn marginal
  cost is zero after the first turn.
- Section A's blacklist is quanta-specific (`HARD_DENY`, `ADR-XXXX`,
  `runHitlGate`). If we rename a subsystem, the blacklist must be
  updated. Treat the list as living documentation, not a fence — the
  test asserts a few load-bearing tokens, not the whole list.
- Section C ("four prohibitions") is the user's voice quoted into the
  system prompt. Future contributors should not soften it; the wording
  is intentional.

## Alternatives considered
- **Persona slot `{{ personality }}` (Codex `models_cache.json`
  pattern).** Deferred to a future ADR. Persona is orthogonal to these
  four gaps; mixing them dilutes both decisions. The persona slot
  needs a server-side push channel or env-driven default — too large
  for the current change set.
- **Tool-description-only fixes.** Rejected: sections A (vocabulary),
  B (don't-ask-early), C (code conduct) are tool-agnostic and belong
  in the base prompt, not per-tool.
- **Soft hints ("prefer not to expose internal terms").** Rejected:
  Codex L26 / L217 are imperative and verbatim for a reason — the LLM
  routes around hedged wording.

## Negative invariants (the patterns this ADR forbids)
- User-facing chat containing `turn_id`, `tool_call_id`, `HARD_DENY`,
  `runHitlGate`, `byte-identical`, `ADR-XXXX`, `Wave [A-D]`, `Slice [1-5]`,
  `dispatch_seam`, `working_memory`, `recall_block`, `cache_breakpoint`.
- "Could you clarify" / "어떤 부분 알고 싶으" / "narrow down 해주세요"
  as the first response to a non-trivial prompt without at least one
  tool call attempted.
- "Fixed" / "works" / "passing" / "완료" / "done" without naming the
  exact command run and quoting a line from its output.
- Code generation that introduces a fallback path, swallows an error
  silently, uses magic numbers without `as const`, or relies on a
  "this usually works" heuristic.

## Implementation
1. `src/agent/prompt.ts` — add the four sections in
   `buildSystemPrompt()`. Section A between Operating principles and
   Evidence discipline (L78). Sections B and C inside Operating
   principles itself (additive bullets). Section D as a strengthening
   inside the Honesty rail block (L190+).
2. `tests/unit/prompt-system.test.ts` — append assertions for each
   section's load-bearing tokens (heading + 2-3 key phrases per
   section). Same shape as the ADR-0062 test block.

## Verification
- `tsc --noEmit` clean
- `biome check` exit 0 (existing 1 warning unrelated)
- `bun test tests/unit/prompt-system.test.ts` all pass + new
  assertions green
- byte-stable: `buildSystemPrompt() === buildSystemPrompt()` still
  holds after the four sections (no dynamic data)

## Related
- ADR-0062 — Tool-failure ladder + exploration multi-step pattern
  (predecessor; same Codex-parity philosophy)
- ADR-0027 — Anti-signals & prompt-injection hardening (orthogonal:
  guards against *external* malicious input; this ADR shapes the
  *agent's* internal discipline)
- ADR-0017 — Closeout 4-rule defended-claim scaffold (D in this ADR
  is the per-claim form of ADR-0017's closeout posture)
- `codex-feature-catalog-2026-05-21` — SKILL.md L26, L213-214, L217,
  L471 are the verbatim sources
- Future ADR — `{{ personality }}` Handlebars slot (Codex
  `models_cache.json` pattern, deferred)
