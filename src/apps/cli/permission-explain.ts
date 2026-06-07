/**
 * `/permission` inspector — Codex 5-axis permission stack breakdown.
 *
 * Sub-commands:
 *   - `/permission`               — short summary (mode + tier counts + 5-axis legend)
 *   - `/permission explain <tool>` — full 5-axis pipeline for one tool
 *   - `/permission list`          — table of all built-in tools (name + tier + read-only)
 *   - `/permission tier <tier>`   — tools in a specific HITL tier
 *
 * Slice discipline: lives in `src/apps/cli` (the application entrypoint). It
 * imports `@/permission` (slash command surface) + `@/tool` (to enumerate
 * default tools + read their `isReadOnly()`/`hitlTier()` declarations). No
 * agent or LLM imports — surface-only, byte-identical impact 0.
 *
 * Security contract: HARD_DENY rules are described by `name` +
 * `description` ONLY. The raw `RegExp` is NEVER rendered — a curious user
 * cannot use this surface to enumerate the catch patterns and craft a
 * bypass. {@link inspectPermission} enforces the same invariant at the
 * library level.
 *
 * Render contract: every block is wrapped through `@/ui/ui-helpers` color
 * helpers so `setColorPolicy("off")` yields plain ASCII byte-identical to a
 * non-TTY render (matches the rest of the slash-command UX).
 */

import { resolveHitlAnnotation } from "@/agent"
import {
  type AxisStep,
  type HITLTier,
  type InspectToolMeta,
  inferToolTier,
  inspectPermission,
  listHardDenyRuleDescriptors,
  type ModePolicyMatrix,
  PERMISSION_AXES,
  type PermissionInspection,
  type PermissionMode,
} from "@/permission"
import { defaultTools, type Tool } from "@/tool"
import { bold, cyan, dim, renderBox } from "@/ui/ui-helpers"
import type { SlashCommand, SlashContext } from "./slash-commands"

/** Tier display order (strict → permissive) for `/permission list`. */
const TIER_ORDER: readonly HITLTier[] = [
  "hand-off-required",
  "always-confirm",
  "pre-approval-ok",
  "none",
]

/** Resolve the *effective* HITL tier for a tool exactly as the runtime gate
 *  does — mirroring `admissibility-gate.ts#resolveHitlTier` (ADR-0047). Two
 *  composed layers:
 *
 *   1. baseline = `inferToolTier(tool, undefined)` — the per-tool classifier /
 *      fail-closed fallback (read-only ⇒ "none"; mutating with no explicit
 *      `hitlTier` ⇒ "always-confirm").
 *   2. `resolveHitlAnnotation(name, undefined, baseline)` — the agent-side
 *      annotation registry (built-in + **operator overrides** from
 *      `~/.quanta/hitl-overrides.json`). The registry applies the one-way
 *      ratchet, so it can only ESCALATE the displayed tier, never relax it.
 *
 *  Layer 2 is the bug fix: the inspector previously reported the *baseline*
 *  only, so an operator override that made a tool STRICTER was invisible here
 *  while the live gate enforced it — the inspector UNDER-reported strictness
 *  (finding #20). Consuming the same resolver the gate uses guarantees the
 *  displayed tier can never be looser than what gates.
 *
 *  Input is `undefined` because no concrete tool input exists at /permission
 *  time: command-prefix overrides correctly stay silent (they are
 *  command-specific), while tool-only overrides — which fire on every
 *  invocation — are reflected, matching the worst case the gate would apply.
 *
 *  A classifier that throws on `undefined` input degrades to the static
 *  inference rule and then still passes through the override registry, so the
 *  fail-closed branch can never under-report relative to the gate. */
const resolveToolTier = (tool: Tool): HITLTier => {
  let baseline: HITLTier
  try {
    baseline = inferToolTier(tool, undefined)
  } catch {
    // A tool whose classifier requires a non-undefined input falls back to
    // the static inference rule — identical to `inferToolTier`'s own
    // fail-closed branch. Never crash the slash command.
    baseline = tool.isReadOnly() ? "none" : "always-confirm"
  }
  // Layer the operator-override registry on top so the displayed tier matches
  // the ENFORCED tier (escalate-only; never under-reports).
  return resolveHitlAnnotation(tool.name, undefined, baseline).tier
}

