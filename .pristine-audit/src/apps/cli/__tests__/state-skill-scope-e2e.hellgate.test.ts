/**
 * Hellgate — ADR-0512 P3 `/state` skill-scope visibility (gate
 * `QUANTA_SKILL_SCOPE_V2`, default-OFF byte-identical).
 *
 * The `/state` panel must answer the user's "왜 이 도구가 없지?" by surfacing the
 * CURRENTLY-active skill and the L1 availability filter's result (visible tools +
 * hidden count). These cases drive the COMMAND through the real `runSlashCommand`
 * dispatcher against the assembled `BUILTINS` (`stateCmd` IS registered in
 * `registry-surface.ts`), with the `skillScope` ctx slot wired exactly as the
 * surface composes it.
 *
 *   §S-1  active skill under v2 ⇒ panel appends a "Skill scope" section naming
 *         the active skill, its visible tools, and the hidden count.
 *   §S-2  slot absent (v2 OFF / skill-less) ⇒ `/state` is BYTE-IDENTICAL to the
 *         working-state-only render (no skill-scope section).
 *   §S-3  slot present but NOTHING scoped (activeSkill null) ⇒ section omitted ⇒
 *         byte-identical to §S-2.
 *   §S-4  hidden tools are summarized by COUNT (and at least one name) so the
 *         user sees WHAT got scoped out.
 */
import { describe, expect, test } from "bun:test"
import type { SkillScopeView } from "@/agent"
import { buildSkillGate, buildSkillScopeView, emptyWorkingState } from "@/agent"
import { runSlashCommand } from "../slash-commands"
import type { SlashContext } from "../slash-contract"

type Spec = { name: string }
const specsOf = (...names: string[]): Spec[] => names.map((name) => ({ name }))

/** Arm a gate for `skill` with `allow`, mirroring how the loop arms scope (a
 *  successful `Skill` dispatch observes `{ name: skill }`). */
const armedScope = (skill: string, allow: string[], specs: Spec[]): SkillScopeView => {
  const gate = buildSkillGate(new Map([[skill, allow]]), undefined)
  if (gate === undefined) throw new Error("expected a gate")
  gate.observe("Skill", { name: skill }, true)
  return buildSkillScopeView(gate, specs)
}

const buildCtx = (opts?: {
  readonly skillScope?: () => SkillScopeView | undefined
}): { ctx: SlashContext; readonly stdout: () => string } => {
  let stdout = ""
  const ctx: SlashContext = {
    out: (s) => {
      stdout += s
    },
    err: () => {},
    cwd: "/tmp",
    // `/state` renders an empty working-state panel when this getter yields an
    // empty snapshot — that empty render is the byte-identical baseline.
    workingState: () => emptyWorkingState(),
    ...(opts?.skillScope !== undefined ? { skillScope: opts.skillScope } : {}),
  }
  return { ctx, stdout: () => stdout }
}

describe("/state skill-scope visibility (ADR-0512 P3)", () => {
  test("§S-1 active skill under v2 ⇒ panel appends a Skill scope section", async () => {
    const specs = specsOf("read", "edit", "bash", "grep", "write")
    const view = armedScope("localize-fault", ["edit"], specs)
    const { ctx, stdout } = buildCtx({ skillScope: () => view })

    const code = await runSlashCommand("/state", ctx)
    expect(code).toBe(0)
    const out = stdout()
    // names the active skill
    expect(out).toContain("localize-fault")
    // a recognizable section header so the user knows what they're looking at
    expect(out.toLowerCase()).toContain("skill scope")
    // visible tools are listed (edit = allowlist, read/grep = nav-base)
    expect(out).toContain("edit")
    expect(out).toContain("read")
  })

  test("§S-2 slot ABSENT (v2 OFF / skill-less) ⇒ byte-identical to working-state only", async () => {
    const withSlot = buildCtx({ skillScope: () => undefined })
    const withoutSlot = buildCtx()

    expect(await runSlashCommand("/state", withSlot.ctx)).toBe(0)
    expect(await runSlashCommand("/state", withoutSlot.ctx)).toBe(0)
    // a slot that yields `undefined` renders identically to no slot at all
    expect(withSlot.stdout()).toBe(withoutSlot.stdout())
    // and neither prints a scope section
    expect(withoutSlot.stdout().toLowerCase()).not.toContain("skill scope")
  })

  test("§S-3 slot present but NOTHING scoped (activeSkill null) ⇒ section omitted, byte-identical", async () => {
    const specs = specsOf("read", "edit", "bash")
    // a declared-but-not-yet-invoked skill: gate exists, no scope armed ⇒
    // activeSkill null ⇒ nothing hidden.
    const gate = buildSkillGate(new Map([["s", ["edit"]]]), undefined)
    if (gate === undefined) throw new Error("expected a gate")
    const view = buildSkillScopeView(gate, specs)
    expect(view.activeSkill).toBeNull()

    const scoped = buildCtx({ skillScope: () => view })
    const baseline = buildCtx()
    expect(await runSlashCommand("/state", scoped.ctx)).toBe(0)
    expect(await runSlashCommand("/state", baseline.ctx)).toBe(0)
    expect(scoped.stdout()).toBe(baseline.stdout())
  })

  test("§S-4 hidden tools surfaced by count + name", async () => {
    const specs = specsOf("read", "edit", "bash", "grep", "write")
    const view = armedScope("read-only-brief", ["edit"], specs)
    // bash + write are out-of-scope
    expect(view.hiddenTools).toEqual(["bash", "write"])
    const { ctx, stdout } = buildCtx({ skillScope: () => view })

    expect(await runSlashCommand("/state", ctx)).toBe(0)
    const out = stdout()
    // the hidden COUNT is shown
    expect(out).toContain("2")
    // and at least one hidden name so the user knows WHAT is scoped out
    expect(out).toMatch(/bash|write/)
  })
})
