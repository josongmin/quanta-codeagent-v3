import { createHash, randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { redactValue } from "@/shared"

const OWNER_DIR_MODE = 0o700
const OWNER_FILE_MODE = 0o600

export interface RedactedExportReceipt {
  readonly schema: "quanta.redacted-cassette-export.v1"
  readonly artifactKind: "redacted-diagnostic-export"
  readonly replayable: false
  readonly source: {
    readonly path: string
    readonly sha256: string
    readonly bytes: number
  }
  readonly output: {
    readonly path: string
    readonly sha256: string
    readonly bytes: number
    readonly records: number
  }
  readonly redactor: "shared.redactValue/v1"
  readonly createdAt: string
}

export interface RedactedExportResult {
  readonly outputPath: string
  readonly receiptPath: string
  readonly receipt: RedactedExportReceipt
}

const sha256 = (body: string): string => createHash("sha256").update(body).digest("hex")

/** Atomic replace: a pre-existing symlink is replaced, never followed. */
const writeOwnerOnly = (path: string, body: string): void => {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, body, { encoding: "utf8", mode: OWNER_FILE_MODE, flag: "wx" })
    chmodSync(temporary, OWNER_FILE_MODE)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/**
 * Create a non-replayable sharing artifact without mutating the canonical
 * cassette. The receipt binds the byte-exact source to the separately redacted
 * output. Malformed JSONL fails closed: silently dropping a line would produce
 * an incomplete diagnostic export while claiming full provenance.
 */
export const exportRedactedCassette = (args: {
  readonly sourcePath: string
  readonly outputPath: string
  readonly now?: () => Date
}): RedactedExportResult => {
  const sourcePath = resolve(args.sourcePath)
  const outputPath = resolve(args.outputPath)
  if (sourcePath === outputPath) {
    throw new Error("redacted export output must differ from the canonical cassette")
  }

  const source = readFileSync(sourcePath, "utf8")
  const rows: unknown[] = []
  for (const [index, line] of source.split("\n").entries()) {
    if (line === "") continue
    try {
      rows.push(JSON.parse(line))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`invalid cassette JSONL at line ${index + 1}: ${message}`)
    }
  }

  const output = rows.map((row) => JSON.stringify(redactValue(row))).join("\n")
  const outputBody = output === "" ? "" : `${output}\n`
  const receiptPath = `${outputPath}.provenance.json`
  const receipt: RedactedExportReceipt = {
    schema: "quanta.redacted-cassette-export.v1",
    artifactKind: "redacted-diagnostic-export",
    replayable: false,
    source: {
      path: sourcePath,
      sha256: sha256(source),
      bytes: Buffer.byteLength(source),
    },
    output: {
      path: outputPath,
      sha256: sha256(outputBody),
      bytes: Buffer.byteLength(outputBody),
      records: rows.length,
    },
    redactor: "shared.redactValue/v1",
    createdAt: (args.now?.() ?? new Date()).toISOString(),
  }

  mkdirSync(dirname(outputPath), { recursive: true, mode: OWNER_DIR_MODE })
  writeOwnerOnly(outputPath, outputBody)
  writeOwnerOnly(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  return { outputPath, receiptPath, receipt }
}