interface ToolRow {
  readonly name: string
  readonly tier: HITLTier
  readonly isReadOnly: boolean
}

const buildToolRows = (tools: readonly Tool[]): readonly ToolRow[] =>
  tools.map((t) => ({
    name: t.name,
    tier: resolveToolTier(t),
    isReadOnly: t.isReadOnly(),
  }))

const padVisible = (s: string, width: number): string => {
  const pad = " ".repeat(Math.max(0, width - s.length))
  return s + pad
}

/** Top-level `/permission` (no args) — short summary. */
const renderSummary = (mode: PermissionMode, tools: readonly Tool[]): string => {
  const rows = buildToolRows(tools)
  const counts = TIER_ORDER.map((tier) => ({
    tier,
    n: rows.filter((r) => r.tier === tier).length,
  }))
  const hardDenyCount = listHardDenyRuleDescriptors().length

  const lines: string[] = []
  lines.push(`${dim("Mode:")}      ${bold(mode)}`)
  lines.push(`${dim("HITL:")}      4-tier registry · ${rows.length} tools mapped`)
  for (const { tier, n } of counts) {
    if (n === 0) continue
    lines.push(`  ${cyan(padVisible(tier, 22))} ${n} tool${n === 1 ? "" : "s"}`)
  }
  lines.push(
    `${dim("HARD_DENY:")} ${hardDenyCount} rules active (descriptions only — regex hidden)`,
  )
  lines.push(
    `${dim("Stack:")}     5-axis (read-only · hard-deny · hitl-tier · mode-policy · global-default)`,
  )
  lines.push("")
  lines.push(`${dim("Try:")} /permission explain bash`)
  lines.push(`     /permission list`)
  lines.push(`     /permission tier always-confirm`)
  return renderBox(lines, { title: "Permission Policy", titleStyle: bold })
}

const verdictDot = (verdict: string): string => {
  if (verdict === "allow") return "allow"
  if (verdict === "deny") return "deny"
  if (verdict === "ask") return "ask"
  return verdict
}

const renderMatrix = (m: ModePolicyMatrix): string => {
  const rows: readonly { mode: PermissionMode; verdict: string }[] = [
    { mode: "default", verdict: m.default },
    { mode: "acceptEdits", verdict: m.acceptEdits },
    { mode: "bypass", verdict: m.bypass },
    { mode: "auto", verdict: m.auto },
  ]
  return rows.map((r) => `  ${cyan(padVisible(r.mode, 14))} → ${verdictDot(r.verdict)}`).join("\n")
}

const renderPipelineStep = (step: AxisStep, idx: number): string =>
  `  ${dim(`${idx + 1}.`)} ${cyan(padVisible(step.axis, 18))} ${padVisible(step.outcome, 6)} ${step.reason}`

const renderInspection = (inspection: PermissionInspection, mode: PermissionMode): string => {
  const lines: string[] = []
  const tierLabel = inspection.hitlTier ?? "(unmapped)"
  lines.push(`${dim("Tier:")}      ${bold(tierLabel)}`)
  lines.push(`${dim("Read-only:")} ${inspection.isReadOnly ? "yes" : "no (mutating)"}`)
  lines.push(
    `${dim("Source:")}    ${inspection.mapped ? "HITL registry + tool declarations" : "(tool not registered — default policy)"}`,
  )

  // HARD_DENY block.
  if (inspection.hardDenyMatched) {
    lines.push(
      `${dim("HARD_DENY:")} ${bold("matched")} — ${inspection.hardDenyRules.length} rule(s)`,
    )
    for (const r of inspection.hardDenyRules) {
      lines.push(`  - ${cyan(r.name)}: ${r.description}`)
    }
  } else {
    lines.push(`${dim("HARD_DENY:")} no rule matched (or no shell command supplied)`)
  }

  lines.push("")
  lines.push(dim("── Mode matrix (final verdict) ──"))
  lines.push(renderMatrix(inspection.modePolicy))

  lines.push("")
  lines.push(dim(`── 5-axis pipeline (current mode: ${mode}) ──`))
  inspection.pipeline.forEach((step, idx) => {
    lines.push(renderPipelineStep(step, idx))
  })
  // Defensive: ensure every axis from PERMISSION_AXES appeared exactly once.
  // This is a structural invariant — the inspector builds them in order.
  const seen = new Set(inspection.pipeline.map((p) => p.axis))
  for (const ax of PERMISSION_AXES) {
    if (!seen.has(ax)) {
      lines.push(renderPipelineStep({ axis: ax, outcome: "n/a", reason: "(missing)" }, -1))
    }
  }

  return renderBox(lines, {
    title: `Permission · ${inspection.tool}`,
    titleStyle: bold,
  })
}

