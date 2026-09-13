/**
 * Merge symbol-loss detector.
 *
 * The incident: merge `9b21d2fd2` ("merge: reconcile parallel goal and
 * verification lanes") reconciled two goal lanes and took ONE side wholesale
 * for the objective domain. It deleted an entire enforcement half —
 * `src/objective/budget-limits.ts`, `resolveProductAutonomousTurnCap`,
 * `autonomousAllowance`, `clampBudgetLimit`, `PRODUCT_BUDGET_CEILING`, the
 * `hard-cap-exhausted` rejection, and two test files. The merge-base LACKED
 * those files and one parent ADDED them, so a plain 3-way merge would have KEPT
 * them. No commit message mentions the removal. Nothing in the repo noticed:
 * there are no git hooks (`.git/hooks` holds only samples, no husky/lefthook)
 * and CI has not run since billing was cut, so the only thing that actually
 * executes on this repo is `bun test`.
 *
 * THE SIGNAL (settled by measurement; the SHAPE is settled, the NUMBERS are
 * a transcript that must be re-run rather than trusted):
 *
 *   Symbol-level, SCOPED TO FILES THE MERGE TOUCHED. For merge M with parents
 *   P1..Pn, for each `.ts` (non-`.test.ts`, non-`.d.ts`) path in
 *   `git diff --name-only <parent> M`, extract exported symbol NAMES from
 *   `<parent>:<file>` and from `M:<file>`. A candidate is a name present in a
 *   parent's set and absent from the merge's. A file the merge deleted
 *   contributes ALL of its parent exports.
 *
 *   A candidate is NOT a loss when git's OWN merge of the parents drops it too: the
 *   export is absent from that path in `git merge-tree --write-tree <p1> <p2>` and
 *   the path merged without conflict. Those are reported as `trivial`. What the
 *   detector exists for is the human part of a merge — a resolution that dropped
 *   what git would have kept — see {@link isTrivialPerGitMerge}.
 *
 * That shape separates the real case from controls. RE-MEASURE, do not trust
 * this table — it is a transcript, and history moves under it:
 *
 *   $ bun run tools/dev/merge-symbol-loss.ts \
 *       9b21d2fd2 79857f28b 615b9b586 528f01ae5 fc199ad3f \
 *     | grep -E '^[0-9a-f]{9}|^scanned'
 *   9b21d2fd2  lost=70  excused=0  trivial=4  files=91  merge: reconcile parallel goal and verification lanes
 *   79857f28b  lost=0  excused=0  trivial=0  files=24  Merge branch 'codex/true100-message-ids'
 *   615b9b586  lost=0  excused=0  trivial=0  files=17  Merge branch 'codex/feeder-checkpoint-capture'
 *   528f01ae5  lost=0  excused=0  trivial=0  files=44  Merge branch 'codex/rfc-def-skill-startup-render' into codex/def-integration
 *   fc199ad3f  lost=0  excused=0  trivial=0  files=9  Merge branch 'codex/rfc12-1-plan-dag'
 *   scanned 5 merge(s), 185 (parent,file) pair(s); 1 with unexcused symbol loss
 *
 * The UNSCOPED variant (diffing all of `src` between parent and merge) was
 * measured at 29–64 "losses" on every control merge — pure noise. It is not
 * implemented here on purpose.
 *
 * ESCAPE HATCH: a merge that MEANS to drop something can say so. If the commit
 * message names the lost path (full path, or a basename that identifies exactly
 * one losing file) or the lost symbol, that loss is excused. Deliberate removal
 * stays possible; SILENT removal does not. A basename SHARED by several losing
 * files does not excuse any of them — otherwise "reconciled the two index.ts
 * barrels" waves through every dropped export in every `index.ts` at once, and
 * a confession about one file silences all of them.
 *
 * Export extraction lives in `tools/shared/ts-exports.ts` — the one AST reader
 * this repo has for "what does this file export" — so this is an AST fact, not
 * a regex guess, and it cannot drift away from the other consumers of that
 * question.
 */

import { spawnSync } from "node:child_process"
import { basename, join } from "node:path"

import { extractExportedSymbols } from "../shared/ts-exports"

export { extractExportedSymbols } from "../shared/ts-exports"

