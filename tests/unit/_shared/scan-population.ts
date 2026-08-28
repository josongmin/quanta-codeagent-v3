import { expect } from "bun:test"
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * A guard that examined NOTHING reports the same value as a clean repo: no
 * violations. Every scanning guard therefore has to say what it reached, and a
 * count alone does not say enough — losing one subtree leaves the count high
 * (measured twice on this repo, on the PEP fence and on `assertWalkFloor`).
 *
 * So the floor is two claims:
 *   1. the scan reached at least `min` files;
 *   2. every subtree that HOLDS a collectable file on disk contributed at least
 *      one — probed INDEPENDENTLY of the walk under test, because deriving the
 *      expectation from the walk makes a lost subtree vanish from both sides.
 *
 * @param files  what the guard's own walk returned (absolute paths)
 * @param root   the directory the walk was rooted at
 * @param opts.min          floor on the total; defaults to 1
 * @param opts.collectable  does this filename count? must match the caller's
 *                          own filter, or a subtree of `.md` reads as lost
 * @param opts.skipDirs     directory names the caller's walk deliberately omits
 * @param opts.topLevelOnly  the walk does NOT recurse. The subtree claim is
 *                           replaced by its non-recursive equivalent: every
 *                           collectable file sitting directly in `root` must
 *                           appear. Same shape, one level.
 */
export const assertScanPopulation = (
  files: readonly string[],
  root: string,
  opts: {
    readonly min?: number
    readonly collectable?: (name: string) => boolean
    readonly skipDirs?: readonly string[]
    readonly topLevelOnly?: boolean
  } = {},
): void => {
  const collectable =
    opts.collectable ?? ((n: string) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
  const skip = new Set(["node_modules", "__tests__", ...(opts.skipDirs ?? [])])
  const isSkipped = (name: string): boolean => skip.has(name) || name.startsWith(".")

  expect(files.length, `the scan of ${root} reached no files at all`).toBeGreaterThanOrEqual(
    opts.min ?? 1,
  )

  if (opts.topLevelOnly === true) {
    const reachedNames = new Set(files.map((f) => relative(root, f)))
    const onDiskNames = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && collectable(e.name))
      .map((e) => e.name)
    expect(
      onDiskNames.filter((name) => !reachedNames.has(name)),
      `these files sit directly in ${root} but the scan did not enumerate them`,
    ).toEqual([])
    return
  }

  const holdsCollectable = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (isSkipped(entry.name)) continue
      if (entry.isDirectory()) {
        if (holdsCollectable(join(dir, entry.name))) return true
        continue
      }
      if (collectable(entry.name)) return true
    }
    return false
  }

  // RECURSIVE, not one level. A claim about immediate children keeps `agent`
  // "reached" while every file under `agent/loop/` goes unscanned — measured on
  // the PEP fence, where dropping that nested slice left a one-level floor green
  // and the count (3337 files, floor 500) nowhere near the threshold. The same
  // defect as a count floor, one level down.
  const reached = new Set<string>()
  for (const f of files) {
    const rel = relative(root, f)
    if (rel.startsWith("..")) continue
    const parts = rel.split("/")
    for (let i = 1; i < parts.length; i++) reached.add(parts.slice(0, i).join("/"))
  }

  const missed: string[] = []
  const probe = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || isSkipped(entry.name)) continue
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`
      if (!holdsCollectable(join(dir, entry.name))) continue
      if (reached.has(childRel)) probe(join(dir, entry.name), childRel)
      else missed.push(childRel)
    }
  }
  probe(root, "")

  expect(
    missed,
    `these subtrees of ${root} hold collectable files on disk but the scan enumerated none of them`,
  ).toEqual([])
}
