import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  type BiomeDiagnostic,
  buildBiomeReceiptKey,
  defaultBiomeReceiptPath,
  diagnosticPath,
  invalidateBiomeReceipt,
  runBiomeDiagnosticsScan,
  writeSuccessfulBiomeReceipt,
} from "./biome-diagnostics-receipt"
import { collectBiomeTargets } from "./biome-targets"

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const biomeBin = join(repoRoot, "node_modules/.bin/biome")
const argv = process.argv.slice(2)
const [subcommand = "check", ...rest] = argv
const targets = collectBiomeTargets(repoRoot)

const messageText = (message: unknown): string => {
  if (typeof message === "string") return message
  if (!Array.isArray(message)) return ""
  return message
    .map((part) =>
      part && typeof part === "object" && "content" in part
        ? String((part as { content: unknown }).content)
        : "",
    )
    .join("")
}

const lineOf = (diagnostic: BiomeDiagnostic): number | null => {
  const start = diagnostic.location?.start
  if (start === null || typeof start !== "object" || !("line" in start)) return null
  const line = (start as { line: unknown }).line
  return typeof line === "number" ? line : null
}

const printJsonDiagnostics = (diagnostics: readonly BiomeDiagnostic[]): void => {
  for (const diagnostic of diagnostics) {
    const path = diagnosticPath(diagnostic) || "<unknown>"
    const line = lineOf(diagnostic)
    const severity = typeof diagnostic.severity === "string" ? diagnostic.severity : "diagnostic"
    const category = typeof diagnostic.category === "string" ? diagnostic.category : "unknown"
    console.error(
      `${path}${line === null ? "" : `:${line}`}: ${severity} ${category}: ${messageText(diagnostic.message)}`,
    )
  }
}

// The canonical CI invocation scans the exact collectBiomeTargets manifest once
// and seals its JSON diagnostics for lint:debt. Directory scanning is
// intentionally NOT used here: it would re-admit ignored mirror/fixture files
// and break the wrapper's target-selection authority. Mutating/parameterized
// invocations retain Biome's native behavior and never publish a receipt.
if (subcommand === "check" && rest.length === 0) {
  const receiptPath = defaultBiomeReceiptPath(repoRoot)
  invalidateBiomeReceipt(receiptPath)
  const keyBefore = buildBiomeReceiptKey(repoRoot, targets)
  const scan = runBiomeDiagnosticsScan({ repoRoot, biomeBin, targets })
  printJsonDiagnostics(scan.report.diagnostics ?? [])
  if (scan.stderr.trim() !== "") console.error(scan.stderr.trim())
  if (scan.exitCode === 0) {
    const receipt = writeSuccessfulBiomeReceipt({
      repoRoot,
      targets,
      report: scan.report,
      exitCode: scan.exitCode,
      receiptPath,
      expectedKey: keyBefore,
    })
    if (receipt === null) {
      console.error("biome: inputs changed during scan; refusing to publish a stale receipt")
      process.exit(1)
    }
    console.log(
      `biome: checked ${targets.length} targets; exact-input receipt ${receipt.receiptSha256.slice(0, 12)}`,
    )
  }
  process.exit(scan.exitCode)
}

const proc = Bun.spawn([biomeBin, subcommand, ...rest, ...targets], {
  cwd: repoRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
})

process.exit(await proc.exited)
