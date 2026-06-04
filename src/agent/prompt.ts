import { basename } from "node:path"
import type { Message, SystemBlock } from "@/llm"
import type {
  AgentPromptMode,
  PromptHookContextMode,
  PromptPolicySnapshot,
  PromptSummaryPrefix,
} from "@/shared"
import { renderTaskBudgetBlock, type TaskBudget } from "./budget/task-budget"
import { buildPersistentInjectionMessages } from "./context-change"
import { renderEnvBlock, type TurnEnvContext } from "./env-context"
import { type GlobRule, renderGlobRulesBlock, selectGlobRules } from "./glob-rules"
import { assertValidIdentityLines } from "./identity"
import { resolveAgentMode } from "./mode"
import { type PersonaKind, personaLines } from "./persona"
import { BODY_AFTER_PERSONA, BODY_AFTER_PROMPT_PACK, INTRO_LINES } from "./prompt-body"
import {
  type AgentMode as PromptPackMode,
  renderPackByMode,
  renderToolUseRules,
} from "./prompt-rules"
import {
  buildSectionedSystemBlocks,
  fourSectionPreset,
  validateSectionsCacheBudget,
} from "./prompt-sections"
import { type RepoRules, renderRepoRulesBlock } from "./repo-rules"
import { embedUntrusted, escapeBoundary } from "./untrusted"
import { UNTRUSTED_ENVELOPE_RULE } from "./untrusted-envelope"
import { renderWorkingStateBlock, type WorkingState } from "./working-state"

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
  },
): string =>
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
    ...BODY_AFTER_PERSONA,
    // Pack-selection seam: when `promptPack` is set the caller gets the
    // mode-specific rule set (headless / batch / ci-bot); when absent we
    // call `renderToolUseRules()` so the interactive default stays byte-
    // identical to pre-slice output and the cached prefix is unchanged.
    ...(opts?.promptPack !== undefined ? renderPackByMode(opts.promptPack) : renderToolUseRules()),
    ...BODY_AFTER_PROMPT_PACK,
  ].join("\n")

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
  /** Caller-supplied STATIC session context (e.g. tool inventory hash, surface
   *  flag, install id). Rides the 4-section preset as the `session_ctx`
   *  breakpoint when present (Claude Desktop 1.7196 pattern). Per-turn dynamic
   *  data (date, cwd, plan notice) does NOT belong here — that stays in the
   *  trailing `<system-reminder>` user message. */
  sessionCtx?: string
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
}

export interface TurnContext {
  system: SystemBlock[]
  messages: Message[]
  promptPolicy: PromptPolicySnapshot
}

const PLAN_NOTICE = [
  "PLAN MODE is active. Do NOT modify anything. Use only read-only tools",
  "(read, search_codebase, grep, glob, localize) to investigate, then produce a concrete,",
  "step-by-step implementation plan as your final answer: which files, what",
  "changes, in what order. Stop calling tools once you can write the plan.",
].join("\n")

const REVIEW_NOTICE = [
  "REVIEW MODE is active. Do NOT modify anything. Investigate with read-only",
  "tools, then deliver findings-first: each finding as { file:line, severity,",
  "what, why, impact }. Order by severity; cut generic praise. No fix patches",
  "unless the user explicitly asks for them.",
].join("\n")

const AUDIT_NOTICE = [
  "AUDIT MODE is active. Do NOT modify anything. Extract the intended contract,",
  "then check the four truth surfaces — type, owner, wire, test — and report",
  "mismatches: authority leaks, dual truth, fail-open paths, stale compat.",
  "Cite file:line evidence per mismatch. No fixes unless asked.",
].join("\n")

// ADR-0211 — architect is a READ-ONLY posture (mode.ts fail-closed default
// blocks mutating tools). The notice emphasizes deep reasoning + design-first
// posture; the model proposes structure, not diffs.
const ARCHITECT_NOTICE = [
  "ARCHITECT MODE is active. Do NOT modify anything. Reason deeply about the",
  "design BEFORE proposing changes: state the problem, enumerate constraints,",
  "lay out the design space, pick the smallest sufficient design. Output as a",
  "design doc; defer edits to a follow-up turn after explicit approval.",
].join("\n")

