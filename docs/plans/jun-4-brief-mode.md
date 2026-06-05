# RFC — C3: brief_mode (condensed render mode)

**Date:** 2026-06-04
**Status:** Design (NOT implementation). This doc proposes a seam; it ships no code.
**Slice:** `@/agent` (prompt-body / prompt.ts dynamic context) + a session posture accessor mirroring `effort` + a knob + a `/brief` slash command. No new slice.
**Default posture:** OFF, byte-identical. Absent toggle ⇒ no brief notice is emitted and `buildTurnContext` output is byte-for-byte unchanged.

> Scope note: SOTA++ design doc grounded in (a) the Claude Code 2.1.150
> `tengu_brief_mode_toggled` / `briefTranscript` model audited on disk and (b)
> quanta's existing output-shaping substrate (prompt-body "Reporting shape by
> task kind", `effort` tiers, the per-turn `<system-reminder>` dynamic block).
> **Verdict up front: brief_mode is a NEW, focused toggle that is genuinely
> ORTHOGONAL to `effort` (effort caps `max_output_tokens` + reasoning mode;
> brief_mode shapes *prose verbosity* via a prompt directive). It PARTIALLY
> overlaps the static "Reporting shape" / "Completion bar … brief summary"
> prose already in `prompt-body.ts` — brief_mode does not replace that prose,
> it adds a session-level *dial* that makes the existing terseness guidance
> stricter on demand. The recommended implementation is a PROMPT DIRECTIVE
> (a per-turn `<system-reminder>` notice), NOT a render-layer transform — see
> §4 and §8 for the verdict and the rejected render-transform alternative.**

---

## 1. 요약 (Summary)

`brief_mode` is a **toggleable session posture** that, when ON, instructs the
model to produce **condensed final prose** — short answers, no preamble, no
recap of what the user already knows — while **leaving correctness reporting
intact** (verification block, error reporting, evidence/claim ladder).

It is a token-saving lever **orthogonal to compaction**: compaction shrinks the
*history* sent up; brief_mode shrinks the *per-turn output verbosity* the model
emits. Both can be on at once.

The design:

- A new **`BRIEF_NOTICE`** constant (a few lines of terse-output directive) in
  `src/agent/prompt-body.ts`, spliced into the **per-turn dynamic context**
  (`buildDynamicContext` in `src/agent/prompt.ts`) — NOT into the static
  cached prefix — so the toggle can flip mid-session without invalidating the
  provider cache prefix.
- A new optional `brief?: boolean` field on `TurnContextInput`
  (`src/agent/prompt.ts:113`). Absent / `false` ⇒ no notice, byte-identical.
- A session-level accessor that **mirrors `effort` exactly**: a tiny mutable
  store (`createBriefStore`) read once per turn by the loop, seeded from a
  `QUANTA_BRIEF` knob, and written by a `/brief` slash command and a
  `session_config`-style self-mutation op (the same seam that flips `effort`
  and `mode` today).
- **Hard floor**: the directive explicitly tells the model that brevity applies
  to *explanatory prose only* and MUST NOT suppress the verification report,
  error/failure reporting, the honesty/claim ladder, or `file:line` evidence.

What it deliberately is NOT: a render-layer string truncator, a tool-result
truncator, or a `max_output_tokens` ceiling. Those are covered (or rejected)
in §4 and §8.

---

## 2. 경쟁사 레퍼런스 — Claude Code 2.1.150 `brief_mode` (verified on disk, honest)

All findings below are from
`.extracted_source/claude-code-cli/_cli-symbols.txt` (the symbol/string dump of
the minified CLI, 270 051 lines). Line numbers cited are in that file.

### 2.1 There are TWO distinct "brief" features — do not conflate them

The audit surfaced two unrelated clusters that both contain "brief". Honesty
demands separating them:

