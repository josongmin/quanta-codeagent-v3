/**
 * tools/arch-gen/main.ts — CLI entry point.
 *
 * Usage:
 *   bun tools/arch-gen/main.ts [--output docs/ARCHITECTURE.generated.md]
 *                              [--docs docs/decisions]
 *                              [--src src]
 *                              [--tests tests/unit]
 *                              [--today YYYY-MM-DD]
 *
 * Default output: docs/ARCHITECTURE.generated.md (preserves the human-curated
 * docs/ARCHITECTURE.md).
 *
 * Pure: only depends on `node:fs/promises` + `node:path`. No `@/*`.
 */
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { render } from "./render"
import { scanAdrs } from "./scan-adrs"
import { scanSlices } from "./scan-slices"

interface CliArgs {
  readonly output: string
  readonly docsDir: string
  readonly srcDir: string
  readonly testsDir: string
  readonly today: string
}

const DEFAULT_OUTPUT = "docs/ARCHITECTURE.generated.md"
const DEFAULT_DOCS = "docs/decisions"
const DEFAULT_SRC = "src"
const DEFAULT_TESTS = "tests/unit"

const todayIso = (): string => {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export const parseArgs = (argv: ReadonlyArray<string>): CliArgs => {
  let output = DEFAULT_OUTPUT
  let docsDir = DEFAULT_DOCS
  let srcDir = DEFAULT_SRC
  let testsDir = DEFAULT_TESTS
  let today = todayIso()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if ((a === "--output" || a === "-o") && next) {
      output = next
      i += 1
    } else if (a === "--docs" && next) {
      docsDir = next
      i += 1
    } else if (a === "--src" && next) {
      srcDir = next
      i += 1
    } else if (a === "--tests" && next) {
      testsDir = next
      i += 1
    } else if (a === "--today" && next) {
      today = next
      i += 1
    }
  }
  return { output, docsDir, srcDir, testsDir, today }
}

export const runGenerator = async (
  args: CliArgs,
  log: (msg: string) => void = () => {},
): Promise<{
  readonly outputPath: string
  readonly bytesWritten: number
  readonly adrCount: number
  readonly sliceCount: number
  readonly skipped: number
}> => {
  const { adrs, skipped } = await scanAdrs(args.docsDir)
  const slices = await scanSlices({ rootSrc: args.srcDir, testsDir: args.testsDir })
  const hellgateCount = slices.filter((s) => s.testFile).length
  const body = render(adrs, slices, {
    today: args.today,
    hellgateCount,
  })
  const outAbs = path.isAbsolute(args.output) ? args.output : path.resolve(args.output)
  await writeFile(outAbs, body, "utf8")
  if (skipped.length > 0) {
    log(`[arch-gen] skipped ${skipped.length} ADR file(s):`)
    for (const s of skipped) log(`  - ${s.filename}: ${s.reason}`)
  }
  return {
    outputPath: outAbs,
    bytesWritten: Buffer.byteLength(body, "utf8"),
    adrCount: adrs.length,
    sliceCount: slices.length,
    skipped: skipped.length,
  }
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1]
    if (!argv1) return false
    // Match this file by basename regardless of .ts/.js extension.
    return /tools\/arch-gen\/main\.(?:t|j)s$/.test(argv1)
  } catch {
    return false
  }
})()

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  // biome-ignore lint/suspicious/noConsole: CLI entrypoint
  runGenerator(args, (m) => console.log(m))
    .then((r) => {
      // biome-ignore lint/suspicious/noConsole: CLI entrypoint
      console.log(
        `[arch-gen] wrote ${r.outputPath} (${r.bytesWritten} B) — ${r.adrCount} ADR / ${r.sliceCount} slice / ${r.skipped} skip`,
      )
    })
    .catch((e: unknown) => {
      // biome-ignore lint/suspicious/noConsole: CLI entrypoint
      console.error("[arch-gen] failed:", e)
      process.exit(1)
    })
}
