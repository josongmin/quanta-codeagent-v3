/**
 * Characterization pin for the indexer's filesystem walk.
 *
 * `walk` was the single most cognitively complex function in `src/` — score 65
 * against a cap of 15 — because four concerns were interleaved inline (ignore
 * matching, symlink resolution, inode cycle-detection, glob matching) across two
 * nearly identical tails, one for symlinks and one for everything else. Splitting
 * it into `classifyEntry` + `visitDirectory` collapses that duplication, and the
 * duplication is exactly what made the split risky: the two tails had subtly
 * different behaviour, and a reader could not tell which differences were
 * deliberate.
 *
 * So the differences are pinned here, captured from the pre-split implementation
 * and reproduced by the current one. Two of them are surprising enough that
 * nobody would have written them down on purpose:
 *
 *   1. THE SYMLINK WINS. A symlink and its target share an inode, and whichever
 *      the traversal reaches FIRST claims it. When `link-to-a.ts -> a.ts` is
 *      visited before `a.ts`, the corpus contains `link-to-a.ts` and NOT `a.ts`.
 *      The real file is silently deduped away. That is the current contract; a
 *      refactor that "fixed" it would change which paths the whole retrieval
 *      layer indexes.
 *   2. ONLY A SYMLINK IS A CYCLE. A repeat inode sighting is reported through
 *      `cycleSink` when it arrived via a symlink, and dropped in silence
 *      otherwise (hard links, bind mounts). Both tails deduped; only one
 *      reported.
 *
 * The fixture also covers the paths that are easy to break and hard to notice:
 * a `.gitignore` entry, a nested directory reached only through a symlink, a
 * self-referential directory link (which hangs forever without cycle detection),
 * a broken link, a non-UTF-8 file, and a mode-000 file.
 */

import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDefaultIndexer } from "@/retrieval/indexer/default-scanner"

const roots: string[] = []
afterAll(() => {
  for (const r of roots) {
    try {
      chmodSync(join(r, "unreadable.ts"), 0o600)
    } catch {
      /* the fixture may not have created it */
    }
    rmSync(r, { recursive: true, force: true })
  }
})

/** The tree every case below scans. Built fresh per call so one case's scan can
 *  never observe another's mutations. */
const buildTree = (): string => {
  const root = mkdtempSync(join(tmpdir(), "scanner-walk-"))
  roots.push(root)
  const mk = (rel: string, body: string): void => {
    const p = join(root, rel)
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, body, "utf8")
  }
  mk("a.ts", "export const a = 1\n")
  mk("b.ts", "export const b = 2\n")
  mk("nested/deep/c.ts", "export const c = 3\n")
  mk("nested/deep/notes.md", "# not matched by the glob\n")
  mk("dist/out.ts", "export const dist = 1\n")
  mk(".gitignore", "dist/\nignored-by-gitignore.ts\n")
  mk("ignored-by-gitignore.ts", "export const g = 1\n")
  // Non-UTF-8 bytes ⇒ the binary skip path, not a decode crash.
  writeFileSync(join(root, "bin.ts"), Buffer.from([0xff, 0xfe, 0x00, 0x41]))
  mkdirSync(join(root, "empty-dir"), { recursive: true })
  symlinkSync(join(root, "a.ts"), join(root, "link-to-a.ts"))
  symlinkSync(join(root, "nested"), join(root, "link-to-nested"))
  // Self-referential directory link: the walk must terminate.
  symlinkSync(root, join(root, "self-cycle"))
  symlinkSync(join(root, "missing.ts"), join(root, "broken-link.ts"))
  // A HARD link: same inode as `b.ts`, reached without a symlink. It is the only
  // input that separates "deduped" from "reported as a cycle" — see the pin below.
  linkSync(join(root, "b.ts"), join(root, "hardlink-to-b.ts"))
  mk("unreadable.ts", "export const u = 1\n")
  chmodSync(join(root, "unreadable.ts"), 0o000)
  return root
}

interface ScanOutcome {
  readonly ok: boolean
  readonly paths: readonly string[]
  readonly filesScanned: number
  readonly filesSkipped: number
  /** `IndexStats.skipped` is a Map — flattened and sorted so it can be compared.
   *  A plain `JSON.stringify` renders a Map as `{}`, which silently hid every
   *  skip REASON from an earlier version of this comparison. */
  readonly skipped: ReadonlyArray<readonly [string, string]>
}