**(A) `briefTranscript` — the condensed *render* mode (this is C3's analogue).**
- `briefTranscript:!1` is a boolean in `DEFAULT_GLOBAL_CONFIG`
  (`~/.claude.json`), listed alongside `verbose`, `todoFeatureEnabled`,
  `showExpandedTodos`, `autoCompactEnabled` (the config init function, ~L243293
  in the bundle; the key also appears in the `GLOBAL_CONFIG_KEYS` allow-list and
  at symbol lines 118392 / 148359 / 189328).
- Consumers are **render-layer**: `isBriefOnly` (L125685, L148360),
  `useBriefLayout` (L133064), `briefTranscript` (L148359). These gate how the
  *transcript* is laid out (a condensed view), sibling to `expandedView`,
  `showTeammateMessagePreview`.
- Toggle surface: a UI action `app:toggleBrief` (L158195), sibling to
  `app:toggleTodos` / `app:toggleTranscript` / `app:toggleTerminal` (L158193–8),
  AND a slash command `Toggle brief-only mode` (L239092, `enable_slash_command`,
  `slash_command`). On toggle it emits a **`<system-reminder>`** (L239098–101):
  `"Brief mode is now enabled. Use the …"` / `"Brief mode is now disabled. The …"`.
  Telemetry: `tengu_brief_mode_toggled` (L158220, L189428, L239094) and
  `tengu_brief_mode_enabled` (L163577, L189427). UI strings
  `"Brief-only mode enabled"` / `"Brief-only mode disabled"` (L239102–3).

**(B) `Brief` = the `SendUserMessage` tool (UNRELATED — a messaging tool).**
- `BRIEF_TOOL_NAME = "Brief"` is the **legacy name** for the `SendUserMessage`
  tool (`LEGACY_BRIEF_TOOL_NAME:"Brief"`, `BRIEF_TOOL_NAME:ii`,
  `ii="SendUserMessage"` at L243779). It sends a single message the user reads
  (remote/teammate sessions). `BRIEF_ENFORCE_SENTINEL =
  "You ended the turn without calling SendUserMessage."`,
  `getBriefEnforceText` (L112226), `"Brief mode enforcement failed:"` (L141300),
  `uploadBriefAttachment` / Bridge URLs (L112220–2), `isBriefEntitled` (L112224,
  an entitlement gate), `tengu_brief_send` (L189429, L232594, next to
  `"Message delivered to user."`). **This is NOT a condensed-output mode** — it
  enforces that the agent *calls a tool to deliver its answer*. It is out of
  scope for C3 and must not be copied.

### 2.2 Honest read of what Claude's `briefTranscript` actually condenses

- **Primarily a RENDER/transcript LAYOUT toggle** persisted as a config
  boolean (`briefTranscript`), consumed by `isBriefOnly` / `useBriefLayout` to
  draw a condensed transcript view. It is *UI-render-side*, not (primarily) a
  prompt rewrite of the model's prose.
- **Plus a light prompt signal**: on toggle, a `<system-reminder>` is injected
  telling the model brief mode changed state. The dump does not contain a long
  "be terse" enforcement paragraph tied to `briefTranscript` (the enforcement
  prose belongs to cluster (B), the `SendUserMessage` tool). So Claude's
  condensed mode is **render-heavy + a thin model-facing reminder**, not a
  heavy prompt directive.

**Verified takeaway for quanta:** Claude's condensed brief mode is mostly a
*display* concern (condense the transcript on screen) with a `<system-reminder>`
nudge to the model. quanta's value, however, is *token savings on the wire* —
shrinking how much the model *generates*, not how much we *display*. A pure
render-layer copy would save zero tokens. Therefore quanta should implement the
*model-facing* half (a prompt directive) and may optionally add the display
half later (§8). This is the key divergence, stated honestly.

---

## 3. 현재 quanta 상태 (grep-verified)

Per-turn output verbosity is controlled today by **two mechanisms, neither of
which is a runtime terse-output toggle**:

### 3.1 Static prose guidance in `src/agent/prompt-body.ts`

`BODY_AFTER_PROMPT_PACK` already carries the entire output-shaping contract,
*always on at one fixed verbosity*:
- **"Reporting shape by task kind"** (L346–364): per-kind shape (knowledge /
  research / inspection / modification / review / audit / visual / delegation).
- **"Verification report"** structured block (L366–373): `performed / rail /
  verdict / failure / skipped because`.
- **"Completion bar"** (L375–380): *"…give a **brief summary** of what changed
  and how it was verified."* — note quanta already asks for a "brief summary"
  unconditionally; brief_mode tightens this, it does not invent it.
- **"Keep reasoning tight and act on it. Explain only what the user needs."**
  (`BODY_AFTER_PERSONA`, L70). Terseness is already a baseline value.

These are baked into the **static cached prefix** (assembled by
`buildSystemPrompt`, `src/agent/prompt.ts:51–81`, joined with `\n`). There is
**no dial** — every session gets the same verbosity guidance.

### 3.2 `effort` tiers — a TOKEN CEILING + reasoning hint, NOT a verbosity directive

`src/agent/effort.ts`:
- `EFFORT_LEVELS = ["default","max","high","medium","low"]` (L24–30).
- `effortToTokenBudget(level)` (L81) maps each tier to a `max_output_tokens`
  ceiling (`low:1024`, `medium:4096`, `high:16384`, `max:64000`,
  `default:undefined`).
- The store (`createEffortStore`, L106) is read once per turn via accessors:
  `readEffort: () => effortStore.get()` (`bootstrap-session.ts:374`),
  `sessionEffort: () => …` (`host/runtime/internal/context-binding.ts:463`).
  Seeded from `QUANTA_EFFORT` (`bootstrap-session.ts:252`), flipped by `/effort`
  (`runner/assemble/config.ts:154`) and the status pills.
- The budget flows to the adapter `maxOutputTokens` (`responses-stream.ts:82`,
  `openai-responses.ts:94`, `chatgpt-oauth.ts:337`) → `max_output_tokens` on the
  wire (`openai-responses-wire.ts:335`).

**Grep verdict:** effort never injects a "be terse" instruction into the prompt.
It clamps the *hard ceiling* and hints reasoning depth. A low effort tier will
*truncate* a long answer (and trigger a continue-nudge on
`incomplete_details.reason === "max_output_tokens"`,
`openai-responses-wire.ts:670`) — it does NOT make the model *choose* to be
concise. brief_mode is the missing "choose to be concise" lever. **No
terse-output toggle exists today — confirmed by grep** (`brief`/`briefMode`/
`terse`/`concise` return zero runtime hits in `src/`).

### 3.3 The seam brief_mode rides on already exists

- **Per-turn dynamic notices**: `buildDynamicContext` (`prompt.ts:432–476`)
  already splices mode-conditional notices (`PLAN_NOTICE`, `REVIEW_NOTICE`,
  `AUDIT_NOTICE`, `ARCHITECT_NOTICE`, `EDITOR_NOTICE` via `modeNotice`,
  L298–305) into the trailing `<system-reminder>` user message — the exact slot
  a `BRIEF_NOTICE` belongs in. Absent-input branches there are already
  byte-identical (`if (notice) parts.push(...)`).
- **Self-mutation op seam**: the loop already routes typed control ops
  (`control-op-handler.ts`: `set_mode`, `cancel_subagent`, `interrupt`); `mode`
  and `effort` are session postures flipped from outside the model. brief_mode
  is a third member of that family.

---

## 4. 설계 (Design)

### 4.1 Decision: PROMPT DIRECTIVE, not render-transform, not token-truncation

| Candidate | Saves wire tokens? | Risk | Verdict |
|---|---|---|---|
| **Prompt directive** (system-reminder telling model to be terse) | **Yes** — model generates less | Model may over-trim if directive is loose | **CHOSEN** |
| Render-layer transform (post-process / summarize output before display) | **No** — full output already billed | Hides info from user, can drop verify block, non-deterministic | Rejected (§8) |
| Tool-result truncation | Saves *input* tokens, not output; different axis | Drops evidence the model needs | Out of scope (that's compaction's neighbor) |
| Reuse `effort=low` ceiling | Truncates, doesn't condense | Mid-answer cutoff + continue-nudge thrash | Orthogonal, not a substitute (§8) |

**Rationale:** C3's stated purpose is *token saving in long sessions*. Only the
prompt-directive path reduces what the model emits. A render transform would
condense the *display* while the full verbose generation is still produced and
billed — zero savings — and would risk dropping correctness content. This is
the honest divergence from Claude's render-primary `briefTranscript` (§2.2).

### 4.2 `BRIEF_NOTICE` content (what it condenses, what it must NOT touch)

A new `readonly string[]` in `prompt-body.ts`, joined like the existing
notices. Draft (final wording is an implementation detail; the *contract* is
load-bearing):

```
BRIEF MODE is active. Condense your FINAL prose: answer first, no preamble,
no recap of what the user already knows, no restating the request. Prefer a
short paragraph or a tight list over an essay. Drop hedging and filler.
This applies to EXPLANATORY prose ONLY. It does NOT change correctness
reporting: still emit the Verification report (command + verdict + exit),
still report errors and failures in full, still cite file:line evidence for
concrete claims, still honor the claim/honesty ladder (FACT/INFERENCE/UNKNOWN).
Brevity is never an excuse to omit a verification you ran, a failure you saw,
or a gap you must name.
```

**Condenses:** final answer prose, explanatory narration, preambles, recaps,
hedging.
**MUST NOT touch (hard floor, stated in the directive AND asserted by tests
§6):** the Verification report block, error/failure reporting, `file:line`
evidence, the honesty/claim ladder, "name the remaining gaps" completion
honesty. These are *correctness* rules (`prompt-body.ts` L299–313, L366–380),
not tone — brief_mode is forbidden from weakening them.

### 4.3 Plumbing (mirror `effort` exactly)

1. **Store** — `createBriefStore(initial: boolean)` in a tiny leaf (co-locate
   in `src/agent/effort.ts` as a sibling, or a new `src/agent/brief.ts`
   leaf — pure, no cross-slice imports), shaped like `EffortStore`:
   `get(): boolean`, `set(b): void`, `snapshot(): boolean`.
2. **Seed** — `createBriefStore(parseBoolKnob(env.QUANTA_BRIEF) ?? false)` in
   `bootstrap-session.ts` (next to the `createEffortStore` line, L252).
3. **Accessor** — `readBrief: () => briefStore.get()` exposed on the same
   boot/runtime accessor surface as `readEffort`
   (`bootstrap-session.ts:374`, `context-binding.ts:463`).
4. **Per-turn read** — the loop reads `readBrief()` once per turn (where it
   already reads `readEffort()` / mode) and threads it as
   `buildTurnContext({ …, brief })`.
5. **Prompt** — `TurnContextInput.brief?: boolean` (`prompt.ts:113`);
   `buildDynamicContext` pushes `BRIEF_NOTICE` when `input.brief === true`
   (one `if (input.brief) parts.push("", BRIEF_NOTICE)` next to the
   `modeNotice` splice, L440–441). Position: after mode notice, before
   repo-rules, so a mode notice (which may itself constrain output) reads first.

> **Why dynamic, not static `buildSystemPrompt` opt?** A `brief` opt on the
> static prefix (like `persona`/`promptPack`) would bake the toggle into the
> *cached* prefix; flipping it mid-session would invalidate the whole provider
> cache prefix (a real cost — the cache is a deliberate lever, see
> `prompt-sections.ts` MAX_CACHE_BREAKPOINTS design). The dynamic
> `<system-reminder>` slot is *already* per-turn and uncached, so a per-turn
> flip is free. This matches how `mode` notices ride.

### 4.4 Relation to `effort` — orthogonal, NOT merged

Keep them separate axes:
- `effort` = **how hard to think + hard output ceiling** (`max_output_tokens`,
  reasoning depth). Mechanical clamp on the wire.
- `brief` = **how terse to write** the prose the model *chooses* to emit.
  Behavioral directive.

They compose meaningfully: `effort=high` + `brief=on` = "think deeply, answer
tersely" (a common power-user want that neither axis expresses alone).
**Merging is rejected** (§8): collapsing them would lose the deep-think-but-
terse-output quadrant and would couple a behavioral nudge to a billing ceiling.
Status chrome can show both pills (mode · effort · brief) — the
`skills-surface.ts` pill surface already renders `mode+effort`.

### 4.5 Overlap with static "Reporting shape" prose — focused dial, not redundant

brief_mode does **not** duplicate the static guidance; it *modulates* it. The
static "Reporting shape by task kind" defines the *structure* per task kind
(always on); brief_mode tightens the *verbosity within that structure* on
demand. The static "Completion bar … brief summary" already asks for brevity at
*one* fixed level — brief_mode is the runtime knob that level never had. So C3
is a **focused new toggle**, not a redundant restatement. (Had the audit found a
runtime terse-output toggle already present, C3 would be redundant — it is not;
§3.2 confirms none exists.)

---

## 5. 통합 (Integration)

- **Knob**: `QUANTA_BRIEF` (boolean, default unset ⇒ `false`). Registered in the
  knob registry (`src/runner/knobs/…`) and surfaced in `help-render.ts` next to
  the existing `QUANTA_EFFORT` entry (L127). Document via `tools/gen-knob-docs`.
- **`session_config` op**: add a `set_brief` (or extend the existing posture
  op) to the typed control-op family handled around `control-op-handler.ts`
  (sibling to `set_mode`). This is the model/host self-mutation seam — the
  agent can flip its own brevity mid-session, exactly as it can flip mode.
  No-throw surface; writes `briefStore.set(b)`; the NEXT turn's
  `readBrief()` observes it.
- **Slash `/brief`**: a REPL slash command (sibling to `/effort`,
  `runner/assemble/config.ts:154` accessor pattern) that toggles
  `briefStore`. On toggle, echo a one-line confirmation
  (`brief mode on/off`) — mirrors Claude's `"Brief-only mode enabled"` and
  emits the next-turn notice automatically.
- **Status pill**: extend the `mode+effort` pill (`skills-surface.ts:36`) to a
  `mode · effort · brief` triple when brief is on (off ⇒ no pill, no chrome
  change).
- **Feature catalog (fc)**: add a `brief_mode` feature entry under
  `tools/feature-catalog` (axis: output-shaping / session-posture; mirrors how
  `effort` and `mode` are catalogued). Wire reachability so the lint
  (`feature-catalog-reachability.test.ts`) sees the store → notice path.
- **Default-OFF byte-identical**: with `QUANTA_BRIEF` unset and no `/brief`,
  `briefStore.get()` is `false`, `input.brief` is `undefined`/`false`,
  `buildDynamicContext` pushes nothing, and `buildTurnContext` output is
  byte-for-byte identical to today. This is the primary safety invariant.

---

## 6. 테스트 계획 (Hellgate + e2e)

New `tests/unit/brief-mode-hellgate.test.ts` (adversarial), plus an e2e through
`buildTurnContext`. Assertions:

1. **Toggle ON ⇒ notice present.** `buildTurnContext({…, brief:true})` →
   the trailing `<system-reminder>` user message contains `BRIEF_NOTICE`'s
   marker text ("BRIEF MODE is active").
2. **Toggle OFF ⇒ byte-identical.** `buildTurnContext({…, brief:false})` and
   `buildTurnContext({…})` (brief omitted) produce output that is
   `toEqual` to the pre-feature baseline — `system` blocks unchanged AND the
   dynamic message text unchanged. Snapshot/byte compare both branches.
3. **Static prefix unchanged either way.** `system` blocks (the cached prefix)
   are identical for `brief:true` vs `brief:false` — proves brief rides the
   *dynamic* slot only and never perturbs the cache prefix.
4. **Does NOT suppress correctness blocks.** With `brief:true`, the assembled
   prompt STILL contains the Verification report fields and the honesty-rail /
   claim-ladder text from `BODY_AFTER_PROMPT_PACK` (those live in the static
   prefix and are untouched). Assert their presence under brief.
5. **Notice ordering.** When `mode` ALSO sets a notice (e.g. `audit`),
   `BRIEF_NOTICE` appears AFTER the mode notice and BEFORE repo-rules in the
   dynamic block (deterministic position).
6. **Defang safety.** `BRIEF_NOTICE` text contains no `<system-reminder>`
   tokens (it rides inside the outer wrapper; assert it survives
   `embedUntrusted` unchanged).
7. **Store semantics.** `createBriefStore(false)` then `.set(true)` →
   `.get()===true`; `parseBoolKnob` maps `"1"/"true"` → true, unset → false
   (mirrors `parseEffort` undefined-vs-default discipline).
8. **e2e self-mutation.** A `set_brief` control-op flips the store; the NEXT
   `buildTurnContext` (reading `readBrief()`) emits the notice; flipping back
   restores byte-identical output.

---

## 7. 단계 (Phases)

- **Phase 1 (core, this RFC's target):** `BRIEF_NOTICE` + `TurnContextInput.brief`
  + `buildDynamicContext` splice + `createBriefStore` + `QUANTA_BRIEF` seed +
  `readBrief` accessor + loop per-turn read. Hellgate tests 1–7. Default-OFF.
- **Phase 2 (surfaces):** `/brief` slash command + status pill + `set_brief`
  control-op (self-mutation) + fc entry + knob docs. Hellgate test 8.
- **Phase 3 (optional, deferred):** the *display* half — a condensed transcript
  render mode (quanta's analogue of Claude's `briefTranscript` layout) for
  CLI/Web surfaces. Orthogonal to token savings; pure UX. Backlog only.

---

## 8. 리스크 / 대안 (Risks & Alternatives)

**R1 — brief_mode suppresses important output (the headline risk).** A loose
"be brief" directive could make the model drop a verification it ran or a
failure it saw. *Mitigation:* the directive's hard floor (§4.2) explicitly
exempts the verification report, error reporting, evidence, and the honesty
ladder; hellgate test 4 asserts those blocks remain in the prompt; the static
honesty rails (`prompt-body.ts` L299–313) are correctness rules the model is
already told it "MUST" honor. brief_mode is layered *below* those in authority.

**R2 — overlap / merge with `effort`.** *Considered and rejected.* Merging
loses the "deep think, terse output" quadrant and couples a behavioral nudge to
a billing ceiling (`max_output_tokens`). Effort *truncates* (and triggers
continue-nudge thrash on `incomplete_details.reason`); brief_mode makes the
model *choose* concision so it never hits the ceiling mid-thought. Keep
orthogonal (§4.4).

**R3 — render-transform alternative.** Post-processing the model's output to
condense it (Claude's `briefTranscript` render path) was rejected: it bills the
full verbose generation (zero token savings — the whole point of C3), is
non-deterministic, and risks programmatically dropping the verify block. May be
revisited as Phase-3 *display* polish, never as the savings mechanism.

**R4 — measuring the savings.** brief_mode's ROI is "fewer output tokens in long
sessions". *Plan:* the live token counter / usage tracker already records
per-turn output tokens; an A/B over the smoke battery (`tests/smoke/`) with
`QUANTA_BRIEF=0` vs `=1` quantifies the delta. Per repo policy
(`no-heuristics-only-validated`), the directive wording should be tuned against
*measured* output-token deltas, not asserted savings — do not claim a % until
measured.

**R5 — cache-prefix invalidation.** Avoided by construction: brief rides the
per-turn dynamic `<system-reminder>` (already uncached), never the static
4-section prefix (§4.3). A naive static-opt implementation would thrash the
cache — explicitly out.

**R6 — divergence from Claude.** Claude's `briefTranscript` is render-primary;
quanta's is model-directive-primary. This is intentional (§2.2) and the honest
core of the design: copying Claude's render-only mode would save zero tokens.

**Alternative considered — do nothing (rely on existing terse guidance).** The
static "Explain only what the user needs" + "brief summary" prose is always on
at one level. C3's value is the *runtime dial* that level lacks; without it,
users in long sessions cannot turn verbosity down without dropping `effort`
(which truncates, not condenses). Net: C3 is a small, focused, orthogonal
addition with a clear token-savings thesis — worth shipping default-OFF.

---

## 9. 코드 위치 요약 (Code-location summary)

**Audited (read, grounds the design):**
- `src/agent/prompt-body.ts` — output-shaping prose: "Reporting shape by task
  kind" (L346–364), "Verification report" (L366–373), "Completion bar … brief
  summary" (L375–380), terseness baseline (L70). The blocks brief_mode tightens
  but must NOT suppress.
- `src/agent/prompt.ts` — `buildSystemPrompt` opts seam (L51–81), `modeNotice` +
  the mode notices (L255–305), `buildDynamicContext` (the per-turn
  `<system-reminder>` splice, L432–476), `buildTurnContext` (L521–602),
  `TurnContextInput` (L113).
- `src/agent/effort.ts` — the mirror: `EFFORT_LEVELS` (L24), `effortToTokenBudget`
  (L81, proves effort = token CEILING not verbosity), `createEffortStore` (L106).
- `src/agent/prompt-sections.ts` — 4-section cached-prefix model (`MAX_CACHE_
  BREAKPOINTS`, why brief must stay OFF the static prefix).
- `src/host/bootstrap/bootstrap-session.ts` — `createEffortStore` seed (L252) +
  `readEffort` accessor (L374); brief seeds/accessors mirror these.
- `src/host/runtime/internal/context-binding.ts:463` — `sessionEffort` accessor.
- `src/runner/assemble/config.ts:154` — `/effort` accessor pattern.
- `src/apps/cli/help-render.ts:127` — `QUANTA_EFFORT` knob doc entry (sibling).
- `src/apps/cli/repl/skills-surface.ts:36,46,53` — the `mode+effort` status pill.
- `src/agent/control-op-handler.ts` — typed control-op family (`set_mode` etc.),
  the self-mutation seam `set_brief` joins.
- `.extracted_source/claude-code-cli/_cli-symbols.txt` — Claude evidence:
  `briefTranscript` (render config, ~L243293 / L118392 / L189328),
  `app:toggleBrief` (L158195), toggle `<system-reminder>` (L239098–101),
  `isBriefOnly`/`useBriefLayout` (L125685/L133064), telemetry
  `tengu_brief_mode_toggled` (L239094); and the UNRELATED `Brief`=`SendUserMessage`
  cluster (L243779, L112226, L141300) explicitly excluded.

**To add (implementation, NOT in this RFC):**
- `src/agent/prompt-body.ts` — `BRIEF_NOTICE` constant.
- `src/agent/prompt.ts` — `TurnContextInput.brief?: boolean` + splice in
  `buildDynamicContext`.
- `src/agent/brief.ts` (or co-located in `effort.ts`) — `createBriefStore`,
  `parseBoolKnob`.
- `src/host/bootstrap/bootstrap-session.ts` + `context-binding.ts` — seed +
  `readBrief` accessor.
- loop per-turn read site — thread `brief` into `buildTurnContext`.
- `src/runner/knobs/…` + `help-render.ts` — `QUANTA_BRIEF` knob.
- `src/agent/control-op-handler.ts` (+ submission types) — `set_brief` op.
- CLI REPL slash table — `/brief`.
- `tools/feature-catalog/…` — `brief_mode` fc entry.
- `tests/unit/brief-mode-hellgate.test.ts` — the §6 battery.
```
