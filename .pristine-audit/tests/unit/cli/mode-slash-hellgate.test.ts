/**
 * #13 — `/mode` interactive permission-posture switch hellgate.
 *
 * `/mode` is the non-keyboard counterpart to the shift+tab mode-cycle: it
 * mutates the SAME `ModeCycleStore` the session loop projects into
 * `permissionModeState` before each turn. So the load-bearing observable is the
 * store's `current().permissionMode` AFTER a set — that is the exact value the
 * next turn reads. The harness backs `ctx.mode` with a REAL `createModeCycleStore`
 * (+ a pill spy mirroring surface-compose's adapter), so these assertions prove
 * the WIRING, not a fake.
 *
 * Coverage:
 *   1. Absent ctx.mode ⇒ "not wired in this surface" + exit 0 (parity).
 *   2. `/mode acceptEdits` ⇒ store.permissionMode flips to "acceptEdits"
 *      (PAIRED with `/mode default` → "default") + pill repainted.
 *   3. `/mode plan` ⇒ permissionMode "default" + agentMode "plan" (the posture
 *      projection, not the literal arg).
 *   4. `/mode bypass` ⇒ permissionMode "bypass" reachable without a 2nd confirm
 *      (parity with shift+tab's 4-rung cycle).
 *   5. Unknown posture ⇒ "unknown posture" + known list + exit 1 (store unchanged).
 *   6. Too many args ⇒ exit 1.
 *   7. No args ⇒ shows the active rung + the list (current marked `*`).
 */
import { describe, expect, test } from "bun:test"
import { createModeCycleStore, MODE_CYCLE } from "../../../src/apps/cli/mode-cycle"
import { runSlashCommand } from "../../../src/apps/cli/slash-commands"
import type { SlashContext } from "../../../src/apps/cli/slash-contract"

interface Harness {
  ctx: SlashContext
  stdout: string
  stderr: string
  store: ReturnType<typeof createModeCycleStore>
  pillCalls: string[]
}

const buildHarness = (opts: { wired: boolean } = { wired: true }): Harness => {
  const store = createModeCycleStore()
  const pillCalls: string[] = []
  const h: Harness = { stdout: "", stderr: "", store, pillCalls } as Harness
  h.ctx = {
    out: (s) => {
      h.stdout += s
    },
    err: (s) => {
      h.stderr += s
    },
    cwd: "/tmp",
    // Mirror surface-compose's modeSlot adapter EXACTLY: set jumps the rung AND
    // repaints the pill; get/list read the live store.
    ...(opts.wired
      ? {
          mode: {
            get: () => store.current().key,
            set: (key: string) => {
              const known = MODE_CYCLE.map((p) => p.key)
              if (!known.includes(key as (typeof known)[number])) {
                return { kind: "unknown" as const, known }
              }
              store.set(key as (typeof known)[number])
              pillCalls.push(store.current().agentMode)
              return "ok" as const
            },
            list: () => MODE_CYCLE.map((p) => p.key),
          },
        }
      : {}),
  }
  return h
}

describe("#13 /mode — not wired", () => {
  test("absent ctx.mode ⇒ 'not wired' + exit 0", async () => {
    const h = buildHarness({ wired: false })
    const code = await runSlashCommand("/mode acceptEdits", h.ctx)
    expect(code).toBe(0)
    expect(h.stdout).toContain("not wired in this surface")
    // The store was never touched (no slot ⇒ no mutation).
    expect(h.store.current().key).toBe("default")
  })
})

describe("#13 /mode — set flips the SAME store the loop projects (WIRING-PROOF)", () => {
  test("PAIRED — /mode acceptEdits ⇒ permissionMode 'acceptEdits'; /mode default ⇒ 'default'", async () => {
    const h = buildHarness()
    expect(await runSlashCommand("/mode acceptEdits", h.ctx)).toBe(0)
    // The exact value the next turn's permissionModeState projection reads.
    expect(h.store.current().permissionMode).toBe("acceptEdits")
    expect(h.store.current().key).toBe("acceptEdits")
    // Pill repainted with the posture's agentMode (acceptEdits ⇒ "default").
    expect(h.pillCalls).toEqual(["default"])

    // Control: back to default ⇒ permissionMode returns to "default".
    expect(await runSlashCommand("/mode default", h.ctx)).toBe(0)
    expect(h.store.current().permissionMode).toBe("default")
  })

  test("/mode plan ⇒ permissionMode 'default' + agentMode 'plan' (posture projection)", async () => {
    const h = buildHarness()
    await runSlashCommand("/mode plan", h.ctx)
    expect(h.store.current().permissionMode).toBe("default")
    expect(h.store.current().agentMode).toBe("plan")
    expect(h.pillCalls).toEqual(["plan"])
  })

  test("/mode bypass ⇒ permissionMode 'bypass' reachable without a 2nd confirm", async () => {
    const h = buildHarness()
    expect(await runSlashCommand("/mode bypass", h.ctx)).toBe(0)
    expect(h.store.current().permissionMode).toBe("bypass")
  })
})

describe("#13 /mode — validation", () => {
  test("unknown posture ⇒ error + known list + exit 1; store unchanged", async () => {
    const h = buildHarness()
    const code = await runSlashCommand("/mode danger", h.ctx)
    expect(code).toBe(1)
    expect(h.stderr).toContain("unknown posture 'danger'")
    expect(h.stderr).toContain("acceptEdits")
    // Rejected set must NOT mutate the store nor repaint the pill.
    expect(h.store.current().key).toBe("default")
    expect(h.pillCalls).toEqual([])
  })

  test("too many args ⇒ exit 1", async () => {
    const h = buildHarness()
    expect(await runSlashCommand("/mode plan bypass", h.ctx)).toBe(1)
  })

  test("no args ⇒ shows active rung + list (current marked '*')", async () => {
    const h = buildHarness()
    await runSlashCommand("/mode acceptEdits", h.ctx)
    h.stdout = ""
    expect(await runSlashCommand("/mode", h.ctx)).toBe(0)
    expect(h.stdout).toContain("permission mode: acceptEdits")
    expect(h.stdout).toContain("* acceptEdits")
    expect(h.stdout).toContain("  default")
  })
})
