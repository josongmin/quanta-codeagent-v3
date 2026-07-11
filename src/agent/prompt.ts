import { basename } from "node:path"
import type { Message, SystemBlock } from "@/llm"
import type {
  AgentPromptMode,
  PromptActiveLeversSnapshot,
  PromptHookContextMode,
  PromptPolicySnapshot,
  PromptSummaryPrefix,
  PromptSurfaceProfileSnapshot,
} from "@/shared"
import type { TaskBudget } from "./budget/task-budget"
import { buildPersistentInjectionMessages } from "./context-change"
import type { TurnEnvContext } from "./env-context"
import { type GlobRule, selectGlobRules } from "./glob-rules"
import { assertValidIdentityLines } from "./identity"
import { resolveAgentMode } from "./mode"
import { type PersonaKind, personaLines } from "./persona"
import { INTRO_LINES } from "./prompt-body"
import { type DirectiveConfig, selectActiveDirectives } from "./prompt-directives"
import {
  BODY_AFTER_PERSONA_ATOMS,
  BODY_AFTER_PROMPT_PACK_ATOMS,
  BODY_ATOMS,
  type CompiledPromptArtifact,
  type AgentMode as GraphMode,
  NOTICE_ATOMS as NOTICE_ATOMS_ALL,
  POSTURE_ATOMS,
  type PromptChannel,
  type PromptContext,
  renderAtoms,
  selectAtoms,
  VERIFY_ATOMS,
} from "./prompt-graph"
import {
  buildDynamicContext,
  collectHookPromptSide,
  noticeCtx,
  resolveReminderBlocks,
} from "./prompt-reminders"
import {
  type AgentMode as PromptPackMode,
  renderPostureBase,
  renderTaskRules,
  renderVerifyStrategy,
  type VerifyStrategy,
} from "./prompt-rules"
import {
  buildSectionedSystemBlocks,
  fourSectionPreset,
  type PromptSection,
  validateSectionsCacheBudget,
} from "./prompt-sections"
import { applyPromptStyle, type PromptStyle } from "./prompt-style"
import { type RepoRules, renderRepoRulesBlock } from "./repo-rules"
import { makeSyntheticUserMessage } from "./synthetic-user"
import { embedUntrusted, escapeBoundary } from "./untrusted"
import { UNTRUSTED_ENVELOPE_RULE } from "./untrusted-envelope"
import type { WorkingState } from "./working-state"

/**
 * System prompt + per-turn context assembly.
 *
 * The cache lever (ADR-0003): the system prompt is STATIC for a session —
 * cwd and the tool set do not change mid-run — so it is built once as
 * `SystemBlock[]` with the final block flagged `cache:true`. That makes the
 * prefix byte-identical every turn, which is what both OpenAI's automatic
 * prefix cache and Anthropic's explicit `cache_control` need to hit. Anything
 * that varies per turn (today's date, cwd/git note, plan-mode notice, memory
 * recall) is NOT folded into the system; it rides as a single trailing
 * `<system-reminder>` user message so the cached prefix never shifts.
 */

/** Environment posture (RFC jul-2 TB levers /01) — selects which env
 *  RULE TEXT the model is told, and NOTHING ELSE. `"frozen"` (DEFAULT) = today's
 *  SWE-bench guardrails verbatim (do-not-install / stop-when-env-blocked). `"owned"`
 *  = the surface owns its container, so install/configure/build freely (the
 *  Terminal brain). `"default"` = a general local-dev machine: install-permitted but
 *  NOT graded (the user's OWN repo — the jul-9 `QUANTA_ENV_DEFAULT` CLI knob selects it
 *  so an interactive user is not told "don't install / stop when env-blocked", which are
 *  SWE-bench assumptions false for a developer at their own machine). PROMPT-TEXT-ONLY:
 *  this NEVER touches `SandboxPolicy` / `os-sandbox` / any runtime enforcement — it only
 *  swaps the rendered rule list. */
export type EnvironmentPosture = "frozen" | "owned" | "default"

/**
 * ADR-0538 Phase 2 — build the FULL `PromptContext` for the static-body atom
 * render from `buildSystemPrompt`'s axis opts. The body atoms condition on
 * `verifyStrategy` (grader-only suppression) and `mode` (the completion-bar
 * read-only-vs-code-change split); every other facet is fixed at its
 * static-prefix representative (no static-body atom reads it — presence facets
 * are per-turn and live on the DYNAMIC channels). This replaces the deleted
 * `withoutBlocks` + `GRADER_ONLY_SUPPRESSED_*` string surgery: applicability is
 * now the atoms' declarative `when` matchers.
 */
const bodyRenderCtx = (opts?: {
  envPosture?: EnvironmentPosture
  promptPack?: PromptPackMode
  verifyStrategy?: VerifyStrategy
  mode?: GraphMode
}): PromptContext => ({
  envPosture: opts?.envPosture ?? "frozen",
  promptPack: opts?.promptPack ?? "interactive",
  verifyStrategy: opts?.verifyStrategy,
  mode: opts?.mode ?? "default",
  hasRepoRules: false,
  hasGlobRules: false,
  hasSessionCtx: false,
  hasMemorySummary: false,
  hasWorkingState: false,
  hasActiveSkills: false,
  hasContextEvents: false,
  hasMentionInjection: false,
  hasHookInjects: false,
  hasImages: false,
  brief: false,
  untrustedEnvelope: false,
  hasLanguageHint: false,
  hasEnvBlock: false,
  hasRepoRulesDynamic: false,
  hasTaskBudget: false,
  hasDirectives: false,
})

