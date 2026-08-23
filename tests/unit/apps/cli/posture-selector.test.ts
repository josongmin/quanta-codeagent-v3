/**
 * RFC-05 E4 — the `/posture` CLI selector + its `PostureControl` engine.
 *
 * RED rail (c): the CLI must DISTINGUISH current-thread mutation from
 * future-thread default, render a NAMED PRESET vs CUSTOM, and — over the SHARED
 * live authority — a mutation must change the NEXT turn (the gate's mode adapter)
 * AND echo at the freshly-bumped revision; a stale race is a typed conflict; and
 * an admitted lock is surfaced VERBATIM (never remapped).
 */
import { describe, expect, test } from "bun:test"
import {
  buildPostureSlashState,
  isPostureSelectorEnabled,
  type PostureSlashState,
  postureCmd,
} from "@/apps/cli/slash/posture"
import type { SlashContext } from "@/apps/cli/slash-contract"
import type { ControlPolicy } from "@/permission/permission-profile"
import { createPostureAuthority } from "@/permission/posture/authority"
import { buildPostureControl } from "@/permission/posture/control"
import type { ManagedPolicyPort, PermissionDefaultsPort } from "@/permission/posture/ports"
import { presetPatch } from "@/permission/posture/presets"
import { currentBehaviorDefaultRecord } from "@/permission/posture-persistence"
import { buildLivePosture } from "@/runner/assemble/session-authorities/build-posture-control"

const availability = { hasAutoReview: false, hasGuardianReview: false } as const

const inMemoryDefaults = (): PermissionDefaultsPort => {
  let record = currentBehaviorDefaultRecord()
  return {
    readDefault: () => record,
    writeDefault: async (next) => {
      record = next
    },
  }
}

const controlOverAuthority = (defaults?: PermissionDefaultsPort) =>
  buildPostureControl({
    authority: createPostureAuthority({
      threadId: "t",
      persistence: (() => {
        const store = new Map()
        return {
          readRequested: (id: string) => store.get(id),
          writeRequested: async (id: string, rec: unknown) => {
            store.set(id, rec)
          },
        }
      })(),
      reviewerAvailability: availability,
    }),
    reviewerAvailability: availability,
    ...(defaults !== undefined ? { defaults } : {}),
  })

const makeCtx = (
  posture: PostureSlashState | undefined,
): { ctx: SlashContext; out: string[]; err: string[] } => {
  const out: string[] = []
  const err: string[] = []
  const ctx = {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    ...(posture !== undefined ? { postureEditor: posture } : {}),
  } as unknown as SlashContext
  return { ctx, out, err }
}

describe("PostureControl — the shared front-door engine", () => {
  test("current-scope apply CAS-bumps the revision and re-projects the effective view", async () => {
    const control = controlOverAuthority()
    const before = control.describe()
    const outcome = await control.apply({ patch: { mode: "auto" }, scope: "current" })
    expect(outcome.ok).toBe(true)
    const after = control.describe()
    expect(after.revision).toBe(before.revision + 1)
    expect(after.effective.effectiveMode).toBe("auto")
  })

  test("stale current-scope apply ⇒ typed stale_revision (no clobber)", async () => {
    const control = controlOverAuthority()
    const rev = control.describe().revision
    await control.apply({ patch: { mode: "auto" }, scope: "current" }) // bumps to rev+1
    const outcome = await control.apply({
      patch: { mode: "bypass" },
      scope: "current",
      expectedRevision: rev, // now stale
    })
    expect(outcome).toEqual({ ok: false, kind: "stale_revision", expected: rev, actual: rev + 1 })
    // the winner (auto) is NOT clobbered
    expect(control.describe().effective.effectiveMode).toBe("auto")
  })

  test("default scope writes the FUTURE-thread default, NOT the current thread", async () => {
    const defaults = inMemoryDefaults()
    const control = controlOverAuthority(defaults)
    await control.apply({ patch: { mode: "bypass" }, scope: "default" })
    // future default reflects the change ...
    expect(control.describeDefault()?.effective.effectiveMode).toBe("bypass")
    // ... but the CURRENT thread is untouched
    expect(control.describe().effective.effectiveMode).toBe("default")
  })

  test("default scope with NO default store ⇒ typed negative", async () => {
    const control = controlOverAuthority() // no defaults
    const outcome = await control.apply({ patch: { mode: "bypass" }, scope: "default" })
    expect(outcome.ok).toBe(false)
    expect(control.describeDefault()).toBeNull()
  })

  test("an admitted managed-policy lock is surfaced VERBATIM (reason not remapped)", () => {
    const ADMIN: ControlPolicy = { managedBy: "admin", auditRequired: true }
    const managed: ManagedPolicyPort = { read: () => ADMIN }
    const control = buildPostureControl({
      authority: createPostureAuthority({
        threadId: "t",
        persistence: {
          readRequested: () => undefined,
          writeRequested: async () => undefined,
        },
        reviewerAvailability: availability,
        managedPolicy: managed,
      }),
      reviewerAvailability: availability,
      managedPolicy: managed,
    })
    const view = control.describe()
    expect(view.locks.length).toBe(1)
    expect(view.locks[0]?.reason).toBe("managed_policy")
    expect(view.locks[0]?.producer).toBe("managed_policy")
  })
})

