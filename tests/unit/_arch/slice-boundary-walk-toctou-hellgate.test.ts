/**
 * HELLGATE — the enumerate-then-read seam, and the two ways it lies.
 *
 * A. TOCTOU. `listSliceTsFiles` walks, the guard reads. This repo churns under
 *    concurrent sessions, so a file can be enumerated and gone microseconds
 *    later. MEASURED against the exact shape of
 *    `tests/unit/surfaces/vscode/core-no-vscode-leak-ratchet.test.ts` — a
 *    module-scope IIFE that walks then reads — deleting ONE enumerated file
 *    produced `0 pass, 1 error`: an "Unhandled error between tests", so bun
 *    never registered the describe block and ALL THREE arms ceased to exist
 *    rather than one arm failing.
 *
 * B. THE SKIP THAT MUST NOT GENERALISE. The repair is to skip ENOENT — but only
 *    for a path a LIVE WALK produced. A CONSTANT or FIXTURE path that has
 *    vanished means the guard is aimed at nothing, and swallowing that would
 *    make several ratchets wholly vacuous: they would read zero bytes and report
 *    clean. Provenance therefore rides on the ARRAY IDENTITY the walk returned,
 *    not on the path string.
 *
 * C. THE FLOOR. The moment any skip exists, "read nothing, pass" is reachable.
 *    A global `read > 0` is not enough — it survives losing an entire SUBTREE,
 *    which is the realistic failure. `assertWalkFloor` checks per top-level
 *    subtree from BOTH directions: walk-vs-disk (the walk dropped a subtree that
 *    is still there) and read-vs-walk (a subtree was enumerated but nothing in
 *    it survived to be read).
 *
 * Every arm below is red-on-injection: it constructs the specific failure and
 * proves the seam reports it, and the paired control proves the same code stays
 * green when nothing is wrong.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertWalkFloor,
  isWalkDerived,
  listSliceTsFiles,
  readWalkedFiles,
} from "./slice-boundary-scanner"

const roots: string[] = []

/** A scratch tree: `<root>/{alpha,beta}/*.ts` plus one root-level file. */
const makeTree = (): string => {
  const root = mkdtempSync(join(tmpdir(), "slice-walk-toctou-"))
  roots.push(root)
  for (const sub of ["alpha", "beta"]) mkdirSync(join(root, sub), { recursive: true })
  writeFileSync(join(root, "root.ts"), "export const r = 1\n")
  writeFileSync(join(root, "alpha", "a1.ts"), "export const a1 = 1\n")
  writeFileSync(join(root, "alpha", "a2.ts"), "export const a2 = 1\n")
  writeFileSync(join(root, "beta", "b1.ts"), "export const b1 = 1\n")
  return root
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

describe("A — a file that vanishes between the walk and the read", () => {
  test("RED-ON-INJECTION: the read no longer throws; the file is reported as vanished", () => {
    const root = makeTree()
    const files = listSliceTsFiles(root, false)
    expect(files.length).toBe(4)

    // The concurrent session deletes an enumerated file before the read.
    rmSync(join(root, "alpha", "a2.ts"))

    const { files: read, coverage } = readWalkedFiles(root, files, false)
    expect(read.map((f) => f.file)).not.toContain(join(root, "alpha", "a2.ts"))
    expect(coverage.vanished).toEqual([join(root, "alpha", "a2.ts")])
    // The other three are still READ — a vanished file costs one file, not the
    // whole scan (and not, as before, the whole test file).
    expect(coverage.read.length).toBe(3)
    // …and the floor still passes: `alpha/` lost a file but not the subtree.
    expect(() => assertWalkFloor(coverage, "A/control")).not.toThrow()
  })

  test("PAIRED CONTROL: with nothing deleted, every enumerated file is read", () => {
    const root = makeTree()
    const files = listSliceTsFiles(root, false)
    const { coverage } = readWalkedFiles(root, files, false)
    expect(coverage.vanished).toEqual([])
    expect(coverage.read.length).toBe(files.length)
  })

  test("RED-ON-INJECTION: a sub-directory deleted mid-walk does not kill the walk", () => {
    // The same TOCTOU one level up: `readdirSync` listed `beta/`, then it went
    // away before the descent. Walk-derived, so skippable — but only there.
    const root = makeTree()
    rmSync(join(root, "beta"), { recursive: true })
    expect(() => listSliceTsFiles(root, false)).not.toThrow()
    expect(listSliceTsFiles(root, false).length).toBe(3)
  })

  test("the walk ROOT is a CONSTANT — its absence still throws", () => {
    const root = makeTree()
    rmSync(root, { recursive: true, force: true })
    // A guard pointed at a slice that no longer exists must go red, not report
    // clean over an empty set.
    expect(() => listSliceTsFiles(root, false)).toThrow(/ENOENT/)
  })
})

describe("B — the skip is scoped to walk-derived paths, never generalised", () => {
  test("RED-ON-INJECTION: ENOENT on a CONSTANT path still THROWS", () => {
    const root = makeTree()
    const missing = join(root, "alpha", "does-not-exist.ts")
    // A hand-built list — a fixture/constant the guard names directly. This is
    // the case that must stay loud: swallowing it makes the ratchet vacuous.
    const constants = [join(root, "root.ts"), missing]
    expect(isWalkDerived(constants)).toBe(false)
    expect(() => readWalkedFiles(root, constants, false)).toThrow(/ENOENT/)
  })

  test("RED-ON-INJECTION: a REBUILT walk result loses provenance and throws", () => {
    const root = makeTree()
    const files = listSliceTsFiles(root, false)
    const copy = [...files] // spread → a different array → not walk-derived
    rmSync(join(root, "alpha", "a2.ts"))
    expect(isWalkDerived(files)).toBe(true)
    expect(isWalkDerived(copy)).toBe(false)
    expect(() => readWalkedFiles(root, copy, false)).toThrow(/ENOENT/)
    // …while the genuine walk result skips the same vanished file.
    expect(() => readWalkedFiles(root, files, false)).not.toThrow()
  })

  test("PAIRED CONTROL: a constant list whose files all exist reads fine", () => {
    const root = makeTree()
    const constants = [join(root, "root.ts")]
    const { coverage } = readWalkedFiles(root, constants, false)
    expect(coverage.read.length).toBe(1)
  })

  test("a non-ENOENT read error is never swallowed, walk-derived or not", () => {
    const root = makeTree()
    const files = listSliceTsFiles(root, false)
    // Replace a file with a DIRECTORY: reading it is EISDIR, not ENOENT.
    rmSync(join(root, "alpha", "a2.ts"))
    mkdirSync(join(root, "alpha", "a2.ts"))
    expect(() => readWalkedFiles(root, files, false)).toThrow()
  })
})

describe("C — the floor catches a lost SUBTREE, not merely a lost file", () => {
  test("RED-ON-INJECTION: an enumerated subtree with ZERO surviving reads fails the floor", () => {
    const root = makeTree()
    const files = listSliceTsFiles(root, false)
    // The whole `beta/` subtree goes away after enumeration. Two of four files
    // still read cleanly, so ANY global "we read > 0 files" floor stays green —
    // this is precisely the case a count-only floor cannot see.
    rmSync(join(root, "beta"), { recursive: true })
    const { coverage } = readWalkedFiles(root, files, false)
    expect(coverage.read.length).toBeGreaterThan(0) // a count-only floor: GREEN
    expect(() => assertWalkFloor(coverage, "C/subtree-loss")).toThrow(/subtree "beta\/"/)
  })

  test("RED-ON-INJECTION: a subtree the WALK dropped but disk still has fails the floor", () => {
    const root = makeTree()
    const files = listSliceTsFiles(root, false)
    // Simulate the enumeration coming back short of a subtree that is still
    // fully present on disk — the failure no enumeration-derived check can see,
    // because the missing files are absent from BOTH the enumerated and the
    // read set. Only a disk re-probe catches it.
    const short = files.filter((f) => !f.includes(`${join(root, "beta")}/`))
    const { coverage } = readWalkedFiles(root, short, false)
    expect(coverage.read.length).toBe(3)
    expect(() => assertWalkFloor(coverage, "C/walk-loss")).toThrow(
      /subtree "beta\/" holds 1 scannable file\(s\) on disk but the walk enumerated NONE/,
    )
  })

  test("RED-ON-INJECTION: reading nothing at all fails the floor", () => {
    const root = makeTree()
    const files = listSliceTsFiles(root, false)
    for (const sub of ["alpha", "beta"]) rmSync(join(root, sub), { recursive: true })
    rmSync(join(root, "root.ts"))
    const { coverage } = readWalkedFiles(root, files, false)
    expect(coverage.read.length).toBe(0)
    expect(() => assertWalkFloor(coverage, "C/vacuous")).toThrow(/vanished before they could be/)
  })

  test("RED-ON-INJECTION: enumerating nothing at all fails the floor", () => {
    const root = makeTree()
    const { coverage } = readWalkedFiles(root, [], false)
    expect(() => assertWalkFloor(coverage, "C/empty")).toThrow(/enumerated NO files/)
  })

  test("PAIRED CONTROL: a healthy walk passes the floor with every subtree covered", () => {
    const root = makeTree()
    const files = listSliceTsFiles(root, false)
    const { coverage } = readWalkedFiles(root, files, false)
    expect([...coverage.readSubtrees.keys()].sort()).toEqual([".", "alpha", "beta"])
    expect(() => assertWalkFloor(coverage, "C/control")).not.toThrow()
  })

  test("PAIRED CONTROL: an EMPTY subtree on disk is not a floor violation", () => {
    // A directory with no scannable `.ts` is legitimately absent from the
    // enumeration. Without this the floor would red on every fixture/asset dir.
    const root = makeTree()
    mkdirSync(join(root, "gamma"))
    writeFileSync(join(root, "gamma", "notes.md"), "not typescript\n")
    writeFileSync(join(root, "gamma", "x.test.ts"), "// test file, not scannable\n")
    const files = listSliceTsFiles(root, false)
    const { coverage } = readWalkedFiles(root, files, false)
    expect(coverage.enumeratedSubtrees.has("gamma")).toBe(false)
    expect(() => assertWalkFloor(coverage, "C/empty-subtree")).not.toThrow()
  })
})

describe("D — the live guards actually clear the floor on the real tree", () => {
  test("src/ splits into many slice subtrees and every one is read", () => {
    const src = join(import.meta.dir, "..", "..", "..", "src")
    const files = listSliceTsFiles(src, false)
    const { coverage } = readWalkedFiles(src, files, false)
    // Anti-vacuity: this is the population the vscode ratchet scans.
    expect(coverage.read.length).toBeGreaterThan(500)
    expect(coverage.readSubtrees.size).toBeGreaterThan(10)
    expect(() => assertWalkFloor(coverage, "D/src")).not.toThrow()
  })
})