/** The static system prompt. No per-turn data — keep it byte-stable so the
 *  provider cache prefix holds across the whole session. The legacy `cwd`
 *  parameter is accepted but ignored: cwd is now per-turn dynamic context
 *  (see {@link buildTurnContext}), kept off the cached prefix on purpose.
 *  The param remains so existing callers (apps) compile unchanged until the
 *  loop is migrated to {@link buildTurnContext}. */
export const buildSystemPrompt = (
  _cwd?: string,
  opts?: {
    persona?: PersonaKind
    promptPack?: PromptPackMode
    /** ADR-0198 identity slot — per-mode identity lines spliced BEFORE the
     *  persona slot. Absent / empty array ⇒ no lines, byte-identical to the
     *  pre-ADR base prompt; the slot's contract is "1..=3 single-line
     *  strings", validated at build time. */
    identity?: readonly string[]
    /** Environment posture (RFC jul-2). `"frozen"` / absent ⇒ IDENTICAL code path
     *  as today (byte-identical). `"owned"` ⇒ render {@link renderOwnedRules} in
     *  place of the CORE-based tool-use rules (a NEW, separate axis from the
     *  task-posture `promptPack` / `mode`; posture is env-ownership, not task-mode).
     *  Prompt-text-only — never touches runtime enforcement. */
    envPosture?: EnvironmentPosture
    /** Verify-strategy axis (jul-4, THIRD slot) — how the agent confirms its own
     *  work. Absent ⇒ NO verify rule, byte-identical to today. `reproduce-first`
     *  (SWE) / `verify-after-edit` (general) render one content rule after the task
     *  axis; each rides a default-OFF knob at its entry point (measure-first). TB's
     *  self-test is its own knob + machinery, not this slot. Prompt-text-only. */
    verifyStrategy?: VerifyStrategy
    /** Render STYLE axis (jul-6, FOURTH slot) — `flat` (default / absent) renders
     *  the byte-identical prose-label prompt; `sectioned` promotes the base prompt's
     *  section headers to Codex-style `##` markdown. Prompt-text-only, applied as a
     *  final pure pass over the assembled string (see {@link applyPromptStyle}); the
     *  varying axes (persona / posture / pack / verify) all compose underneath it.
     *  Rides its own default-OFF knob (measure-first before flipping any default). */
    promptStyle?: PromptStyle
    /** ADR-0538 §KEY-TRANSFORM 2 — task mode for the completion-bar split. Absent
     *  / `"default"` ⇒ the CODE-CHANGE completion bar (byte-identical to the
     *  pre-migration single block). A read-only mode (plan/review/audit/architect)
     *  ⇒ the read-only completion-bar variant (the deliverable is the
     *  plan/findings/design). `editor` mutates ⇒ code-change variant.
     *  ⚠️ FORWARD SEAM: no composition-root caller threads `mode` here today, and
     *  the session cache path calls `buildSystemPrompt()` bare — so the cached
     *  static prefix is mode-INDEPENDENT and the read-only variant does NOT ship
     *  yet (the split is byte-identical in practice). See the completion-bar note
     *  in `prompt-graph/atoms-body.ts` for the wiring options (mode-aware cache
     *  key vs. moving it onto the dynamic reminder channel). */
    mode?: GraphMode
  },
): string => {
  // The FULL context the static-body atoms select over (the graph is
  // authoritative for the body). Axes only — presence facets are per-turn.
  const bodyCtx = bodyRenderCtx(opts)
  return applyPromptStyle(
    [
      ...INTRO_LINES,
      // ADR-0198 identity slot — rides BETWEEN the intro and persona so the
      // model sees "who you are in this mode" before "how you talk". When the
      // caller supplies no identity (or an empty array) we emit nothing and
      // the rendered prompt is byte-identical to the pre-ADR base prompt.
      ...identityLines(opts?.identity),
      // ADR-0068 persona slot — `default` (or absent) ⇒ no extra lines,
      // byte-identical to the pre-ADR base prompt; `friendly`/`pragmatic`
      // splice the persona body + a blank-line separator before Policy stack.
      ...personaLines(opts?.persona ?? "default"),
      // ADR-0538 Phase 2 — the AFTER-PERSONA body (policy stack → tool routing) is
      // now DERIVED from the instruction graph (the graph is AUTHORITATIVE — no
      // parallel copy). grader-only suppression that was `withoutBlocks` string
      // surgery is now the atoms' `when.verifyStrategy:{not:["grader-only"]}`
      // matchers; `renderAtoms` selects + orders them. Byte-identical for every
      // posture/pack/verify combination (the sub-block atoms carry the exact prior
      // literal text at the exact prior order).
      ...renderAtoms(BODY_AFTER_PERSONA_ATOMS, bodyCtx),
      // 2-AXIS rendering (jul-4): env posture and task pack are INDEPENDENT slots (the prior
      // XOR — owned XOR pack — is gone; an owned surface can now also carry a task pack).
      // (1) POSTURE-BASE axis — honesty rails + env guardrails, selected by envPosture:
      //     `owned` = install-permitted (OWNED_RULES); `frozen`/absent = SWE guardrails (CORE_RULES).
      //     Byte-identical to the pre-change path: owned == OWNED, frozen == CORE.
      ...renderPostureBase(opts?.envPosture ?? "frozen"),
      // (2) TASK axis — mode-specific narrowing (batch/headless/ci-bot); interactive/ide/absent = none.
      //     A frozen pack == CORE + task rules == the prior `renderPackByMode(pack)` byte-for-byte.
      ...renderTaskRules(opts?.promptPack ?? "interactive"),
      // (3) VERIFY axis — how the surface confirms its own work (reproduce-first / verify-after-edit).
      //     Absent/undefined ⇒ NO lines, byte-identical. Each rides a default-OFF entry-point knob.
      ...renderVerifyStrategy(opts?.verifyStrategy),
      // ADR-0538 Phase 2 — the AFTER-PACK body (vision → completion bar) is DERIVED
      // from the graph too. grader-only suppression (vision body / verification
      // report / whole completion bar) is the atoms' `when.verifyStrategy` matchers;
      // the completion bar is split into a code-change variant (`when.mode:{not:
      // [plan,review,audit,architect]}`) and a read-only variant — exactly one fires
      // per ctx. Byte-identical for the code-change path; the read-only variant is
      // the single intentional new output (only under plan/review/audit/architect).
      ...renderAtoms(BODY_AFTER_PROMPT_PACK_ATOMS, bodyCtx),
    ].join("\n"),
    opts?.promptStyle ?? "flat",
  )
}

