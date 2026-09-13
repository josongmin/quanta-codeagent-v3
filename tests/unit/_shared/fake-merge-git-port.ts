/**
 * A synthetic `GitReadPort` for `tools/dev/merge-symbol-loss` — commits, parents,
 * messages and file contents we choose, so a test can drive a merge that drops a
 * symbol without inventing a repository.
 *
 * It used to be defined twice, in `merge-symbol-loss-ratchet.test.ts` and
 * `merge-symbol-loss-residue.test.ts`, as behaviourally identical copies. The port
 * gained a merge question when the detector learned to ask one, and one shared fake is
 * the only way both suites keep answering it the same way.
 *
 * `autoMerge` here is a FILE-level three-way merge over the nearest common ancestor: a
 * path takes the side that changed it, and a path both sides changed differently is a
 * conflict. Real git merges lines, so two non-overlapping edits merge cleanly there; the
 * synthetic cases only rely on the file-level answers, and the real-repository cases in
 * the residue suite exercise `git merge-tree` itself.
 */
import type { AutoMerge, GitReadPort } from "../../../tools/dev/merge-symbol-loss"

export interface FakeCommit {
  readonly parents: readonly string[]
  readonly message: string
  readonly files: Readonly<Record<string, string>>
}

/** File-level three-way merge of one path: the side that changed wins; both changed
 *  differently is a conflict (resolved to `a`, like a merge that has not been edited). */
const mergePath = (
  a: string | undefined,
  b: string | undefined,
  base: string | undefined,
): { readonly value: string | undefined; readonly conflict: boolean } => {
  if (a === b || b === base) return { value: a, conflict: false }
  if (a === base) return { value: b, conflict: false }
  return { value: a, conflict: true }
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
  /** The NEAREST common ancestor of every parent — what `git merge-base` answers for the
   *  small DAGs these tests build. */
  const nearestCommonAncestor = (parents: readonly string[]): string | undefined => {
    const maps = parents.map(ancestry)
    const [first, ...rest] = maps
    if (first === undefined) return undefined
    const common = [...first.keys()].filter((c) => rest.every((m) => m.has(c)))
    const score = (c: string): number => maps.reduce((n, m) => n + (m.get(c) ?? 0), 0)
    return common.sort((x, y) => score(x) - score(y))[0]
  }
  const autoTrees = new Map<string, Readonly<Record<string, string>>>()
  const filesOf = (sha: string): Readonly<Record<string, string>> =>
    autoTrees.get(sha) ?? at(sha).files
  return {
    parents: (sha) => at(sha).parents,
    message: (sha) => at(sha).message,
    changedFiles: (from, to) => {
      const a = filesOf(from)
      const b = filesOf(to)
      return [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter((p) => a[p] !== b[p])
        .sort()
    },
    readFiles: (sha, paths) => new Map(paths.map((p) => [p, filesOf(sha)[p] ?? null])),
    listMerges: () => Object.keys(commits).filter((sha) => at(sha).parents.length >= 2),
    autoMerge: (parents): AutoMerge | undefined => {
      if (parents.length !== 2) return undefined
      const baseSha = nearestCommonAncestor(parents)
      if (baseSha === undefined) return undefined
      const [a, b] = parents.map((p) => at(p).files)
      const base = at(baseSha).files
      const merged: Record<string, string> = {}
      const conflicted = new Set<string>()
      for (const path of new Set([
        ...Object.keys(a ?? {}),
        ...Object.keys(b ?? {}),
        ...Object.keys(base),
      ])) {
        const verdict = mergePath(a?.[path], b?.[path], base[path])
        if (verdict.conflict) conflicted.add(path)
        if (verdict.value !== undefined) merged[path] = verdict.value
      }
      const tree = `auto:${parents.join("+")}`
      autoTrees.set(tree, merged)
      return { tree, conflicted }
    },
  }
}
