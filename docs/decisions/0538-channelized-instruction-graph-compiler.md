# ADR-0538 — Channelized Instruction Graph Compiler (prompt-as-compiled-primitives)

**Status:** Accepted (jul-10)
**Supersedes/extends:** ADR-0326 (system-prompt session cache), the jul-4 3-axis prompt refactor, ADR-0410 (few-shot anchors). Does NOT change the wire shape those established — it makes them the compiler's output contract.

## Context

The system prompt is the highest-leverage artifact (every run). Today it is assembled by `buildSystemPrompt` (static axis slots + a monolithic flat-string tail in `prompt-body.ts`) and `buildTurnContext` (dynamic per-turn channels). Applicability is handled THREE incompatible ways: (1) which list a rule lives in (`CORE_RULES` vs `OWNED_RULES`, which pack), (2) ad-hoc string surgery (`withoutBlocks` for grader-only suppression), (3) nothing — the monolithic tail renders regardless of context and hard-codes assumptions that specific axes invalidate.

A jul-10 contradiction audit found this is structurally fragile: 4 real rule contradictions, each because a tail rule assumed a context (a code-change task, a frozen install-prohibited env, a graded harness) that a posture/mode/pack axis had abolished. They were caught only by MANUAL adversarial audit. Nothing prevents the next one.

Root cause: **rules do not declare WHEN they apply, do not declare what they CONFLICT with, and are not verified against the full reachable context surface.**

## Decision

Model the entire prompt as a graph of **conditioned instruction atoms** compiled into the existing **channelized** wire artifact, with **build-time graph verification** over the real context surface. Breaking internal changes are allowed; the repo's load-bearing invariants are NOT: static cached system prefix, the 4-section cache budget (ADR-0326), dynamic reminder/user-side injection separation, and `promptPolicy`/`PromptAssembledSnapshot` observability.

### Primitive — `InstructionAtom` (declarative, pure)

```ts
type AuthorityLayer =
  | "L1_system" | "L2_runtime" | "L3_app_env" | "L4_permission"
  | "L5_mode" | "L6_repo" | "L7_skill" | "L8_user" | "L9_working_state"

// The 8 real channels (ADR-0326 system sections + the dynamic message channels).
type PromptChannel =
  | "system.base" | "system.project_md" | "system.session_ctx" | "system.user_append"
  | "message.hook_context" | "message.context_update"
  | "message.mention_injection" | "message.system_reminder"

// DECLARATIVE matcher — NOT an arbitrary (ctx)=>boolean. Purity + auditability +
// exhaustive verification require a closed, inspectable facet set. Absent facet =
// "don't care". All present facets AND together.
interface AtomMatcher {
  envPosture?: EnvironmentPosture[]
  promptPack?: PromptPackMode[]
  verifyStrategy?: VerifyStrategy[]
  mode?: AgentMode[]
  // presence facets over the real TurnContextInput surface (P1 review):
  hasRepoRules?: boolean; hasGlobRules?: boolean; hasSessionCtx?: boolean
  hasMemorySummary?: boolean; hasWorkingState?: boolean; hasActiveSkills?: boolean
  hasContextEvents?: boolean; hasMentionInjection?: boolean; hasHookInjects?: boolean
  hasImages?: boolean; brief?: boolean; untrustedEnvelope?: boolean
}

interface InstructionAtom {
  atomId: string           // SEMANTIC id (stable, one per rule)
  variantId: string        // RENDERED-instance id — a semantic atom may have
                           // posture/mode variants with different text
                           // (e.g. R-NO-SHIM frozen vs owned). supersedes/
                           // conflicts/coverage account against variantId.
  authority: AuthorityLayer
  channel: PromptChannel
  section: string          // group + intra-channel order label
  order: number
  lines: readonly string[] // rendered content — NO ADR/Codex citations (those go in provenance)
  when?: AtomMatcher       // absent ⇒ always applies
  supersedes?: readonly string[]   // variantIds this one overrides (owned R-* over frozen R-*)
  conflictsWith?: readonly string[] // variantIds that must NEVER co-render
  requires?: readonly string[]
  provenance?: readonly string[]   // ADR/Codex refs — metadata only, never sent to the model
}
```

### Compiler — multi-channel, not one string (P1 review)

`compile(ctx): CompiledPromptArtifact` where ctx is the FULL `PromptContext` (the axes PLUS the presence facets above).

```ts
interface CompiledPromptArtifact {
  systemSections: PromptSection[]     // the ≤4 cached system.* channels (ADR-0326)
  injectedMessages: Message[]         // hook_context / context_update / mention_injection
  trailingReminder?: string           // the message.system_reminder channel (embedUntrusted)
  manifest: {
    firedAtomIds: readonly string[]
    firedVariantIds: readonly string[]
    suppressed: ReadonlyArray<{ loser: string; winner: string }>  // supersede audit trail
    byChannel: Readonly<Record<PromptChannel, readonly string[]>>
    policy: PromptPolicySnapshot
  }
}
```

