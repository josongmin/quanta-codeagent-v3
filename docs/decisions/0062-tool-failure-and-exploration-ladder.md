# ADR-0062 — Tool-failure ladder + exploration multi-step pattern

## Status
Accepted (2026-05-21)

## Context
Live REPL run, real user prompt "분석해줘" against the quanta repo. The agent
called `file_tree_summary` with default `max_depth=3`, hit the depth cap
(`+292 deeper, increase max_depth`), and **immediately concluded "I can't
provide a detailed summary"** — turning the explicit next-action hint into a
generic refusal. The user followed with "구체적으로 확인하면 되잖아"; the agent
then tried `src/src` (relative-path confusion, agent cwd was already inside
`src/`), `..` (FS-jail violation), and again the same `.` (same cap), and
finally apologized in Korean and asked the user to narrow down.

Two distinct weaknesses surfaced at the same time:

1. **Single-tool cap → "I can't" reflex.** The cap message names the exact
   next parameter (`increase max_depth`). The agent treats this as a
   capability boundary instead of an instruction. The same pattern repeats on
   `file cap reached — narrow with path or raise max_files`, `output spill`,
   and other quanta-tool caps.
2. **No multi-step exploration pattern for analysis tasks.** A user prompt
   like "이 레포 분석해줘" is implicitly multi-tool (orient → narrow →
   confirm). With no such pattern in the system prompt, the agent runs a
   single broad call, sees it cap, and surfaces "narrow down 해주세요" back
   to the user — handing the user's own work back to them.

The existing system prompt has a generic clause (`prompt.ts:67-68`,
"When a tool fails, read the error and diagnose the actual cause before
retrying. Do not repeat the same failing call or thrash blindly.") but no
**failure-type → next-action ladder**, no **exploration pattern**, and no
**"never delegate the task back to the user"** invariant. Codex's
`browser/SKILL.md` solves the analogous problem with seven verbatim rules
(L220, L248, L254, L268, L345-346, L351, L353, L361) that prescribe the
*specific* next action per failure type and forbid asking the user to do the
agent's narrowing.

## Decision
Absorb the Codex `browser/SKILL.md` failure-recovery + exploration pattern
into our base system prompt as a single section, **`## Tool failures &
exploration`**, with five hard rules. The wording is concrete (it names
quanta tools and quanta cap messages by string), not abstract, so the LLM
cannot route around it.

The same ADR also hardens the description strings of cap-prone tools
(`file_tree_summary`, `glob`, `grep`) to make the next action imperative
rather than informational, so the agent receives the same instruction from
two independent channels (system prompt + per-tool description).

### Five hard rules (verbatim, in base prompt)

1. **Cap hints are instructions, not boundaries.** When a tool result
   contains a cap message that names a parameter (`increase max_depth`,
   `raise max_files`, `narrow with path`), the *next* call MUST apply that
   exact change. Switching tools or surrendering before applying the cap's
   own suggestion is a bug.
2. **Two failures on the same tool → switch tool, not parameters.** After
   two consecutive failures of the same tool against the same target
   (not counting cap-hint retries from rule 1), change the tool itself:
   `file_tree_summary → glob → ls → read` is the canonical analysis ladder.
   "Same tool with a different parameter" does not count as a switch.
3. **Analysis tasks are multi-step.** A user prompt of the form
   "분석/요약/탐색/explain/summarize/audit" is multi-tool by default:
   ORIENT (one broad observation, ≤1 tool) → NARROW (3–7 candidates from
   the orient output) → CONFIRM (read/grep the candidates directly).
   Reporting after only the ORIENT step is incomplete by construction.
4. **Never delegate the narrowing back to the user.** Phrases like "어떤
   부분을 알고 싶으신가요" / "could you narrow down" / "더 구체적으로
   알려주세요" are forbidden as the agent's first response to an analysis
   request. Run 5–10 tool calls yourself first; only then, if information
   is still insufficient, report what you found with explicit uncertainty.
5. **FS-jail and path errors have one fix: absolute path inside the jail.**
   `..` is never the answer. When a tool says "Path escapes the
   working-directory jail", re-call with an **absolute** path under the
   current jail root (read the `[info] quanta ready` cwd banner to find
   it). Trying `..` again is a bug.

## Rationale
- **Concrete > abstract.** "Do not retry the same failing call" (current
  prompt) is too generic — the agent reads it and still retries with a
  different *interpretation* of the same call. Naming the actual cap
  strings (`increase max_depth`, `raise max_files`) anchors the rule to
  observable tool output.
- **Two channels.** System prompt and tool description say the same thing
  from different angles. The LLM has been shown to ignore one but rarely
  both.
- **Codex parity.** Codex's seven rules cover exactly this failure mode
  for a different tool surface (browser locators). We adopt the same
  shape (failure-type → exact next action) for our surface (file/grep/
  patch tools). The five rules above are the minimum that map our caps
  1:1 to next actions.
- **No code change.** This is a prompt + description change only. The
  agent loop, tool registry, and dispatch seam are byte-identical. LLM
  behavior changes; nothing else does.

## Trade-offs
- Base prompt grows by ~30 lines (≈350 tokens). This rides in the
  `base` cached section of the 4-section preset (Claude Desktop 1.7196
  mirror), so the cost is paid once per cache cycle, not per turn.
- Tool descriptions grow by 1–2 lines each. Same cache treatment.
- Some LLMs may over-apply rule 3 ("multi-step for analysis") to
  trivially read-only one-shots. Rule 3's trigger words (analysis /
  summary / explore / audit / explain) are restrictive enough that
  "ls a directory" or "read this file" stays single-step.

