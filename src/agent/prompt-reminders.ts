import { runtimeConfig } from "@/shared"
import { renderTaskBudgetBlock } from "./budget/task-budget"
import { renderEnvBlock } from "./env-context"
import { type GlobRule, renderGlobRulesBlock } from "./glob-rules"
import type { AgentMode, TurnContextInput } from "./prompt"
import { type DirectiveConfig, selectActiveDirectives } from "./prompt-directives"
import {
  DYNAMIC_ATOMS,
  type DynamicContentKey,
  type AgentMode as GraphMode,
  type InstructionAtom,
  NOTICE_ATOMS as NOTICE_ATOMS_ALL,
  type PromptContext,
  renderNoticeAtom,
  selectAtoms,
} from "./prompt-graph"
import { renderRepoRulesBlock } from "./repo-rules"
import { renderWorkingStateBlock } from "./working-state"

/**
 * ADR-0538 §KEY-TRANSFORM — per-turn DYNAMIC reminder assembly (extracted from
 * prompt.ts to keep that module under the god-code size gate). The instruction
 * graph is AUTHORITATIVE here: `resolveReminderBlocks` is the SINGLE ordered atom
 * selection both the wire (`buildDynamicContext`) and the fired-atom manifest
 * (`buildCompileManifest`, still in prompt.ts) derive from, so they cannot drift.
 * PURE — every function is a pure fn of its inputs + the injected clock.
 */

/** ADR-0538 Phase 2 — a minimal `PromptContext` carrying only the `mode` +
 *  `brief` facets the notice atoms select over (all other facets fixed at their
 *  representative). The notice atoms ride the per-turn `message.system_reminder`
 *  channel, so this is the DYNAMIC-side selection surface. */
export const noticeCtx = (mode: GraphMode, brief: boolean): PromptContext => ({
  envPosture: "frozen",
  promptPack: "interactive",
  verifyStrategy: undefined,
  mode,
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
  brief,
  untrustedEnvelope: false,
  hasLanguageHint: false,
  hasEnvBlock: false,
  hasRepoRulesDynamic: false,
  hasTaskBudget: false,
  hasObjective: false,
  hasDirectives: false,
  hasDelegationSuppress: false,
})

/**
 * ADR-0538 Phase 3 — derive the per-turn DYNAMIC `PromptContext` facets the
 * reminder-channel atoms select over. Only the facets the dynamic atoms read are
 * set true; the rest stay at their representative default. PURE.
 */
export const dynamicReminderCtx = (
  input: TurnContextInput,
  effectiveMode: AgentMode,
  selectedGlobRules: readonly GlobRule[],
  repoRulesInStaticSystem: boolean,
): PromptContext => ({
  ...noticeCtx(effectiveMode, input.brief === true),
  hasLanguageHint: input.languageHint !== undefined && input.languageHint.length > 0,
  hasEnvBlock: renderEnvBlock(input.env) !== undefined,
  // repo-rules ride the reminder ONLY when NOT hoisted to the cached prefix.
  hasRepoRulesDynamic: input.repoRules !== undefined && !repoRulesInStaticSystem,
  hasGlobRules: selectedGlobRules.length > 0,
  hasActiveSkills: input.activeSkills !== undefined && input.activeSkills.length > 0,
  // C2b — LIVE per-turn read: invoke the thunk here so the facet reflects the
  // CURRENT goal (mirrors the task-budget renderer double-call pattern below).
  hasObjective: renderObjectiveBlock(input.objective?.()) !== undefined,
  hasWorkingState: input.workingState !== undefined,
  hasMemorySummary: (input.memoryContext?.trim().length ?? 0) > 0,
  hasHookInjects: collectHookPromptSide(input.hookPromptInjects, "injectAfterSystem") !== undefined,
  hasTaskBudget: renderTaskBudgetBlock(input.taskBudget) !== undefined,
  hasDirectives:
    selectActiveDirectives(input.directiveConfig ?? resolveDirectiveConfig()).length > 0,
  // C5059-05 — gate the tool-routing fan-out line on the delegation-suppress knob.
  hasDelegationSuppress: runtimeConfig().subagentDelegateSuppress,
})

/** Render the active-skills catalogue + trigger-rule block (Codex
 *  `skills-audit.md` mirror). Each entry is `- $name — description-first-line`.
 *  The trigger-rule footer encodes the explicit/implicit/multi-skill/progressive
 *  rules so the model reads them every turn (cheap, the bodies stay lazy).
 *  Returns `undefined` for an empty list so the caller emits no block — byte-
 *  identical for skill-less sessions. */