Pipeline: `atoms.filter(a => matches(a.when, ctx)) → resolveSupersedes → group by channel → sort by (authority, section, order) → render per channel`. The `system.*` channels feed `fourSectionPreset` (order = cache prefix, never per-turn reorder); the `message.*` channels feed the chronological injection list + trailing reminder — exactly today's shape.

### Cache key — per-channel stable fingerprint, NOT full-ctx (P1 review)

Do NOT key the whole compiled prompt on a full-ctx fingerprint (blows cardinality / tempts leaking per-turn data into the static compile). Each `system.*` section keeps its OWN stable-input fingerprint (base / project_md / session_ctx / user_append), exactly ADR-0326's 4-breakpoint invalidation. `message.*` channels are per-turn and NOT cached. The compiler MUST NOT place a per-turn atom into a `system.*` channel (verified below).

### Build-time verifier — `verifyRuleGraph()` (the SOTA++ core)

Runs over the full reachable `PromptContext` surface (real facets, not a 5-axis reduction — P2 review). It is ADDED alongside the existing exact-phrase / placement / duplicate-count / cache-prefix hellgates, which it does NOT replace (Open-Q resolved: ADD, not replace).

1. **Conflict-freedom** — no two `conflictsWith` variants co-render in the SAME channel, for any reachable ctx. This carries the mutual-exclusivity load for the env-posture + verify-strategy variants: they are CONTRADICTORY, selected by disjoint `when` matchers, and DECLARE their exclusivity with `conflictsWith` so this check witnesses it across every reachable ctx. Red-on-injection: overlap two conflicting atoms.
2. **Supersede soundness + edge integrity** — an applicable superseder must actually suppress its loser (a selectAtoms tripwire), and no `supersedes`/`conflictsWith`/`requires` edge may dangle (target a non-existent variant). Note: the `supersedes` primitive is DORMANT — the shipped variants use disjoint matchers + `conflictsWith` (stronger: co-render is structurally impossible, not suppression-dependent — see the reconciliation note). The integrity half is red-on-injection (edge to a phantom variant).
3. **Coverage** — every variant fires in ≥1 reachable ctx (dead/inert-rule detection).
4. **Cached-section budget** — ≤ 4 live `system.*` cache sections. Checked on the compiled MANIFEST, not the atom graph: every atom rides `system.base`, so the three caller-data sections (`project_md`/`session_ctx`/`user_append`) are only visible on the artifact. (A per-ctx count over atom channels can only ever see `{system.base}` and would be a tautology.) Red-on-injection: a manifest with a 5th live `system.*` section.
5. **Static/dynamic separation** — a per-turn-natured atom (matcher references memory/repo/skills/context-events/etc.) may NOT land in a `system.*` channel.
6. **Authority placement** — L6_repo / L7_skill / L8_user / L9_working_state atoms may NOT occupy `system.base`.
7. **No-hidden-assumption lint** — an atom whose text asserts a context premise (env-blocked, read-only deliverable, hidden-grader, vision-priority, graded-harness) MUST declare the matching matcher facet, else FAIL. BEST-EFFORT (keyword-matched: a premise phrased outside the table is a false-negative — it is a tripwire for the known contradiction phrasings, not a proof). The STRUCTURAL guarantee that contradictory variants never co-render is check (1). Red-on-injection: a premise atom with no facet.
8. **Manifest completeness** — every rendered text span is traceable to a variantId.
8b. **Dynamic-content placement** — a `contentKey` atom must ride `message.system_reminder` with empty `lines`.
9. **Snapshot parity** — the manifest can reconstruct the current `promptPolicy` / `PromptAssembledSnapshot`. Only `system.base` + `message.system_reminder` are atom-bearing; the caller-data channels carry synthetic `SECTION-*`/`MSG-*` presence markers (their content is NOT atomized) and are exempt from atom-traceability.

## Open questions — resolved

- **compile target = buildTurnContext whole** (not just buildSystemPrompt). ⇒ multi-channel artifact, one-string compile rejected.
- **Verifier ADDS to existing hellgates**, does not replace them (exact phrase / placement / dup-count / cache stability remain).
- **Drop** byte-identical golden worship. **Keep** channel semantics + the 4 cache sections + reminder separation.

## Migration (narrow, staged; breaking OK internally)