export const REPO_ROOT = join(import.meta.dir, "../..")

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/**
 * Everything this detector needs from git. Narrow on purpose: the whole
 * decision procedure is a pure function of this port, so the red-on-injection
 * test can drive a synthetic merge that drops a symbol without inventing a
 * repository.
 */
export interface GitReadPort {
  /** Parent shas of `sha`, in order. */
  readonly parents: (sha: string) => readonly string[]
  /** Full commit message (subject + body) of `sha`. */
  readonly message: (sha: string) => string
  /** `git diff --name-only <from> <to>` — paths, repo-relative. */
  readonly changedFiles: (from: string, to: string) => readonly string[]
  /**
   * Contents of each path at `sha`. A path absent at that revision maps to
   * `null` (that is how a deletion is expressed). Batched because a single
   * merge can touch hundreds of files.
   */
  readonly readFiles: (sha: string, paths: readonly string[]) => ReadonlyMap<string, string | null>
  /**
   * The newest `maxMerges` merge commits reachable from `rev`, newest first.
   * The window is bounded by MERGE COUNT, not by commit count — `git log
   * --merges -n N` limits how many merges are printed, not how far it walks.
   */
  readonly listMerges: (rev: string, maxMerges: number) => readonly string[]
  /**
   * Git's own merge of `parents`, without the merge commit's human resolution:
   * `git merge-tree --write-tree` (the ort strategy — virtual merge bases for a
   * criss-cross history, rename detection). `undefined` for anything but two parents:
   * nothing can be excused for an octopus merge.
   */
  readonly autoMerge: (parents: readonly string[]) => AutoMerge | undefined
  /**
   * Paths `from` has that `to` holds under another name — `git diff --find-renames`,
   * old path → new path. Asked of a parent and git's merge tree: when git moved a file,
   * the parent's exports are to be looked for at the new path, not the empty old one.
   */
  readonly renames: (from: string, to: string) => ReadonlyMap<string, string>
}

/** The result of {@link GitReadPort.autoMerge}. */
export interface AutoMerge {
  /** A tree-ish {@link GitReadPort.readFiles} can read. */
  readonly tree: string
  /** Paths git could not merge cleanly. A loss in one is never excused. */
  readonly conflicted: ReadonlySet<string>
}