// ADR-0211 — editor is a MUTATING posture, but the contract is "minimal,
// surgical diffs only". The notice nudges `edit` over `write`, single-file
// touches, and explicit pre-read; mutation is PERMITTED (mode.ts MUTATING_MODES
// includes "editor"). No "do not modify" line — that would contradict the
// posture and confuse the model.
const EDITOR_NOTICE = [
  "EDITOR MODE is active. Make MINIMAL, SURGICAL diffs only. Prefer `edit`",
  "over `write`. Touch the fewest files needed. Always read before editing.",
  "No drive-by reformatting, no opportunistic refactors, no scope creep —",
  "ship the smallest correct change that resolves the user's request.",
].join("\n")

const modeNotice = (mode: AgentMode): string | undefined => {
  if (mode === "plan") return PLAN_NOTICE
  if (mode === "review") return REVIEW_NOTICE
  if (mode === "audit") return AUDIT_NOTICE
  if (mode === "architect") return ARCHITECT_NOTICE
  if (mode === "editor") return EDITOR_NOTICE
  return undefined
}

/** Render the active-skills catalogue + trigger-rule block (Codex
 *  `skills-audit.md` mirror). Each entry is `- $name — description-first-line`.
 *  The trigger-rule footer encodes the explicit/implicit/multi-skill/progressive
 *  rules so the model reads them every turn (cheap, the bodies stay lazy).
 *  Returns `undefined` for an empty list so the caller emits no block — byte-
 *  identical for skill-less sessions. */
const renderActiveSkillsBlock = (
  skills: readonly { name: string; description: string }[],
): string | undefined => {
  if (skills.length === 0) return undefined
  const lines = skills.map((s) => {
    // First-line only: skill descriptions may carry a long body; the trigger
    // rules below tell the model to load `SKILL.md` via the Skill tool when it
    // actually invokes one (progressive disclosure).
    const first = s.description.split("\n", 1)[0]?.trim() ?? ""
    return `- $${s.name}${first ? ` — ${first}` : ""}`
  })
  return [
    "## Active skills",
    ...lines,
    "Trigger rules:",
    "  1. If the user names a skill ($name or plain), invoke it that turn.",
    "  2. If the task clearly matches a skill description, invoke it (mandatory).",
    "  3. If multiple apply, pick the minimal covering set; announce the order.",
    "  4. Progressive disclosure: load SKILL.md body via the `Skill` tool only",
    "     when you decide to invoke it.",
  ].join("\n")
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

/** ADR-0078 determinism leak (date): the per-turn block is model-facing — every
 *  turn embeds today's date, which makes the assembled prompt drift day-by-day
 *  and breaks the byte-identical replay invariant. Default `Date.now` keeps
 *  production output unchanged for the current moment; replay / unit tests pin
 *  the moment via the injected `now` source. Pattern: `opts.now ?? Date.now`
 *  (cf. agent/admissibility-gate.ts, memory/consolidate/writer.ts). Extracted
 *  out of buildDynamicContext so its cognitive complexity is unchanged. */
const todayDateLine = (now?: () => number): string =>
  `Today's date is ${new Date((now ?? Date.now)()).toISOString().slice(0, 10)}.`

/** ADR-0133 — collapse a list of {@link HookPromptInject}s for one side
 *  (`afterSystem` or `beforeUser`) into a single newline-joined string.
 *  Returns `undefined` when no entry has the side set (so the caller emits
 *  no block — byte-identical for the pre-ADR-0133 path). */
const collectHookPromptSide = (
  injects: readonly import("./hooks").HookPromptInject[] | undefined,
  side: "injectAfterSystem" | "injectBeforeUser",
): string | undefined => {
  if (injects === undefined || injects.length === 0) return undefined
  const parts: string[] = []
  for (const inj of injects) {
    const text = inj[side]
    if (typeof text === "string" && text.length > 0) parts.push(text)
  }
  return parts.length > 0 ? parts.join("\n") : undefined
}

/** ADR-0133 — append `## Hook context` + the `injectAfterSystem` text at
 *  the TAIL of the dynamic context parts array. Extracted from
 *  {@link buildDynamicContext} to keep its complexity below the biome cap.
 *  No-op when no inject carries an after-system side. The label exposes
 *  the source so an audit can see "a hook returned this since the last
 *  turn". The text uses a simple H2 (not a nested system-reminder) to
 *  avoid double-wrap inside the outer reminder. */
const appendHookContextDynamicTail = (
  parts: string[],
  injects: readonly import("./hooks").HookPromptInject[] | undefined,
): void => {
  const afterSystem = collectHookPromptSide(injects, "injectAfterSystem")
  if (afterSystem === undefined) return
  parts.push("", "## Hook context", afterSystem)
}

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
  messages.push({
    role: "user",
    content: [{ type: "text", text: embedUntrusted("hook-context", beforeUser) }],
  })
}

