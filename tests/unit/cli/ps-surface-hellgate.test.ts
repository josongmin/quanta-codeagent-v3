/**
 * RFC02-1 — `/ps` list-only background-shell surface hellgate.
 *
 * Two load-bearing properties:
 *  1. REGISTRATION GATE (OFF byte-identical) — `/ps` is registered ONLY when
 *     `QUANTA_PROC_PANEL` is on. With the gate unset the command is absent from
 *     the surface layer, so the `/help` catalog is byte-identical (the exact T2
 *     jul-15 foreground-registration parity break). Red-on-injection: drop the
 *     `isProcPanelEnabled()` guard on the registration and the OFF case gains a
 *     `/ps` entry.
 *  2. REDACTION (list-only) — the rendered panel surfaces ONLY the lifecycle
 *     facts (id/status/elapsed/exitCode). A secret-bearing command/cwd/output in
 *     the underlying registry snapshot NEVER reaches the `/ps` output, because
 *     the read model (`ProcPanelRow`) does not even carry those fields.
 */

import { describe, expect, test } from "bun:test"
import { renderProcPanel } from "@/apps/cli/proc-panel"
import { buildSurfaceSlashCommands } from "@/apps/cli/slash/registry-surface"
import type { SlashCommand, SlashContext } from "@/apps/cli/slash-contract"

const names = (): string[] => {
  const cmds = buildSurfaceSlashCommands((): readonly SlashCommand[] => [])
  return cmds.map((c) => c.name)
}

const withEnv = <T>(key: string, val: string | undefined, fn: () => T): T => {
  const prev = process.env[key]
  if (val === undefined) delete process.env[key]
  else process.env[key] = val
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

describe("RFC02-1 — /ps registration gate (OFF byte-identical)", () => {
  test("QUANTA_PROC_PANEL unset ⇒ /ps is NOT registered", () => {
    withEnv("QUANTA_PROC_PANEL", undefined, () => {
      expect(names()).not.toContain("/ps")
    })
  })

  test("QUANTA_PROC_PANEL=1 ⇒ /ps IS registered", () => {
    withEnv("QUANTA_PROC_PANEL", "1", () => {
      expect(names()).toContain("/ps")
    })
  })
})

const capture = () => {
  const box = { out: "", err: "" }
  return {
    box,
    ctx: {
      out: (s: string) => {
        box.out += s
      },
      err: (s: string) => {
        box.err += s
      },
      now: () => 10_000,
    } as unknown as Partial<SlashContext> & Pick<SlashContext, "out" | "err">,
  }
}

/** Build a `/ps` command instance with the gate on + drive its `run`. */
const runPs = async (
  box: { out: string; err: string },
  ctx: Partial<SlashContext> & Pick<SlashContext, "out" | "err">,
  args: string[] = [],
): Promise<{ out: string; err: string; code: number }> => {
  const cmd = withEnv("QUANTA_PROC_PANEL", "1", () =>
    buildSurfaceSlashCommands((): readonly SlashCommand[] => []).find((c) => c.name === "/ps"),
  )
  if (cmd === undefined) throw new Error("/ps not registered")
  const code = await cmd.run(args, ctx as SlashContext)
  return { out: box.out, err: box.err, code }
}

describe("RFC02-1 — /ps is list-only + owner-scoped + redacted", () => {
  test("renders owned shells' id/status/exit but NEVER command/cwd/output", async () => {
    const { box, ctx } = capture()
    ;(ctx as Record<string, unknown>).procShells = () => [
      { id: "aaaa1111bbbb", status: "running" as const, startedAt: 5_000, exitCode: null },
      { id: "cccc2222dddd", status: "completed" as const, startedAt: 1_000, exitCode: 0 },
    ]
    const { out, code } = await runPs(box, ctx)
    expect(code).toBe(0)
    // Ids (short) + statuses present.
    expect(out).toContain("aaaa1111")
    expect(out).toContain("running")
    expect(out).toContain("completed")
    // Elapsed derived from injected now (10s - 5s = 5s).
    expect(out).toContain("5s")
    // No sensitive fields — even if the underlying registry had them, the read
    // model does not carry command/cwd/output, so they cannot appear.
    expect(out).not.toContain("PGPASSWORD")
    expect(out).not.toContain("/secret/cwd")
  })

  test("absent procShells getter ⇒ 'not wired' + exit 0 (parity with /agents)", async () => {
    const { box, ctx } = capture()
    const { out, code } = await runPs(box, ctx)
    expect(code).toBe(0)
    expect(out).toContain("not wired")
  })

  test("rejects arguments (list-only; no kill verb on /ps)", async () => {
    const { box, ctx } = capture()
    ;(ctx as Record<string, unknown>).procShells = () => []
    const { code } = await runPs(box, ctx, ["kill", "abc"])
    expect(code).toBe(1)
  })
})

describe("RFC02-1 — renderProcPanel drops sensitive fields by construction", () => {
  test("a secret embedded via a rogue extra field is never rendered", () => {
    // Even if a caller sneaks command/cwd onto the row object, the renderer only
    // reads id/status/startedAt/exitCode.
    const rogue = [
      {
        id: "deadbeef0000",
        status: "running" as const,
        startedAt: 0,
        exitCode: null,
        command: "psql PGPASSWORD=topsecret",
        cwd: "/secret/cwd",
        stdout: "leak-me",
      },
    ]
    const out = renderProcPanel(rogue, { now: 1000 })
    expect(out).toContain("deadbeef")
    expect(out).not.toContain("topsecret")
    expect(out).not.toContain("/secret/cwd")
    expect(out).not.toContain("leak-me")
  })

  test("empty inventory renders a clear owned-none line", () => {
    expect(renderProcPanel([], { now: 0 })).toContain("No background shells")
  })
})
