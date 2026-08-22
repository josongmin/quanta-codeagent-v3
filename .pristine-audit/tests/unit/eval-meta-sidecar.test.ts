/**
 * Meta sidecar — write/read round-trip and refusal on missing/malformed.
 *
 * The sidecar is the ONLY authoritative source for the seed user prompt
 * (Phase B replaced the firstUserText heuristic with this). If `readMeta`
 * silently invents data on a missing file the entire replay-tier contract
 * breaks. This test pins the refusal.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  EVAL_META_SCHEMA,
  type EvalMeta,
  metaPathFor,
  readMeta,
  writeMeta,
} from "@/../src/apps/eval/trajectory/meta"

describe("eval meta sidecar", () => {
  test("write then read round-trips required and optional fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-meta-"))
    const jsonl = join(dir, "session.jsonl")
    writeFileSync(jsonl, "")
    const m: EvalMeta = {
      schema: EVAL_META_SCHEMA,
      userPrompt: "fix the typo in calc.ts",
      cwd: "/tmp/sandbox-xyz",
      model: "claude-sonnet-4-6",
      scenarioId: "typo-undefined-var",
      usecase: "software-quality.debugging.error-message-paste",
      producer: { name: "eval.synthetic", version: "1" },
      recordedAt: "2026-05-21T00:00:00Z",
    }
    writeMeta(jsonl, m)
    const back = readMeta(jsonl)
    expect(back).toEqual(m)
    expect(metaPathFor(jsonl)).toBe(`${jsonl}.meta.json`)
  })

  test("missing sidecar returns null — never invents data", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-meta-missing-"))
    const jsonl = join(dir, "no-sidecar.jsonl")
    expect(readMeta(jsonl)).toBeNull()
  })

  test("schema mismatch returns null", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-meta-badschema-"))
    const jsonl = join(dir, "bad-schema.jsonl")
    writeFileSync(metaPathFor(jsonl), JSON.stringify({ schema: 999, userPrompt: "x" }))
    expect(readMeta(jsonl)).toBeNull()
  })

  test("missing required fields returns null", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-meta-incomplete-"))
    const jsonl = join(dir, "incomplete.jsonl")
    writeFileSync(metaPathFor(jsonl), JSON.stringify({ schema: 1, userPrompt: "x" }))
    expect(readMeta(jsonl)).toBeNull()
  })

  test("malformed JSON returns null (does not throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-meta-garbage-"))
    const jsonl = join(dir, "garbage.jsonl")
    writeFileSync(metaPathFor(jsonl), "{not-json")
    expect(readMeta(jsonl)).toBeNull()
  })
})