1. New `src/agent/prompt-graph/`: `AtomMatcher`, `InstructionAtom`, `CompiledPromptArtifact`, pure `matches()`, `compile()`, `verifyRuleGraph()`.
2. Promote `prompt-rules/core.ts` + `verify-strategy.ts` to atoms first: frozen/owned/default become distinct variants selected by DISJOINT `when.envPosture` matchers + a `conflictsWith` edge declaring their mutual exclusivity (NOT `supersedes` — see the reconciliation note; contradictory postures should be structurally non-co-rendering, not suppression-dependent). grader-only suppression becomes `when.verifyStrategy: {not:["grader-only"]}` (delete `withoutBlocks`). Encode the jul-10 contradictions as `conflictsWith` edges — the verifier confirms they no longer co-render.
3. Then atomize the body in order: completion-bar (split into code/env-blocked/read-only variants with matchers), verification-report, honesty, trust/inputs, reporting-shape, mode notices, brief, untrusted-envelope.
4. `buildSystemPrompt` / `buildTurnContext` stay as FACADES over `compile()` (callers unchanged).
5. Add optional `firedAtomIds` / `byChannel` to `promptPolicy` + `PromptAssembledSnapshot` (observability).
6. Keep every existing prompt hellgate; add the `verifyRuleGraph` suite.

## Consequences

- Contradictions become COMPILE errors (no-hidden-assumption lint + conflictsWith), not audit findings.
- Applicability is declarative and inspectable; no monolithic tail with hidden assumptions.
- One SSOT for all prompt content with a fired-atom manifest (observability the current path lacks).
- ADR-0326 cache model, channel separation, and snapshot observability are PRESERVED as the compiler's output contract.
- Cost: a real migration of the highest-leverage artifact. Mitigated by the facade + keeping all existing hellgates + per-ctx snapshot review (not byte-identical golden).

## Post-migration audit reconciliation (jul-11)

A hell-audit of the landed Phase 1–3 corrected these deviations between the ADR's letter and the implementation (each is now honest in code + verifier, none breaks the byte-identical wire):

- **`supersedes` → `conflictsWith` for the env/verify variants.** The ADR proposed frozen/owned/default as `supersedes` edges. The implementation (correctly) selects them with DISJOINT `when` matchers, which made every `supersedes` edge INERT (the loser never co-applies, so nothing is suppressed) and the supersede-soundness check vacuous. Resolved by declaring the mutual exclusivity with `conflictsWith` (the accurate primitive for CONTRADICTORY variants) so the real conflict-freedom check proves it, and hardening the supersede check with dangling-edge integrity. The `supersedes` primitive stays available but DORMANT.
- **`contentByKey` is IMPLEMENTED — the graph is authoritative for the reminder** (jul-11 follow-up). Originally the reminder TEXT was produced by a hand-rolled `buildDynamicContext` sequence while the dynamic atoms only labelled the manifest — an observability SHADOW that could drift (guarded only by a test). Now the compiler's `contentByKey(key, input, …)` resolver maps each atom's `contentKey` to its per-turn wire text via the leaf renderers, and `resolveReminderBlocks` folds over the ONE ordered atom selection to produce BOTH the wire (`buildDynamicContext`) AND the fired-atom manifest — so an atom is "fired" IFF it produced wire text, and the two CANNOT drift by construction (the drift-guard is now a structural guarantee, not a tripwire). Notice atoms share the `dynamic.reminder` section at order 104/106 so one `selectAtoms` sort reproduces the exact wire order. Verified byte-identical across a 70-input pre/post reminder diff.
- **Read-only completion bar is a FORWARD SEAM.** The `BODY-COMPLETION-BAR#read-only` variant renders only when `buildSystemPrompt` gets a read-only `mode`, but no composition-root caller threads `mode` and the session cache builds the prefix bare — so the cached static prefix is mode-INDEPENDENT and the read-only variant does NOT ship today (the split is byte-identical). Wiring needs a mode-aware cache key OR moving the bar onto the dynamic reminder channel (where the mode notice already rides). Deferred (measure-first).
- **Verifier honesty.** The cached-section-budget check was inert over atom channels (all atoms ride `system.base`); it now runs on the compiled manifest where the caller-data sections are visible. Snapshot-parity now exempts the synthetic `SECTION-*`/`MSG-*` caller-data markers (only `system.base` + `message.system_reminder` are atom-bearing). The no-hidden-assumption lint is documented as BEST-EFFORT (keyword-matched); the structural contradiction guarantee is conflict-freedom. Every non-static check names a red-on-injection test.
- **Single completion-bar SSOT + dead-export removal.** The `#code-change` bar sources its text from the one `BODY_AFTER_PROMPT_PACK_COMPLETION_BAR` const (no inline duplicate); the dead `BODY_AFTER_PROMPT_PACK` flat aggregate (no live importer once the atoms render the body) was deleted.
