import { afterEach, describe, expect, test } from "bun:test"
import { readSessionRuntimeConfig } from "../../../src/apps/cli/repl/session-runtime-config"

/**
 * `argPrompt` honesty (jun-10) — the field is typed `string | undefined` and
 * EVERY interactive-only gate downstream checks `=== undefined`:
 *   - the welcome banner (repl.ts)
 *   - the crash-resume reinject offer (repl.ts, ADR-0528 L2)
 *   - the image queue / one-shot branch selection
 *
 * But `argvPrompt()` returns `""` for a bare `quanta` launch, so the value was
 * NEVER undefined in a real run — both `=== undefined` gates were dead in the
 * field while green in tests (their stubs passed `undefined`). The config
 * reader is the SSOT seam: an empty positional prompt MUST normalize to
 * `undefined` here so the type tells the truth and the gates work.
 */

const originalArgv = process.argv

afterEach(() => {
  process.argv = originalArgv
})

describe("readSessionRuntimeConfig — argPrompt normalization", () => {
  test("bare launch (no positionals) ⇒ argPrompt is undefined, NOT ''", () => {
    process.argv = ["bun", "/entry.ts"]
    expect(readSessionRuntimeConfig().argPrompt).toBeUndefined()
  })

  test("flag-only launch ⇒ still undefined (flags are not positionals)", () => {
    process.argv = ["bun", "/entry.ts", "--new-session"]
    expect(readSessionRuntimeConfig().argPrompt).toBeUndefined()
  })

  test("a real one-shot prompt passes through verbatim", () => {
    process.argv = ["bun", "/entry.ts", "fix", "the", "tests"]
    expect(readSessionRuntimeConfig().argPrompt).toBe("fix the tests")
  })

  test("whitespace-only positional collapses to undefined (trimmed empty = no prompt)", () => {
    process.argv = ["bun", "/entry.ts", "   "]
    expect(readSessionRuntimeConfig().argPrompt).toBeUndefined()
  })
})