/** Spread helper for the identity slot — returns the lines to splice
 *  BETWEEN the intro section and the persona slot. Absent / empty array ⇒
 *  empty result (no lines, no extra newlines) so the rendered prompt is
 *  byte-identical to the pre-ADR base prompt. Non-empty ⇒ validated lines
 *  followed by ONE blank-line separator (same shape as the persona slot
 *  uses to keep section spacing consistent). */
const identityLines = (identity: readonly string[] | undefined): readonly string[] => {
  if (identity === undefined || identity.length === 0) return []
  return [...assertValidIdentityLines(identity), ""]
}

/** Agent interaction mode (Codex `mode-and-plan-process-audit.md` mirror). The
 *  mode controls tool availability and the shape of the per-turn reminder;
 *  Phase 3 extends `plan` with structured choice + update_plan state and adds
 *  the `review` / `audit` task postures. Absent / "default" ⇒ legacy
 *  assume-and-execute posture (byte-identical).
 *
 *  ADR-0211 widens the enum with two posture-only variants:
 *    - `architect` — deep-reasoning READ-ONLY posture (mutating tools blocked by
 *      mode.ts fail-closed default, identical to plan/review/audit). Tone: design
 *      first, propose, no edits.
 *    - `editor`    — minimal-diff MUTATING posture; favors `edit` over `write`,
 *      tight surgical changes only. Mutating ALLOWED (explicit add to
 *      MUTATING_MODES in mode.ts).
 *
 *  Adding values to this union is BACKWARD-COMPATIBLE: existing 4-mode callers
 *  still typecheck; new modes default to fail-closed in `mode.ts`'s admissibility
 *  gate unless explicitly added to `MUTATING_MODES`. */
export type AgentMode = AgentPromptMode

export interface TurnContextInput {
  baseMessages: Message[]
  cwd: string
  /** Explicit mode. Preferred over the legacy `planMode` boolean. When both are
   *  set, `mode` wins. Absent ⇒ derived from `planMode`. */
  mode?: AgentMode
  /** Legacy plan-mode flag. Kept for callers that have not migrated. When
   *  `mode` is absent and `planMode` is true, effective mode is `"plan"`. */
  planMode?: boolean
  /** N1 — pre-computed assistant-language notice (default-OFF `QUANTA_LANG_DETECT`).
   *  Built by the context-assembler from the latest user message via
   *  `buildLanguageHint`. Absent ⇒ no language notice (byte-identical). */
  languageHint?: string
  memoryContext?: string
  /** Repo-local rule body to inject ahead of memory hints as repo authority
   *  (Codex `repo-local-rule-ingestion-audit.md` mirror). Absent ⇒ no block,
   *  byte-identical for callers that don't wire the loader. */
  repoRules?: RepoRules
  /** File-scoped rules (Cursor `.cursor/rules/*.mdc` parity). The FULL loaded
   *  set; the per-turn selection (alwaysApply ∪ glob-matched) is computed here
   *  from `changedPaths`. Absent / empty ⇒ no block, byte-identical for callers
   *  that don't wire the loader. */
  globRules?: GlobRule[]
  /** Files in play this turn — drives glob-rule selection. A glob rule injects
   *  only when one of these matches its globs; `alwaysApply` rules ignore it.
   *  Absent ⇒ only `alwaysApply` glob rules ride (no glob can match). */
  changedPaths?: string[]
  /** Active skills discovered for this session (Codex `skills-audit.md` mirror).
   *  Each entry is the skill `{name, description}` — the body is loaded lazily
   *  via the `Skill` tool (progressive disclosure). Rendered as the "## Active
   *  skills" block in the per-turn reminder so the model sees the catalogue
   *  AND the trigger rules every turn without paying the body cost upfront.
   *  Plain shape (no @/skill type leak); absent or empty ⇒ no block,
   *  byte-identical for callers that don't configure skills. */
  activeSkills?: { name: string; description: string }[]
  /** Per-turn working state (Codex memory L3). Renders BELOW repo-rules and
   *  ABOVE memory hints. Absent or empty ⇒ no block (byte-identical). */
  workingState?: WorkingState
  /** Caller-provided static base prompt. Set once per session and never
   *  mutated per turn, so it stays a byte-stable cache prefix. Absent ⇒ the
   *  built-in {@link buildSystemPrompt}. */
  system?: string
  /** Declared surface prompt axes for this session. Observation-only:
   *  forwarded into `promptPolicy` so turn telemetry can report the active
   *  prompt profile without scraping prompt text. */
  promptSurfaceProfile?: PromptSurfaceProfileSnapshot
  /** Presence-only runtime lever snapshot for this turn/session. */
  activeLevers?: PromptActiveLeversSnapshot
  /** Caller-supplied STATIC session context (e.g. tool inventory hash, surface
   *  flag, install id). Rides the 4-section preset as the `session_ctx`
   *  breakpoint when present (Claude Desktop 1.7196 pattern). Per-turn dynamic
   *  data (date, cwd, plan notice) does NOT belong here — that stays in the
   *  trailing `<system-reminder>` user message. */
  sessionCtx?: string
  /** Distilled `memory_summary.md` body loaded once per session start. When
   *  present it shares the cached `session_ctx` section with `sessionCtx`
   *  under the untrusted-aggregate wrapper from `fourSectionPreset`. */
  memorySummaryMd?: string
  /** User-supplied STATIC prefix (e.g. global `~/CLAUDE.md` body). When set,
   *  buildTurnContext activates the 4-section preset and pins `user_append`
   *  as a distinct cache breakpoint so changes here only invalidate the tail.
   *  Absent ⇒ legacy single-block prefix (byte-identical). */
  userAppend?: string
  /** Injected clock so replay / unit tests get a deterministic
   *  `Today's date is YYYY-MM-DD.` line in the per-turn dynamic block.
   *  Defaults to {@link Date.now} (production behavior byte-identical for the
   *  current moment). Same `opts.now ?? Date.now` pattern as
   *  `src/agent/admissibility-gate.ts` and `src/memory/consolidate/writer.ts`. */
  now?: () => number
  /** ADR-0133 — accumulated `promptHook` responses from hook handlers that
   *  fired since the LAST turn-context build (drained by the caller). Each
   *  entry's `injectAfterSystem` is folded into the dynamic system-reminder
   *  block (TAIL — closest to the user's input); `injectBeforeUser` is
   *  rendered as a SEPARATE user-side `<hook-context>` message inserted
   *  immediately BEFORE the dynamic reminder. The dynamic reminder still
   *  rides at the tail.
   *
   *  Cache discipline: hook injects ride in the per-turn user-side reminder,
   *  NEVER on the cached static `SystemBlock[]` prefix. A hook that wanted
   *  to permanently modify the cached prompt would have to flow through
   *  `system`/`userAppend` (caller-owned). This keeps cache hits stable
   *  across hook activity.
   *
   *  Absent or empty array ⇒ no block, byte-identical to the pre-ADR-0133
   *  path. */
  hookPromptInjects?: readonly import("./hooks").HookPromptInject[]

