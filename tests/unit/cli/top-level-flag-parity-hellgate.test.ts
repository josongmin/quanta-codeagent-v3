/**
 * Hellgate — the top-level `--help` flag list and the top-level PARSER are one
 * table, checked in both directions.
 *
 * WHAT WENT WRONG. `topLevelUsage()` was hand-written prose. It advertised three
 * flags no top-level parser consumes:
 *
 *   --lsp-tools   never implemented; `git log -S` finds it only in an old
 *                 prompt-denylist, never in a branch
 *   --git-tools   same; the real switch is the knob `QUANTA_GIT_TOOLS`
 *   --metrics     bench-only, read by apps/bench/otel-trace-sink.ts
 *
 * and omitted six the parser DOES accept: `--version`/`-v`, `--image`,
 * `--tool-profile`, `--playbook-trigger`, `--skills`, `--shell-snapshot`. Prose
 * cannot drift-check either direction, so both rotted quietly for months.
 *
 * WHY BOTH DIRECTIONS. A forward-only guard ("everything advertised is parsed")
 * is satisfied by deleting rows, and a reverse-only guard ("everything parsed is
 * advertised") is satisfied by advertising anything. Each below therefore has the
 * other as its paired control.
 *
 * The reverse direction reads the parser SOURCE rather than calling it, because a
 * flag's effect usually needs a whole composition root; what it must prove is only
 * that the token appears in a read, which is a static fact. The forward direction
 * is stronger: it drives the real `topLevelUsage()`.
 *
 * Pure: one `readFileSync` per parser file and the rendered help string.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { argvPrompt } from "@/apps/cli/internal/argv"
import {
  ALL_TOP_LEVEL_FLAG_TOKENS,
  TOP_LEVEL_FLAGS,
  unknownTopLevelFlags,
  VALUED_TOP_LEVEL_FLAGS,
} from "../../../src/apps/cli/top-level-flags"
import { topLevelUsage } from "../../../src/apps/cli/top-level-usage"

const ROOT = join(import.meta.dir, "..", "..", "..")

/** Files that may read a top-level flag. Closed on purpose: a NEW reader has to
 *  be added here, which is the moment to ask whether the flag belongs in the
 *  table. Every entry is a `readSite` some row already names. */
const PARSER_FILES = [
  "src/apps/cli/index.ts",
  "src/apps/cli/internal/argv.ts",
  "src/apps/cli/internal.ts",
  "src/apps/cli/internal/shell-snapshot.ts",
] as const

const parserSource = (): string =>
  PARSER_FILES.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n")

/**
 * Every `--flag` the parser READS, taken from the argv-membership call it is read
 * through rather than from any quoted token on any line.
 *
 * Two narrowings, each because the loose version produced a false positive here:
 *
 *   - double dash only. A single-dash token in this source is never a top-level
 *     flag: `"-lc"` is bash argv inside a comment in shell-snapshot.ts, `"-p"` is
 *     an argument handed to the HOST arg parser in index.ts. Short aliases
 *     (`-h`, `-v`) are declared in the table beside their long form and are
 *     checked through the long one.
 *   - it must sit inside an argv-membership call — `includes`, `indexOf`,
 *     `hasArg`. A flag is always compared as a literal against argv, so this is
 *     the shape of a read, and prose mentioning a flag no longer counts as one.
 */
