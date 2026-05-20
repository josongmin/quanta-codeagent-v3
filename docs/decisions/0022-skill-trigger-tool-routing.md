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