export const renderActiveSkillsBlock = (
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

/** C2b — render the CONCISE `## Current objective` awareness block from the LIVE
 *  objective view (goal + 6-state status only). Mirrors {@link renderActiveSkillsBlock}:
 *  returns `undefined` for an absent view OR an empty goal so the caller emits NO
 *  block — byte-identical for goal-less / authority-less sessions. Deliberately
 *  NOT a dump: no criteria / blockers / nextActions (the `objective_*` tools
 *  already stream those); this is a passive per-turn cue so a restored/active goal
 *  is visible-to-model without a proactive `objective_get`. */
export const renderObjectiveBlock = (
  view: import("./prompt").ObjectiveContextView | undefined,
): string | undefined => {
  if (view === undefined) return undefined
  const goal = view.goal.trim()
  if (goal.length === 0) return undefined
  return ["## Current objective", `goal: ${goal}`, `status: ${view.status}`].join("\n")
}

/** ADR-0078 determinism leak (date): the per-turn block is model-facing — every
 *  turn embeds today's date, which makes the assembled prompt drift day-by-day
 *  and breaks the byte-identical replay invariant. Default `Date.now` keeps
 *  production output unchanged for the current moment; replay / unit tests pin
 *  the moment via the injected `now` source. Pattern: `opts.now ?? Date.now`
 *  (cf. agent/admissibility-gate.ts, memory/consolidate/writer.ts). Extracted
 *  out of buildDynamicContext so its cognitive complexity is unchanged. */
export const todayDateLine = (now?: () => number): string =>
  `Today's date is ${new Date((now ?? Date.now)()).toISOString().slice(0, 10)}.`

/** ADR-0133 — collapse a list of {@link HookPromptInject}s for one side
 *  (`afterSystem` or `beforeUser`) into a single newline-joined string.
 *  Returns `undefined` when no entry has the side set (so the caller emits
 *  no block — byte-identical for the pre-ADR-0133 path). */
export const collectHookPromptSide = (
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
/** §5 — project the frozen `runtimeConfig()` onto the narrow {@link DirectiveConfig}
 *  slice the pure selector consumes. The loop layer (`prompt.ts`) is the env
 *  reader; the bundle module stays pure/injected. Default-OFF ⇒ every field
 *  false ⇒ the selector emits nothing. */
export const resolveDirectiveConfig = (): DirectiveConfig => {
  const c = runtimeConfig()
  return {
    directiveAutonomous: c.directiveAutonomous,
    directiveReadComplete: c.directiveReadComplete,
    directiveProgress: c.directiveProgress,
    directiveMemoryVerify: c.directiveMemoryVerify,
    directiveThinkFreq: c.directiveThinkFreq,
    directiveAntiPlatitude: c.directiveAntiPlatitude,
    directiveParallelTools: c.directiveParallelTools,
    // RFC jun-6 §5.2 — advisor timing rail (QUANTA_ADVISOR_RAIL). Additive.
    directiveAdvisorRail: c.directiveAdvisorRail,
    // RFC jun-6-code-mode Phase 3 — code_mode_only steering (QUANTA_CODE_MODE_ONLY).
    // Additive; default-OFF ⇒ zero bytes (byte-identical dynamic tail).
    codeModeOnly: c.codeModeOnly,
  }
}

/** The ONE presence guard the dynamic-atom resolver needs: absent-or-empty ⇒
 *  `undefined` (the assembler skips the block), otherwise the text.
 *
 *  A unit because `contentByKey` spelled this same "is there anything to say?"
 *  test six different ways across its arms — `!== undefined && .length > 0`,
 *  `?.trim()` then a length check, `.length > 0 ? render : undefined` — and
 *  those repeated guards, not the switch, were its whole score. */
const nonEmptyText = (s: string | undefined): string | undefined =>
  s !== undefined && s.length > 0 ? s : undefined

/** Render an optional value, or `undefined` when it is absent. Sibling of
 *  `nonEmptyText` for the arms whose emptiness test is "is the field there",
 *  not "is the string non-empty". */
const renderIfPresent = <T>(
  value: T | undefined,
  render: (value: T) => string | undefined,
): string | undefined => (value === undefined ? undefined : render(value))

/** Render an optional LIST, or `undefined` when it is absent or empty.
 *  Sibling of `renderIfPresent`; kept separate because "present but empty" is
 *  a skip for lists and a render for scalars. */
const renderIfAny = <T>(
  values: readonly T[] | undefined,
  render: (values: readonly T[]) => string | undefined,
): string | undefined => (values !== undefined && values.length > 0 ? render(values) : undefined)

/**
 * ADR-0538 §KEY-TRANSFORM (dynamic atoms) — the `contentByKey` RESOLVER. Maps a
 * dynamic reminder atom's stable `contentKey` to its per-turn wire text via the
 * leaf renderers (a PURE function of the input + the injected clock). Returns
 * `undefined` when the block is empty/absent so the assembler skips it. This is
 * what makes the instruction graph AUTHORITATIVE for the reminder: the wire text
 * is now DERIVED from the atom selection, not a parallel hand-rolled sequence.
 */
export const contentByKey = (
  key: DynamicContentKey,
  input: TurnContextInput,
  selectedGlobRules: readonly GlobRule[],
): string | undefined => {
  switch (key) {
    case "date":
      return todayDateLine(input.now)
    case "cwd":
      return `Working directory: ${input.cwd}`
    case "directives":
      return nonEmptyText(selectActiveDirectives(input.directiveConfig ?? resolveDirectiveConfig()))
    case "language-hint":
      return nonEmptyText(input.languageHint)
    case "env-block":
      return renderEnvBlock(input.env)
    case "repo-rules":
      return renderIfPresent(input.repoRules, renderRepoRulesBlock)
    case "glob-rules":
      return renderIfAny(selectedGlobRules, (rules) => renderGlobRulesBlock([...rules]))
    case "active-skills":
      return renderIfAny(input.activeSkills, renderActiveSkillsBlock)
    case "objective":
      // C2b — LIVE per-turn read of the session objective authority (thunk).
      return renderObjectiveBlock(input.objective?.())
    case "working-state":
      return renderIfPresent(input.workingState, renderWorkingStateBlock)
    case "memory-context":
      return nonEmptyText(input.memoryContext?.trim())
    case "hook-context-tail":
      return renderIfPresent(
        collectHookPromptSide(input.hookPromptInjects, "injectAfterSystem"),
        (afterSystem) => `## Hook context\n${afterSystem}`,
      )
    case "task-budget":
      return renderTaskBudgetBlock(input.taskBudget)
    default:
      // `key` is a DynamicContentKey; every member is handled above. The drift-
      // guard hellgate (case-set == DYNAMIC_ATOMS) fails if a new key is added
      // without a case here.
      return undefined
  }
}

/**
 * ADR-0538 §KEY-TRANSFORM — resolve the ORDERED reminder blocks (atom + text) the
 * per-turn reminder is assembled from. This is the SINGLE selection both the WIRE
 * ({@link buildDynamicContext}) and the fired-atom MANIFEST ({@link buildCompileManifest})
 * derive from, so they CANNOT drift. A notice atom renders its `lines`; a dynamic
 * atom resolves its `contentKey`. An atom whose block is empty/absent is dropped
 * (an atom is "fired" IFF it produced wire text), so the manifest reports exactly
 * what shipped. Order = the atoms' `order` (date/cwd < notices < the rest), which
 * reproduces the prior `buildDynamicContext` sequence exactly.
 */
export const resolveReminderBlocks = (
  input: TurnContextInput,
  effectiveMode: AgentMode,
  selectedGlobRules: readonly GlobRule[],
  repoRulesInStaticSystem: boolean,
): ReadonlyArray<{ atom: InstructionAtom; text: string }> => {
  const ctx = dynamicReminderCtx(input, effectiveMode, selectedGlobRules, repoRulesInStaticSystem)
  const out: { atom: InstructionAtom; text: string }[] = []
  for (const atom of selectAtoms([...NOTICE_ATOMS_ALL, ...DYNAMIC_ATOMS], ctx)) {
    const text =
      atom.contentKey !== undefined
        ? contentByKey(atom.contentKey as DynamicContentKey, input, selectedGlobRules)
        : renderNoticeAtom(atom)
    if (text !== undefined && text.length > 0) out.push({ atom, text })
  }
  return out
}

/**
 * Build the per-turn dynamic context — DERIVED from the reminder atom graph
 * ({@link resolveReminderBlocks}), NOT a hand-rolled sequence. date + cwd are
 * always the first two blocks (lowest `order`, always-on) and join with a single
 * newline; every subsequent block is separated by a blank line — exactly the
 * prior `parts[]` assembly (`[date, cwd]` then `push("", block)` per subsequent
 * block), now produced from one atom selection so the wire and the fired-atom
 * manifest cannot drift. The ORDER (mode notice → brief → directives → langhint →
 * env → repo → glob → skills → working-state → memory → hook-tail → task-budget)
 * is the atoms' `order`, reproducing the prior sequence byte-for-byte.
 */
export const buildDynamicContext = (
  input: TurnContextInput,
  effectiveMode: AgentMode,
  selectedGlobRules: readonly GlobRule[],
  repoRulesInStaticSystem: boolean,
): string | undefined => {
  const blocks = resolveReminderBlocks(
    input,
    effectiveMode,
    selectedGlobRules,
    repoRulesInStaticSystem,
  )
  if (blocks.length === 0) return undefined // date/cwd always render, so unreachable
  const parts: string[] = []
  blocks.forEach(({ text }, i) => {
    if (i < 2)
      parts.push(text) // date, cwd — single-newline joined, no leading blank
    else parts.push("", text) // every subsequent block gets a leading blank line
  })
  return parts.join("\n")
}