const READ_FORMS: readonly RegExp[] = [
  // argv membership: `includes("--x")` / `indexOf("--x")` / `hasArg("--x")`
  /\b(?:includes|indexOf|hasArg)\(\s*"(--[a-z][a-z0-9-]*)"/g,
  // token equality, which is how the valued-flag loops read: `token === "--x"`,
  // `argv[i] === "--x"`. Found while writing this guard — the membership-only
  // version reported `--image` and `--tool-profile` as advertised-but-unread, and
  // the scanner was what was wrong, not the table.
  /===\s*"(--[a-z][a-z0-9-]*)"/g,
  // prefix form for `--flag=value`: `startsWith("--x=")`
  /\bstartsWith\(\s*"(--[a-z][a-z0-9-]*)="/g,
]

const tokensReadByParser = (): Set<string> => {
  const out = new Set<string>()
  const src = parserSource()
  for (const form of READ_FORMS) {
    for (const m of src.matchAll(form)) out.add(m[1] as string)
  }
  return out
}

describe("top-level flag registry ↔ parser parity", () => {
  test("the table and the parser scan are both non-empty (anti-vacuity)", () => {
    expect(TOP_LEVEL_FLAGS.length).toBeGreaterThan(10)
    expect(tokensReadByParser().size).toBeGreaterThan(10)
  })

  // FORWARD — nothing advertised is unparsed. This is the direction the three
  // phantom flags violated.
  test("every advertised flag is read by a parser file", () => {
    const read = tokensReadByParser()
    const phantom = TOP_LEVEL_FLAGS.map((f) => f.flag).filter((t) => !read.has(t))
    expect(
      phantom,
      "advertised in --help but no parser reads it — this is how --lsp-tools/--git-tools/--metrics survived",
    ).toEqual([])
  })

  // REVERSE — nothing parsed is unadvertised, and the paired control for the
  // forward direction (which deleting rows would otherwise satisfy).
  test("every top-level flag a parser reads is advertised", () => {
    const advertised = new Set<string>(ALL_TOP_LEVEL_FLAG_TOKENS)
    // Subcommand-local flags are advertised by their own `--help`; the top-level
    // table must not claim the top-level parser accepts them.
    const SUBCOMMAND_LOCAL = new Set(["--stdio", "--session", "--mode", "--bail", "--json"])
    const unadvertised = [...tokensReadByParser()]
      .filter((t) => !advertised.has(t) && !SUBCOMMAND_LOCAL.has(t))
      .sort()
    expect(
      unadvertised,
      "a parser reads this flag but --help never mentions it — the direction that hid --version, --image, --tool-profile",
    ).toEqual([])
  })

  /**
   * The table's third consumer: rejecting what it does not advertise.
   *
   * `ALL_TOP_LEVEL_FLAG_TOKENS` was built by this campaign and had NO production
   * consumer — only this test imported it. Meanwhile `argvPrompt`'s allowlist
   * dropped every `-`-prefixed token and its docstring concluded "no new top-level
   * flag can ever leak". The flag does not leak; its VALUE does. An unknown flag is
   * not in `VALUED_TOP_LEVEL_FLAGS`, so the loop never skips the following token
   * and that token becomes the seed prompt. Measured against the real CLI:
   * `quanta --resumee xyz` — a one-character typo of `--resume` — sent `xyz` to the
   * model and fired a billed request.
   */
  describe("unknownTopLevelFlags", () => {
    test("a typo is reported, and its value is what was at stake", () => {
      expect(unknownTopLevelFlags(["--resumee", "xyz"])).toEqual(["--resumee"])
      // The value must NOT be reported as a flag — the error names the typo only.
      expect(unknownTopLevelFlags(["--resumee", "xyz"])).not.toContain("xyz")
    })

    test("every advertised spelling is accepted, aliases included", () => {
      expect(unknownTopLevelFlags([...ALL_TOP_LEVEL_FLAG_TOKENS])).toEqual([])
      for (const t of ALL_TOP_LEVEL_FLAG_TOKENS) {
        expect(unknownTopLevelFlags([t]), `${t} is advertised but rejected`).toEqual([])
      }
    })

    test("the `--flag=value` form is matched on the flag half", () => {
      const valued = TOP_LEVEL_FLAGS.filter((f) => f.valued === true)
      expect(valued.length).toBeGreaterThan(3)
      for (const f of valued) expect(unknownTopLevelFlags([`${f.flag}=v`])).toEqual([])
      expect(unknownTopLevelFlags(["--tool-profil=full"])).toEqual(["--tool-profil"])
    })

    test("single-dash tokens are left alone", () => {
      // An earlier scanner in this campaign over-matched `-lc` and `-p` and had to
      // be narrowed; this one is double-dash only by construction.
      expect(unknownTopLevelFlags(["-lc", "-p", "-x"])).toEqual([])
    })

    /**
     * A valued flag CONSUMES the next token, whatever it looks like.
     *
     * This function shipped without consulting `VALUED_TOP_LEVEL_FLAGS` — declared
     * twenty lines above it, in the same file, for exactly this job — so
     * `quanta --title --wip-fix-the-parser` exited 64 on a legitimate value.
     * `argvPrompt` had always skipped it, so the two consumers of one table
     * disagreed: the mirror of the defect this function was added to fix.
     */
    test("a valued flag's value is not mistaken for a flag", () => {
      for (const f of TOP_LEVEL_FLAGS.filter((x) => x.valued === true)) {
        expect(unknownTopLevelFlags([f.flag, "--looks-like-a-flag"]), f.flag).toEqual([])
        expect(unknownTopLevelFlags([f.flag, "plain-value"]), f.flag).toEqual([])
      }
      // The `=value` form does NOT consume the next token.
      expect(unknownTopLevelFlags(["--title=hello", "--nope"])).toEqual(["--nope"])
      // A NON-valued flag does not consume the next token either.
      expect(unknownTopLevelFlags(["--plan", "--nope"])).toEqual(["--nope"])
    })

    /**
     * POSIX end of options. Without it there is NO way to write
     * `quanta -- explain the --verbose flag`: before the rejection landed the dash
     * token was silently dropped and the prompt became "explain the flag" with a
     * billed call; after it, exit 64. A rejection needs an escape hatch to be
     * reasonable, and `argvPrompt` honours the same marker.
     */
    test("everything after a bare -- is positional, not a flag", () => {
      expect(unknownTopLevelFlags(["--", "--not-a-flag"])).toEqual([])
      expect(unknownTopLevelFlags(["--", "explain", "the", "--verbose", "flag"])).toEqual([])
      // …but a flag BEFORE the marker is still checked.
      expect(unknownTopLevelFlags(["--nope", "--", "--whatever"])).toEqual(["--nope"])
    })

    test("positionals are never flags", () => {
      expect(unknownTopLevelFlags(["fix the bug", "--plan"])).toEqual([])
    })

    test("each unknown flag is reported once, in argv order", () => {
      expect(unknownTopLevelFlags(["--bbb", "--aaa", "--bbb"])).toEqual(["--bbb", "--aaa"])
    })

    /**
     * THE INVARIANT, not just the two behaviours: `argvPrompt` and
     * `unknownTopLevelFlags` are the two production consumers of one table, and they
     * must agree about which tokens are flags and which are values.
     *
     * Both defects in this area were disagreements between them. `argvPrompt` skipped
     * an unknown flag but kept its VALUE as a positional, so a typo became a billed
     * prompt. Then `unknownTopLevelFlags` landed without consulting
     * `VALUED_TOP_LEVEL_FLAGS`, so a known flag's legitimate value was rejected. Each
     * consumer was individually testable and individually passed.
     */
    const promptFor = (argv: readonly string[]): string => {
      const prior = process.argv
      try {
        process.argv = ["bun", "x", ...argv]
        return argvPrompt()
      } finally {
        process.argv = prior
      }
    }

    test("a flag and its value are accepted by the checker and kept out of the prompt", () => {
      const cases: readonly (readonly string[])[] = [
        ["--title", "--wip-fix-the-parser"],
        ["--title", "my title", "hello"],
        ["--resume", "--abc"],
        ["--title=hello", "world"],
        ["--plan", "hello"],
        ["--image", "--pic.png", "describe it"],
      ]
      for (const argv of cases) {
        expect(unknownTopLevelFlags(argv), `${JSON.stringify(argv)} must be accepted`).toEqual([])
        const words = promptFor(argv).split(" ")
        for (const token of argv.filter((t) => t.startsWith("--"))) {
          expect(words.includes(token), `${token} reached the prompt`).toBe(false)
        }
      }
    })

    test("BOTH consumers treat everything after `--` as prompt text", () => {
      const argv = ["--", "explain", "the", "--verbose", "flag"]
      expect(unknownTopLevelFlags(argv), "the checker must not reject past the marker").toEqual([])
      // The direction a one-sided assertion misses: the tokens must ARRIVE, not just
      // fail to be rejected. Dropping the marker from `argvPrompt` alone silently
      // yields "explain the flag" and only this assertion sees it.
      expect(promptFor(argv)).toBe("explain the --verbose flag")
      expect(promptFor(["--", "--not-a-flag"])).toBe("--not-a-flag")
    })

    test("the rejected case is exactly the billed prompt it prevents", () => {
      expect(unknownTopLevelFlags(["--resumee", "xyz"])).toEqual(["--resumee"])
      expect(promptFor(["--resumee", "xyz"]), "this is what used to be sent to the model").toBe(
        "xyz",
      )
    })

    /** Paired control: the check is only sound because the table is complete, which
     *  the two parity directions above establish. If it were empty, this would
     *  reject everything — so assert it is not. */
    test("ANTI-VACUITY: the accepted set is non-trivial", () => {
      expect(ALL_TOP_LEVEL_FLAG_TOKENS.length).toBeGreaterThan(10)
      expect(unknownTopLevelFlags(["--plan"])).toEqual([])
      expect(unknownTopLevelFlags(["--nope"])).toEqual(["--nope"])
    })
  })

  test("the rendered help actually contains every advertised flag", () => {
    const help = topLevelUsage()
    for (const f of TOP_LEVEL_FLAGS) expect(help).toContain(f.flag)
    // And none of the three phantoms came back through a hand edit.
    for (const ghost of ["--lsp-tools", "--git-tools", "--metrics"]) {
      expect(help, `${ghost} is not a top-level flag`).not.toContain(ghost)
    }
  })

  test("valued flags are derived from the table, not listed twice", () => {
    expect([...VALUED_TOP_LEVEL_FLAGS].sort()).toEqual(
      TOP_LEVEL_FLAGS.filter((f) => f.valued === true)
        .map((f) => f.flag)
        .sort(),
    )
    // Spot-check the reason the list exists: `--state foo` must drop both tokens.
    expect(VALUED_TOP_LEVEL_FLAGS).toContain("--state")
  })

  test("every row names a readSite that exists and is a scanned parser file", () => {
    const scanned = new Set<string>(PARSER_FILES)
    for (const f of TOP_LEVEL_FLAGS) {
      const rel = `src/${f.readSite.replace(/^apps\//, "apps/")}`
      expect(
        scanned.has(rel),
        `${f.flag}: readSite ${f.readSite} is not a scanned parser file`,
      ).toBe(true)
    }
  })
})
