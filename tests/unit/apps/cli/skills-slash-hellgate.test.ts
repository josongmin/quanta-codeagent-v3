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
import { dispatchReplSlash } from "../../../../src/apps/cli/repl"
import { composePromptPipeline } from "../../../../src/apps/cli/repl/prompt-pipeline"
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

// ── REPL slash routing via prompt-pipeline + dispatcher seams ───────────

const stubStatusBar = () => ({
  setDefault: () => undefined,
  transient: () => undefined,
  clearTransient: () => undefined,
  teardown: () => undefined,
})

const runPromptSequence = async (
  lines: string[],
  dispatchSlash: (input: string) => Promise<boolean>,
): Promise<string | null> => {
  const pipe = composePromptPipeline({
    dispatchSlash,
    idleMonitor: {
      markActive: () => undefined,
      isIdle: () => false,
      snooze: () => undefined,
      unsnooze: () => undefined,
      isSnoozed: () => false,
      reset: () => undefined,
    },
    rejectCounter: {
      recordDeny: () => 0,
      recordAccept: () => undefined,
      count: () => 0,
      shouldAutoExit: () => false,
      reset: () => undefined,
    },
    statusBar: stubStatusBar(),
    readPromptLine: async () => lines.shift() ?? null,
  })
  const result = await pipe.next(new AbortController().signal)
  return typeof result === "string" ? result : result === null ? null : result.text
}

describe("REPL slash routing: /skills shortcut DOES NOT reach the model", () => {
  test("/skills routed to dispatcher and the next plain prompt still surfaces", async () => {
    let skillsCalls = 0
    const skillsCb = async (): Promise<SkillRow[]> => {
      skillsCalls++
      return [{ name: "alpha", description: "first" }]
    }
    const result = await runPromptSequence(
      ["/skills", "real prompt for the model", "/exit"],
      (input) => dispatchReplSlash(input, { skills: skillsCb }),
    )
    expect(skillsCalls).toBe(1)
    expect(result).toBe("real prompt for the model")
  })

  test("/skills with NO slashCtx prints 'not wired' and no model prompt is emitted", async () => {
    const originalWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write
    let captured = ""
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s)
      return true
    }) as typeof process.stdout.write
    try {
      const result = await runPromptSequence(["/skills", "/exit"], (input) =>
        dispatchReplSlash(input),
      )
      expect(result).toBeNull()
    } finally {
      process.stdout.write = originalWrite
    }
    expect(captured).toContain("not wired")
  })

  test("/exit breaks before any slash dispatch", async () => {
    let skillsCalls = 0
    const skillsCb = async (): Promise<SkillRow[]> => {
      skillsCalls++
      return []
    }
    const result = await runPromptSequence(["/exit"], (input) =>
      dispatchReplSlash(input, { skills: skillsCb }),
    )
    expect(result).toBeNull()
    expect(skillsCalls).toBe(0)
  })

  test("path-like tokens still fall through to the model path", async () => {
    let skillsCalls = 0
    const skillsCb = async (): Promise<SkillRow[]> => {
      skillsCalls++
      return []
    }
    const result = await runPromptSequence(["/tmp/some/file", "/exit"], (input) =>
      dispatchReplSlash(input, { skills: skillsCb }),
    )
    expect(result).toBe("/tmp/some/file")
    expect(skillsCalls).toBe(0)
  })

  test("unknown slash command is consumed by the dispatcher", async () => {
    const originalErr = process.stderr.write.bind(process.stderr) as typeof process.stderr.write
    let captured = ""
    process.stderr.write = ((s: string | Uint8Array): boolean => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s)
      return true
    }) as typeof process.stderr.write
    try {
      const handled = await dispatchReplSlash("/bogus")
      expect(handled).toBe(true)
    } finally {
      process.stderr.write = originalErr
    }
    expect(captured).toContain("unknown command: /bogus")
  })
})

// ── Post-review hardening (critic round 1, 2026-05-23) ──────────────────

