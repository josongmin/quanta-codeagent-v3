/**
 * The top-level CLI flag REGISTRY — one table the parser and `--help` both read.
 *
 * # Why a table
 *
 * `topLevelUsage()` was a hand-written string. It advertised `--lsp-tools`,
 * `--git-tools` and `--metrics`, and no top-level parser consumed any of the
 * three: `--lsp-tools` and `--git-tools` appear NOWHERE in `src/` outside that
 * usage line (they were never implemented — `git log -S` finds them only in an
 * old prompt-denylist), and `--metrics` is a bench-only flag read by
 * `apps/bench/otel-trace-sink.ts`. Meanwhile six flags the parser DOES accept
 * were unadvertised: `--version`/`-v`, `--image`, `--tool-profile`,
 * `--playbook-trigger`, `--skills`, `--shell-snapshot`.
 *
 * Both directions of that drift are invisible to a prose block, which is why this
 * is a table and `topLevelUsage()` renders FROM it. `tests/unit/cli/
 * top-level-flag-parity-hellgate.test.ts` closes the loop in the other direction
 * too: a flag the parser reads and the table omits is also RED.
 *
 * # `valued` absorbs VALUED_FLAGS
 *
 * `internal/argv.ts` carried its own `VALUED_FLAGS` list for the separate job of
 * keeping a flag's VALUE out of the prompt. Keeping both would make three lists
 * (parser reads, this table, that list) where there were two. `VALUED_FLAGS` now
 * derives from `valued: true` here.
 *
 * Slice note: pure data + one renderer. No argv read, no env read, no imports —
 * `argv.ts` imports THIS, never the reverse.
 */

export interface TopLevelFlag {
  /** The flag as typed, including dashes. */
  readonly flag: `--${string}` | `-${string}`
  /** Additional accepted spellings (e.g. `-v` for `--version`). */
  readonly aliases?: readonly string[]
  /** True ⇒ consumes the FOLLOWING argv token as its value (`--flag <value>`).
   *  Drives both the help rendering and `argvPrompt`'s value-skipping. */
  readonly valued?: boolean
  /** Metavariable shown in help for a valued flag (`<path>`, `<id|path>`, …). */
  readonly value?: string
  /** One line for `--help`. */
  readonly describe: string
  /** Where the parser actually reads it. Traceability, and the parity guard
   *  resolves this file to prove the read exists. */
  readonly readSite: string
}

/**
 * Every flag the top-level `quanta` invocation accepts. Subcommand-local flags
 * (`quanta session …`, `quanta serve --stdio`, `quanta batch …`) are NOT here —
 * they are advertised by their own `--help`, and pulling them in would claim the
 * top-level parser accepts them.
 */
export const TOP_LEVEL_FLAGS: readonly TopLevelFlag[] = [
  {
    flag: "--help",
    aliases: ["-h"],
    describe: "Show this help",
    readSite: "apps/cli/index.ts",
  },
  {
    flag: "--version",
    aliases: ["-v"],
    describe: "Print the resolved CLI version (and short commit when baked in)",
    readSite: "apps/cli/index.ts",
  },
  {
    flag: "--new-session",
    describe: "Start a new id-mode session",
    readSite: "apps/cli/internal/argv.ts",
  },
  {
    flag: "--resume",
    valued: true,
    value: "<id|path>",
    describe: "Resume by id (id-mode) or path (path-mode)",
    readSite: "apps/cli/internal/argv.ts",
  },
  {
    flag: "--state",
    valued: true,
    value: "<path>",
    describe: "Save a path-mode transcript",
    readSite: "apps/cli/internal/argv.ts",
  },
  {
    flag: "--title",
    valued: true,
    value: "<t>",
    describe: "Title for a new id-mode session",
    readSite: "apps/cli/internal/argv.ts",
  },
  {
    flag: "--observe-dir",
    valued: true,
    value: "<dir>",
    describe: "Write per-turn observation artefacts here",
    readSite: "apps/cli/internal/argv.ts",
  },
  {
    flag: "--image",
    valued: true,
    value: "<path>",
    describe: "Attach an image to the first turn (repeatable)",
    readSite: "apps/cli/internal/argv.ts",
  },
  {
    flag: "--tool-profile",
    valued: true,
    value: "<token>",
    describe: "Select a tool profile for this invocation",
    readSite: "apps/cli/internal/argv.ts",
  },
  {
    flag: "--plan",
    describe: "Start in plan mode (same as QUANTA_PLAN=1)",
    readSite: "apps/cli/internal/argv.ts",
  },
  {
    flag: "--lsp",
    describe: "Swap the `diagnostics` tool onto a real language server (QUANTA_LSP=1)",
    readSite: "apps/cli/internal/argv.ts",
  },
  {
    flag: "--skills",
    describe: "Force the skill surface on (same as QUANTA_SKILLS=1)",
    readSite: "apps/cli/internal.ts",
  },
  {
    flag: "--shell-snapshot",
    describe: "Capture a shell snapshot for this session (QUANTA_SHELL_SNAPSHOT=1)",
    readSite: "apps/cli/internal/shell-snapshot.ts",
  },
  {
    flag: "--playbook-trigger",
    describe: "Echo the matched playbook trigger instead of running it",
    readSite: "apps/cli/internal/argv.ts",
  },
]

/** Flags whose VALUE is the next argv token. Derived — never a second list. */
export const VALUED_TOP_LEVEL_FLAGS: readonly string[] = TOP_LEVEL_FLAGS.filter(
  (f) => f.valued === true,
).map((f) => f.flag)

/** Every accepted spelling, flags and aliases alike. */
export const ALL_TOP_LEVEL_FLAG_TOKENS: readonly string[] = TOP_LEVEL_FLAGS.flatMap((f) => [
  f.flag,
  ...(f.aliases ?? []),
])

/** Render the `Common flags:` rows from the table. */
export const renderTopLevelFlagRows = (): readonly string[] =>
  TOP_LEVEL_FLAGS.map((f) => {
    const spellings = [f.flag, ...(f.aliases ?? [])].join(", ")
    const left = f.value === undefined ? spellings : `${spellings} ${f.value}`
    return `  ${left.padEnd(36)} ${f.describe}`
  })
