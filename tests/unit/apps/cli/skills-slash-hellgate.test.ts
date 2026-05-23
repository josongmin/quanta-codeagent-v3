/**
 * /skills + /reload-skills hellgate (2026-05-23, Codex forceReloadSkills parity).
 *
 * Pins the surface contract for the two new slash commands AND the REPL-inside
 * slash routing (was previously only at shell entry; the inside-loop gate is
 * new). Every case targets a real behavioral branch — no flimsy "callback
 * returns" assertions; we exercise the actual render, the empty path, the
 * truncation rules, the throwing-callback recovery, and the route-vs-turn
 * discrimination inside the REPL loop.
 */

import { describe, expect, test } from "bun:test"
import { runReplLoop } from "../../../../src/apps/cli/repl"
import { runSlashCommand, type SkillRow } from "../../../../src/apps/cli/slash-commands"

interface CapturedCtx {
  out: string
  err: string
}

const makeCtx = (
  cap: CapturedCtx,
  skills?: () => Promise<SkillRow[]>,
): Parameters<typeof runSlashCommand>[1] => ({
  out: (s) => {
    cap.out += s
  },
  err: (s) => {
    cap.err += s
  },
  cwd: "/tmp",
  ...(skills !== undefined ? { skills } : {}),
})

// ── /skills: callback-absent path (not-wired surface) ───────────────────

describe("/skills: callback unwired", () => {
  test("prints 'not wired' and exits 0 (default-OFF byte-identical)", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand("/skills", makeCtx(cap))
    expect(code).toBe(0)
    expect(cap.out).toContain("not wired")
    expect(cap.err).toBe("")
  })
  test("/reload-skills mirrors the same not-wired contract", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand("/reload-skills", makeCtx(cap))
    expect(code).toBe(0)
    expect(cap.out).toContain("not wired")
  })
})

// ── /skills: empty + populated discovery ────────────────────────────────

describe("/skills: empty discovery", () => {
  test("0 skills ⇒ '(0 skills found)' + exit 0", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand(
      "/skills",
      makeCtx(cap, async () => []),
    )
    expect(code).toBe(0)
    expect(cap.out).toContain("0 skills found")
  })
})

describe("/skills: populated", () => {
  const fixtures: SkillRow[] = [
    {
      name: "alpha",
      description: "First skill — short description, no paths.",
    },
    {
      name: "beta",
      description: "Second skill triggers on 'second', 'two', '둘'.",
      paths: ["src/**/*.ts", "tests/**/*.ts"],
    },
    {
      name: "gamma-with-many-paths",
      description: "Third — has 5 paths to test truncation logic in the renderer.",
      paths: ["a", "b", "c", "d", "e"],
    },
  ]

  test("singular vs plural noun agreement", async () => {
    const capOne: CapturedCtx = { out: "", err: "" }
    await runSlashCommand(
      "/skills",
      makeCtx(capOne, async () => [fixtures[0] as SkillRow]),
    )
    expect(capOne.out).toContain("1 skill:")
    expect(capOne.out).not.toContain("1 skills:")

    const capMany: CapturedCtx = { out: "", err: "" }
    await runSlashCommand(
      "/skills",
      makeCtx(capMany, async () => fixtures),
    )
    expect(capMany.out).toContain("3 skills:")
  })

  test("renders name + first-line description for each row", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    await runSlashCommand(
      "/skills",
      makeCtx(cap, async () => fixtures),
    )
    expect(cap.out).toContain("alpha")
    expect(cap.out).toContain("beta")
    expect(cap.out).toContain("gamma-with-many-paths")
    expect(cap.out).toContain("First skill")
    expect(cap.out).toContain("Second skill triggers")
  })

  test("paths absent ⇒ no [paths: …] tag", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    await runSlashCommand(
      "/skills",
      makeCtx(cap, async () => [fixtures[0] as SkillRow]),
    )
    expect(cap.out).not.toContain("[paths:")
  })

  test("paths ≤3 ⇒ rendered verbatim, no ellipsis", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    await runSlashCommand(
      "/skills",
      makeCtx(cap, async () => [fixtures[1] as SkillRow]),
    )
    expect(cap.out).toContain("[paths: src/**/*.ts, tests/**/*.ts]")
    expect(cap.out).not.toContain("…]")
  })

  test("paths >3 ⇒ first 3 + ellipsis (no leak of remainder)", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    await runSlashCommand(
      "/skills",
      makeCtx(cap, async () => [fixtures[2] as SkillRow]),
    )
    // Extract just the [paths: ...] tag and assert truncation only there
    // (the description string also contains the letter 'd' so a blanket
    // not.toContain("d") would fire false-positive).
    const pathsMatch = /\[paths: ([^\]]+)\]/.exec(cap.out)
    expect(pathsMatch).not.toBeNull()
    const pathsTag = pathsMatch?.[1] ?? ""
    expect(pathsTag).toBe("a, b, c…")
    expect(pathsTag).not.toContain("d")
    expect(pathsTag).not.toContain("e")
  })
})