const git = (args: readonly string[], cwd: string): string => {
  const res = spawnSync("git", [...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr ?? ""}`)
  }
  return res.stdout ?? ""
}

const LF = 0x0a

/**
 * `git cat-file --batch` over a list of `<sha>:<path>` specs. One subprocess
 * per revision instead of one per file — a 176-file merge parent is otherwise
 * 176 spawns.
 *
 * Batch output per request is either `<spec> missing\n` or
 * `<oid> <type> <size>\n<contents>\n`, and `<size>` is BYTES, so this parses
 * the raw buffer rather than a decoded string.
 */
const catFileBatch = (
  cwd: string,
  sha: string,
  paths: readonly string[],
): Map<string, string | null> => {
  const out = new Map<string, string | null>()
  if (paths.length === 0) return out
  const input = `${paths.map((p) => `${sha}:${p}`).join("\n")}\n`
  const res = spawnSync("git", ["cat-file", "--batch"], {
    cwd,
    input,
    maxBuffer: 512 * 1024 * 1024,
  })
  if (res.status !== 0) {
    throw new Error(`git cat-file --batch failed (${res.status}): ${String(res.stderr ?? "")}`)
  }
  const buf = res.stdout as Buffer
  let cursor = 0
  for (const path of paths) {
    if (cursor >= buf.length) {
      out.set(path, null)
      continue
    }
    const eol = buf.indexOf(LF, cursor)
    if (eol < 0) {
      out.set(path, null)
      cursor = buf.length
      continue
    }
    const header = buf.toString("utf8", cursor, eol)
    cursor = eol + 1
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
      out.set(path, null)
      continue
    }
    const parts = header.split(" ")
    const size = Number(parts[parts.length - 1])
    if (!Number.isFinite(size)) {
      out.set(path, null)
      continue
    }
    out.set(path, buf.toString("utf8", cursor, cursor + size))
    cursor = cursor + size + 1 // trailing LF after the object payload
  }
  return out
}

/** `git diff -z --name-status` output → renamed old path → new path. A rename is
 *  `R<score>\0old\0new\0`, a copy `C<score>\0src\0dst\0`, anything else `<status>\0path\0`. */
export const parseRenames = (output: string): ReadonlyMap<string, string> => {
  const fields = output.split("\0")
  const out = new Map<string, string>()
  let i = 0
  while (i < fields.length) {
    const status = fields[i] ?? ""
    const twoPaths = status.startsWith("R") || status.startsWith("C")
    const [first, second] = [fields[i + 1], fields[i + 2]]
    if (status.startsWith("R") && first !== undefined && second !== undefined)
      out.set(first, second)
    i += status === "" ? 1 : twoPaths ? 3 : 2
  }
  return out
}

export const createGitReadPort = (cwd: string = REPO_ROOT): GitReadPort => ({
  parents: (sha) =>
    git(["rev-list", "--parents", "-n", "1", sha], cwd).trim().split(/\s+/).slice(1),
  message: (sha) => git(["log", "-1", "--format=%B", sha], cwd),
  // `-z` is NOT a micro-optimisation. `core.quotePath` defaults ON, so plain
  // `git diff --name-only` emits `"src/caf\303\251.ts"` — quotes, octal escapes
  // and all — for any non-ASCII path. That spec then MISSES on `cat-file
  // --batch` for BOTH the parent and the merge, so the file reads as zero
  // exports on each side and every loss in it is silently invisible. `-z` emits
  // raw NUL-separated bytes, which cat-file resolves.
  //
  // `--no-renames`: with rename detection on, a path renamed away appears only under its
  // NEW name, so the old path — where the parent's exports were — was never read, and a
  // merge that renamed a file and dropped symbols from it examined zero files (round-8
  // audit, reproduced). As a delete plus an add, the old path is compared; when git's own
  // merge also moved the file, the loss at the old path is excused (isTrivialPerGitMerge).
  changedFiles: (from, to) =>
    git(["diff", "-z", "--no-renames", "--name-only", from, to], cwd)
      .split("\0")
      .filter((l) => l.length > 0),
  readFiles: (sha, paths) => catFileBatch(cwd, sha, paths),
  autoMerge: (parents) => {
    if (parents.length !== 2) return undefined
    // `--allow-unrelated-histories`: without it git refuses a merge of histories with no
    // common base, and the refusal aborted the whole scan (round-10 audit, reproduced).
    const res = spawnSync(
      "git",
      [
        "merge-tree",
        "--write-tree",
        "--allow-unrelated-histories",
        "--name-only",
        "--no-messages",
        "-z",
        ...parents,
      ],
      { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    )
    // Exit 1 is "merged, with conflicts" (the tree still exists). Anything else is a
    // failure to ask, reported rather than read as "nothing excusable" — which would
    // merely widen what is reported, but silently.
    if (res.status !== 0 && res.status !== 1) {
      throw new Error(`git merge-tree failed (${res.status}): ${res.stderr ?? ""}`)
    }
    const [tree, ...rest] = (res.stdout ?? "").split("\0")
    if (tree === undefined || tree.trim() === "") {
      throw new Error(`git merge-tree printed no tree for ${parents.join(" ")}`)
    }
    return { tree: tree.trim(), conflicted: new Set(rest.filter((f) => f.length > 0)) }
  },
  renames: (from, to) =>
    parseRenames(git(["diff", "-z", "--find-renames", "--name-status", from, to], cwd)),
  listMerges: (rev, maxMerges) =>
    git(["log", "--merges", "--format=%H", "-n", String(maxMerges), rev], cwd)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
})

// ---------------------------------------------------------------------------
// Export extraction (TypeScript AST)
// ---------------------------------------------------------------------------

/** Files the settled signal looks at: `.ts`, excluding tests and declarations. */
export const isScannedPath = (path: string): boolean =>
  path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts")

// ---------------------------------------------------------------------------
// Escape hatch
// ---------------------------------------------------------------------------

const escapeForRegex = (raw: string): string => raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Does `message` name this identifier as a word (not as a substring)? */
export const messageNamesSymbol = (message: string, symbol: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_$])${escapeForRegex(symbol)}([^A-Za-z0-9_$]|$)`).test(message)

/**
 * Characters that can sit INSIDE a path token. A mention only counts when it is
 * bounded by something outside this set, so "reindex.ts" does not name
 * `index.ts` and "budget-limits.ts.bak" does not name `budget-limits.ts`.
 */
const PATH_TOKEN_CHARS = "A-Za-z0-9_$./\\-"

const namesToken = (message: string, token: string): boolean =>
  new RegExp(`(^|[^${PATH_TOKEN_CHARS}])${escapeForRegex(token)}([^${PATH_TOKEN_CHARS}]|$)`).test(
    message,
  )

/**
 * Does `message` name this file — by full repo-relative path, or by a basename
 * that unambiguously identifies it?
 *
 * `ambiguousBasenames` holds basenames that MORE THAN ONE losing file in the
 * same merge shares. Without that check, a message reading "reconciled the two
 * index.ts barrels" blanket-excused every dropped export in every `index.ts`
 * the merge touched — a confession about one file silencing all of them. A
 * shared basename must therefore be disambiguated by writing the full path;
 * a distinctive one (`budget-limits.ts`) still works on its own.
 */
export const messageNamesPath = (
  message: string,
  path: string,
  ambiguousBasenames: ReadonlySet<string> = new Set(),
): boolean => {
  if (namesToken(message, path)) return true
  const base = basename(path)
  return !ambiguousBasenames.has(base) && namesToken(message, base)
}

/**
 * The escape hatch. A merge that deliberately drops something says so in its
 * message; naming EITHER the file or the symbol excuses that loss.
 */
export const isExcusedByMessage = (
  message: string,
  loss: SymbolLoss,
  ambiguousBasenames: ReadonlySet<string> = new Set(),
): boolean =>
  messageNamesPath(message, loss.file, ambiguousBasenames) ||
  messageNamesSymbol(message, loss.symbol)

/** Basenames shared by more than one losing file — these need a full path. */
export const ambiguousBasenamesOf = (losses: readonly SymbolLoss[]): ReadonlySet<string> => {
  const filesByBase = new Map<string, Set<string>>()
  for (const loss of losses) {
    const base = basename(loss.file)
    const seen = filesByBase.get(base) ?? new Set<string>()
    seen.add(loss.file)
    filesByBase.set(base, seen)
  }
  return new Set([...filesByBase].filter(([, files]) => files.size > 1).map(([base]) => base))
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface SymbolLoss {
  /** Repo-relative path of the file that lost the export. */
  readonly file: string
  /** The exported symbol name present in `parent` and absent in the merge. */
  readonly symbol: string
  /** Sha of the parent that still had it. */
  readonly parent: string
}

export interface MergeScan {
  readonly sha: string
  readonly parents: readonly string[]
  /** First line of the commit message, for reporting. */
  readonly subject: string
  /** Unexcused losses — what the ratchet fails on. */
  readonly losses: readonly SymbolLoss[]
  /** Losses the commit message named. Deliberate removal, on the record. */
  readonly excused: readonly SymbolLoss[]
  /**
   * Symbols absent from the merge because git's own merge of the parents lacks them too —
   * the change was authored on a line of history, not by the merge's resolution, and this
   * detector is scoped to resolutions. Reported, never hidden: see
   * {@link isTrivialPerGitMerge}. (This said "the merge TRIVIALLY took another parent's
   * byte-identical file", the rule two rounds replaced.)
   */
  readonly trivial: readonly SymbolLoss[]
  /**
   * How many (parent, file) pairs were actually opened and parsed. The
   * anti-vacuity floor: a scan that examined 0 pairs found 0 losses for free,
   * and must never read as a pass.
   */
  readonly filesExamined: number
}

const sortLosses = (losses: SymbolLoss[]): SymbolLoss[] =>
  losses.sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol))

/**
 * Losses this parent contributes, appended to `out`. Returns how many files it
 * actually opened — the anti-vacuity count.
 */
const collectParentLosses = (
  parent: string,
  paths: readonly string[],
  port: GitReadPort,
  exportsAfter: (path: string) => Set<string>,
  out: SymbolLoss[],
): number => {
  const parentSide = port.readFiles(parent, paths)
  let examined = 0
  for (const file of paths) {
    const source = parentSide.get(file) ?? null
    if (source === null) continue // added by the merge — nothing could be lost
    examined += 1
    const after = exportsAfter(file)
    for (const symbol of extractExportedSymbols(source, file)) {
      if (!after.has(symbol)) out.push({ file, symbol, parent })
    }
  }
  return examined
}

/**
 * The whole decision procedure, as a pure function of the port.
 *
 * A non-merge commit (fewer than 2 parents) scans to an empty, zero-examined
 * result: this detector has nothing to say about linear history.
 */
/** Every scanned path the merge changed relative to each parent. */
const changedScannedPaths = (
  sha: string,
  parents: readonly string[],
  port: GitReadPort,
): Map<string, readonly string[]> =>
  new Map(parents.map((p) => [p, port.changedFiles(p, sha).filter(isScannedPath)]))

/** Memoised export sets for the MERGE side, so a path shared by both parents is parsed once. */
const mergeSideExports = (
  sha: string,
  paths: readonly string[],
  port: GitReadPort,
): ((path: string) => Set<string>) => {
  const contents = port.readFiles(sha, paths)
  const cache = new Map<string, Set<string>>()
  return (path) => {
    const hit = cache.get(path)
    if (hit !== undefined) return hit
    const source = contents.get(path) ?? null
    const computed = source === null ? new Set<string>() : extractExportedSymbols(source, path)
    cache.set(path, computed)
    return computed
  }
}

/**
 * Would git's own merge of the parents have dropped this export too?
 *
 * WHY. The incident this detector is for is a merge RESOLUTION that dropped what a plain
 * merge keeps ("the merge-base LACKED those files and one parent ADDED them"). Comparing
 * each parent to the merge cannot tell that apart from an ordinary change git merged in:
 * a symbol one line of history renamed reads as lost relative to the other parent.
 *
 * TWO EARLIER RULES, BOTH MEASURED WRONG:
 *  - "the losing parent's file equals the merge-base and the merge took the other
 *    parent's file" (4d28097c6) picked ONE base; in a criss-cross history git merges
 *    against a virtual base, and a real loss was filed as trivial (round-8 audit);
 *  - the same rule with a UNIQUE base required (779e229f5) excused nothing for the two
 *    criss-cross merges in this repository (`aae56857e`, `f1e936d9c`), whose drops git's
 *    own merge also makes, and a rename on one side with an edit on the other was
 *    reported as nine losses because the losing parent had changed the file (round-9).
 * Asking git answers both: `git merge-tree --write-tree` IS the plain merge, with virtual
 * bases and rename detection.
 *
 * WHERE TO LOOK (round-10 audit, reproduced). My first version looked at the loss's own
 * path. When git's merge MOVED the file — a rename on the other side, or a new file inside
 * a renamed directory — that path is empty in git's tree, so every loss in the file was
 * excused, including an export git's merge kept at the new path and the resolution then
 * dropped. `placedAt` is where git's merge put the parent's file.
 *
 * A CONFLICTED path is git's text with both sides between markers. The export is excused
 * only when its name appears nowhere in that text — neither side of any hunk has it, as
 * when one side deleted it in a hunk that merged cleanly. My first version excused no
 * conflicted path at all, and reported that clean deletion as a loss.
 *
 * WHAT IT DOES NOT EXCUSE: an export git's merge keeps; a name either side of a conflict
 * still spells; anything in an octopus merge.
 */
export const isTrivialPerGitMerge = (
  loss: SymbolLoss,
  placement: {
    readonly auto: AutoMerge | undefined
    readonly placedAt: string
    readonly autoExports: (path: string) => Set<string>
    readonly autoText: (path: string) => string | null
  },
): boolean => {
  const { auto, placedAt } = placement
  if (auto === undefined) return false
  if (auto.conflicted.has(loss.file) || auto.conflicted.has(placedAt)) {
    const text = placement.autoText(placedAt) ?? ""
    return !messageNamesSymbol(text, loss.symbol)
  }
  return !placement.autoExports(placedAt).has(loss.symbol)
}

/** Where git's merge put each parent's files, and what it holds there. */
const gitMergePlacement = (
  sha: string,
  parents: readonly string[],
  found: readonly SymbolLoss[],
  port: GitReadPort,
) => {
  const auto = port.autoMerge(parents)
  const renamesByParent = new Map(
    auto === undefined ? [] : parents.map((p) => [p, port.renames(p, auto.tree)] as const),
  )
  const placedAt = (l: SymbolLoss): string => renamesByParent.get(l.parent)?.get(l.file) ?? l.file
  const placedPaths = [...new Set(found.map(placedAt))]
  const autoFiles =
    auto === undefined ? new Map<string, string | null>() : port.readFiles(auto.tree, placedPaths)
  const autoExports =
    auto === undefined ? () => new Set<string>() : mergeSideExports(auto.tree, placedPaths, port)
  return {
    auto,
    placedAt,
    autoExports,
    autoText: (path: string) => autoFiles.get(path) ?? null,
    /** The merge commit's exports at the placed paths — a moved export it kept is no loss. */
    mergeExportsAtPlaced: mergeSideExports(sha, placedPaths, port),
  }
}

export const scanMerge = (sha: string, port: GitReadPort): MergeScan => {
  const parents = port.parents(sha)
  if (parents.length < 2) {
    return { sha, parents, subject: "", losses: [], excused: [], trivial: [], filesExamined: 0 }
  }
  const message = port.message(sha)
  const subject = message.split("\n")[0]?.trim() ?? ""

  const perParentPaths = changedScannedPaths(sha, parents, port)
  const allPaths = [...new Set([...perParentPaths.values()].flat())]
  const exportsAfter = mergeSideExports(sha, allPaths, port)

  const found: SymbolLoss[] = []
  let filesExamined = 0
  for (const parent of parents) {
    filesExamined += collectParentLosses(
      parent,
      perParentPaths.get(parent) ?? [],
      port,
      exportsAfter,
      found,
    )
  }

  // Only merges that report something pay for git's own merge and the extra reads.
  const placement = found.length > 0 ? gitMergePlacement(sha, parents, found, port) : undefined
  // A file git's merge moved, whose export the merge commit has at the new path, lost
  // nothing: the parent-to-merge diff saw a delete and an add.
  const candidates =
    placement === undefined
      ? found
      : found.filter((l) => {
          const at = placement.placedAt(l)
          return at === l.file || !placement.mergeExportsAtPlaced(at).has(l.symbol)
        })
  const trivial =
    placement === undefined
      ? []
      : candidates.filter((l) =>
          isTrivialPerGitMerge(l, { ...placement, placedAt: placement.placedAt(l) }),
        )
  const substantive = candidates.filter((l) => !trivial.includes(l))

  const ambiguous = ambiguousBasenamesOf(substantive)
  const excused = substantive.filter((l) => isExcusedByMessage(message, l, ambiguous))
  const losses = substantive.filter((l) => !isExcusedByMessage(message, l, ambiguous))

  return {
    sha,
    parents,
    subject,
    losses: sortLosses(losses),
    excused: sortLosses(excused),
    trivial: sortLosses(trivial),
    filesExamined,
  }
}

// ---------------------------------------------------------------------------
// Enforcement policy (SSOT for the ratchet in
// `tests/unit/_arch/merge-symbol-loss-ratchet.test.ts`)
// ---------------------------------------------------------------------------

/** CLI default: above the whole reachable merge history of this repo (91 merges at
 *  421e3abcb). */
export const DEFAULT_MAX_MERGES = 200

/**
 * How many of the newest merges the ratchet enforces. Bounded so the unit test
 * stays fast (the full 91-merge history is a 19-23s scan; measured below).
 *
 * WHY 14, CORRECTED. This used to say widening past 14 "pulls in `deeaa91da` and
 * the `aug02-integration` chain, which carry real (small) historical losses". They
 * did not. Every one of those losses — 693 across the 26 non-incident merges that
 * reported any, of 91 reachable (re-measured at 421e3abcb; "681" here was wrong) —
 * was a change git's own merge makes too, which the first detector could not tell from a
 * loss (see {@link isTrivialPerGitMerge}). Re-measured with the git-merge rule (sep-14,
 * full reachable history): the only unexcused loss is the grandfathered incident.
 *
 * 14 stays for COST, not cleanliness. A merge is enforced while it is among the
 * newest 14, which includes the moment it lands, and history below the window is
 * immutable, so re-scanning it catches nothing new. Measured scan time at load ~15:
 * 14 merges 2.4s, 40 merges 7.4s, 91 merges 19-23s. Regressions of the DETECTOR
 * itself are what a wider window would catch, and the synthetic cases plus the
 * incident reference already pin those.
 */
export const ENFORCED_MERGE_WINDOW = 14

/**
 * Grandfathered merges: already in history, already shipped, cannot be
 * un-merged. They are NOT hidden — the ratchet re-measures every one of them and
 * fails if a baseline entry stops reporting loss, so gutting the detector cannot
 * masquerade as progress.
 *
 * A new entry here is a decision to accept a silent deletion. It needs a reason,
 * in writing, in this file.
 */
export const GRANDFATHERED_MERGES: ReadonlyMap<string, string> = new Map([
  [
    "9b21d2fd295097009487d9b37b477fd1f5be2388",
    "THE incident this detector exists for. Took one goal lane wholesale and dropped " +
      "src/objective/budget-limits.ts, resolveProductAutonomousTurnCap, autonomousAllowance, " +
      "clampBudgetLimit, PRODUCT_BUDGET_CEILING and the hard-cap-exhausted rejection with no " +
      "mention in the commit message. Already in history; some symbols have since been restored " +
      "by later work, while clampBudgetLimit, PRODUCT_BUDGET_CEILING and " +
      "src/objective/budget-limits.ts are still absent. Grandfathered so the guard is green " +
      "TODAY while still naming the loss out loud.",
  ],
])

/**
 * Shortest prefix accepted as a sha. Not a tuning knob: git itself refuses to
 * abbreviate an object name below 4 hex digits (`core.abbrev` floor), so
 * anything shorter is not an abbreviation, it is noise.
 */
const MIN_SHA_PREFIX = 4

/**
 * Is this merge on the recorded baseline? Accepts abbreviated shas.
 *
 * The empty string used to return TRUE here, because `known.startsWith("")` is
 * always true — a baseline check that fails OPEN on the emptiest possible
 * input. A non-sha now answers `false`, which is the safe direction: an
 * unrecognised merge is enforced, not waived.
 */
export const isGrandfathered = (sha: string): boolean => {
  if (sha.length < MIN_SHA_PREFIX || !/^[0-9a-f]+$/.test(sha)) return false
  for (const known of GRANDFATHERED_MERGES.keys()) {
    if (known === sha || known.startsWith(sha) || sha.startsWith(known)) return true
  }
  return false
}

export interface WindowScan {
  readonly merges: readonly MergeScan[]
  /** Total (parent, file) pairs opened across the window — anti-vacuity floor. */
  readonly filesExamined: number
}

/** Scan the newest `maxMerges` merges reachable from `rev`. */
export const scanMergeWindow = (
  port: GitReadPort,
  rev = "HEAD",
  maxMerges = DEFAULT_MAX_MERGES,
): WindowScan => {
  const merges = port.listMerges(rev, maxMerges).map((sha) => scanMerge(sha, port))
  return { merges, filesExamined: merges.reduce((n, m) => n + m.filesExamined, 0) }
}

/** One-line rendering of a scan, used by the CLI and by the ratchet's failure text. */
export const formatMergeScan = (scan: MergeScan): string => {
  const head = `${scan.sha.slice(0, 9)}  lost=${scan.losses.length}  excused=${scan.excused.length}  trivial=${scan.trivial.length}  files=${scan.filesExamined}  ${scan.subject}`
  const detail = scan.losses.map(
    (l) => `    - ${l.file}: ${l.symbol}  (kept in ${l.parent.slice(0, 9)})`,
  )
  return [head, ...detail].join("\n")
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const readFlag = (argv: readonly string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

const main = (argv: readonly string[]): number => {
  const port = createGitReadPort()
  const maxMerges = Number(readFlag(argv, "--max-merges") ?? DEFAULT_MAX_MERGES)
  const rev = readFlag(argv, "--rev") ?? "HEAD"
  const flagValues = new Set([readFlag(argv, "--max-merges"), readFlag(argv, "--rev")])
  const shas = argv.filter((a) => !a.startsWith("--") && !flagValues.has(a))

  const scans =
    shas.length > 0
      ? shas.map((sha) => scanMerge(sha, port))
      : scanMergeWindow(port, rev, maxMerges).merges

  let dirty = 0
  for (const scan of scans) {
    process.stdout.write(`${formatMergeScan(scan)}\n`)
    if (scan.losses.length > 0) dirty += 1
  }
  const pairs = scans.reduce((n, s) => n + s.filesExamined, 0)
  process.stdout.write(
    `\nscanned ${scans.length} merge(s), ${pairs} (parent,file) pair(s); ${dirty} with unexcused symbol loss\n`,
  )
  return dirty > 0 ? 1 : 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