  // ─── ADR-0327 wire seam (Codex r2 absorption) ──────────────────────────────
  //
  // Three orthogonal optional channels that, when ALL absent, leave the
  // `system` array and `messages` array byte-identical to the legacy path.
  // The byte-identical invariant is pinned by hellgate (`prompt-adr-0327-
  // wire-hellgate.test.ts`).

  /** ADR-0326 — session-scoped system-prompt cache. When both `systemPromptCache`
   *  and `systemPromptCacheKey` are present AND `system` is absent (i.e. the
   *  default `buildSystemPrompt()` would otherwise be re-invoked every call),
   *  buildTurnContext routes the base-prompt resolution through
   *  `cache.getOrBuild(key, buildSystemPrompt)` so iterations within the same
   *  session reuse a memoized string. The cached text is byte-identical to the
   *  un-cached call, so the rendered `SystemBlock[]` prefix is unchanged. */
  systemPromptCache?: import("@/llm/system-prompt-cache").SystemPromptCachePort
  systemPromptCacheKey?: import("@/llm/system-prompt-cache").SystemPromptCacheKey

  /** ADR-0321 — persistent context-change typed events. Each event renders as
   *  a `<context-update>` (or sibling envelope) user-role message and is
   *  spliced AFTER `baseMessages` (+ any hook-context) and BEFORE the trailing
   *  `<system-reminder>` so the model reads state transitions as chronological
   *  pre-turn signals. Empty / absent ⇒ no splice, byte-identical. */
  contextChangeEvents?: readonly import("./context-change").ContextEvent[]

  /** ADR-0325 — already-built mention-injection user messages (from
   *  `buildMentionInjectionMessages`). Spliced into the same slot as
   *  `contextChangeEvents`, AFTER any context-change messages so the
   *  chronological order is `context-update → mention-injection → reminder`.
   *  Empty / absent ⇒ no splice, byte-identical. */
  mentionInjectionMessages?: readonly Message[]

  /** ADR-0397 — per-turn env / build dynamic context (platform / shell /
   *  git-status / pkg-mgr). Mirrors the clock-injection pattern
   *  ({@link now}): when ABSENT or fully empty, buildDynamicContext emits
   *  ZERO new bytes (byte-identical to the pre-ADR-0397 path); when present,
   *  the renderer is a pure function of the provided fields (replay
   *  deterministic). The live probe lives in
   *  `src/agent/env-context.ts#probeTurnEnv` — opt-in, caller-invoked. */
  env?: TurnEnvContext

  /** jun-02 — Soft, MODEL-FACING task budget (Claude `task_budget` mirror).
   *  When present with `tokens > 0`, buildDynamicContext appends a single
   *  self-moderation guidance line to the dynamic-context TAIL showing the
   *  REMAINING task budget (`tokens − spent`). This is ORTHOGONAL to the hard
   *  `BudgetMeter` enforcement breaker (ADR-0138): it NEVER stops the run,
   *  never throws, and is explicitly labelled "guidance, not a hard limit".
   *  Absent / `tokens <= 0` ⇒ ZERO new bytes (byte-identical default-OFF). */
  taskBudget?: TaskBudget