## Alternatives considered
- **Auto-escalate the tool itself** (cap hit → re-run with 2× depth
  internally). Rejected: Codex deliberately keeps this decision with
  the agent, because the right escalation (depth × 2 vs narrow path vs
  switch tool) depends on the user's intent. Hiding the cap from the
  LLM removes its ability to steer.
- **Pure description change, no system prompt section.** Rejected: tool
  descriptions are loaded only when the tool is in scope. Rule 3
  (multi-step) and rule 4 (no delegation) are tool-agnostic and belong
  in the base prompt.
- **Pure system prompt, no tool description change.** Rejected: rule 1
  (cap hints are instructions) is strongest when the cap message itself
  uses imperative phrasing. Two-channel reinforcement is cheap.

## Negative invariants (forbidden patterns)
- "I can't provide a detailed summary" / "directory structure is too deep"
  as a *first response* after one cap hit.
- "narrow down 해주세요" / "specific 한 부분 알려주세요" before the agent
  has run at least 3 tool calls on the analysis path.
- Re-calling the same tool with the same arguments after a cap hit (cap
  hint says to change a parameter — apply it).
- `..` after an FS-jail violation.
- Switching tools after one cap hit but before applying the cap's own
  suggestion.

## Implementation
1. `src/agent/prompt.ts` — add the `## Tool failures & exploration`
   section to `base` in the canonical position (after the existing
   tool-use guidance, before `## Active skills`).
2. `src/tool/file-tree-summary/index.ts` — promote cap messages from
   informational to imperative: `… (+N deeper, MUST re-call with
   max_depth: ${N×2 ceil} before switching tools)`.
3. `src/tool/glob/index.ts`, `src/tool/grep/index.ts` — append to
   `description`: cap/limit semantics + "narrow with path or raise the
   limit before switching tools."
4. `tests/unit/prompt-system.test.ts` — append assertions that the five
   rule headings are present in the base prompt (the LLM behavior itself
   is exercised by `tests/eval/` real-LLM smokes, not unit tests).

## Verification
- `tsc --noEmit` clean
- `biome check src/agent src/tool tests/unit/prompt-system.test.ts` exit 0
- Existing prompt/system tests pass byte-identical (section is purely
  additive; no rewording of prior rules).
- Manual REPL replay of the original failing prompt against the patched
  agent: should produce ≥5 tool calls (orient → narrow → confirm) and a
  concrete summary, not "narrow down 해주세요".

## Related
- ADR-0029 (reviewer 3-tier) — the reviewer dispatcher already returns
  `rule_ask` deny when wiring is missing; this ADR is the equivalent for
  *information gathering* refusals.
- ADR-0031 (prefix-rule DSL) — same Codex-parity philosophy: encode the
  policy explicitly so the agent cannot route around it.
- `codex-feature-catalog-2026-05-21` memory — Codex SKILL.md L220, L254,
  L353 are the source verbatim references.