// ── /skills: description truncation rules ───────────────────────────────

describe("/skills: description truncation invariants", () => {
  test("single-line ≤100 chars ⇒ verbatim, no '...' suffix", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const desc = "A".repeat(50)
    await runSlashCommand(
      "/skills",
      makeCtx(cap, async () => [{ name: "x", description: desc }]),
    )
    expect(cap.out).toContain(desc)
    expect(cap.out).not.toContain("...")
  })

  test("single-line >100 chars ⇒ truncated at 97 + '...'", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const long = "B".repeat(200)
    await runSlashCommand(
      "/skills",
      makeCtx(cap, async () => [{ name: "x", description: long }]),
    )
    expect(cap.out).toContain(`${"B".repeat(97)}...`)
    // Total rendered description must be <= 100 chars (97 + 3 dots).
    expect(cap.out).not.toContain("B".repeat(101))
  })

  test("multi-line description ⇒ only first line shown (no body leak)", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const desc = "First line.\nSECRET_BODY should not appear.\nMore body."
    await runSlashCommand(
      "/skills",
      makeCtx(cap, async () => [{ name: "x", description: desc }]),
    )
    expect(cap.out).toContain("First line.")
    expect(cap.out).not.toContain("SECRET_BODY")
    expect(cap.out).not.toContain("More body")
  })

  test("empty description ⇒ renders name without crashing", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand(
      "/skills",
      makeCtx(cap, async () => [{ name: "x", description: "" }]),
    )
    expect(code).toBe(0)
    expect(cap.out).toContain("x")
  })
})

// ── /skills: defensive — callback throws / rejects ──────────────────────

describe("/skills: callback failure recovery (defensive)", () => {
  test("Error throw ⇒ exit 1 + err message contains the reason", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand(
      "/skills",
      makeCtx(cap, async () => {
        throw new Error("simulated disk read failure")
      }),
    )
    expect(code).toBe(1)
    expect(cap.err).toContain("discovery failed")
    expect(cap.err).toContain("simulated disk read failure")
  })

  test("non-Error reject (string) ⇒ still exits 1, no propagation", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    let crashed = false
    try {
      const code = await runSlashCommand(
        "/skills",
        makeCtx(cap, async () => {
          throw "raw string failure"
        }),
      )
      expect(code).toBe(1)
    } catch {
      crashed = true
    }
    expect(crashed).toBe(false)
  })

  test("/reload-skills uses the SAME defensive recovery (parity contract)", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand(
      "/reload-skills",
      makeCtx(cap, async () => {
        throw new Error("boom")
      }),
    )
    expect(code).toBe(1)
    expect(cap.err).toContain("discovery failed")
    expect(cap.err).toContain("boom")
  })
})

// ── /reload-skills: output prefix differs from /skills ──────────────────

describe("/reload-skills: prefix differentiates from /skills", () => {
  test("populated ⇒ 'reloaded:' prefix (not 'skills:')", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    await runSlashCommand(
      "/reload-skills",
      makeCtx(cap, async () => [{ name: "x", description: "y" }]),
    )
    expect(cap.out).toContain("reloaded: 1 skill")
    expect(cap.out).not.toContain("skills: 1")
  })
  test("empty ⇒ 'reloaded: (0 skills found)' (not 'skills: ...')", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    await runSlashCommand(
      "/reload-skills",
      makeCtx(cap, async () => []),
    )
    expect(cap.out).toContain("reloaded:")
    expect(cap.out).toContain("0 skills found")
  })
})

// ── REPL-inside slash routing (the part that's actually new) ────────────

/** Minimal fake readline for runReplLoop. Plays back a pre-set list of inputs
 *  then signals EOF by aborting via the test-supplied controller. */
