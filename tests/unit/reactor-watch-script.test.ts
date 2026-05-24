/**
 * ADR-0132 Phase E — reactor-watch cron stub: argv + pollOnce decision matrix.
 *
 * The script is intentionally a stub (production adapters bind at the
 * composition root). The contract worth locking is:
 *
 *   1. `parseArgs` shape — argv flags don't drift before production wires.
 *   2. `pollOnce` decision matrix — given (triggers, dryRun, env), the
 *      `action` field is what the watcher will do. This is the same matrix
 *      a CI smoke would assert end-to-end.
 *
 * Both helpers are pure and import-only (no IO at construction), so the
 * tests run in-process without spawning gh / git.
 */

import { describe, expect, test } from "bun:test"
import { REACTOR_ENV_FLAG } from "@/reactor"
import type { ProactiveTrigger } from "@/reactor/types"
import { parseArgs, pollOnce } from "../../scripts/reactor-watch"

const fakeTrigger = (): ProactiveTrigger =>
  Object.freeze({
    reason: "ci_completion",
    evidence: Object.freeze({ kind: "url" as const, value: "https://x/1" }),
    simulatedMessage: "CI done",
    abortSignal: new AbortController().signal,
  })

describe("ADR-0132 Phase E — parseArgs", () => {
  test("defaults: undefined pr, 60s interval, not-once, not-dry-run, not-help", () => {
    const a = parseArgs([])
    expect(a.prRef).toBeUndefined()
    expect(a.intervalMs).toBe(60_000)
    expect(a.once).toBe(false)
    expect(a.dryRun).toBe(false)
    expect(a.help).toBe(false)
  })

  test("--pr <ref> + --once + --dry-run are picked up", () => {
    const a = parseArgs(["--pr", "owner/repo#7", "--once", "--dry-run"])
    expect(a.prRef).toBe("owner/repo#7")
    expect(a.once).toBe(true)
    expect(a.dryRun).toBe(true)
  })

  test("--interval-ms accepts large values and ignores too-small (min 5s)", () => {
    expect(parseArgs(["--interval-ms", "120000"]).intervalMs).toBe(120_000)
    // Below MIN_INTERVAL_MS ⇒ default is kept.
    expect(parseArgs(["--interval-ms", "1000"]).intervalMs).toBe(60_000)
    // Non-numeric ⇒ default.
    expect(parseArgs(["--interval-ms", "fast"]).intervalMs).toBe(60_000)
  })

  test("--help and -h both set help=true", () => {
    expect(parseArgs(["--help"]).help).toBe(true)
    expect(parseArgs(["-h"]).help).toBe(true)
  })

  test("unknown flags are tolerated (forward-compat)", () => {
    const a = parseArgs(["--pr", "1", "--future-flag", "xyz"])
    expect(a.prRef).toBe("1")
  })
})

describe("ADR-0132 Phase E — pollOnce decision matrix", () => {
  const sourceWith = (
    triggers: readonly ProactiveTrigger[],
  ): { poll(): Promise<readonly ProactiveTrigger[]> } => ({
    poll: async () => triggers,
  })
  const envWith = (
    vars: Readonly<Record<string, string>>,
  ): { get(name: string): string | undefined } => ({
    get: (n) => vars[n],
  })

  test("no triggers ⇒ action=no-trigger regardless of env / dry-run", async () => {
    const r1 = await pollOnce({
      source: sourceWith([]),
      dryRun: false,
      env: envWith({ [REACTOR_ENV_FLAG]: "1" }),
    })
    expect(r1.action).toBe("no-trigger")
    const r2 = await pollOnce({
      source: sourceWith([]),
      dryRun: true,
      env: envWith({}),
    })
    expect(r2.action).toBe("no-trigger")
  })

  test("triggers + dry-run ⇒ action=dry-run (env irrelevant)", async () => {
    const r = await pollOnce({
      source: sourceWith([fakeTrigger()]),
      dryRun: true,
      env: envWith({}),
    })
    expect(r.action).toBe("dry-run")
    expect(r.triggers.length).toBe(1)
  })

  test("triggers + env-off + not-dry-run ⇒ action=env-off", async () => {
    const r = await pollOnce({
      source: sourceWith([fakeTrigger()]),
      dryRun: false,
      env: envWith({}),
    })
    expect(r.action).toBe("env-off")
  })

  test("triggers + env=1 + not-dry-run ⇒ action=enqueued", async () => {
    const r = await pollOnce({
      source: sourceWith([fakeTrigger()]),
      dryRun: false,
      env: envWith({ [REACTOR_ENV_FLAG]: "1" }),
    })
    expect(r.action).toBe("enqueued")
  })

  test("env value other than literal '1' ⇒ action=env-off (strict match)", async () => {
    const r = await pollOnce({
      source: sourceWith([fakeTrigger()]),
      dryRun: false,
      env: envWith({ [REACTOR_ENV_FLAG]: "true" }),
    })
    expect(r.action).toBe("env-off")
  })
})
