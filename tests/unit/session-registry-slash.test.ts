/**
 * ★ ADR-0370 + ADR-0374 + ADR-0376 — `/session-registry` slash command wire test.
 *
 * Lives in `tests/unit/` (NOT under `src/agent/.../​__tests__/`) because
 * the slice fence forbids library slices importing `@/apps/cli/*`.
 * The companion inspector hellgate
 * (`src/agent/session-resource-registry/__tests__/inspector.hellgate.test.ts`)
 * pins the inspector contract; this file pins ONLY the CLI registration
 * + the `run`-path NO-THROW invariant.
 *
 * Coverage:
 *   ADR-0370 (5 cases — baseline):
 *     1.  `/session-registry` is present in `BUILTINS`
 *     2.  command has `run` + `describe` + correct category
 *     3.  `run [no args]` writes a stats block to `out` + exits 0
 *     4.  `run ["help"]` writes the help menu + exits 0
 *     5.  `run ["unknown"]` writes to `err` + exits 1
 *
 *   ADR-0374 (evict sub-command — 7 cases):
 *     6.  `run ["evict"]` (no id) → stderr "usage" + exit 1 (NO-THROW)
 *     7.  `run ["evict", "session-x"]` → success message on out + exit 0
 *     8.  `run ["evict", "session-x"]` → calls registry.evict(sessionId) once
 *     9.  `run ["evict", "unknown-id"]` → idempotent success (ADR-0345)
 *     10. `run ["evict", "session-x"]` then `run [stats]` → sessions count drops
 *     11. registry.evict throws → graceful error on stderr + exit 1 (NO-THROW)
 *     12. `run ["evict", "session-x", "extra"]` → only first id is evicted
 *
 *   ADR-0376 (help discovery — 5 cases):
 *     13. help output lists all sub-commands (stats / evict / help)
 *     14. help output shows `evict <id>` usage
 *     15. help output mentions backend detect priority (sqlite > disk > in-memory)
 *     16. `run ["help"]` is NO-THROW + exit 0 (already covered, re-pinned)
 *     17. unknown sub-command stderr includes "evict" in the known list
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import {
  getGlobalSessionResourceRegistry,
  resetGlobalSessionResourceRegistry,
} from "@/agent/session-resource-registry/global"
import { BUILTINS } from "@/apps/cli/slash-commands"
import type { SlashContext } from "@/apps/cli/slash-contract"

const findCmd = () => BUILTINS.find((c) => c.name === "/session-registry")

interface CapturedCtx extends SlashContext {
  readonly outBuf: string[]
  readonly errBuf: string[]
}

const makeCtx = (): CapturedCtx => {
  const outBuf: string[] = []
  const errBuf: string[] = []
  return {
    outBuf,
    errBuf,
    out: (s: string) => {
      outBuf.push(s)
    },
    err: (s: string) => {
      errBuf.push(s)
    },
    cwd: process.cwd(),
  }
}

// Per-test registry isolation so the singleton from earlier tests
// (or sibling files) does not pollute the assertions below. The
// registry is process-local so a `resetGlobalSessionResourceRegistry()`
// at every boundary suffices.
beforeEach(() => {
  resetGlobalSessionResourceRegistry()
})

afterEach(() => {
  resetGlobalSessionResourceRegistry()
})

describe("ADR-0370 /session-registry slash wire", () => {
  test("[1] BUILTINS contains /session-registry", () => {
    const names = BUILTINS.map((c) => c.name)
    expect(names).toContain("/session-registry")
  })

  test("[2] command has run + describe + category=other", () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    expect(typeof cmd?.run).toBe("function")
    expect(typeof cmd?.describe).toBe("string")
    expect(cmd?.describe.length).toBeGreaterThan(0)
    expect(cmd?.category).toBe("other")
  })

  test("[3] run [no args] → stats block + exit 0", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run([], ctx)
    expect(exit).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out).toContain("Session Registry")
    expect(out).toContain("Sessions:")
    expect(ctx.errBuf).toEqual([])
  })

  test("[4] run [help] → help menu + exit 0", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run(["help"], ctx)
    expect(exit).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out).toContain("/session-registry")
    expect(out).toContain("stats")
  })

  test("[5] run [unknown] → stderr + exit 1", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run(["bogus"], ctx)
    expect(exit).toBe(1)
    const err = ctx.errBuf.join("")
    expect(err).toContain("unknown subcommand")
    expect(err).toContain("bogus")
  })
})

describe("ADR-0374 /session-registry evict <id>", () => {
  test("[6] run [evict] (no id) → usage on stderr + exit 1", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run(["evict"], ctx)
    expect(exit).toBe(1)
    const err = ctx.errBuf.join("")
    expect(err).toContain("usage")
    expect(err).toContain("/session-registry evict <sessionId>")
    expect(ctx.outBuf).toEqual([])
  })

  test("[7] run [evict, session-x] → success on out + exit 0", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    // Pre-seed the registry so the evict has a target.
    getGlobalSessionResourceRegistry().getOrCreate("session-x")
    const ctx = makeCtx()
    const exit = await cmd.run(["evict", "session-x"], ctx)
    expect(exit).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out).toContain("evicted")
    expect(out).toContain("session-x")
    expect(ctx.errBuf).toEqual([])
  })

  test("[8] run [evict, id] calls registry.evict(id) exactly once", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const reg = getGlobalSessionResourceRegistry()
    const spy = mock(reg.evict.bind(reg))
    // Replace evict on the singleton instance so the slash hits the spy.
    ;(reg as { evict: (id: string) => void }).evict = spy
    const ctx = makeCtx()
    const exit = await cmd.run(["evict", "session-spy"], ctx)
    expect(exit).toBe(0)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]).toEqual(["session-spy"])
  })

  test("[9] run [evict, unknown-id] is idempotent — success even with no entry", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    // Registry empty — evict on an unknown id must be a NO-THROW no-op
    // and the slash must still report success (ADR-0345 idempotent contract).
    const ctx = makeCtx()
    const exit = await cmd.run(["evict", "never-existed"], ctx)
    expect(exit).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out).toContain("evicted")
    expect(out).toContain("never-existed")
    expect(ctx.errBuf).toEqual([])
  })

  test("[10] evict then stats → sessions count reflects removal", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const reg = getGlobalSessionResourceRegistry()
    reg.getOrCreate("session-a")
    reg.getOrCreate("session-b")
    expect(reg.size()).toBe(2)
    const ctx1 = makeCtx()
    await cmd.run(["evict", "session-a"], ctx1)
    expect(reg.size()).toBe(1)
    const ctx2 = makeCtx()
    await cmd.run(["stats"], ctx2)
    const out = ctx2.outBuf.join("")
    expect(out).toContain("Sessions:")
    // The stats line carries the post-evict count.
    expect(out).toMatch(/Sessions:\s+1/)
  })

  test("[11] registry.evict throws → graceful stderr + exit 1 (NO-THROW slash)", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const reg = getGlobalSessionResourceRegistry()
    ;(reg as { evict: (id: string) => void }).evict = () => {
      throw new Error("disk-io-error")
    }
    const ctx = makeCtx()
    // The slash itself MUST NOT throw — the await resolves to an exit code.
    const exit = await cmd.run(["evict", "session-q"], ctx)
    expect(exit).toBe(1)
    const err = ctx.errBuf.join("")
    expect(err).toContain("evict failed")
    expect(err).toContain("disk-io-error")
  })

  test("[12] extra args after id are ignored (only first id evicted)", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const reg = getGlobalSessionResourceRegistry()
    const evicted: string[] = []
    ;(reg as { evict: (id: string) => void }).evict = (id) => {
      evicted.push(id)
    }
    const ctx = makeCtx()
    const exit = await cmd.run(["evict", "session-x", "extra", "junk"], ctx)
    expect(exit).toBe(0)
    expect(evicted).toEqual(["session-x"])
  })
})

describe("ADR-0376 /session-registry help discovery", () => {
  test("[13] help lists every sub-command (stats / evict / help)", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run(["help"], ctx)
    expect(exit).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out).toContain("stats")
    expect(out).toContain("evict")
    expect(out).toContain("help")
  })

  test("[14] help shows `evict <id>` usage shape", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    await cmd.run(["help"], ctx)
    const out = ctx.outBuf.join("")
    // Must include the placeholder so operators see the required arg.
    expect(out).toMatch(/evict\s+<.*id.*>/i)
  })

  test("[15] help shows backend detect priority chain", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    await cmd.run(["help"], ctx)
    const out = ctx.outBuf.join("")
    // Priority chain — the precedence is the operator's mental model.
    expect(out).toContain("QUANTA_SESSION_REGISTRY_SQLITE_PATH")
    expect(out).toContain("QUANTA_SESSION_REGISTRY_DISK_DIR")
    expect(out).toContain("in-memory")
  })

  test("[16] help is NO-THROW + exit 0 (re-pin of [4])", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    let threw = false
    try {
      const exit = await cmd.run(["help"], ctx)
      expect(exit).toBe(0)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(ctx.errBuf).toEqual([])
  })

  test("[17] unknown sub-command surfaces 'evict' in known list", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run(["typo"], ctx)
    expect(exit).toBe(1)
    const err = ctx.errBuf.join("")
    expect(err).toContain("unknown subcommand")
    expect(err).toContain("evict")
    expect(err).toContain("stats")
    expect(err).toContain("help")
  })

  // ─── ADR-0379 `cleanup` sub-command ────────────────────────────────────

  test("[18] cleanup is a known sub-command (no unknown-subcommand error)", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run(["cleanup"], ctx)
    expect(exit).toBe(0)
    const err = ctx.errBuf.join("")
    expect(err).not.toContain("unknown subcommand")
  })

  test("[19] cleanup renders stats + 'Sweep complete' marker", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    await cmd.run(["cleanup"], ctx)
    const out = ctx.outBuf.join("")
    expect(out).toContain("Session Registry")
    expect(out).toContain("Sweep complete.")
  })

  test("[20] help menu lists the new `cleanup` sub-command", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run(["help"], ctx)
    expect(exit).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out).toContain("cleanup")
    expect(out).toContain("ADR-0379")
  })

  test("[21] unknown-sub error message mentions 'cleanup' in known list", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    await cmd.run(["bogus"], ctx)
    const err = ctx.errBuf.join("")
    expect(err).toContain("cleanup")
  })

  // ─── ADR-0387 `cleanup --dry-run` flag ─────────────────────────────────

  test("[32] cleanup --dry-run renders 'Dry-run:' header + exit 0", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run(["cleanup", "--dry-run"], ctx)
    expect(exit).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out).toContain("Dry-run:")
    expect(ctx.errBuf).toEqual([])
  })

  test("[33] cleanup --dry-run does NOT run sweep ('Sweep complete' absent)", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    await cmd.run(["cleanup", "--dry-run"], ctx)
    const out = ctx.outBuf.join("")
    // The sweep marker MUST NOT appear in dry-run output.
    expect(out).not.toContain("Sweep complete.")
  })

  test("[34] cleanup --dry-run leaves in-memory registry size unchanged", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const reg = getGlobalSessionResourceRegistry()
    reg.getOrCreate("session-stable-a")
    reg.getOrCreate("session-stable-b")
    expect(reg.size()).toBe(2)
    const ctx = makeCtx()
    const exit = await cmd.run(["cleanup", "--dry-run"], ctx)
    expect(exit).toBe(0)
    // Registry MUST be untouched — dry-run is read-only.
    expect(reg.size()).toBe(2)
  })

  test("[35] cleanup (no flag) preserves ADR-0379 behavior — sweep marker present", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run(["cleanup"], ctx)
    expect(exit).toBe(0)
    const out = ctx.outBuf.join("")
    // ADR-0379 contract — the sweep ran + the marker is rendered.
    expect(out).toContain("Sweep complete.")
    expect(out).not.toContain("Dry-run:")
  })

  test("[36] cleanup --dry-run --bogus extra flag is gracefully ignored", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run(["cleanup", "--dry-run", "--unknown-flag"], ctx)
    // Extra flags after --dry-run do NOT toggle the mode back on — the
    // contract treats them as informational noise. exit MUST stay 0.
    expect(exit).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out).toContain("Dry-run:")
    expect(out).not.toContain("Sweep complete.")
  })
})

// ─── ADR-0384 — evict hygiene message ──────────────────────────────────

describe("ADR-0384 /session-registry evict hygiene message", () => {
  test("[22] evict success message includes 'irreversible' warning", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    getGlobalSessionResourceRegistry().getOrCreate("session-h1")
    const ctx = makeCtx()
    const exit = await cmd.run(["evict", "session-h1"], ctx)
    expect(exit).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out.toLowerCase()).toContain("irreversible")
  })

  test("[23] evict success message includes 'Sessions:' post-evict count", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const reg = getGlobalSessionResourceRegistry()
    reg.getOrCreate("session-h2a")
    reg.getOrCreate("session-h2b")
    const ctx = makeCtx()
    await cmd.run(["evict", "session-h2a"], ctx)
    const out = ctx.outBuf.join("")
    // Must surface session count change so operator sees the impact.
    expect(out).toContain("Sessions:")
  })

  test("[24] evict on unknown id ⇒ 'irreversible' still appears (idempotent + hygiene)", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run(["evict", "never-existed-h3"], ctx)
    expect(exit).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out).toContain("evicted")
    expect(out.toLowerCase()).toContain("irreversible")
  })
})

// ─── ADR-0386 — bulk evict --pattern ───────────────────────────────────

describe("ADR-0386 /session-registry evict --pattern <glob>", () => {
  test("[25] pattern 'test-*' evicts all matching ids", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const reg = getGlobalSessionResourceRegistry()
    reg.getOrCreate("test-1")
    reg.getOrCreate("test-2")
    reg.getOrCreate("prod-1")
    const ctx = makeCtx()
    const exit = await cmd.run(["evict", "--pattern", "test-*"], ctx)
    expect(exit).toBe(0)
    expect(reg.peek("test-1")).toBeNull()
    expect(reg.peek("test-2")).toBeNull()
    expect(reg.peek("prod-1")).not.toBeNull()
    const out = ctx.outBuf.join("")
    expect(out).toMatch(/2/)
  })

  test("[26] pattern matching zero sessions ⇒ 'No sessions matched' + exit 0", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const ctx = makeCtx()
    const exit = await cmd.run(["evict", "--pattern", "absent-*"], ctx)
    expect(exit).toBe(0)
    const out = ctx.outBuf.join("") + ctx.errBuf.join("")
    expect(out.toLowerCase()).toContain("no sessions matched")
  })

  test("[27] pattern matching > 100 sessions ⇒ error + exit 1 (safety cap)", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const reg = getGlobalSessionResourceRegistry()
    for (let i = 0; i < 101; i++) reg.getOrCreate(`bulk-${i}`)
    const ctx = makeCtx()
    const exit = await cmd.run(["evict", "--pattern", "bulk-*"], ctx)
    expect(exit).toBe(1)
    const err = ctx.errBuf.join("")
    expect(err.toLowerCase()).toContain("too many matches")
    // Safety cap: nothing should be evicted on overflow.
    expect(reg.size()).toBe(101)
  })

  test("[28] '*' wildcard matches everything", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const reg = getGlobalSessionResourceRegistry()
    reg.getOrCreate("alpha")
    reg.getOrCreate("beta")
    reg.getOrCreate("gamma")
    const ctx = makeCtx()
    const exit = await cmd.run(["evict", "--pattern", "*"], ctx)
    expect(exit).toBe(0)
    expect(reg.size()).toBe(0)
  })

  test("[29] '?' wildcard matches single char", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const reg = getGlobalSessionResourceRegistry()
    reg.getOrCreate("aa")
    reg.getOrCreate("ab")
    reg.getOrCreate("abc") // length 3 — should NOT match "a?"
    const ctx = makeCtx()
    const exit = await cmd.run(["evict", "--pattern", "a?"], ctx)
    expect(exit).toBe(0)
    expect(reg.peek("aa")).toBeNull()
    expect(reg.peek("ab")).toBeNull()
    expect(reg.peek("abc")).not.toBeNull()
  })

  test("[30] regex special chars in pattern are escaped (literal '.')", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const reg = getGlobalSessionResourceRegistry()
    reg.getOrCreate("a.b")
    reg.getOrCreate("axb") // would match if '.' were treated as regex any-char
    const ctx = makeCtx()
    const exit = await cmd.run(["evict", "--pattern", "a.b"], ctx)
    expect(exit).toBe(0)
    expect(reg.peek("a.b")).toBeNull()
    // The literal-dot semantics protects ids that happen to share the
    // regex-any-char shape from accidental eviction.
    expect(reg.peek("axb")).not.toBeNull()
  })

  test("[31] glob injection safety — regex special chars cannot escape the glob alphabet", async () => {
    const cmd = findCmd()
    expect(cmd).toBeDefined()
    if (cmd === undefined) return
    const reg = getGlobalSessionResourceRegistry()
    reg.getOrCreate("safe-1")
    reg.getOrCreate(".*") // literal ".*" id should not be evicted by anything but its own literal pattern
    // A pattern of ".+" should NOT evict anything (no regex evaluation):
    const ctx = makeCtx()
    await cmd.run(["evict", "--pattern", ".+"], ctx)
    // ".+" pattern → literal "\.\+" regex → only matches the literal string ".+"
    // Neither "safe-1" nor ".*" contains the literal characters ".+", so both survive.
    expect(reg.peek("safe-1")).not.toBeNull()
    expect(reg.peek(".*")).not.toBeNull()
  })
})