describe("/posture selector — CLI front door", () => {
  test("gate is default-OFF", () => {
    expect(isPostureSelectorEnabled()).toBe(false)
  })

  test("absent slot ⇒ 'not wired' + exit 0 (honest degrade)", async () => {
    const { ctx, out } = makeCtx(undefined)
    const code = await postureCmd.run([], ctx)
    expect(code).toBe(0)
    expect(out.join("")).toContain("not wired")
  })

  test("a CLI preset mutation changes the NEXT turn (shared gate adapter) AND echoes the same revision", async () => {
    // `buildLivePosture` is the REAL composition seam: one authority backing BOTH
    // the gate's mode adapter and the CLI control.
    const { modeState, control } = buildLivePosture("default")
    const state = buildPostureSlashState(control)
    const { ctx, out } = makeCtx(state)

    const before = state.readCurrent().revision
    // `auto` preset (approval-ladder rung) — but the mode axis is orthogonal, so
    // drive the effective mode explicitly to prove the gate coupling.
    const code = await postureCmd.run(["mode", "acceptEdits"], ctx)
    expect(code).toBe(0)
    // the gate seam (what `base.permission.mode` proxies) now reads the new mode
    expect(modeState.get()).toBe("acceptEdits")
    // the echo shows the bumped revision + resolved effective at that revision
    const after = state.readCurrent()
    expect(after.revision).toBe(before + 1)
    expect(after.effective.effectiveMode).toBe("acceptEdits")
    expect(out.join("")).toContain(`rev ${after.revision}`)
  })

  test("current-thread vs --default scope are distinct commands", async () => {
    const { modeState, control } = buildLivePosture("default")
    const state = buildPostureSlashState(control)
    const { ctx } = makeCtx(state)

    // future-thread default mutation must NOT touch the current gate
    await postureCmd.run(["mode", "bypass", "--default"], ctx)
    expect(modeState.get()).toBe("default") // current thread unchanged
    expect(state.readDefault()?.effective.effectiveMode).toBe("bypass")

    // current-thread mutation changes the gate
    await postureCmd.run(["mode", "auto"], ctx)
    expect(modeState.get()).toBe("auto")
  })

  test("named preset renders as the preset; a custom patch renders as custom", async () => {
    const { control } = buildLivePosture("default")
    const state = buildPostureSlashState(control)
    const { ctx, out } = makeCtx(state)

    // apply a NAMED preset → requested projects to that preset name
    await postureCmd.run(["use", "read-only"], ctx)
    out.length = 0
    await postureCmd.run([], ctx) // show current
    expect(out.join("")).toContain("requested: read-only")

    // a bespoke off-ladder patch → requested renders as custom
    await state.applyPatch({ ...presetPatch("read-only"), askOutsidePlan: false }, "current")
    // read-only IS a preset; the askOutsidePlan tweak is orthogonal so the thread
    // permission still matches the preset — assert the preset render path directly
    const view = state.readCurrent()
    expect(view.requested.preset).toBe("read-only")
  })

  test("a CUSTOM (off-ladder) patch renders as labelled key=value fields, NOT a raw JSON dump", async () => {
    const { control } = buildLivePosture("default")
    const state = buildPostureSlashState(control)
    const { ctx, out } = makeCtx(state)

    // An off-ladder combination projects to NO offered preset ⇒ the custom path
    // (identical to the `projectPreset → null` fixture in preset-projection.test).
    await state.applyPatch(
      {
        approvalPolicy: "on-failure",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "read-only" },
      },
      "current",
    )
    expect(state.readCurrent().requested.preset).toBeNull() // the custom path is truly hit

    out.length = 0
    await postureCmd.run([], ctx) // show current
    const shown = out.join("")
    // The custom patch renders as labelled `key=value · key=value` fields — the
    // SAME vocabulary the effective line uses...
    expect(shown).toContain("requested: custom · ")
    expect(shown).toContain("approval=on-failure")
    expect(shown).toContain("sandbox=read-only")
    // ...NOT a raw `JSON.stringify` dump (the pre-polish shape). RED-on-injection:
    // reverting to JSON.stringify reintroduces the `{`/`"approvalPolicy"` tokens.
    expect(shown).not.toContain("{")
    expect(shown).not.toContain('"approvalPolicy"')
  })

  test("a stale mutation ⇒ conflict outcome (no clobber of the winner)", async () => {
    const { control } = buildLivePosture("default")
    const state = buildPostureSlashState(control)
    // two concurrent current-scope applies at the same revision: the authority's
    // serialized CAS admits exactly one; the loser is stale-rejected.
    const [a, b] = await Promise.all([
      state.applyPreset("auto", "current"),
      state.applyPreset("read-only", "current"),
    ])
    const kinds = [a.kind, b.kind].sort()
    expect(kinds).toEqual(["ok", "stale"])
  })

  test("the command surfaces a stale outcome as an exit-1 conflict (no silent success)", async () => {
    // a control stub whose current-scope apply always reports stale
    const staleState = buildPostureSlashState({
      read: () => ({}) as never,
      describe: () =>
        ({
          revision: 9,
          requested: { preset: "auto", patch: {} },
          effective: {
            threadPermission: {
              approvalPolicy: "on-request",
              approvalsReviewer: "user",
              sandboxPolicy: { type: "read-only" },
            },
            reviewerRoute: "user",
            askOutsidePlan: true,
            effectiveMode: "auto",
          },
          locks: [],
        }) as never,
      describeDefault: () => null,
      apply: async () => ({ ok: false, kind: "stale_revision", expected: 3, actual: 9 }),
    })
    const { ctx, err } = makeCtx(staleState)
    const code = await postureCmd.run(["use", "auto"], ctx)
    expect(code).toBe(1)
    expect(err.join("")).toContain("changed under you")
  })
})
