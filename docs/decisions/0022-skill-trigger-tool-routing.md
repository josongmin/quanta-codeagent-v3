# ADR-0022 — Skill trigger rules + tool routing matrix

Status: accepted (2026-05-20)
Phase: SOTA++ Codex absorption — Phase 7

## Context

Codex defines two related routing contracts our prompt did not articulate:

- **Skill triggers** (`skills-audit.md`): explicit (`$name` or plain text
  mention) → MUST use; implicit (task clearly matches description) → MUST
  use. Multi-skill → minimal covering set with declared order. Skills load
  via progressive disclosure (the body only when invoked).
- **Tool routing** (`tool-routing-and-triggering.md`): "Tools are not
  triggered by query strings; they are triggered by the TRUTH CONDITION of
  the answer." The matrix maps need → tool, not keyword → tool.

Our skill system existed (`src/skill/`) but its inventory never reached the
per-turn reminder, and the system prompt had no routing matrix — the model
had to infer which tool to use from generic descriptions.

## Decision

### A. Active skill inventory in the per-turn reminder
`TurnContextInput.activeSkills?: { name, description }[]` — flat shape so
the `@/agent/prompt` slice stays isolated from `@/skill`.
`buildSessionFeatures` discovers skills ONCE at session start and caches
`{name, description}[]` on the session features. `prepareTurnContext`
threads it through; `renderActiveSkillsBlock` emits:

```
## Active skills
- $name — first-line description
...
Trigger rules:
  1. If the user names a skill ($name or plain), invoke it that turn.
  2. If the task clearly matches a skill description, invoke it (mandatory).
  3. If multiple apply, pick the minimal covering set; announce the order.
  4. Progressive disclosure: load SKILL.md body via the `Skill` tool only
     when you decide to invoke it.
```

Empty array or absent ⇒ no block rendered (byte-identical for skill-less
sessions).

### B. Tool routing matrix in the system prompt
`buildSystemPrompt` adds a static "Tool routing" section between Budget
and Honesty rail:

```
Tool routing (the truth condition picks the tool, not the keyword):
- Need a fresh public fact            → web/research tool (if available)
- Need local code evidence            → grep / read / glob / localize
- Need to modify code (stable context) → edit (one minimal patch)
- Need to modify code (unstable/bulk) → scripted_replace
- Need to verify a change             → test_runner or scoped bash
- Need parallel independent reads     → batch tool calls in one message
- Need a sidecar task with disjoint
  write scope                         → Agent tool (explicit permission only)
- Need to discover MCP/dynamic tools  → ToolSearch (preferred over raw
                                         list_mcp_resources)
Do not match tools to query strings. Pick the cheapest tool whose
output is sufficient evidence for the claim you intend to make.
```

## Mechanism

- Inventory is built ONCE at session start (Codex anti-reread rule). The
  reminder shows {name, description} every turn but the body of SKILL.md is
  ONLY loaded when the existing `Skill` tool is invoked (progressive
  disclosure).
- The routing matrix is static prose, byte-stable, cached with the rest of
  the system prompt.

## Consequences

- The model now sees, every turn, exactly which skills it can invoke and
  the rules for when invocation is mandatory.
- The matrix gives the model a single canonical place to read which tool
  to reach for — fewer thrash patterns where the model uses bash for what
  should be `grep` or `read` for what should be `glob`.
- Skill-less sessions stay byte-identical (no inventory rendered).

## Tests

- `tests/unit/skill-trigger-rules.test.ts` — 8 tests: header + entries +
  trigger rules, first-line-only descriptions, empty/absent ⇒ no block,
  ordering vs memory and repo-rules, system prefix unchanged.
- `tests/unit/prompt.test.ts` (extended) — Tool routing section present,
  every matrix entry named.
- `tests/integration/agent-features.test.ts` — skill discovery wires the
  inventory through to the reminder; absent ⇒ no block.

## References

- Codex `skills-audit.md` (trigger rules).
- Codex `tool-routing-and-triggering.md` (truth-condition routing).
- Codex `mcp-usage-audit.md` (ToolSearch preference for MCP discovery).

## Intentional non-absorption — closure rationale (2026-05-21)

Four adjacent capabilities Claude/Codex either expose differently or do not
absorb at all. The decision to keep them at their current grade is itself a
load-bearing design choice — documented here so a future reader does not
mistake "L1/L2" for "left undone by accident".

### L1-A — skill `paths:` auto-activation (status: HOLD)

`Skill.paths?: string[]` (gitignore-style globs) is parsed and the activation
function (`src/skill/activation.ts` `skillsActivatedFor`) and host API
(`skillToolAllowlist`) are exported, but the agent loop does NOT call them.
Claude Code wires this by hooking `Read`/`Edit`/`Write` to record touched
paths per turn and matching them on the next turn's reminder build.