  /** ADR-0471 — untrusted-source-envelope system rule gate. When true, the
   *  `UNTRUSTED_ENVELOPE_RULE` is appended to the STATIC base prompt section so
   *  the model is taught to read `<untrusted-source name="...">` envelopes as
   *  DATA, never instructions. This MUST track the SAME
   *  `runtimeConfig().untrustedEnvelope` gate the dispatch wrap site
   *  (`src/agent/dispatch.ts`) reads: resolving BOTH from the loop (the one env
   *  reader allowed in @/agent) guarantees the rule and the result-wrapping
   *  engage together — the model never sees a wrapped tool result without the
   *  rule that explains the envelope. Absent / false ⇒ no append, byte-identical
   *  default-OFF; the rule rides the `base` cache breakpoint so the
   *  4-breakpoint budget is untouched. */
  untrustedEnvelope?: boolean

  /** C3 (jun-4-brief-mode RFC) — brief-mode session posture. When `true`,
   *  `buildDynamicContext` splices `BRIEF_NOTICE` into the per-turn DYNAMIC
   *  `<system-reminder>` slot (NOT the static cached prefix), instructing the
   *  model to condense its FINAL explanatory prose while EXEMPTING correctness
   *  reporting (verification block, errors, file:line evidence, the honesty
   *  ladder). ORTHOGONAL to {@link mode} and to the `effort` token ceiling —
   *  both can be set and compose. The loop reads the session `brief` store once
   *  per turn and threads it here. Absent / `false` ⇒ no notice, byte-identical
   *  to the pre-feature dynamic tail (the primary safety invariant). */
  brief?: boolean

  /** §5 prompt-directive bundle (jun-06) — optional override for the seven
   *  DEFAULT-OFF behavioral directives. When OMITTED, `buildDynamicContext`
   *  resolves the knobs from the frozen `runtimeConfig()` (the production path).
   *  Supplying it lets a test/caller drive the selection without env mutation;
   *  the pure selector ({@link selectActiveDirectives}) consumes this slice.
   *  ALL-false / omitted-with-knobs-unset ⇒ no directive bytes (byte-identical). */
  directiveConfig?: DirectiveConfig
}

export interface TurnContext {
  system: SystemBlock[]
  messages: Message[]
  promptPolicy: PromptPolicySnapshot
}

/** ADR-0538 Phase 2 — the fired-notice-atom manifest for this turn's DYNAMIC
 *  reminder channel. Selects the mode notice + brief notice atoms that fired
 *  and returns their `firedAtomIds` + `byChannel` grouping for `promptPolicy`.
 *  Returns `undefined` when NONE fired (default mode + `brief:false`) so the
 *  snapshot stays byte-identical to the pre-ADR-0538 shape — the wiring is
 *  strictly ADDITIVE. */
const firedNoticeManifest = (
  mode: GraphMode,
  brief: boolean,
):
  | {
      firedAtomIds: readonly string[]
      byChannel: Partial<Record<"message.system_reminder", readonly string[]>>
    }
  | undefined => {
  const fired = selectAtoms(NOTICE_ATOMS_ALL, noticeCtx(mode, brief))
  if (fired.length === 0) return undefined
  const ids = fired.map((a) => a.variantId)
  return { firedAtomIds: ids, byChannel: { "message.system_reminder": ids } }
}

/** ADR-0538 Phase 3 — the FULL fired-atom manifest across all 8 channels. Every
 *  channel is present (empty array ⇒ nothing fired there). `firedVariantIds` is
 *  the union of all channel lists; `policy` is the compiled snapshot (snapshot
 *  parity). PURE — derived from the same selection the assembly used. */
const buildCompileManifest = (
  input: TurnContextInput,
  effectiveMode: AgentMode,
  selectedGlobRules: readonly GlobRule[],
  meta: {
    useSectioned: boolean
    hasProjectMd: boolean
    hasSessionCtx: boolean
    hasUserAppend: boolean
    repoRulesInStaticSystem: boolean
    policy: PromptPolicySnapshot
  },
): CompiledPromptArtifact["manifest"] => {
  // system.base — the static body (posture ∪ verify ∪ body atoms) selected over
  // the DEFAULT static bodyCtx (buildSystemPrompt is called without axis opts on
  // the default path, so the cached prefix is mode/verify-independent).
  const baseCtx = bodyRenderCtx()
  const systemBaseAtoms = [
    ...selectAtoms(POSTURE_ATOMS, baseCtx),
    ...selectAtoms(VERIFY_ATOMS, baseCtx),
    ...selectAtoms(BODY_ATOMS, baseCtx),
  ]

  // message.system_reminder — the SAME resolved selection the WIRE assembles from
  // ({@link resolveReminderBlocks}), so the manifest reports EXACTLY the atoms that
  // produced reminder text (no facet-vs-render shadow: an atom is fired IFF its
  // block shipped). This is what makes the graph authoritative for the reminder.
  const reminderAtoms = resolveReminderBlocks(
    input,
    effectiveMode,
    selectedGlobRules,
    meta.repoRulesInStaticSystem,
  ).map((b) => b.atom)

  const byChannel: Record<PromptChannel, readonly string[]> = {
    "system.base": systemBaseAtoms.map((a) => a.variantId),
    // The cached optional sections are presence-marked (their CONTENT is caller
    // data, not atoms) — a stable synthetic id per present section so the
    // manifest reports which cached breakpoints are live without atomizing data.
    "system.project_md": meta.useSectioned && meta.hasProjectMd ? ["SECTION-project_md"] : [],
    "system.session_ctx": meta.useSectioned && meta.hasSessionCtx ? ["SECTION-session_ctx"] : [],
    "system.user_append": meta.useSectioned && meta.hasUserAppend ? ["SECTION-user_append"] : [],
    "message.hook_context":
      collectHookPromptSide(input.hookPromptInjects, "injectBeforeUser") !== undefined
        ? ["MSG-hook_context"]
        : [],
    "message.context_update":
      (input.contextChangeEvents?.length ?? 0) > 0 ? ["MSG-context_update"] : [],
    "message.mention_injection":
      (input.mentionInjectionMessages?.length ?? 0) > 0 ? ["MSG-mention_injection"] : [],
    "message.system_reminder": reminderAtoms.map((a) => a.variantId),
  }

  const firedVariantIds = Object.values(byChannel).flat()
  // firedAtomIds = the SEMANTIC atom ids of the REAL atoms that fired
  // (system.base ∪ reminder). Distinct from firedVariantIds: a semantic atom
  // (`atomId`) can render as several variants (`variantId`) — e.g. R-ENV#owned /
  // R-ENV#frozen, BODY-COMPLETION-BAR#code-change / #read-only. The synthetic
  // caller-data markers (SECTION-*/MSG-*) are NOT atoms and carry no atomId, so
  // they appear only in firedVariantIds/byChannel, never here (ADR-0538 §Compiler).
  const firedAtomIds = [...systemBaseAtoms, ...reminderAtoms].map((a) => a.atomId)
  return {
    firedAtomIds,
    firedVariantIds,
    // The cached static prefix is built over the DEFAULT (frozen) bodyCtx, where
    // no owned/read-only variant fires — so no supersede fires at this ctx and the
    // audit trail is empty. (Posture/mode variants supersede only under their own
    // ctx, which the WHOLE-GRAPH verifier crosses; the per-turn manifest reflects
    // the cached prefix that actually ships.)
    suppressed: [],
    byChannel,
    policy: meta.policy,
  }
}

