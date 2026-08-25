import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exportRedactedCassette } from "@/apps/eval/trajectory"

const digest = (body: string): string => createHash("sha256").update(body).digest("hex")

describe("trajectory redacted export", () => {
  test("keeps canonical bytes, redacts a separate owner-only output, and binds both digests", () => {
    const dir = mkdtempSync(join(tmpdir(), "redacted-export-"))
    try {
      const source = join(dir, "canonical.jsonl")
      const out = join(dir, "share", "cassette.redacted.jsonl")
      const raw = `${JSON.stringify({ request: { apiKey: "sk-live-123456789", text: "safe" } })}\n`
      writeFileSync(source, raw)

      const result = exportRedactedCassette({
        sourcePath: source,
        outputPath: out,
        now: () => new Date("2026-08-25T00:00:00.000Z"),
      })
      const exported = readFileSync(out, "utf8")

      expect(readFileSync(source, "utf8")).toBe(raw)
      expect(exported).not.toContain("sk-live-123456789")
      expect(exported).toContain("***REDACTED***")
      expect(result.receipt.source.sha256).toBe(digest(raw))
      expect(result.receipt.output.sha256).toBe(digest(exported))
      expect(result.receipt.replayable).toBe(false)
      expect(statSync(out).mode & 0o077).toBe(0)
      expect(statSync(result.receiptPath).mode & 0o077).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("refuses canonical overwrite and malformed JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "redacted-export-red-"))
    try {
      const source = join(dir, "canonical.jsonl")
      writeFileSync(source, "{bad\n")
      expect(() => exportRedactedCassette({ sourcePath: source, outputPath: source })).toThrow(
        /must differ/,
      )
      expect(() =>
        exportRedactedCassette({ sourcePath: source, outputPath: join(dir, "out.jsonl") }),
      ).toThrow(/invalid cassette JSONL at line 1/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("atomic output replacement never follows a pre-existing symlink to the canonical source", () => {
    const dir = mkdtempSync(join(tmpdir(), "redacted-export-link-"))
    try {
      const source = join(dir, "canonical.jsonl")
      const out = join(dir, "share.jsonl")
      const raw = `${JSON.stringify({ apiKey: "sk-live-123456789" })}\n`
      writeFileSync(source, raw)
      symlinkSync(source, out)

      exportRedactedCassette({ sourcePath: source, outputPath: out })

      expect(readFileSync(source, "utf8")).toBe(raw)
      expect(lstatSync(out).isSymbolicLink()).toBe(false)
      expect(readFileSync(out, "utf8")).not.toContain("sk-live-123456789")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
