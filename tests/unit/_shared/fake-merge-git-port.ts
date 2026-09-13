/**
 * A synthetic `GitReadPort` for `tools/dev/merge-symbol-loss` — commits, parents,
 * messages and file contents we choose, so a test can drive a merge that drops a
 * symbol without inventing a repository.
 *
 * It used to be defined twice, in `merge-symbol-loss-ratchet.test.ts` and
 * `merge-symbol-loss-residue.test.ts`, as behaviourally identical copies. The port
 * gained `mergeBase` when the detector learned the 3-way rule, and one shared fake
 * is the only way both suites keep answering that question the same way.
 */
import type { GitReadPort } from "../../../tools/dev/merge-symbol-loss"

export interface FakeCommit {
  readonly parents: readonly string[]
  readonly message: string
  readonly files: Readonly<Record<string, string>>
}

export const fakeMergeGitPort = (commits: Readonly<Record<string, FakeCommit>>): GitReadPort => {
  const at = (sha: string): FakeCommit => {
    const c = commits[sha]
    if (c === undefined) throw new Error(`fake port: unknown sha ${sha}`)
    return c
  }
  /** `sha` and every ancestor, with the distance from `sha`. */
  const ancestry = (sha: string): Map<string, number> => {
    const depth = new Map<string, number>([[sha, 0]])
    const queue = [sha]
    for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
      for (const p of at(cur).parents) {
        if (depth.has(p)) continue
        depth.set(p, (depth.get(cur) ?? 0) + 1)
        queue.push(p)
      }
    }
    return depth
  }
  return {
    parents: (sha) => at(sha).parents,
    message: (sha) => at(sha).message,
    changedFiles: (from, to) => {
      const a = at(from).files
      const b = at(to).files
      return [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter((p) => a[p] !== b[p])
        .sort()
    },
    readFiles: (sha, paths) => new Map(paths.map((p) => [p, at(sha).files[p] ?? null])),
    listMerges: () => Object.keys(commits).filter((sha) => at(sha).parents.length >= 2),
    // The NEAREST common ancestor of every parent — what `git merge-base --octopus`
    // answers for the small DAGs these tests build.
    mergeBase: (parents) => {
      const maps = parents.map(ancestry)
      const [first, ...rest] = maps
      if (first === undefined) return undefined
      const common = [...first.keys()].filter((c) => rest.every((m) => m.has(c)))
      if (common.length === 0) return undefined
      const score = (c: string): number => maps.reduce((n, m) => n + (m.get(c) ?? 0), 0)
      return common.sort((x, y) => score(x) - score(y))[0]
    },
  }
}
