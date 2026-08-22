/**
 * PMX-02 — the STORAGE-ROOT half of invariant 3.
 *
 * Different TYPES are not enough. If the grader bundle sits inside the directory
 * the agent runs in, then every mechanism that walks that directory — the repo
 * map, the index roots, a `grep`, a `read_file` — reaches gold, no matter how
 * carefully the types are separated. So the split is enforced as a REFUSAL at
 * write time rather than as a convention in a doc:
 *
 *   <agentRoot>/public-tasks.json        written for the run
 *   <graderRoot>/grader-bundle/…         MUST NOT be under <agentRoot>
 *
 * The check is on RESOLVED, symlink-free real paths, because `agent/../grader`
 * and a symlink from inside the agent root are the two ways a nominally-outside
 * path is actually inside.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import {
  ProMaxArtifactError,
  serializeProMaxGraderBundle,
  serializeProMaxPublicTasks,
} from "./artifacts"
import { openProMaxGraderBundle, type ProMaxGraderBundle } from "./grader-bundle"
import { readProMaxPublicTasks } from "./public-reader"
import {
  PROMAX_GRADER_BUNDLE_DIR,
  PROMAX_GRADER_TASKS_FILE,
  PROMAX_PUBLIC_TASKS_FILE,
  type PromaxAgentTaskView,
  type PromaxGraderBundleArtifact,
  type PromaxPublicTasksArtifact,
} from "./types"

/**
 * Resolve symlinks as far as the path EXISTS, then re-append the not-yet-created
 * suffix. Both halves matter: `realpathSync` throws on a missing leaf (and both
 * roots are typically about to be created), while simply walking up and returning
 * the deepest existing ancestor would collapse two sibling roots under a shared
 * parent into the SAME path — reporting every layout as overlapping.
 */
const resolveExisting = (path: string): string => {
  const abs = resolve(path)
  let current = abs
  const missing: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return missing.length === 0 ? real : join(real, ...[...missing].reverse())
    } catch {
      const parent = resolve(current, "..")
      if (parent === current) return abs
      missing.push(basename(current))
      current = parent
    }
  }
}

const isInside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * REFUSE a grader bundle that would land inside the agent's own root. Exported
 * so a transport (PMX-04) can assert the same property about a BOX-side layout
 * without re-deriving the rule.
 */
export const assertGraderBundleOutsideAgentRoot = (args: {
  readonly agentRoot: string
  readonly graderRoot: string
}): void => {
  const agent = resolveExisting(args.agentRoot)
  const grader = resolveExisting(args.graderRoot)
  if (isInside(agent, grader)) {
    throw new ProMaxArtifactError(
      `promax: the grader bundle root ${args.graderRoot} resolves INSIDE the agent root ` +
        `${args.agentRoot} (${grader} ⊂ ${agent}). REFUSING — anything under the agent root is ` +
        "reachable from the agent's repo map, index roots and file tools, so gold placed there " +
        "is agent-visible regardless of how the types are separated.",
    )
  }
}

export interface WriteProMaxArtifactsInput {
  /** Where `public-tasks.json` is written — the ONLY thing the run opens. */
  readonly agentRoot: string
  /** Where `grader-bundle/` is written. Must be outside {@link agentRoot}. */
  readonly graderRoot: string
  readonly publicTasks: PromaxPublicTasksArtifact
  readonly graderBundle: PromaxGraderBundleArtifact
}

export interface ProMaxArtifactPaths {
  readonly publicTasksPath: string
  readonly graderBundleDir: string
  readonly graderTasksPath: string
}

/** Materialize both artifacts, refusing an overlapping layout FIRST (so a bad
 *  layout never gets a partial write of gold into the agent root). */
export const writeProMaxArtifacts = (input: WriteProMaxArtifactsInput): ProMaxArtifactPaths => {
  assertGraderBundleOutsideAgentRoot(input)
  const graderBundleDir = join(input.graderRoot, PROMAX_GRADER_BUNDLE_DIR)
  const publicTasksPath = join(input.agentRoot, PROMAX_PUBLIC_TASKS_FILE)
  const graderTasksPath = join(graderBundleDir, PROMAX_GRADER_TASKS_FILE)
  mkdirSync(input.agentRoot, { recursive: true })
  mkdirSync(graderBundleDir, { recursive: true })
  writeFileSync(publicTasksPath, serializeProMaxPublicTasks(input.publicTasks))
  writeFileSync(graderTasksPath, serializeProMaxGraderBundle(input.graderBundle))
  return { publicTasksPath, graderBundleDir, graderTasksPath }
}

/** AGENT SIDE: read the public tasks file. Takes a path to ONE file and has no
 *  parameter through which a grader location could be supplied. */
export const readProMaxPublicTasksFile = (path: string): readonly PromaxAgentTaskView[] =>
  readProMaxPublicTasks(readFileSync(path, "utf8"))

/** GRADER SIDE: open the bundle directory. Called by the harness adapter after
 *  model-patch capture; never by anything the agent runs. */
export const openProMaxGraderBundleDir = (graderBundleDir: string): ProMaxGraderBundle =>
  openProMaxGraderBundle(readFileSync(join(graderBundleDir, PROMAX_GRADER_TASKS_FILE), "utf8"))
