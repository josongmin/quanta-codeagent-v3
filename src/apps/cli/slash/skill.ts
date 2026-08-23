/**
 * RFC-06 F5 — `/skill` CLI per-skill action surface (`@/apps/cli/slash`).
 *
 * The operator's per-skill management front door — the surface realization of
 * the copy / reveal / enable-disable verbs. Enable/disable is the surface twin
 * of the `session.skill.set_enabled` command (the web/SDK daemon dispatches the
 * SAME verb through the kernel/host command bus; the CLI REPL is single-focus so
 * it applies it IN-PROCESS through the SHARED F1 {@link SkillRuntimeAuthority}'s
 * CAS `setEnabled`, exactly as `/posture` applies its posture control in-process
 * rather than round-tripping the kernel). Because it mutates the SAME live
 * authority the per-turn prompt/search/invocation read, an enable/disable here
 * changes the NEXT turn's active set, and the echo shows the freshly-bumped
 * revision.
 *
 *   - `/skill copy <name>`      print the RAW on-disk markdown (action-time
 *                               re-resolved + path-jailed + bounded).
 *   - `/skill reveal <name>`    reveal the source in the OS file manager
 *                               (capability-based; unsupported ⇒ honest notice).
 *   - `/skill enable <name>`    CAS enable through the F1 authority.
 *   - `/skill disable <name>`   CAS disable through the F1 authority.
 *
 * There is NO `/skill uninstall` / delete — F6 stays PARKED (destructive jailed
 * FS authority not built).
 *
 * DEFAULT-OFF: registered only when `QUANTA_SKILL_ACTIONS` is on (see
 * {@link isSkillActionsEnabled}) so the `/help` catalog + command table are
 * byte-identical when the gate is unset (parity with `/posture`). When the slot
 * (`ctx.skillActions`) is absent it prints "not wired" + exit 0.
 */

import type {
  SkillActionPorts,
  SkillCopyResult,
  SkillRevealResult,
  SkillRuntimeAuthority,
  SkillSetEnabledResult,
} from "@/skill"
import { copySkillMarkdown, revealSkill, setSkillEnabledAction } from "@/skill"
import { readCliKnob } from "../cli-knobs-accessor"
import type { SlashCommand, SlashContext } from "../slash-contract"
import { successReceipt } from "./render-helpers"

/** The CLI `/skill` wire (`ctx.skillActions`). A thin projection over the shared
 *  live {@link SkillRuntimeAuthority} + the action ports; the surface builds it
 *  via {@link buildSkillActionsState}. Absent ⇒ `/skill` prints "not wired". */
export interface SkillActionsState {
  /** The current unified authority revision (shown in the enable/disable echo). */
  currentRevision(): number
  copy(name: string): Promise<SkillCopyResult>
  reveal(name: string): Promise<SkillRevealResult>
  /** CAS enable/disable at the CURRENT revision (atomic caller). A concurrent
   *  peer that moved the authority makes this a typed `stale_revision` rejection. */
  setEnabled(name: string, enabled: boolean): Promise<SkillSetEnabledResult>
}

/**
 * Build the `/skill` wire over the shared live authority + action ports (the SAME
 * authority the host `setSkillEnabled` projection and the per-turn reader use, so
 * the CLI and the wire never fork mutation semantics). Enable/disable binds the
 * authority's CURRENT revision (atomic caller); a stale peer edit races here and
 * the loser gets a `stale_revision` rejection (never a clobber).
 */
export const buildSkillActionsState = (
  authority: SkillRuntimeAuthority,
  ports: SkillActionPorts,
): SkillActionsState => ({
  currentRevision: () => authority.read().revision,
  copy: (name) => copySkillMarkdown(ports, { name }),
  reveal: (name) => revealSkill(ports, { name }),
  setEnabled: (name, enabled) =>
    setSkillEnabledAction(authority, {
      name,
      enabled,
      expectedRevision: authority.read().revision,
    }),
})

/** RFC-06 F5 — `/skill` registration gate. Default-OFF (opt-IN): registered only
 *  when `QUANTA_SKILL_ACTIONS` is on so `/help` + the command table are
 *  byte-identical when the gate is unset (parity with `/posture`). Routed through
 *  the typed `readCliKnob` accessor (never raw `process.env`). */
