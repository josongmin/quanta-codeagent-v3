/**
 * NO RAW NUL BYTES IN SOURCE (jun-7 corruption ratchet).
 *
 * Several slices use U+0000 as an uncollidable separator / sentinel (the batch
 * template markers, the stale-read-guard key joiner, the `continue_from` lineage
 * sentinel `ROOT_LINEAGE`, …). That is a fine TECHNIQUE — but the NUL must be
 * written as the ESCAPE `\x00`, never as a RAW 0x00 byte embedded in the file.
 *
 * A raw NUL byte makes the whole file "binary" to the toolchain: ripgrep skips
 * it, `grep`/`git grep` choke, diffs corrupt, and source scanners (including the
 * gate-vocabulary ratchet) silently miss it. The jun-7 adversarial audit found
 * exactly this — a raw NUL inside `ROOT_LINEAGE` hid a security-sentinel mismatch
 * because the file read as binary.
 *
 * This guard fails if ANY src/*.ts file contains a raw 0x00 byte. The fix is
 * always mechanical: replace the raw byte with the `\x00` escape (byte-identical
 * runtime value, text-clean source).
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) yield* walk(p)
    else if (entry.endsWith(".ts") || entry.endsWith(".md")) yield p
  }
}

describe("source integrity — no raw NUL (0x00) bytes", () => {
  test("every src/tests .ts AND docs .md file is NUL-free (use \\x00, never a raw byte)", () => {
    const offenders: string[] = []
    // src+tests .ts (a raw NUL in a fixture string binary-flags the test file
    // just like source) AND docs .md (a raw NUL in an ADR — e.g. illustrating a
    // stripped control char — makes the doc binary; write it as `\x00`/`U+0000`).
    for (const root of ["src", "tests", "docs"]) {
      for (const file of walk(root)) {
        const buf = readFileSync(file)
        const idx = buf.indexOf(0)
        if (idx !== -1) offenders.push(`${file} (first NUL @ byte ${idx})`)
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `Raw NUL (0x00) bytes found in ${offenders.length} source file(s) — these read as ` +
          `BINARY and break grep/rg/diff/source-scanners. Replace each raw byte with the ` +
          `\\x00 escape (same runtime value, text-clean source):\n${offenders.join("\n")}`,
      )
    }
    expect(offenders).toEqual([])
  })
})