/**
 * Defang any `<system-reminder>` / `</system-reminder>` substrings inside the
 * dynamic block before we wrap it. The wrapper itself is a literal
 * `<system-reminder>...</system-reminder>` pair, so any value inside
 * (`repoRules.body`, working state, skill description, memory hints) that
 * carries an UNESCAPED closer would terminate the harness reminder block —
 * the text after it would then become indistinguishable from a
 * system-attributed instruction, a classic prompt-injection vector for
 * repo-checked content (`AGENTS.md` is on disk and ANY contributor can edit
 * it). The same applies to a forged OPENER: an attacker could mid-block
 * declare a new `<system-reminder>...` and convince the model the inner
 * payload is harness-attributed.
 *
 * This is now a thin alias over the canonical {@link escapeBoundary} helper
 * (`src/agent/untrusted.ts`) bound to the `system-reminder` tag — the SINGLE
 * enforced path all untrusted fragments funnel through. The behavior is
 * byte-identical to the prior local implementation
 * (`s.replace(/<(\/?system-reminder>)/gi, "<\\$1")`): a single `\` is inserted
 * immediately after the opening `<` of any `<system-reminder>` /
 * `</system-reminder>` token, case-insensitive, casing preserved
 * (`</SYSTEM-REMINDER>` → `<\/SYSTEM-REMINDER>`).
 */
export const escapeReminderBoundary = (s: string): string => escapeBoundary("system-reminder", s)

/** ADR-0133 — push the `<hook-context>` user-side message when a hook
 *  returned `injectBeforeUser`. Wrapped via `embedUntrusted` so an inner
 *  `</hook-context>` is defanged. Extracted from {@link buildTurnContext}
 *  to keep its complexity below the biome cap. No-op when no injects
 *  carry a before-user side. */
const appendHookContextMessage = (
  messages: Message[],
  injects: readonly import("./hooks").HookPromptInject[] | undefined,
): void => {
  const beforeUser = collectHookPromptSide(injects, "injectBeforeUser")
  if (beforeUser === undefined) return
  messages.push(
    makeSyntheticUserMessage("hook-context", [
      { type: "text", text: embedUntrusted("hook-context", beforeUser) },
    ]),
  )
}

const hasText = (value: string | undefined): boolean =>
  value !== undefined && value.trim().length > 0

const resolveHookContextMode = (
  injects: readonly import("./hooks").HookPromptInject[] | undefined,
): PromptHookContextMode => {
  const beforeUser = collectHookPromptSide(injects, "injectBeforeUser") !== undefined
  const afterSystem = collectHookPromptSide(injects, "injectAfterSystem") !== undefined
  if (beforeUser && afterSystem) return "both"
  if (beforeUser) return "before_user"
  if (afterSystem) return "after_system"
  return "none"
}

const resolveSummaryPrefix = (messages: readonly Message[]): PromptSummaryPrefix => {
  for (const message of messages) {
    if (message.role !== "user") continue
    for (const block of message.content) {
      if (block.type !== "text") continue
      if (block.text.startsWith("<continuation summary>\n")) return "continuation_summary"
      if (block.text.startsWith("<conversation summary>\n")) return "conversation_summary"
    }
  }
  return "none"
}

/**
 * Assemble one turn's request. `system` is the STATIC prompt as
 * `SystemBlock[]` with the last block marked `cache:true` (the cache
 * breakpoint) — byte-identical across every turn of a session. `messages` is
 * the caller's history with the dynamic context appended as ONE trailing
 * `<system-reminder>` user message, so the cached prefix is preserved and only
 * the tail varies.
 */
/** ADR-0471 — append the untrusted-source trust rule to the STATIC base section
 *  when the gate is on (the loop resolves it from `runtimeConfig().untrustedEnvelope`,
 *  the SAME frozen gate the dispatch wrap site reads, so rule + wrapping engage
 *  together). It rides the `base` cache breakpoint — no new section, the
 *  4-breakpoint budget is untouched — and is byte-identical when off (no append).
 *  Extracted so `buildTurnContext` stays under biome's cognitive-complexity gate. */
