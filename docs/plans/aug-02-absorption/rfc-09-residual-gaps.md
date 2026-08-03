# RFC-09 — Residual absorption gaps: current-HEAD final scope

**Status:** FINAL PLAN — current `main@0a00ced392102073fe35eccd202bca92cabd71dc` audit complete; implementation not started.
**Scope:** the 4 bucket-(a) items + ~11 trivial-polish items the coverage-critic (`_coverage-critic.md`) found un-lettered by RFC-01..08. This RFC exists to make the README's "100% coverage" claim honest by *accounting* for the residue — **not** to manufacture build tickets. Grounding (below) collapses the residue hard: **backlog = graveyard.**

## Motivation

The critic correctly found that 4 items (LSP-as-MCP-tools, hook additionalContext, fork_turns+delegation-prompt, richer review-finding schema) + ~11 polish items live only in the detail audit files and never got an A/B/C/D ledger ID. That is a real accounting crack. But the critic did **not** grep `src/` for three of the four "gaps" — it reasoned from the *analysis prose*, not the tree — and the README's own knob table (`QUANTA_LSP_TOOLS=full`, line 43) already contradicts the load-bearing premise of the headline MED item. This RFC re-grounds every item in code first, then admits the vanishingly small true residue.

**Net after grounding: 1 thin BUILD (A-GAP-2 residual only), 2 DROP-as-already-built (A-GAP-1, A-GAP-3), 1 small BUILD (A-GAP-4's consumed fields only). Polish: 0 build, 4 park, 7 drop-as-absent-but-sub-threshold.**

## Non-goals

- No second LSP surface, MCP-server surface, subagent context-carry mechanism, or delegation runner — all four exist (grounded below).
- No re-litigation of RFC-01..08 DROPs — the critic already spot-checked them clean (its §Wrong-DROP table: 0 hard wrong-DROPs).
- No renderer work, no hosted control-plane, no efficacy claim without measurement.
- No change to the review reviewer-subagent posture (isolated, read-only, depth+1) — A-GAP-4 touches only the *finding schema*, not the delivery mechanism.

## Current-state — per-item code verdict (file:line)

### A-GAP-1 — LSP-as-MCP tools (call-on-demand) → **ALREADY-BUILT (both modalities). DROP build; keep measure-first receipt.**

The critic's premise — "quanta has LSP only as PUSH observations, no on-demand tool" — is **false at HEAD**.

- **Callable tool modality is live.** `src/tool/lsp_nav/index.ts:312` `lspNavTools(provider)` returns **10** real `Tool` objects the agent invokes on demand: `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_type_definition`, `lsp_implementation`, `lsp_document_symbol`, `lsp_workspace_symbol`, `lsp_rename_preview`, `lsp_incoming_calls`, `lsp_outgoing_calls` (index.ts:516-527). Each is `execute()`-driven with its own zod schema — "find all refs of X" is exactly `lsp_references` (index.ts:321, description literally says *"PREFER over grep when answering 'where else is this symbol used?'"*). Plus 4 more via ADR-0141 (`lsp_code_action`, `lsp_rename_apply`, `lsp_format`, `lsp_signature_help`, index.ts:41-88).
- **Registration knob exists.** `QUANTA_LSP_TOOLS=full` (README:43, ADR-0024) registers them; default-OFF, registry byte-identical when unset. The push-observation kernel (jul-06, `src/agent/lsp-diagnostics-hook.ts:115`) is a *separate* modality, not the *only* one.
- **MCP-server modality is ALSO live.** `src/mcp/server-builder.ts:2` (TICKET-19 reverse-MCP) exposes quanta's own tools to external MCP clients, per-tool opt-in via `QUANTA_MCP_SERVER_EXPOSE` (server-builder.ts:14,66). An operator who wants Codex-style `codex-lsp-mcp` *literally does* `QUANTA_MCP_SERVER_EXPOSE=lsp_definition,lsp_references,…` and gets an MCP server exposing the LSP nav tools. No new surface required.

**Verdict: ALREADY-BUILT** on both axes (agent-callable tool *and* MCP-server exposure). The only honest residue is the audit's own "measure whether call-on-demand beats push-observation" — that is a *measurement receipt*, not a build. **DROP the build. File the measurement as an Open-Q.**

### A-GAP-2 — hook append-context channel → **PARTIAL. Thin BUILD: external command-hook stdout→append bridge only.**

- **In-process append-context is FULLY BUILT and already trust-gated.** `src/agent/hooks/event-types.ts:171` (ADR-0133) `HookPromptInject{injectAfterSystem?, injectBeforeUser?}` — exactly Claude's `additionalContext`/`systemMessage` append channel, distinct from deny/rewrite. Wired end-to-end: producers (`lsp-diagnostics-hook.ts:115`, `no-patch-breaker-adapter.ts:50`, `plan-enter-wire.ts:31`), per-side budget accumulation with FIFO trim (`hooks.ts:101,660-677`), and folding into the prompt (`prompt.ts:328,557`). **Trust-gating already present**: `injectBeforeUser` is wrapped via `embedUntrusted("hook-context", …)` (`prompt.ts:565-569`) so an inner `</hook-context>` is defanged.
- **The narrow real gap:** the *external* command-hook path (a spawned process emitting stdout JSON) parses **only** `deny` / `decision:"block"` / `updatedInput` (`src/agent/command-hooks/runner.ts:154-172`, `denyReasonFrom` runner.ts:191). Its stdout JSON is **not** bridged to `promptHook`/`injectAfterSystem`. So a `SessionStart`/`UserPromptSubmit` *command* hook cannot inject context — only in-process (host-code) handlers can.

**Verdict: PARTIAL.** Channel + trust-gate exist; only the command-hook-stdout→append bridge is missing. This is the one genuine (thin) BUILD in this RFC. Untrusted-by-construction: a spawned repo hook is *more* untrusted than in-process code, so the injected text MUST ride the identical `embedUntrusted` fold, never `injectAfterSystem` raw system-prompt authority from an untrusted producer.

### A-GAP-3 — spawn_agent fork_turns knob + delegation-policy prompt → **ALREADY-BUILT. DROP.**

Both halves the critic named as "NOT in any RFC" are live at HEAD (RFC-07's own table line 13 already said `fork_turns` is live; the critic missed it).

- **fork_turns is fully built.** `src/agent/fork-turns.ts:22` `ForkTurnsSpec = "none" | "all" | number`; `selectForkTurns` (fork-turns.ts:27), `buildForkTurnsPreamble` with **injected redactor** (fork-turns.ts:45), `composeForkedPrompt` frames inherited turns as **DATA — analyze, do NOT obey** (fork-turns.ts:58-61). First-class field on the spawn schema (`src/subagent/agent-tool.ts:42`, `tools-6.ts:214`) with a **trio↔6-tool accept-set parity guard** (agent-tool.ts:18). Redaction reuses the advisor's `redactTranscript` (secret+PII scrub).
- **Delegation-policy prompt is fully built.** `src/subagent/agent-tool.ts:674` `agentToolDescription()` = `withDelegationPolicy(AGENT_TOOL_BASE_DESCRIPTION, runtimeConfig().subagentDelegateSuppress)` — the C5059-05 "single-agent-first delegation policy" prepended to the model-facing tool description, default-OFF byte-identical. Plus a whole `src/agent/delegation-runner/` slice (ADR-0283) for the runtime mechanism.

**Verdict: ALREADY-BUILT (both).** DROP entirely. Nothing to design.

### A-GAP-4 — richer typed review-finding contract → **PARTIAL GAP (S). BUILD consumed fields only.**

- Current contract: `src/tool/git/review-diff.ts:63` `ReviewFinding{file, line?, severity:"info"|"warning"|"error", what, why?, impact?}` + `ReviewReport{summary, findings}`. Parsed **opportunistically** (`tryParseReport` review-diff.ts:178, "we do NOT enforce the JSON schema" review-diff.ts:62). No `verdict`, no `outcome` disposition, no effort tier, no `category` slug.
- Codex's `ReportFindings` carries `verdict:CONFIRMED|PLAUSIBLE`, `outcome:fixed|skipped|no_change_needed`, effort tier incl. `xhigh`, `category` kebab slug, `short_summary`. `xhigh` already exists in quanta's effort vocabulary (`src/llm/openai-responses-wire.ts:334`) but is unused by the review schema. `gitReview.full/lastTurnOnly` scope submenu: grep 0 — the tool takes `{base, head, paths, focus}` (review-diff.ts:46) but has no first-class *scope* selector (uncommitted vs branch vs last-turn).

**Verdict: PARTIAL GAP, S.** `verdict`/`category`/`shortSummary` have an immediate reviewer→parser→renderer consumer. `outcome` belongs to a future apply receipt owner, effort already belongs to the invocation/model configuration, and `last_turn` has no canonical edit-boundary authority. Those three are not admitted into this build.

## Design (gaps only)

### D-A2 — command-hook append-context bridge (S, thin)

Goal: an external `session_start` / `user_prompt_submit` command hook can inject *additive* context (env facts, repo state) via stdout JSON, reusing the existing `HookPromptInject` channel — never a new inject site.

Boundary:
- Extend `parseVerdict` in `src/agent/command-hooks/runner.ts` (the `runner.ts:154` stdout-classifier) to ALSO recognize a `{additionalContext: string}` (Claude alias) / `{injectBeforeUser?: string, injectAfterSystem?: string}` field on exit-0 stdout JSON, projecting it into the existing `CommandHookVerdict` as an optional `promptHook` carrying a `HookPromptInject`.
- The `CommandHookVerdict` (`src/agent/command-hooks/types.ts:94`) gains an optional `promptHook?: HookPromptInject`. The command-hook→HookBus adapter forwards it onto the same `HookEmitResult.promptHook` accumulator the in-process path already fills (`hooks.ts:705`). **Zero new inject site**; the existing `prompt.ts` fold consumes it.
- **Trust rule (HARD):** an untrusted command-hook's text is bridged **only** onto `injectBeforeUser` (the `embedUntrusted`-wrapped user-side channel, prompt.ts:565), never `injectAfterSystem` (raw system-prompt authority). `additionalContext` from a spawned process maps to `injectBeforeUser`. A command hook cannot obtain system-prompt authority. (In-process host code keeps `injectAfterSystem` because it is trusted-by-construction.)
- Inherit the existing command-hook **trust/approval gate** (`command-hooks/review-store.ts` hookBindingKey SHA-256, deny-on-doubt for un-approved bindings, runner.ts:225): an un-approved binding is HELD, so an unreviewed repo hook cannot inject context either.

Owner files: `src/agent/command-hooks/runner.ts` (parse+project), `src/agent/command-hooks/types.ts` (verdict field), the command-hook→HookBus adapter (`command-hooks/index.ts`). No new file strictly required.

### D-A4 — consumed review-finding fields only (S)

Goal: `git_review_diff` findings carry the consumed audit fields `verdict`/`category`/`shortSummary`, backward-compatible with the current shape and the opportunistic parse.

Boundary:
- Extend `ReviewFinding` (review-diff.ts:63) with **optional** fields: `verdict?: "confirmed" | "plausible"`, `category?: string` (kebab slug, free-string not enum — categories are open-ended), `shortSummary?: string`. Keep `severity` as the required closed union.
- **The consumed closed union gets the drift-guard.** `verdict` gets a `Record<Verdict, …>` exhaustive-classification guard so adding a member without handling it fails compile. `severity` already has its manual guard (review-diff.ts:144); do not churn it solely for style.
- **Do not add dead ownership.** `outcome` is PARKED until the hunk-apply/receipt owner can emit it. Effort remains invocation metadata. A `last_turn` scope is PARKED until a durable, canonical edit-batch boundary exists; no fallback to `working`. Existing explicit `{base, head, paths}` remains the review-scope authority.
- Parser (`parseOneFinding` review-diff.ts:139) projects the new optional fields the same opportunistic way (present+well-typed ⇒ kept; else omitted). Renderer (`renderReport` review-diff.ts:189) shows `verdict`/`category` when present. **Byte-identical output when the reviewer emits the old shape** (all new fields optional).

Owner files: `src/tool/git/review-diff.ts` (finding type, parse, render, reviewer prompt). A new pure leaf is allowed only if the 150-line function/god-code ratchet forces extraction; it may not become a second finding-schema owner.

## Trust + safety

- **A-GAP-2 bridge is the only new trust surface.** Command-hook stdout is untrusted-by-construction (a repo-shipped script). Two independent fences already gate it and MUST be reused, not bypassed: (1) the SHA-256 binding-approval / deny-on-doubt gate (runner.ts:225) blocks unreviewed hooks entirely; (2) `embedUntrusted` (prompt.ts:565) defangs boundary-injection. The bridge adds the constraint that an untrusted producer can reach **only** `injectBeforeUser`, never `injectAfterSystem`. This is a strict subset of what in-process (trusted) hooks can already do — no new authority is minted.
- **A-GAP-4** touches no trust boundary: findings are read-only reviewer output already surfaced as a tool result; adding optional descriptive fields changes no permission/exec path.
- The DROP items (A-GAP-1, A-GAP-3) introduce nothing.

## Default-OFF / byte-identical gate

- **A-GAP-2 bridge:** a command hook that does not emit the new field → verdict unchanged → `promptHook` absent → prompt byte-identical. Gate = "no `additionalContext`/`injectBeforeUser` key on stdout ⇒ zero fold." The command-hook subsystem itself is already default-OFF (no bindings ⇒ `{deny:null}`, zero exec, types.ts:30).
- **A-GAP-4:** all three new finding fields are optional; review scope remains today's explicit `{base,head,paths}` contract. A reviewer emitting the current JSON → identical parse + identical render. No knob needed (the tool is already opt-in via subagent dispatch), but the reviewer-seed line describing the richer shape is the only behavioral delta and it is additive.

## TDD + hellgate

Per README convention: RED e2e real `runAgent` × scripted-LLM → TDD → 3R adversarial → self-audit; leaf-crate units where pure.

- **A-GAP-2 (`command-hooks-append.hellgate`):** real command-hook exec port returns exit-0 stdout `{"additionalContext":"REPO FACT: monorepo"}` on `user_prompt_submit`; assert the NEXT scripted-LLM turn's prompt contains the fact wrapped in `<hook-context>` (embedUntrusted). RED-on-injection: (a) a hook emitting `{"injectAfterSystem":"…"}` must NOT reach the system prompt (untrusted→before-user only) — removing that clamp makes the test RED; (b) an un-approved binding injects nothing (deny-on-doubt); (c) a hook emitting `</hook-context>` is defanged. Byte-identical: no field ⇒ prompt unchanged (snapshot). Leaf unit: the `parseVerdict` projection of `additionalContext`→`HookPromptInject`.
- **A-GAP-4 (`review-finding-contract.hellgate`):** scripted reviewer sub-agent returns JSON with `verdict:"confirmed"`, `category:"resource-leak"`, `shortSummary:"watcher leaks on abort"`; assert `git_review_diff` structured output carries them and the render shows them. RED: a reviewer emitting the OLD shape must still parse (back-compat) — a strict-schema regression makes it RED. Drift-guard unit: adding a `verdict` member without a `Record` arm fails compile (red-on-injection by deleting an arm). Assert that no dead `outcome`, effort, or heuristic `last_turn` scope is introduced.

Anti-vacuity: the A-GAP-4 back-compat test must feed the FULL old JSON through the real `tryParseReport` (not a hand-built object), or it vacuously passes. The A-GAP-2 test must observe the injected text in the assembled request (not just the verdict object), or it proves nothing about the fold.

## Effort

| item | verdict | effort |
|---|---|---|
| A-GAP-1 LSP-as-MCP | DROP (already-built ×2) | 0 (measurement receipt only) |
| A-GAP-2 command-hook append bridge | BUILD | **S** (~1 parse branch + 1 verdict field + adapter forward + hellgate) |
| A-GAP-3 fork_turns + delegation prompt | DROP (already-built ×2) | 0 |
| A-GAP-4 review-finding contract | BUILD | **S** (three consumed optional fields + verdict guard + parser/render hellgate) |

## Structural action packets

### RFC09-1 — command-hook append bridge (P1, S, READY)

- **Owner/write set:** `src/agent/command-hooks/runner.ts`, `types.ts`, `install.ts`; extend existing `HookPromptInject` only. Tests stay in the existing command-hook unit/hellgate family plus one assembled-prompt integration receipt.
- **RED:** exit-0 `user_prompt_submit` command stdout `{"additionalContext":"REPO FACT"}` does not appear in the next assembled model request; `injectAfterSystem` from the same process must never reach system authority.
- **GREEN rail:** `bun test tests/unit/command-hooks-hellgate.test.ts tests/unit/command-hooks-trust-gate-hellgate.test.ts tests/unit/command-hooks-fail-closed-adversarial-hellgate.test.ts` plus the new assembled-prompt integration test, then `bun run typecheck` and `bun test tests/unit/god-code-ratchet.test.ts`.
- **DoD:** approved binding only; exact user-side `promptHook` projection; `embedUntrusted` boundary observed in the real request; deny/rewrite/neutral paths byte-identical without the new field.
- **Stop:** any second prompt accumulator/inject site, repo hook→system prompt path, approval bypass, unbounded stdout/context, or source-text-only proof.

### RFC09-2 — review finding consumed fields (P2, S, READY)

- **Owner/write set:** `src/tool/git/review-diff.ts`; extend the existing `ReviewFinding` parser/renderer and reviewer prompt. No review store, scope resolver, or apply receipt owner.
- **RED:** real reviewer JSON carrying `verdict/category/shortSummary` loses those values through `tryParseReport` or model-visible render; the complete old JSON shape must remain accepted.
- **GREEN rail:** `bun test tests/unit/tool/git-review-diff.test.ts tests/integration/git-review-diff-e2e.test.ts`, then `bun run typecheck` and `bun test tests/unit/god-code-ratchet.test.ts`.
- **DoD:** consumed optional fields round-trip through the real parser and renderer; verdict exhaustive guard compiles; old output is byte-identical; no dead `outcome`/effort/scope field.
- **Stop:** strict-schema migration, duplicate finding contract, category enum, inferred last-turn base, or fallback from an unavailable scope.

## Risks + traps

- **Trap: re-DROP litigation.** The temptation is to "build LSP-as-MCP anyway." Stop rule: `QUANTA_LSP_TOOLS=full` + `QUANTA_MCP_SERVER_EXPOSE` already ship both modalities; a new surface is duplicate development. Reject.
- **Trap: A-GAP-2 injecting system-prompt authority from a repo script.** The whole point of the bridge is *additive user-side context*; letting a command hook write `injectAfterSystem` is a privilege-escalation hole. HARD constraint: untrusted producer → `injectBeforeUser` only.
- **Trap: A-GAP-4 schema churn / drift.** `verdict` carries a compile-time all-members guard. `category` stays free-string. `outcome`, effort, and `last_turn` scope remain absent until their real owners exist.
- **Trap: vacuous back-compat.** A-GAP-4's back-compat proof must round-trip real old JSON through the real parser.
- **Trap: byte-identical regression.** Both builds are additive+optional; the gate-OFF snapshot (no new field / old reviewer shape) must be captured on the same revision.

## Sequencing / deps

- **A-GAP-2** depends on nothing new; reuses the command-hook subsystem + HookBus accumulator + `prompt.ts` fold that already exist. Land independently.
- **A-GAP-4** depends on nothing new; reuses the isolated reviewer subagent. Land independently.
- The two are file-disjoint (`command-hooks/*` vs `tool/git/review-diff.ts`) → parallelizable. Final verification owner-local per README convention.
- No dependency on RFC-01..08; this RFC is a pure residue-closer.

## Polish-triage table (~11 items — grep-confirmed, NOT designed)

Every one grep-confirmed at HEAD (all returned 0 unless noted). Verdicts: **BUILD-trivial** / **PARK** / **DROP(already-built)** / **DROP(absent, sub-threshold)**.

| item | grep result | verdict |
|---|---|---|
| `afkTimeoutMs` (ask-user auto-resolve when away) | absent (`src/tool/ask-user/` has label/description/preview, no afk/annotations) | **PARK** — needs a real "user away" signal source (headless already returns typed `headless-denied`, ask-user.ts:7); no consumer today |
| per-option `annotations` (ask-user) | absent | **DROP(absent, sub-threshold)** — 1 display-only field; ride a future ask-user touch, not RFC-worthy |
| PermissionUpdate remove/replace algebra (`removeRules`/`replaceRules`/`removeDirectories`/`addDirectories`) | absent (grep 0 in `src/rules`,`src/permission`) | **PARK** — runtime rule *mutation* algebra is a design-completeness item with no current consumer; rules are add-and-match by design |
| CodexErrorInfo closed error enum (`cyber_policy`/`session_budget_exceeded`/`sandbox_error`) | absent | **PARK** — a `Record<Union>` error taxonomy fits the drift-guard culture but has no forcing consumer; park until an error-routing site needs it |
| `reviewDelivery` inline/detached toggle | absent | **DROP(absent, sub-threshold)** — the isolated reviewer already provides detached delivery without context pollution (`review-diff.ts:8`); no renderer consumer exists for a toggle |
| `addFileToThread` (whole-file attach) | absent | **DROP(absent, sub-threshold)** — `@`-mention + read tool already attach files; a title-bar affordance is renderer chrome |
| `present_to_user` deliverable flag on writes | absent | **DROP(absent, sub-threshold)** — 1 boolean marker; no behavioral change, pure UX hint |
| `ScheduleWakeup` dynamic pacing (`/loop` interval-fixed) | `/loop` fixed; model self-pace exists for LLM requests only (`llm/types.ts:294` adaptive) not for loop cadence | **PARK** — needs a measured consumer requiring model-chosen delay; `/loop`+reactor cover the current need |
| `ReadMcpResourceDir` (directory resource listing) | absent | **DROP(absent, sub-threshold)** — MCP has resource read; directory-listing variant is a thin MCP-client add, no consumer |
| seeded read-state (CLAUDE.md pre-loaded into read-dedup) | read-dedup cache EXISTS (`readFileState`/`rangeDedupCap`, composition snapshot) but no seeding | **DROP(absent, sub-threshold)** — dedup machinery is built; pre-seeding is a micro-ergonomic, no measured win |
| MemoryCitation (cite a memory in output) | absent | **DROP(absent, sub-threshold)** — memory recall injects context (README §메모리); citing the source id is a niche provenance affordance |
| Fast-mode one-key preset | absent (no `fast` preset) | **DROP(absent, sub-threshold)** — subsumed by RFC-08 P7 (named multi-axis profiles, PARKED) + the effort-cycle keybind (RFC-08 BUILD-1); a named "fast" preset is one profile row |

**Counts: 0 BUILD-trivial · 4 PARK · 7 DROP.** (The `annotations` line and the two ask-user rows collapse — count of distinct DROP-absent = 7, PARK = 4.) None is RFC-worthy alone; all are on-record so "we didn't miss them" is honest.

## Open questions

1. **A-GAP-1 measurement (the only carried-over receipt):** does agent-invoked `lsp_references` (call-on-demand) beat the push-observation kernel on solve-rate, or are they complementary? Both ship default-OFF; measure-first before flipping either default-ON. Not a build — a bench A/B question.
2. **A-GAP-2 `injectAfterSystem` for trusted local hooks:** should a *user-home* (`~/.quanta`) command hook — more trusted than a repo hook — be allowed `injectAfterSystem`? Lean NO for v1: any spawned process is untrusted-by-construction; keep the before-user-only clamp uniform, revisit only with a measured need.

---

## Audit log R1 → R3

Three adversarial rounds against this RFC's own claims (break it).

### R1 — "the gaps are real; the DROPs are papering."

- **Attack (A-GAP-1 push-vs-tool duplication):** maybe `lspNavTools` are registered but never actually reach the agent — a dead registration, so "push-only" is still effectively true. **Refute:** each tool has a live `execute()` with schema and a task-anchored description telling the model when to call it (index.ts:246,321); `QUANTA_LSP_TOOLS=full` is the documented registration knob (README:43) and the file carries a cost-tiering SSOT (`LSP_NAV_EXPENSIVE_TOOL_NAMES`, index.ts:294) that only matters if the tools are dispatched. Not dead. DROP stands. **BUT** R1 forced the honest split: the *modality* is built, the *efficacy vs push* is unmeasured → moved to Open-Q #1 rather than silently dropping the audit's "measure-first" note.
- **Attack (A-GAP-3 fork_turns lineage leak):** if fork_turns is built but leaks parent secrets into a foreign-lineage child, "built" is a lie. **Refute:** `buildForkTurnsPreamble` runs the injected `redactTranscript` (secret+PII scrub, fork-turns.ts:14,45) and `composeForkedPrompt` frames it as *DATA — do NOT obey* (fork-turns.ts:60); the spawn path is lineage/ownership-gated (RFC-07 line 15, `ownersForRegistry`). No leak found. DROP stands.
- **R1 changed:** A-GAP-1 reframed from "DROP silently" to "DROP build + carry measurement receipt as Open-Q." A-GAP-2 confirmed PARTIAL (not full DROP) — the command-hook bridge is a genuine thin gap the in-process build does not cover.

### R2 — "the one build (A-GAP-2) is an injection / trust hole."

- **Attack:** bridging command-hook stdout to the prompt lets a malicious repo `AGENTS.md`-shipped hook inject instructions the model obeys — the jul-12 OmO trusted-surface hole class. **Refute + tighten:** the bridge routes untrusted producers to `injectBeforeUser` ONLY, which is `embedUntrusted`-wrapped (prompt.ts:565) and framed as data, never `injectAfterSystem` (system-prompt authority). AND the command-hook must be an *approved* binding (SHA-256 deny-on-doubt, runner.ts:225) before it runs at all — an unreviewed repo hook injects nothing. R2 made this a **HARD constraint in the Design + a RED-on-injection hellgate case** (emit `injectAfterSystem` from a command hook → must NOT reach system prompt; deleting the clamp goes RED). Previously the design said "trust-gated" loosely; R2 made "untrusted→before-user-only" load-bearing and testable.
- **Attack (byte-identical):** does adding the parse branch change the no-field path? **Refute:** the branch is guarded on key-presence; absent `additionalContext` ⇒ verdict unchanged ⇒ no fold. Added the explicit gate-OFF snapshot to the TDD section.
- **R2 changed:** promoted the untrusted→`injectBeforeUser`-only rule from prose to a HARD design constraint + a red-on-injection hellgate; retained the open question on whether trusted home-dir hooks get `injectAfterSystem` (lean NO).

### R3 — "A-GAP-4 is schema churn/drift; the polish DROPs are wrong-DROPs; tests are vacuous."

- **Attack (review-schema drift):** adding `verdict`/`outcome`/`category` invites uncontrolled schema growth and the same drift the culture forbids. **Refute + tighten:** only fields with immediate reviewer→parser→renderer consumers are admitted. `verdict` carries an exhaustive `Record<Union>` guard; `category` stays **free-string**; `outcome`, effort, and `last_turn` stay parked with their missing owners named.
- **Attack (vacuous back-compat):** A-GAP-4's "old shape still parses" could pass against a hand-built object while the real parser rejects. **Refute:** made the anti-vacuity rule explicit — the back-compat test feeds the FULL old JSON string through the real `tryParseReport` (review-diff.ts:178), and A-GAP-2's test must observe injected text in the assembled request, not the verdict object.
- **Attack (polish wrong-DROPs):** maybe one of the 11 "absent" items is actually built (graveyard risk). **Refute:** re-grepped each; `seeded read-state` surfaced a real nuance — the read-dedup *cache* IS built (`readFileState`/`rangeDedupCap`) though *seeding* isn't, so that row is DROP-sub-threshold not DROP-already-built. `Fast-mode` correctly folds into RFC-08 P7 (parked) — reclassified from standalone to "subsumed." `reviewDelivery` folds into A-GAP-4 (the isolated reviewer already IS "detached"). No item flipped to a missed build.
- **R3 changed:** open-string vs closed-union split for A-GAP-4; dead outcome/effort/scope fields removed; anti-vacuity rules made explicit for both builds; polish table corrected (`seeded read-state` cache-built nuance, `Fast-mode`→P7 subsumption, `reviewDelivery`→A-GAP-4 fold).

**Convergence:** after R3 no attack survives. Final scope: **2 DROP (A-GAP-1, A-GAP-3 — grounded already-built), 2 BUILD (A-GAP-2 command-hook append bridge S, A-GAP-4 consumed review fields S), polish 0 build / 4 park / 7 drop.** The README's "100%" becomes honest by accounting: the residue is real, tiny, and mostly already in the tree.
