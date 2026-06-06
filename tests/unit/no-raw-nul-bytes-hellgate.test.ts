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

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) yield* walk(p)
    else if (entry.endsWith(".ts")) yield p
  }
}

describe("source integrity — no raw NUL (0x00) bytes", () => {
  test("every src/ AND tests/ .ts file is NUL-free (use the \\x00 escape, never a raw byte)", () => {
    const offenders: string[] = []
    // Tests scan too: a raw NUL in a FIXTURE string (NUL/control-char handling
    // tests) makes the test file binary just the same — write it as `\x00`.
    for (const root of ["src", "tests"]) {
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