**Why hold:**
- Loop-wired auto-activation requires file-touch tracking integrated with
  `dispatch.ts`. Without a clear host-side use case (IDE/daemon /
  monorepo watcher) the activation produces false positives — every
  `Read("README.md")` activates README-touching skills, inflating per-turn
  context.
- The component pieces are already there (glob matcher + allowlist
  computation + per-turn reminder render). The missing seam is the
  "which paths got touched this turn" recorder, which is a separate
  concern (run-context-level) from the prompt scaffold this ADR governs.

**Promotion path (L1 → L3):** a `RunContext.touchedPaths: Set<string>`
recorder fed by tool dispatch, plus a `prepareTurnContext` call to
`skillsActivatedFor(skills, [...touchedPaths])` whose result is appended to
`activeSkills`. Estimated ~50 LOC + integration test that a file-touch
on a `paths:`-scoped skill's matching glob causes the skill to appear in
the next turn's reminder. Not done now — gated on a documented host use
case (IDE integration / daemon arch).

### L1-C — Activation-timing phase FSM (status: HOLD)

Skill activation runs in two phases today: (1) **session-start** inventory
cache (one shot, Codex anti-reread), (2) **per-turn** label injection of
`{name, description}` only. There is no explicit phase enum/FSM.

**Why hold:**
- Codex itself does not split activation into discrete phases — file-touch
  triggers are evaluated at the dispatch site, not at "phase boundaries".
- A phase FSM (`session-start | turn-start | turn-end | dispatch`) buys
  zero behavioral difference over the current scaffold; it only adds a
  vocabulary for code reviewers, which is not load-bearing yet.

**Promotion path:** introduce `ActivationPhase` enum + `TurnContextInput.
phase` only when at least two phases need distinct activation rules (e.g.
a "validation phase" that runs after a tool batch but before re-streaming).
Not done now — UX gain unproven, Codex precedent absent.

### L2-B — skill `model` / `effort` scoping (status: HOLD as advisory)

`Skill.model?` and `Skill.effort?` are parsed; `scopingNote(skill)` emits an
**advisory** prompt fragment but the agent does NOT swap the LLM model or
change the effort budget per skill. Claude treats these as pure metadata
the host's `contextModifier` may act on; quanta has no equivalent host
modifier seam.

**Why hold (deliberately advisory):**
- Enforcement requires a per-turn `LLMPort` swap (effort) or a
  `RetryingLLM(buildLLM(provider, skill.model))` wrap, both of which are
  CLI-host concerns. Pushing them into `@/agent` would force the core
  slice to know about provider/model strings — exactly the leak ADR-0001
  forbids.
- The advisory prompt fragment is honest: the model sees author intent
  and can adapt prompt budget, but the runtime does not silently override
  the user's `QUANTA_MODEL`. Silent overrides would be a UX trap (cost
  delta with no visible cause).

**Promotion path:** add an optional `AgentConfig.skillRuntimeModifier?:
(skill: Skill) => Partial<{ llm: LLMPort; effort: string }>` callback the
CLI host can populate; `@/agent` calls it only when present. Not done now
— host modifier seam not yet justified by a concrete request.

### L2-A — `ToolSearch` server-side deferral (status: HOLD; lexical refine
in scope)

`ToolSearch` performs **client-side lexical** discovery (token / substring
/ description scoring + `select:NAME` for exact pulls). Claude's
"server-side deferred tools" mechanism — where the model receives only
tool *names* until a `ToolSearch` query pulls the schema mid-turn — is
NOT absorbed.

**Why hold (the honesty IS the feature):**
- "No-defer" is a positive guarantee: every tool the agent can call has
  its full schema visible in the system prompt from t=0. There are no
  silently-omitted tools the model might be unable to invoke. A 2026-05-20
  prompt-policy stack (ADR-0016) leans on this: claim-ladder UNKNOWN is
  triggered when a tool's schema is *visibly* absent, not when the model
  guesses it might exist.
- Switching to server-side deferral would weaken the prompt-policy
  guarantee and add a tool-discovery turn-cost that the small (~20-tool)
  registry does not need.

**Promotion path (lexical refine, NOT deferral):** under this ADR's
scope, the in-tier improvement is to make the lexical scoring sharper
(CamelCase/snake_case tokenization, description-first-line weight bump,
optional `aliases?: string[]` per tool). The grade stays L2 — "lexical
catalog, not server-side deferral" — but accuracy lifts. Server-side
deferral remains a separate RFC if and when the registry exceeds the
size where prompt budget pressure justifies it.