export const isSkillActionsEnabled = (): boolean =>
  readCliKnob("QUANTA_SKILL_ACTIONS", "bool") ?? false

/* ------------------------------------------------------------------------- *
 * Sub-command handlers.
 * ------------------------------------------------------------------------- */

const handleCopy = async (
  name: string,
  ctx: SlashContext,
  state: SkillActionsState,
): Promise<number> => {
  const result = await state.copy(name)
  if (result.ok) {
    ctx.out(
      `# ${result.name} (${result.scope}) · ${result.bytes} bytes · ${result.sourcePath}\n\n${result.markdown}\n`,
    )
    return 0
  }
  const r = result.rejection
  switch (r.kind) {
    case "unknown_skill":
      ctx.err(`/skill copy: unknown skill '${r.name}'\n`)
      return 1
    case "path_jail":
      ctx.err(`/skill copy: refused (path jail): ${r.detail}\n`)
      return 1
    case "too_large":
      ctx.err(`/skill copy: '${r.name}' is ${r.bytes} bytes (limit ${r.limit})\n`)
      return 1
    case "read_failed":
      ctx.err(`/skill copy: read failed for '${r.name}': ${r.detail}\n`)
      return 1
  }
}

const handleReveal = async (
  name: string,
  ctx: SlashContext,
  state: SkillActionsState,
): Promise<number> => {
  const result = await state.reveal(name)
  if (result.ok) {
    ctx.out(`📂 Revealed ${result.name} — ${result.sourcePath}\n`)
    return 0
  }
  const r = result.rejection
  switch (r.kind) {
    case "unknown_skill":
      ctx.err(`/skill reveal: unknown skill '${r.name}'\n`)
      return 1
    case "unsupported":
      ctx.err("/skill reveal: not supported on this surface (no OS file manager capability)\n")
      return 1
    case "reveal_failed":
      ctx.err(`/skill reveal: failed for '${r.name}': ${r.detail}\n`)
      return 1
  }
}

const handleSetEnabled = async (
  name: string,
  enabled: boolean,
  ctx: SlashContext,
  state: SkillActionsState,
): Promise<number> => {
  const result = await state.setEnabled(name, enabled)
  if (result.ok) {
    const verb = enabled ? "enabled" : "disabled"
    ctx.out(`${successReceipt(`Skill '${name}' ${verb} (rev ${result.view.revision}).`)}\n`)
    return 0
  }
  const r = result.rejection
  switch (r.kind) {
    case "stale_revision":
      ctx.err(`/skill: changed under you (now rev ${r.actual}) — re-run /skills and retry\n`)
      return 1
    case "unknown_skill":
      ctx.err(`/skill: unknown skill '${r.name}'\n`)
      return 1
    case "policy_denied":
      ctx.err(
        `/skill: refused by admin policy (${r.reason}) — '${r.name}' cannot be ${enabled ? "enabled" : "disabled"}\n`,
      )
      return 1
    case "persist_failed":
      ctx.err(`/skill: failed to persist: ${r.detail}\n`)
      return 1
  }
}

/** RFC-06 F5 — `/skill copy | reveal | enable | disable <name>`. */
export const skillCmd: SlashCommand = {
  name: "/skill",
  describe:
    "Per-skill actions: copy <name> | reveal <name> | enable <name> | disable <name>. Opt-in: QUANTA_SKILL_ACTIONS=1",
  category: "skills",
  async run(args, ctx) {
    const state = ctx.skillActions
    if (state === undefined) {
      ctx.out("/skill: not wired in this surface\n")
      return 0
    }
    const sub = args[0]
    const name = args[1]
    if (sub === undefined) {
      ctx.err("/skill: requires a sub-command (copy | reveal | enable | disable)\n")
      return 1
    }
    if (sub !== "copy" && sub !== "reveal" && sub !== "enable" && sub !== "disable") {
      ctx.err(`/skill: unknown sub-command '${sub}' (copy | reveal | enable | disable)\n`)
      return 1
    }
    if (name === undefined) {
      ctx.err(`/skill ${sub}: requires a skill name\n`)
      return 1
    }
    if (sub === "copy") return handleCopy(name, ctx, state)
    if (sub === "reveal") return handleReveal(name, ctx, state)
    return handleSetEnabled(name, sub === "enable", ctx, state)
  },
}

export type { SlashContext }
