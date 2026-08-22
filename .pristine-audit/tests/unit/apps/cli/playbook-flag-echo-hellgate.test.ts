/**
 * HELLGATE — ADR-0301: thread `--playbook-trigger` CLI flag echo through
 * `apps/agent/cli-args.ts` → `toAssembleRequest` → `playbookTriggerFlag()`
 * surface helper → `maybeStartPlaybookTriggerWire({ cliFlag })`.
 *
 * Invariants:
 *   (i)   Flag present ⇒ `AgentArgs.playbookTrigger === true`.
 *   (ii)  Flag absent  ⇒ `AgentArgs.playbookTrigger === undefined` (NOT
 *         `false`, so the projection / spread stays default-OFF-clean).
 *   (iii) `toAssembleRequest(args)` propagates the true-value onto
 *         `AssembleRequestPartial.playbookTrigger`; absent ⇒ slot omitted.
 *   (iv)  `playbookTriggerFlag()` (the REPL-surface argv reader) returns
 *         `true` when `--playbook-trigger` is on `process.argv`,
 *         `false` otherwise.
 *   (v)   `maybeStartPlaybookTriggerWire`: env-on + flag-absent ⇒ active
 *         (existing precedence path).
 *   (vi)  Env-absent + flag-true ⇒ active (the NEW path this ADR enables).
 *   (vii) Env-on + flag-false ⇒ env wins, wire active (precedence locked).
 *   (viii) Both absent ⇒ NOOP handle (`isActive()===false`, no allocation).
 *   (ix)  Value-form `--playbook-trigger=maybe` ⇒ argv parser treats it as
 *         an unknown flag (boolean-only — token equality, not prefix
 *         match) and throws `AgentArgsError` (byte-identical to today —
 *         this ADR does NOT broaden the flag's grammar).
 *
 * 9 cases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentArgsError, parseAgentArgs } from "@/../src/apps/agent/cli-args"
import { toAssembleRequest } from "@/../src/apps/agent/index"
import { playbookTriggerFlag } from "@/../src/apps/cli/internal"
import { maybeStartPlaybookTriggerWire } from "@/../src/apps/cli/repl/playbook-trigger-wire"
import type { PlaybookPlanQueueSink } from "@/skill/playbook"

// ── helpers ────────────────────────────────────────────────────────────

const stubSink = (): PlaybookPlanQueueSink => ({
  enqueue: () => ({ ok: true }),
})

const stubLogger = (): { warn: (m: string) => void; lines: string[] } => {
  const lines: string[] = []
  return { warn: (m: string) => lines.push(m), lines }
}

/** Build a real registry-root directory so `validateRoot` passes; without
 *  this every "active" case would degrade to NOOP via the existsSync gate. */
let tmpRoot: string
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "adr0301-hellgate-"))
  mkdirSync(join(tmpRoot, ".quanta", "playbooks"), { recursive: true })
})
afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* tmp cleanup is best-effort */
  }
})
const root = (): string => join(tmpRoot, ".quanta", "playbooks")

// argv swap for surface-helper test (process.argv read at call time).
let savedArgv: string[]
const setArgv = (argv: string[]): void => {
  process.argv = argv
}
beforeEach(() => {
  savedArgv = [...process.argv]
})
afterEach(() => {
  process.argv = savedArgv
})