const renderTierList = (tier: HITLTier, rows: readonly ToolRow[]): string => {
  const matching = rows.filter((r) => r.tier === tier).map((r) => r.name)
  const lines: string[] = []
  if (matching.length === 0) {
    lines.push(dim(`(no built-in tools in tier '${tier}')`))
  } else {
    lines.push(`${matching.length} tool${matching.length === 1 ? "" : "s"}:`)
    lines.push(`  ${matching.join(" · ")}`)
  }
  return renderBox(lines, { title: `HITL Tier · ${tier}`, titleStyle: bold })
}

const renderList = (rows: readonly ToolRow[]): string => {
  const lines: string[] = []
  for (const tier of TIER_ORDER) {
    const matching = rows.filter((r) => r.tier === tier)
    if (matching.length === 0) continue
    lines.push(dim(`── ${tier} (${matching.length}) ──`))
    for (const r of matching) {
      const ro = r.isReadOnly ? "ro" : "rw"
      lines.push(`  ${cyan(padVisible(r.name, 28))} ${dim(`[${ro}]`)}`)
    }
    lines.push("")
  }
  return renderBox(lines, { title: "Tool / Tier Registry", titleStyle: bold })
}

const isHitlTier = (s: string): s is HITLTier =>
  s === "hand-off-required" || s === "always-confirm" || s === "pre-approval-ok" || s === "none"

/** Map a tool name to caller-supplied inspect meta. Falls back gracefully
 *  when the tool is not in the default registry — the inspector then
 *  emits `mapped: false` and renders the default-policy explanation. */
const buildToolMeta = (name: string, tools: readonly Tool[]): InspectToolMeta => {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) return {}
  const tier = resolveToolTier(t)
  return {
    isReadOnly: t.isReadOnly(),
    hitlTier: tier,
  }
}

/** Default mode for the inspector when the surface doesn't pin one.
 *  `default` matches the CLI's documented startup posture. */
const DEFAULT_MODE: PermissionMode = "default"

export const runPermissionRender = async (
  args: readonly string[],
  ctx: SlashContext,
): Promise<number> => {
  const tools = defaultTools
  const mode = DEFAULT_MODE

  if (args.length === 0) {
    ctx.out(`${renderSummary(mode, tools)}\n`)
    return 0
  }

  const sub = args[0] as string
  const rest = args.slice(1)

  if (sub === "explain") {
    if (rest.length !== 1) {
      ctx.err("/permission explain: expected exactly one tool name\n")
      return 1
    }
    const toolName = rest[0] as string
    const meta = buildToolMeta(toolName, tools)
    const inspection = inspectPermission(toolName, { mode }, meta)
    ctx.out(`${renderInspection(inspection, mode)}\n`)
    return 0
  }

  if (sub === "list") {
    if (rest.length > 0) {
      ctx.err("/permission list: takes no arguments\n")
      return 1
    }
    ctx.out(`${renderList(buildToolRows(tools))}\n`)
    return 0
  }

  if (sub === "tier") {
    if (rest.length !== 1) {
      ctx.err("/permission tier: expected exactly one tier name\n")
      return 1
    }
    const tier = rest[0] as string
    if (!isHitlTier(tier)) {
      ctx.err(`/permission tier: invalid tier '${tier}' (valid: ${TIER_ORDER.join("|")})\n`)
      return 1
    }
    ctx.out(`${renderTierList(tier, buildToolRows(tools))}\n`)
    return 0
  }

  ctx.err(`/permission: unknown sub-command '${sub}' (valid: explain|list|tier)\n`)
  return 1
}

export const permissionCmd: SlashCommand = {
  name: "/permission",
  describe: "Inspect permission policy: /permission explain <tool> | list | tier <tier>",
  category: "config",
  run: runPermissionRender,
}