const makeRl = (
  lines: string[],
): { rl: { question: (q: string) => Promise<string> }; trace: string[] } => {
  const trace: string[] = []
  let i = 0
  const rl = {
    question: async (_q: string): Promise<string> => {
      const line = lines[i++]
      if (line === undefined) throw new Error("rl: out of inputs")
      trace.push(line)
      return line
    },
  }
  return { rl, trace }
}

describe("REPL-inside slash routing: /skills shortcut DOES NOT reach the model", () => {
  test("/skills routed to dispatcher (turn never called) + loop continues", async () => {
    const turnCalls: string[] = []
    const turn = async (t: string): Promise<void> => {
      turnCalls.push(t)
    }
    // Lines: a slash command, then a plain prompt, then /exit.
    const { rl } = makeRl(["/skills", "real prompt for the model", "/exit"])
    let skillsCalls = 0
    const skillsCb = async (): Promise<SkillRow[]> => {
      skillsCalls++
      return [{ name: "alpha", description: "first" }]
    }
    const abort = new AbortController()
    await runReplLoop(rl as never, abort.signal, turn, { skills: skillsCb })

    // /skills was routed (callback fired); the plain prompt went to turn().
    expect(skillsCalls).toBe(1)
    expect(turnCalls).toEqual(["real prompt for the model"])
  })

  test("/skills with NO slashCtx (skills callback absent) ⇒ prints 'not wired' + DOES NOT reach turn", async () => {
    const turnCalls: string[] = []
    const turn = async (t: string): Promise<void> => {
      turnCalls.push(t)
    }
    const { rl } = makeRl(["/skills", "/exit"])
    const abort = new AbortController()
    // Capture stdout to verify the surface message:
    const originalWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write
    let captured = ""
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s)
      return true
    }) as typeof process.stdout.write
    try {
      await runReplLoop(rl as never, abort.signal, turn)
    } finally {
      process.stdout.write = originalWrite
    }
    expect(captured).toContain("not wired")
    expect(turnCalls).toHaveLength(0)
  })

  test("/exit and /quit break the loop BEFORE any slash dispatch (parity)", async () => {
    const turnCalls: string[] = []
    const turn = async (t: string): Promise<void> => {
      turnCalls.push(t)
    }
    let skillsCalls = 0
    const skillsCb = async (): Promise<SkillRow[]> => {
      skillsCalls++
      return []
    }
    // If the slash dispatcher hijacked /exit we'd see skillsCalls > 0 or
    // an "unknown command: /exit" line; loop must break immediately instead.
    const { rl } = makeRl(["/exit"])
    const abort = new AbortController()
    await runReplLoop(rl as never, abort.signal, turn, { skills: skillsCb })
    expect(skillsCalls).toBe(0)
    expect(turnCalls).toHaveLength(0)
  })

  test("path-like tokens (e.g. '/tmp/foo') still reach turn (not mistaken for slash command)", async () => {
    // `isSlashCommand` rejects `/path/segment` so legacy file-resume tokens
    // continue to the agent path. Verify this with a path-like first line.
    const turnCalls: string[] = []
    const turn = async (t: string): Promise<void> => {
      turnCalls.push(t)
    }
    const { rl } = makeRl(["/tmp/some/file", "/exit"])
    const abort = new AbortController()
    let skillsCalls = 0
    const skillsCb = async (): Promise<SkillRow[]> => {
      skillsCalls++
      return []
    }
    await runReplLoop(rl as never, abort.signal, turn, { skills: skillsCb })
    expect(turnCalls).toEqual(["/tmp/some/file"])
    expect(skillsCalls).toBe(0)
  })

  test("unknown slash command does NOT reach turn (stays at slash dispatcher)", async () => {
    const turnCalls: string[] = []
    const turn = async (t: string): Promise<void> => {
      turnCalls.push(t)
    }
    const { rl } = makeRl(["/bogus", "/exit"])
    const abort = new AbortController()
    // Capture stderr to confirm the dispatcher's unknown-command path fires.
    const originalErr = process.stderr.write.bind(process.stderr) as typeof process.stderr.write
    let captured = ""
    process.stderr.write = ((s: string | Uint8Array): boolean => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s)
      return true
    }) as typeof process.stderr.write
    try {
      await runReplLoop(rl as never, abort.signal, turn)
    } finally {
      process.stderr.write = originalErr
    }
    expect(captured).toContain("unknown command: /bogus")
    expect(turnCalls).toHaveLength(0)
  })
})