describe("/skills + /reload-skills: zero-args contract (parity with Codex forceReloadSkills)", () => {
  test("/skills with extra arg ⇒ exit 1 + clear error message (no silent ignore)", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand(
      "/skills foo",
      makeCtx(cap, async () => [{ name: "x", description: "y" }]),
    )
    expect(code).toBe(1)
    expect(cap.err).toContain("takes no arguments")
    expect(cap.err).toContain("got 1")
    // The skills callback must NOT have fired (we reject before reading disk).
    expect(cap.out).not.toContain("skills:")
  })

  test("/reload-skills with extra args ⇒ exit 1 (consistency)", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    let cbFired = false
    const code = await runSlashCommand(
      "/reload-skills foo bar baz",
      makeCtx(cap, async () => {
        cbFired = true
        return []
      }),
    )
    expect(code).toBe(1)
    expect(cap.err).toContain("takes no arguments")
    expect(cap.err).toContain("got 3")
    expect(cbFired).toBe(false)
  })
})

describe("/skills: callback non-Error rejection coerced cleanly (no 'undefined' leak)", () => {
  test("string throw ⇒ err message contains the string verbatim (NOT 'undefined')", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand(
      "/skills",
      makeCtx(cap, async () => {
        throw "raw string failure"
      }),
    )
    expect(code).toBe(1)
    expect(cap.err).toContain("raw string failure")
    expect(cap.err).not.toContain("undefined")
  })

  test("number throw ⇒ String() coercion (number reaches the err message)", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand(
      "/skills",
      makeCtx(cap, async () => {
        throw 42
      }),
    )
    expect(code).toBe(1)
    expect(cap.err).toContain("42")
    expect(cap.err).not.toContain("undefined")
  })

  test("null throw ⇒ String(null) === 'null' (defensive)", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    const code = await runSlashCommand(
      "/skills",
      makeCtx(cap, async () => {
        throw null
      }),
    )
    expect(code).toBe(1)
    expect(cap.err).toContain("null")
  })
})

describe("/skills: grapheme-aware truncation (no emoji / surrogate splitting)", () => {
  test("emoji at the truncation boundary is NOT split mid-codepoint", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    // Build a description where the naive `slice(0, 97)` would land in the
    // middle of a high-plane emoji (length 2 UTF-16 units). The emoji `🦄` is
    // U+1F984 (surrogate pair). Position emoji so the truncation point lands
    // INSIDE it.
    const desc = `${"A".repeat(96)}🦄${"B".repeat(50)}` // length > 100, emoji at index 96-97
    await runSlashCommand(
      "/skills",
      makeCtx(cap, async () => [{ name: "x", description: desc }]),
    )
    // Extract just the rendered description (before any [paths:] suffix).
    // The render line is `  x<padding> <desc>` so we look for "A...A" and
    // verify NO lone surrogate appears.
    const match = / {2}x +([^\n]*)/.exec(cap.out)
    expect(match).not.toBeNull()
    const rendered = match?.[1] ?? ""
    // Lone-surrogate detection: scan for unpaired surrogates.
    let hasLoneSurrogate = false
    for (let i = 0; i < rendered.length; i++) {
      const code = rendered.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        // high surrogate — must be followed by a low surrogate
        const next = rendered.charCodeAt(i + 1)
        if (!(next >= 0xdc00 && next <= 0xdfff)) hasLoneSurrogate = true
        i++ // skip the low surrogate we just verified
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        // low surrogate not preceded by a high surrogate
        hasLoneSurrogate = true
      }
    }
    expect(hasLoneSurrogate).toBe(false)
    expect(rendered).toContain("...")
  })

  test("ZWJ family sequence not broken mid-cluster (👨‍👩‍👧‍👦 stays intact or is dropped wholesale)", async () => {
    const cap: CapturedCtx = { out: "", err: "" }
    // Family emoji is a ZWJ cluster (multiple codepoints, single grapheme).
    // Place it near the truncation boundary.
    const family = "👨‍👩‍👧‍👦" // 11 UTF-16 units = 1 grapheme
    const desc = `${"A".repeat(95)}${family}${"B".repeat(30)}`
    await runSlashCommand(
      "/skills",
      makeCtx(cap, async () => [{ name: "y", description: desc }]),
    )
    const match = / {2}y +([^\n]*)/.exec(cap.out)
    expect(match).not.toBeNull()
    const rendered = match?.[1] ?? ""
    // If the family cluster appears in the output, it must appear in FULL
    // (all 4 component glyphs + ZWJs). The renderer either keeps it whole or
    // drops it entirely — but never a half-cluster.
    const familyIdx = rendered.indexOf("👨")
    if (familyIdx >= 0) {
      // Whole cluster must be present (substring check on the canonical form).
      expect(rendered).toContain(family)
    }
  })
})
