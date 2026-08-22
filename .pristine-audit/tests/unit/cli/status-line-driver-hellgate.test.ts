import { describe, expect, test } from "bun:test"
import type { StatusBar } from "@/apps/cli/status-bar"
import type {
  SessionStatusView,
  StatusLineConfig,
  StatusSpawner,
  StatusSpawnHandle,
} from "@/apps/cli/status-command-runner"
import { createStatusLineDriver } from "@/apps/cli/status-line-driver"
import { createStatusPills } from "@/apps/cli/status-pills"

/**
 * #15 — the scriptable statusLine had ZERO production consumers
 * (`runStatusCommand` / `buildStatusPayload` were built-not-wired). This proves
 * the DRIVER closes the full chain end-to-end:
 *
 *   command stdout ──▶ runStatusCommand ──▶ driver.tick ──▶ pills.update
 *                  ──▶ composeLine segment ──▶ statusBar.setDefault (the row)
 *
 * REAL-EFFECT: we assert the rendered STATUS ROW (what `setDefault` receives)
 * actually contains the script's output — not that a mock was called.
 */

/** Recording status bar — captures every default-row paint. */
const recordingBar = (): StatusBar & { lastDefault: () => string; defaults: string[] } => {
  const defaults: string[] = []
  return {
    setDefault: (t) => defaults.push(t),
    transient: () => undefined,
    clearTransient: () => undefined,
    teardown: () => undefined,
    defaults,
    lastDefault: () => defaults[defaults.length - 1] ?? "",
  }
}

/** Deterministic spawner emitting `line\n` on stdout with exit 0. */
const spawnerEmitting = (line: string): StatusSpawner => {
  return (): StatusSpawnHandle => ({
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`${line}\n`))
        c.close()
      },
    }),
    exited: Promise.resolve(0),
    kill: () => undefined,
  })
}

/** A spawner that throws synchronously ⇒ runStatusCommand degrades to "". */
const spawnerThrowing = (): StatusSpawner => {
  return (): StatusSpawnHandle => {
    throw new Error("spawn failed")
  }
}

const cfg: StatusLineConfig = { command: ["status-script"] }
const view = (): SessionStatusView => ({ cwd: "/x/proj", modelId: "m1" })

const livePills = (bar: StatusBar) =>
  createStatusPills({ statusBar: bar, enabled: true, isTTY: true, initial: { cwd: "/x/proj" } })

describe("#15 — status line driver routes command output into the pills row", () => {
  test("tick ⇒ the script's first line appears in the rendered status row", async () => {
    const bar = recordingBar()
    const pills = livePills(bar)
    const driver = createStatusLineDriver({
      cfg,
      view,
      pills,
      spawn: spawnerEmitting("BUILD ✓ 42ms"),
      width: 200,
    })
    await driver.tick()
    // REAL-EFFECT: the status ROW (not a mock) carries the script output.
    expect(bar.lastDefault()).toContain("BUILD ✓ 42ms")
    // WIRING: pills are NOT clobbered — the workspace pill still shows.
    expect(bar.lastDefault()).toContain("proj")
  })

  test("PAIRED — a degraded run (spawn throws) leaves the row WITHOUT a status line", async () => {
    const bar = recordingBar()
    const pills = livePills(bar)
    const driver = createStatusLineDriver({
      cfg,
      view,
      pills,
      spawn: spawnerThrowing(),
      width: 200,
    })
    await driver.tick()
    // No status-line segment was painted; the row is just the base pills.
    expect(bar.lastDefault()).not.toContain("BUILD")
    expect(bar.defaults.every((d) => !d.includes("status-script"))).toBe(true)
  })
})

describe("#15 — pills statusLine segment is additive (byte-identical when absent)", () => {
  test("no statusLine set ⇒ render equals the pre-#15 baseline", () => {
    const a = createStatusPills({ enabled: true, isTTY: true, initial: { cwd: "/x/proj" } })
    // Same composer, then set + clear the statusLine back to empty.
    const b = createStatusPills({ enabled: true, isTTY: true, initial: { cwd: "/x/proj" } })
    b.update({ statusLine: "" })
    expect(b.render()).toBe(a.render())
  })

  test("statusLine set ⇒ segment appears; PAIRED clearing it removes the segment", () => {
    const p = createStatusPills({ enabled: true, isTTY: true, initial: { cwd: "/x/proj" } })
    const base = p.render()
    p.update({ statusLine: "SENTINEL-LINE" })
    expect(p.render()).toContain("SENTINEL-LINE")
    p.update({ statusLine: "" })
    expect(p.render()).toBe(base) // back to byte-identical baseline
  })
})