// ── (i) flag present → playbookTrigger === true ──────────────────────────
describe("ADR-0301 — flag echo through cli-args / lift / surface", () => {
  test("(i) --playbook-trigger present ⇒ AgentArgs.playbookTrigger === true", () => {
    const a = parseAgentArgs(["--mode", "interactive", "--playbook-trigger"])
    expect(a.playbookTrigger).toBe(true)
  })

  // ── (ii) absent → undefined (NOT false) ───────────────────────────────
  test("(ii) flag absent ⇒ AgentArgs.playbookTrigger === undefined (default-OFF)", () => {
    const a = parseAgentArgs(["--mode", "interactive"])
    expect(a.playbookTrigger).toBeUndefined()
    expect(a.playbookTrigger === false).toBe(false) // explicit assertion
    expect(Object.hasOwn(a, "playbookTrigger")).toBe(false)
  })

  // ── (iii) toAssembleRequest carries the field through ─────────────────
  test("(iii) toAssembleRequest projects playbookTrigger=true when set; omits when absent", () => {
    const withFlag = toAssembleRequest(
      parseAgentArgs(["--mode", "interactive", "--playbook-trigger"]),
    )
    expect(withFlag.playbookTrigger).toBe(true)

    const without = toAssembleRequest(parseAgentArgs(["--mode", "interactive"]))
    expect(without.playbookTrigger).toBeUndefined()
    expect(Object.hasOwn(without, "playbookTrigger")).toBe(false)
  })

  // ── (iv) surface-side argv reader (playbookTriggerFlag helper) ────────
  test("(iv) playbookTriggerFlag() reflects --playbook-trigger presence on argv", () => {
    setArgv(["bun", "quanta", "--playbook-trigger"])
    expect(playbookTriggerFlag()).toBe(true)

    setArgv(["bun", "quanta"])
    expect(playbookTriggerFlag()).toBe(false)
  })
})

// ── (v)-(viii) precedence inside the wire ────────────────────────────────
describe("ADR-0301 — wire precedence (env vs cliFlag)", () => {
  test("(v) env=on + cliFlag absent ⇒ wire active (existing precedence)", () => {
    const log = stubLogger()
    const handle = maybeStartPlaybookTriggerWire({
      env: { QUANTA_PLAYBOOK_TRIGGER: "on" },
      threadId: "t-v",
      planQueueSink: stubSink(),
      registryRoot: root(),
      logger: log,
    })
    expect(handle.isActive()).toBe(true)
    handle.stop()
  })

  test("(vi) env absent + cliFlag=true ⇒ wire active (NEW path)", () => {
    const log = stubLogger()
    const handle = maybeStartPlaybookTriggerWire({
      env: {}, // no QUANTA_PLAYBOOK_TRIGGER
      cliFlag: true,
      threadId: "t-vi",
      planQueueSink: stubSink(),
      registryRoot: root(),
      logger: log,
    })
    expect(handle.isActive()).toBe(true)
    handle.stop()
  })

  test("(vii) env=on + cliFlag=false ⇒ env wins, wire active", () => {
    const log = stubLogger()
    const handle = maybeStartPlaybookTriggerWire({
      env: { QUANTA_PLAYBOOK_TRIGGER: "on" },
      cliFlag: false,
      threadId: "t-vii",
      planQueueSink: stubSink(),
      registryRoot: root(),
      logger: log,
    })
    expect(handle.isActive()).toBe(true)
    handle.stop()
  })

  test("(viii) env absent + cliFlag absent ⇒ NOOP handle (default-OFF)", () => {
    const log = stubLogger()
    const handle = maybeStartPlaybookTriggerWire({
      env: {},
      threadId: "t-viii",
      planQueueSink: stubSink(),
      registryRoot: root(),
      logger: log,
    })
    expect(handle.isActive()).toBe(false)
    // Idempotent stop is a no-op on the shared NOOP handle.
    handle.stop()
    handle.stop()
    expect(handle.isActive()).toBe(false)
  })
})

// ── (ix) invalid grammar — `--playbook-trigger=value` rejected ─────────
describe("ADR-0301 — invalid grammar parity with today", () => {
  test("(ix) --playbook-trigger=maybe ⇒ AgentArgsError (token equality, not prefix)", () => {
    // The parser matches `a === "--playbook-trigger"` exactly. A value-suffix
    // token is an unknown flag — same as today (this ADR did NOT change the
    // grammar). The parser throws AgentArgsError.
    expect(() => parseAgentArgs(["--mode", "interactive", "--playbook-trigger=maybe"])).toThrow(
      AgentArgsError,
    )
  })
})