const scan = async (root: string): Promise<ScanOutcome> => {
  const seen: string[] = []
  const indexer = createDefaultIndexer({
    scanner: { root, glob: "**/*.ts" },
    upsert: {
      upsert(chunk: { readonly path?: string }) {
        if (chunk.path !== undefined) seen.push(chunk.path)
      },
      delete() {
        /* nothing is deleted on an initial scan */
      },
    } as never,
  })
  const res = (await indexer.scanInitial()) as {
    ok: boolean
    value?: { filesScanned: number; filesSkipped: number; skipped: Map<string, string> }
  }
  indexer.stop()
  return {
    ok: res.ok,
    paths: [...new Set(seen)].sort(),
    filesScanned: res.value?.filesScanned ?? -1,
    filesSkipped: res.value?.filesSkipped ?? -1,
    skipped: [...(res.value?.skipped ?? new Map())].sort() as ReadonlyArray<
      readonly [string, string]
    >,
  }
}

describe("indexer walk — pinned traversal", () => {
  test("the scanned corpus is exactly the captured set", async () => {
    const out = await scan(buildTree())
    expect(out.ok).toBe(true)
    expect(out.paths).toEqual([
      // `.gitignore` itself is not a `.ts` file; `dist/out.ts` and
      // `ignored-by-gitignore.ts` are excluded by it; `notes.md` misses the
      // glob; `bin.ts` and `unreadable.ts` are read-skips; `broken-link.ts`
      // and `empty-dir` resolve to nothing.
      "b.ts",
      // …and NOT `a.ts` / `nested/deep/c.ts`: the symlinks to them were reached
      // first and claimed their inodes. See the header — this is the contract.
      "link-to-a.ts",
      "link-to-nested/deep/c.ts",
    ])
    expect(out.filesScanned).toBe(3)
  })

  test("skip REASONS are exactly the captured set", async () => {
    const out = await scan(buildTree())
    expect(out.skipped).toEqual([
      ["bin.ts", "binary"],
      // The self-referential directory link is entered ONCE; everything under it
      // is then a repeat inode arriving through a symlink.
      ["self-cycle/link-to-a.ts", "symlink_cycle"],
      ["self-cycle/link-to-nested", "symlink_cycle"],
      ["self-cycle/self-cycle", "symlink_cycle"],
      ["unreadable.ts", "permission_denied"],
    ])
    // `hardlink-to-b.ts` shares an inode with `b.ts` and is therefore deduped —
    // but it is NOT reported, because it did not arrive through a symlink. This
    // is the assertion that separates the two dedup paths, and the ONLY one that
    // fails if a refactor collapses them into a single `cycle` verdict.
    expect(out.skipped.map(([p]) => p)).not.toContain("hardlink-to-b.ts")
    expect(out.paths).not.toContain("hardlink-to-b.ts")
  })

  test("a self-referential directory symlink terminates instead of hanging", async () => {
    // Without inode cycle-detection this never returns. A wall-clock bound is
    // the only honest assertion for "terminates"; it is generous so a loaded
    // machine cannot make it flaky, and an infinite walk blows past it anyway.
    const started = Date.now()
    await scan(buildTree())
    expect(Date.now() - started).toBeLessThan(20_000)
  })

  test("two scans of two identical trees agree — the traversal is deterministic", async () => {
    // The walk pops from a stack seeded by `readdir` order, and the symlink
    // dedup above depends on that order. If it were not deterministic, the
    // corpus pin would be flaky rather than wrong, which is far worse.
    const first = await scan(buildTree())
    const second = await scan(buildTree())
    expect(second.paths).toEqual([...first.paths])
    expect(second.filesScanned).toBe(first.filesScanned)
    expect(second.filesSkipped).toBe(first.filesSkipped)
  })

  test("PAIRED CONTROL — a tree with no symlinks indexes its real paths", async () => {
    // Non-vacuity for the dedup pin: with nothing to alias them, `a.ts` and
    // `nested/deep/c.ts` DO appear. Their absence above is the symlink rule at
    // work, not a scanner that simply misses files.
    const root = mkdtempSync(join(tmpdir(), "scanner-plain-"))
    roots.push(root)
    mkdirSync(join(root, "nested", "deep"), { recursive: true })
    writeFileSync(join(root, "a.ts"), "export const a = 1\n", "utf8")
    writeFileSync(join(root, "nested", "deep", "c.ts"), "export const c = 3\n", "utf8")
    const out = await scan(root)
    expect(out.paths).toEqual(["a.ts", "nested/deep/c.ts"])
  })
})