const resolveStaticBase = (basePrompt: string, untrustedEnvelope: boolean | undefined): string =>
  untrustedEnvelope === true ? `${basePrompt}\n${UNTRUSTED_ENVELOPE_RULE}` : basePrompt

/**
 * ADR-0538 Phase 3 — the SINGLE assembly path.
 *
 * `compile(input)` is the one place the prompt is assembled from the atom graph
 * + the leaf renderers. It emits a {@link CompiledPromptArtifact}:
 *
 *   - `systemSections` — the ≤4 cached `system.*` sections (base / project_md /
 *     session_ctx / user_append), ORDER = cache prefix, ADR-0326 4-breakpoint
 *     budget preserved. Feed `buildSectionedSystemBlocks` to recover the wire
 *     `SystemBlock[]`.
 *   - `injectedMessages` — `baseMessages` + `message.hook_context` +
 *     `message.context_update` + `message.mention_injection`, in the EXACT
 *     current chronology (ADR-0321/0325).
 *   - `trailingReminder` — the RAW `message.system_reminder` block BEFORE
 *     `embedUntrusted` (the caller wraps it once). Absent ⇒ no reminder message.
 *   - `manifest` — the fired-atom manifest across all 8 channels + the policy
 *     snapshot (snapshot parity).
 *
 * `buildTurnContext` is a THIN FACADE over this (below). Byte-equivalence to the
 * prior direct assembly is the HARD CONSTRAINT: the section list, the message
 * order, and the reminder text are produced by the SAME leaf renderers in the
 * SAME order as before — `compile` only RE-SHAPES them into the artifact.
 */
/** ADR-0538 Phase 3 — resolve the base statics + the sectioning decision the
 *  compiler branches on. Extracted so {@link compile} stays under the cognitive-
 *  complexity cap. PURE (renderers only). */
const resolveCompileStatics = (
  input: TurnContextInput,
): { staticBase: string; projectMd: string | undefined; useSectioned: boolean } => {
  const basePrompt =
    input.system ?? resolveCachedSystemPrompt(input.systemPromptCache, input.systemPromptCacheKey)
  const staticBase = resolveStaticBase(basePrompt, input.untrustedEnvelope)
  const projectMd =
    input.repoRules !== undefined ? renderRepoRulesBlock(input.repoRules) : undefined
  const useSectioned =
    (projectMd !== undefined && projectMd.trim().length > 0) ||
    (input.userAppend !== undefined && input.userAppend.trim().length > 0) ||
    (input.sessionCtx !== undefined && input.sessionCtx.trim().length > 0) ||
    (input.memorySummaryMd !== undefined && input.memorySummaryMd.trim().length > 0)
  return { staticBase, projectMd, useSectioned }
}

/** ADR-0538 Phase 3 — build the ≤4 cached `system.*` sections (ORDER = cache
 *  prefix, ADR-0326 budget preserved). Byte-identical to the prior inline
 *  branch. Extracted for complexity. */
const buildSystemSections = (
  input: TurnContextInput,
  staticBase: string,
  projectMd: string | undefined,
  useSectioned: boolean,
): PromptSection[] => {
  if (!useSectioned) return [{ name: "base", text: staticBase, cache: true }]
  // SECURITY: the CALLER-DATA sections (repo AGENTS.md, session ctx, memory
  // aggregate, user global CLAUDE.md) are repo-/user-controllable and ride the
  // TRUSTED system prefix. Defang the `<system-reminder>` boundary in each so a
  // forged tag in e.g. an AGENTS.md body cannot masquerade as a genuine harness
  // reminder (an L6-repo → L1-system authority elevation). This is the same
  // defense the per-turn reminder gets via `embedUntrusted`; when repo-rules were
  // hoisted from the reminder into the cached `project_md` section they lost it,
  // so it is restored here. `base` is Quanta's OWN prompt — NOT escaped. Benign
  // content (no genuine boundary token) is byte-identical (escapeBoundary's benign
  // invariant), so the cache prefix for real repos is unchanged.
  const defang = (s: string): string => escapeBoundary("system-reminder", s)
  const sections = fourSectionPreset({
    base: staticBase,
    ...(projectMd !== undefined ? { projectMd: defang(projectMd) } : {}),
    ...(input.sessionCtx !== undefined ? { sessionCtx: defang(input.sessionCtx) } : {}),
    ...(input.memorySummaryMd !== undefined
      ? { memorySummaryMd: defang(input.memorySummaryMd) }
      : {}),
    ...(input.userAppend !== undefined ? { userAppend: defang(input.userAppend) } : {}),
  })
  // Fail-soft cache-budget check (unchanged): the preset cannot exceed 4 by
  // construction; kept so future growth surfaces in dev, not at the API.
  validateSectionsCacheBudget(sections)
  return sections
}

/** ADR-0538 Phase 3 — assemble the `PromptPolicySnapshot` (observability). Byte-
 *  identical to the prior inline object; the ADR-0538-Phase-2 fired-notice
 *  manifest spreads in additively. Extracted for complexity. */
