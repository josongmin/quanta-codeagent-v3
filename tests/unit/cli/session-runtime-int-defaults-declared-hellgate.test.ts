import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CLI_KNOBS } from "../../../src/apps/cli/cli-knobs"
import { readSessionRuntimeConfig } from "../../../src/apps/cli/repl/session-runtime-config"

/**
 * The session's int fallbacks ARE the `CLI_KNOBS` declarations, not copies of them.
 *
 * `repl/session-runtime-config.ts` used to restate them inline —
 * `intKnob("QUANTA_IDLE_MS", 60_000)` beside `default: 60000` in `cli-knobs.ts` — so a
 * changed default had two homes and `/knobs` could advertise one while the session
 * ran the other. The inline literal also tripped the magic-timeout scan in
 * `src-no-sketchy-code.test.ts`.
 *
 * Asserted by BEHAVIOUR against the declaration, not by reading the source: a
 * source-string check would pass over a copy that happens to hold the same number
 * today.
 */

const KEYS = [
  ["QUANTA_IDLE_MS", "idleMs"],
  ["QUANTA_SNOOZE_DEFAULT_MS", "snoozeDefaultMs"],
  ["QUANTA_REJECT_LIMIT", "rejectLimit"],
] as const

const saved: Record<string, string | undefined> = {}
const originalArgv = process.argv

beforeEach(() => {
  process.argv = ["bun", "/entry.ts"]
  for (const [key] of KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  process.argv = originalArgv
  for (const [key] of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe("session runtime int fallbacks come from CLI_KNOBS", () => {
  for (const [key, field] of KEYS) {
    test(`${key} unset ⇒ ${field} is the declared default`, () => {
      const row = CLI_KNOBS.find((k) => k.envKey === key)
      expect(row, `${key} is not declared in CLI_KNOBS`).toBeDefined()
      expect(typeof row?.default).toBe("number")
      expect(readSessionRuntimeConfig()[field]).toBe(row?.default as number)
    })

    test(`${key} set ⇒ ${field} follows the env, not the declaration`, () => {
      // PAIRED CONTROL: without it a config that ignored the env entirely and always
      // returned the declared default would pass the arm above.
      const row = CLI_KNOBS.find((k) => k.envKey === key)
      const other = (row?.default as number) + 7
      process.env[key] = String(other)
      expect(readSessionRuntimeConfig()[field]).toBe(other)
    })
  }
})
