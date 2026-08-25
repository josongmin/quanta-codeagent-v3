/**
 * ADR-0296 auto-background — bash tool knob hellgate
 * (`QUANTA_BASH_AUTO_BACKGROUND` + per-call `timeout_behavior`).
 *
 * The bash tool resolves the effective deadline behavior as
 * `input.timeout_behavior ?? runtimeConfig().bashAutoBackground`. When the
 * effective behavior detaches, a command still running at its deadline is moved
 * into the bg registry and the tool yields a `[bash background] shellId=…`
 * placeholder; otherwise the legacy SIGTERM-on-deadline `[timed out]` result.
 *
 * Real `bash` children (POSIX only). Slow commands use sub-second sleeps with a
 * tiny `timeout_ms` so the deadline fires fast.
 *
 * Axes:
 *  1. DEFAULT `kill` — a slow command is KILLED at the deadline (legacy timeout),
 *     NOT detached. Wiring-proof the registry is untouched (size stays 0).
 *  2. KNOB `background` — the SAME slow command now DETACHES (placeholder +
 *     a live registry entry). Red-on-injection: flip the env back to `kill` and
 *     the placeholder disappears.
 *  3. PER-CALL OVERRIDES KNOB — `timeout_behavior:"kill"` under a `background`
 *     knob still kills; `timeout_behavior:"background"` under a `kill` knob
 *     detaches. The per-call argument always wins.
 *  4. THRESHOLD KNOB — `QUANTA_BASH_AUTO_BACKGROUND_THRESHOLD_MS` governs the
 *     detach deadline when no per-call `timeout_ms` is given.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetBashBgRegistry, getBashBgRegistry } from "@/runtime/bash-bg-registry"
import { __resetRuntimeConfig } from "@/shared"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import { bashTool } from "@/tool/bash"

const POSIX = process.platform !== "win32"
const dir = mkdtempSync(join(tmpdir(), "bash-autobg-knob-"))

// `afterAll`, NOT `process.on("exit")`. Bun's test runner does not fire an
// exit hook for a test file, so that form never ran and every fixture dir it
// created stayed on disk — enough of them to make `ls /tmp` slow enough to
// time other tests out.
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

const ENV_KEYS = [
  "QUANTA_BASH_AUTO_BACKGROUND",
  "QUANTA_BASH_AUTO_BACKGROUND_THRESHOLD_MS",
] as const

afterEach(async () => {
  // Reap any detached children this test spawned, then clear knob env + caches.
  await getBashBgRegistry()
    .killAll()
    .catch(() => {})
  __resetBashBgRegistry()
  for (const k of ENV_KEYS) delete process.env[k]
  __resetRuntimeConfig()
})

/** Set knob env + reload the frozen runtimeConfig so the tool reads it. */
const withKnobs = (vars: Partial<Record<(typeof ENV_KEYS)[number], string>>): void => {
  for (const k of ENV_KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(vars)) process.env[k] = v
  __resetRuntimeConfig()
}

const ctx = (signal?: AbortSignal): ToolContext => ({
  cwd: dir,
  signal: signal ?? new AbortController().signal,
})

const run = async (input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of bashTool.execute(input as never, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const SLOW = "printf 'started\\n'; sleep 2"

describe.if(POSIX)("default knob (background, ships ON) — slow command auto-detaches", () => {
  test("absent knob ⇒ background: a slow command at its deadline auto-detaches (default ON)", async () => {
    withKnobs({}) // default → background (ADR-0296 ships ON)
    const result = await run({ command: SLOW, timeout_ms: 120 })
    expect(result.ok).toBe(true)
    expect(result.output).toContain("[bash background]")
    expect(getBashBgRegistry().size()).toBe(1)
  })

  test("explicit QUANTA_BASH_AUTO_BACKGROUND=kill restores the legacy timeout (opt-out)", async () => {
    withKnobs({ QUANTA_BASH_AUTO_BACKGROUND: "kill" })
    const result = await run({ command: SLOW, timeout_ms: 120 })
    expect(result.output).not.toContain("[bash background]")
    expect(result.output.toLowerCase()).toContain("timed out")
    expect(getBashBgRegistry().size()).toBe(0) // never touched the registry
  })
})

describe.if(POSIX)("knob=background — the same slow command now detaches", () => {
  test("QUANTA_BASH_AUTO_BACKGROUND=background ⇒ detach placeholder + a live registry entry", async () => {
    withKnobs({ QUANTA_BASH_AUTO_BACKGROUND: "background" })
    const result = await run({ command: SLOW, timeout_ms: 120 })
    expect(result.ok).toBe(true)
    expect(result.output).toContain("[bash background]")
    expect(result.output).toContain("shellId=")
    expect(result.output).toContain("started") // pre-detach output surfaced
    expect(getBashBgRegistry().size()).toBe(1) // the detached shell is registered
  })

  test("red-on-injection: flipping the knob back to kill removes the placeholder", async () => {
    withKnobs({ QUANTA_BASH_AUTO_BACKGROUND: "kill" })
    const result = await run({ command: SLOW, timeout_ms: 120 })
    expect(result.output).not.toContain("[bash background]")
    expect(getBashBgRegistry().size()).toBe(0)
  })
})

describe.if(POSIX)("per-call timeout_behavior overrides the knob", () => {
  test("timeout_behavior:'kill' under a background knob still kills", async () => {
    withKnobs({ QUANTA_BASH_AUTO_BACKGROUND: "background" })
    const result = await run({ command: SLOW, timeout_ms: 120, timeout_behavior: "kill" })
    expect(result.output).not.toContain("[bash background]")
    expect(result.output.toLowerCase()).toContain("timed out")
    expect(getBashBgRegistry().size()).toBe(0)
  })

  test("timeout_behavior:'background' under a kill knob detaches", async () => {
    withKnobs({ QUANTA_BASH_AUTO_BACKGROUND: "kill" })
    const result = await run({ command: SLOW, timeout_ms: 120, timeout_behavior: "background" })
    expect(result.output).toContain("[bash background]")
    expect(getBashBgRegistry().size()).toBe(1)
  })
})

describe.if(POSIX)("threshold knob governs the detach deadline", () => {
  test("QUANTA_BASH_AUTO_BACKGROUND_THRESHOLD_MS fires the detach when no per-call timeout_ms is set", async () => {
    withKnobs({
      QUANTA_BASH_AUTO_BACKGROUND: "background",
      QUANTA_BASH_AUTO_BACKGROUND_THRESHOLD_MS: "120",
    })
    const result = await run({ command: SLOW }) // no per-call timeout_ms
    expect(result.output).toContain("[bash background]")
    expect(getBashBgRegistry().size()).toBe(1)
  })

  test("a fast command under the threshold completes normally (no detach)", async () => {
    withKnobs({
      QUANTA_BASH_AUTO_BACKGROUND: "background",
      QUANTA_BASH_AUTO_BACKGROUND_THRESHOLD_MS: "5000",
    })
    const result = await run({ command: "printf done" })
    expect(result.output).not.toContain("[bash background]")
    expect(result.output).toContain("done")
    expect(getBashBgRegistry().size()).toBe(0)
  })
})