const buildPromptPolicy = (
  input: TurnContextInput,
  effectiveMode: AgentMode,
  selectedGlobRules: readonly GlobRule[],
  projectMd: string | undefined,
  useSectioned: boolean,
): PromptPolicySnapshot => ({
  mode: effectiveMode,
  baseSystem: input.system !== undefined ? "caller_provided" : "default",
  systemLayout: useSectioned ? "four_section" : "single_block",
  repoRulesPresent: hasText(projectMd),
  sessionCtxPresent: hasText(input.sessionCtx) || hasText(input.memorySummaryMd),
  userAppendPresent: hasText(input.userAppend),
  selectedGlobRuleNames: selectedGlobRules.map((rule) => basename(rule.sourcePath)),
  activeSkillNames: input.activeSkills?.map((skill) => skill.name) ?? [],
  workingStatePresent: input.workingState !== undefined,
  memoryContextPresent: hasText(input.memoryContext),
  contextChangeCount: input.contextChangeEvents?.length ?? 0,
  mentionInjectionCount: input.mentionInjectionMessages?.length ?? 0,
  hookContext: resolveHookContextMode(input.hookPromptInjects),
  summaryPrefix: resolveSummaryPrefix(input.baseMessages),
  ...(input.promptSurfaceProfile !== undefined
    ? { surfaceProfile: input.promptSurfaceProfile }
    : {}),
  ...(input.activeLevers !== undefined ? { activeLevers: input.activeLevers } : {}),
  // ADR-0538 Phase 2 — fired notice-atom manifest (additive; absent when no
  // notice atom fired ⇒ byte-identical snapshot for a default/non-brief turn).
  ...(firedNoticeManifest(effectiveMode, input.brief === true) ?? {}),
})

export const compile = (input: TurnContextInput): CompiledPromptArtifact => {
  const { staticBase, projectMd, useSectioned } = resolveCompileStatics(input)
  const effectiveMode = resolveAgentMode(input.mode, input.planMode)
  const selectedGlobRules =
    input.globRules !== undefined && input.globRules.length > 0
      ? selectGlobRules(input.globRules, input.changedPaths ?? [])
      : []

  // ── system.* channels — the cached prefix sections (ORDER = cache prefix). ──
  const systemSections = buildSystemSections(input, staticBase, projectMd, useSectioned)

  // ── message.system_reminder channel — the RAW dynamic block (pre-embed). ──
  const repoRulesInStaticSystem = useSectioned && hasText(projectMd)
  const trailingReminder = buildDynamicContext(
    input,
    effectiveMode,
    selectedGlobRules,
    repoRulesInStaticSystem,
  )

  // ── message.hook_context / context_update / mention_injection — EXACT
  //    current chronology (ADR-0321/0325), assembled onto `injectedMessages`. ──
  const injectedMessages: Message[] = [...input.baseMessages]
  appendHookContextMessage(injectedMessages, input.hookPromptInjects)
  appendContextChangeMessages(injectedMessages, input.contextChangeEvents)
  appendMentionInjectionMessages(injectedMessages, input.mentionInjectionMessages)

  const policy = buildPromptPolicy(input, effectiveMode, selectedGlobRules, projectMd, useSectioned)
  const manifest = buildCompileManifest(input, effectiveMode, selectedGlobRules, {
    useSectioned,
    hasProjectMd: hasText(projectMd),
    hasSessionCtx: hasText(input.sessionCtx) || hasText(input.memorySummaryMd),
    hasUserAppend: hasText(input.userAppend),
    repoRulesInStaticSystem,
    policy,
  })

  return {
    systemSections,
    injectedMessages,
    ...(trailingReminder !== undefined ? { trailingReminder } : {}),
    manifest,
  }
}

/** ADR-0538 Phase 3 — thin facade over {@link compile}. Callers stay byte-
 *  identical: this re-derives the wire `SystemBlock[]` + `messages` from the
 *  artifact (the SAME `buildSectionedSystemBlocks` + single `embedUntrusted`
 *  the direct assembly used) and forwards the compiled `promptPolicy`. */
export const buildTurnContext = (input: TurnContextInput): TurnContext => {
  const artifact = compile(input)
  const system = buildSectionedSystemBlocks([...artifact.systemSections])
  const messages: Message[] = [...artifact.injectedMessages]
  if (artifact.trailingReminder !== undefined) {
    // Route the assembled dynamic block through the canonical untrusted-embed
    // helper: it defangs inner `<system-reminder>` boundaries BEFORE wrapping so
    // a value supplied by repoRules / memory / skills cannot terminate the outer
    // block and forge a system-attributed instruction. Byte-identical to the
    // prior inline path — one wrap, one escape.
    messages.push({
      role: "user",
      content: [
        { type: "text", text: embedUntrusted("system-reminder", artifact.trailingReminder) },
      ],
    })
  }
  return { system, messages, promptPolicy: artifact.manifest.policy }
}

// ─── ADR-0327 wire helpers ───────────────────────────────────────────────────
//
// Three small helpers, deliberately kept at module scope so each is exactly
// one responsibility and exactly one shape. All three are NO-OP when their
// optional input is absent — the byte-identical invariant lives here.

const resolveCachedSystemPrompt = (
  cache: import("@/llm/system-prompt-cache").SystemPromptCachePort | undefined,
  key: import("@/llm/system-prompt-cache").SystemPromptCacheKey | undefined,
): string => {
  // Both must be present for the cache to engage. Either-or absent ⇒ legacy
  // per-call build, byte-identical to the pre-ADR-0326 path.
  if (cache !== undefined && key !== undefined) {
    return cache.getOrBuild(key, () => buildSystemPrompt()).text
  }
  return buildSystemPrompt()
}

const appendContextChangeMessages = (
  messages: Message[],
  events: readonly import("./context-change").ContextEvent[] | undefined,
): void => {
  if (events === undefined || events.length === 0) return
  for (const m of buildPersistentInjectionMessages(events)) {
    messages.push(m)
  }
}

const appendMentionInjectionMessages = (
  messages: Message[],
  injects: readonly Message[] | undefined,
): void => {
  if (injects === undefined || injects.length === 0) return
  for (const m of injects) {
    messages.push(m)
  }
}