/** Build the per-turn dynamic context — date, cwd, mode notice, repo rules,
 *  working state, memory — as a single block of text, or `undefined` when there
 *  is nothing to say. Order matters: repo-local rules ride ABOVE working state
 *  (repo authority) which rides ABOVE memory hints (routing hint only — Codex
 *  trust ladder). Working state is the in-session L3 scratchpad: anchored to
 *  THIS task, so it sits between repo authority and generic memory hints.
 *
 *  ADR-0133 — `hookPromptInjects[].injectAfterSystem` is appended at the
 *  TAIL of the dynamic block (closest to the user message) so a hook's
 *  freshly-emitted guidance is read last by the model. `injectBeforeUser`
 *  is NOT folded here — it rides as a separate user-side message in
 *  {@link buildTurnContext}. */
const buildDynamicContext = (
  input: TurnContextInput,
  effectiveMode: AgentMode,
  selectedGlobRules: readonly GlobRule[],
): string | undefined => {
  const parts: string[] = [todayDateLine(input.now), `Working directory: ${input.cwd}`]
  // SSOT mode precedence (ADR-0018): prompt + dispatch share resolveAgentMode
  // so the per-turn notice and the dispatch admissibility gate never disagree.
  const notice = modeNotice(effectiveMode)
  if (notice) parts.push("", notice)
  // ADR-0397 env block — sits ABOVE repo-rules because env/build context is
  // host-static authority (the platform/shell/pkg-mgr don't change mid-turn
  // and the git snapshot is taken at turn boundary). Absent / empty env ⇒
  // renderEnvBlock returns undefined and parts stay byte-identical.
  const envBlock = renderEnvBlock(input.env)
  if (envBlock) parts.push("", envBlock)
  if (input.repoRules) parts.push("", renderRepoRulesBlock(input.repoRules))
  // File-scoped rules (Cursor `.cursor/rules` parity) ride right after the
  // top-level repo contract — both are repo authority, but these are selected
  // per-turn by the files in play. Absent / no selection ⇒ no block.
  if (selectedGlobRules.length > 0) {
    const block = renderGlobRulesBlock([...selectedGlobRules])
    if (block) parts.push("", block)
  }
  if (input.activeSkills && input.activeSkills.length > 0) {
    const block = renderActiveSkillsBlock(input.activeSkills)
    if (block) parts.push("", block)
  }
  if (input.workingState) {
    const block = renderWorkingStateBlock(input.workingState)
    if (block) parts.push("", block)
  }
  // Memory recall body already carries the trust-ladder H2 header inside
  // `formatBlock` (src/agent/memory.ts) — append as-is, no double-label.
  const memory = input.memoryContext?.trim()
  if (memory) parts.push("", memory)
  appendHookContextDynamicTail(parts, input.hookPromptInjects)
  // jun-02 — soft task-budget guidance rides at the TAIL (read last by the
  // model, like hook context) so the self-moderation hint is the freshest
  // signal. Orthogonal to the hard breaker; absent / non-positive ⇒ no block
  // (byte-identical default-OFF).
  const taskBudgetLine = renderTaskBudgetBlock(input.taskBudget)
  if (taskBudgetLine !== undefined) parts.push("", taskBudgetLine)
  return parts.join("\n")
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
export const buildTurnContext = (input: TurnContextInput): TurnContext => {
  // ADR-0326 wire — cache the default `buildSystemPrompt()` result per
  // session-key. `input.system` (caller-provided) bypasses the cache so a
  // caller that already memoizes its own static prefix isn't shadowed.
  const basePrompt =
    input.system ?? resolveCachedSystemPrompt(input.systemPromptCache, input.systemPromptCacheKey)
  // ADR-0471 — append the untrusted-source trust rule to the STATIC base
  // section when the gate is on (the loop resolves it from
  // `runtimeConfig().untrustedEnvelope`, the SAME frozen gate the dispatch wrap
  // site reads, so rule + wrapping engage together). It rides the `base` cache
  // breakpoint — no new section, the 4-breakpoint budget is untouched — and is
  // byte-identical when off (no append).
  const staticBase =
    input.untrustedEnvelope === true ? `${basePrompt}\n${UNTRUSTED_ENVELOPE_RULE}` : basePrompt
  // 4-section preset (Claude Desktop 1.7196 `systemPromptSectionCache` mirror)
  // activates only when the caller supplies repo-local rules text OR a static
  // user-append; otherwise we stay byte-identical to the legacy single-block
  // shape so existing callers and their cached prefixes are untouched.
  const projectMd = input.repoRules?.body
  const useSectioned =
    (projectMd !== undefined && projectMd.trim().length > 0) ||
    (input.userAppend !== undefined && input.userAppend.trim().length > 0) ||
    (input.sessionCtx !== undefined && input.sessionCtx.trim().length > 0)
  const effectiveMode = resolveAgentMode(input.mode, input.planMode)
  const selectedGlobRules =
    input.globRules !== undefined && input.globRules.length > 0
      ? selectGlobRules(input.globRules, input.changedPaths ?? [])
      : []
  const system: SystemBlock[] = useSectioned
    ? (() => {
        const sections = fourSectionPreset({
          base: staticBase,
          ...(projectMd !== undefined ? { projectMd } : {}),
          ...(input.sessionCtx !== undefined ? { sessionCtx: input.sessionCtx } : {}),
          ...(input.userAppend !== undefined ? { userAppend: input.userAppend } : {}),
        })
        // Fail-soft cache-budget check: the validator can only return ok:false
        // here if the preset itself ever exceeds 4 sections, which it cannot by
        // construction. Kept as a guard so future preset growth surfaces in
        // dev rather than at the provider's 400-on-too-many-breakpoints.
        validateSectionsCacheBudget(sections)
        return buildSectionedSystemBlocks(sections)
      })()
    : [{ type: "text", text: staticBase, cache: true }]
  const dynamic = buildDynamicContext(input, effectiveMode, selectedGlobRules)
  const messages: Message[] = [...input.baseMessages]
  appendHookContextMessage(messages, input.hookPromptInjects)
  // ADR-0321 + ADR-0325 wire — persistent injection channels.
  // Both are inserted AFTER the base history (+ any hook-context) and BEFORE
  // the trailing `<system-reminder>` so the model reads them as chronological
  // pre-turn signals. Same-slot ordering: context-change first (it represents
  // state transitions that happened BEFORE the turn started), then mention
  // injections (user-driven invocations FOR this turn).
  appendContextChangeMessages(messages, input.contextChangeEvents)
  appendMentionInjectionMessages(messages, input.mentionInjectionMessages)
  if (dynamic !== undefined) {
    // Route the assembled dynamic block through the canonical untrusted-embed
    // helper: it defangs inner `<system-reminder>` boundaries BEFORE wrapping so
    // a value supplied by repoRules / memory / skills cannot terminate the outer
    // block and forge a system-attributed instruction. Byte-identical to the
    // prior inline `<system-reminder>\n${escapeReminderBoundary(dynamic)}\n
    // </system-reminder>` form — the wrapper and escape are unchanged, only the
    // path is now the single enforced one.
    messages.push({
      role: "user",
      content: [{ type: "text", text: embedUntrusted("system-reminder", dynamic) }],
    })
  }
  return {
    system,
    messages,
    promptPolicy: {
      mode: effectiveMode,
      baseSystem: input.system !== undefined ? "caller_provided" : "default",
      systemLayout: useSectioned ? "four_section" : "single_block",
      repoRulesPresent: hasText(projectMd),
      sessionCtxPresent: hasText(input.sessionCtx),
      userAppendPresent: hasText(input.userAppend),
      selectedGlobRuleNames: selectedGlobRules.map((rule) => basename(rule.sourcePath)),
      activeSkillNames: input.activeSkills?.map((skill) => skill.name) ?? [],
      workingStatePresent: input.workingState !== undefined,
      memoryContextPresent: hasText(input.memoryContext),
      contextChangeCount: input.contextChangeEvents?.length ?? 0,
      mentionInjectionCount: input.mentionInjectionMessages?.length ?? 0,
      hookContext: resolveHookContextMode(input.hookPromptInjects),
      summaryPrefix: resolveSummaryPrefix(input.baseMessages),
    },
  }
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
