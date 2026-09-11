import { readFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { loadPolicyOverrides } from "./test-policy"

export type InputScopeKind = "whole-tree" | "declared-v1"

/** One file the certified test can read, bound by CONTENT. */
export interface DeclaredClosureEntry {
  readonly path: string
  readonly sha256: string
}

export type Certification =
  | {
      readonly kind: "declared-v1"
      readonly files: readonly string[]
      readonly reason: string
      /** The test source plus every statically imported helper/fixture. */
      readonly closure: readonly DeclaredClosureEntry[]
    }
  | {
      readonly kind: "whole-tree"
      readonly reason: string
    }

const FORBIDDEN = /\bfs\b|\bspawn\b|\bprocess\.env\b|import\s*\(|Bun\.Glob|child_process/

const REPO_ROOT = dirname(dirname(import.meta.dir))

const OVERRIDES_PATH = join(REPO_ROOT, "tools/dev/test-policy-overrides.json")

const digestOf = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex")

/**
 * Every quoted specifier reachable from a static `import`/`export … from` or a
 * `require(…)`.
 *
 * DELIBERATELY OVER-MATCHING. A string that merely LOOKS like a specifier adds
 * a file to the closure (more invalidation) or fails to resolve (decertifies
 * the file). Both are fail-safe. Missing a real import would be the unsafe
 * direction, so the pattern errs the other way; `import(` is already a
 * FORBIDDEN edge, so a dynamic specifier never reaches here at all.
 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".mjs", ".json", "/index.ts", "/index.tsx"]

const isRelative = (specifier: string): boolean =>
  specifier.startsWith("./") || specifier.startsWith("../")

/** Repo-relative path of the file a relative specifier names, or undefined. */
const resolveRelative = (
  repoRoot: string,
  fromId: string,
  specifier: string,
  read: (id: string) => string | undefined,
): string | undefined => {
  const base = resolve(repoRoot, dirname(fromId), specifier)
  for (const suffix of CANDIDATE_SUFFIXES) {
    const absolute = `${base}${suffix}`
    const id = relative(repoRoot, absolute)
    if (id === "" || id.startsWith("..") || isAbsolute(id)) return undefined
    if (read(id) !== undefined) return id
  }
  return undefined
}

const readRepoFile =
  (repoRoot: string) =>
  (id: string): string | undefined => {
    try {
      return readFileSync(join(repoRoot, id), "utf8")
    } catch {
      return undefined
    }
  }

interface ClosureResult {
  readonly kind: "ok" | "unresolved" | "forbidden"
  readonly entries: readonly DeclaredClosureEntry[]
  readonly detail: string
}

/**
 * Transitive content closure of one test file.
 *
 * WHY CONTENT AND NOT PATHS. A declared identity built from `path + reason`
 * cannot tell "the same test" from "the same test rewritten", so editing the
 * test itself — or a helper it imports — would replay a green earned against
 * different code. That is a strictly worse failure than the whole-tree digest
 * it replaces, which is why declared opt-in stays at zero until this contract
 * exists.
 */
type EdgeResolution =
  | { readonly kind: "ok"; readonly ids: readonly string[] }
  | { readonly kind: "unresolved"; readonly detail: string }

/** Every repo-relative file the given source statically reaches in one hop. */
const resolveEdges = (
  repoRoot: string,
  fromId: string,
  source: string,
  read: (id: string) => string | undefined,
): EdgeResolution => {
  const ids: string[] = []
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? ""
    if (!isRelative(specifier)) continue
    const resolved = resolveRelative(repoRoot, fromId, specifier, read)
    if (resolved === undefined) {
      return { kind: "unresolved", detail: `${fromId} → ${specifier}` }
    }
    ids.push(resolved)
  }
  return { kind: "ok", ids }
}

/**
 * Transitive content closure of one test file.
 *
 * WHY CONTENT AND NOT PATHS. A declared identity built from `path + reason`
 * cannot tell "the same test" from "the same test rewritten", so editing the
 * test itself — or a helper it imports — would replay a green earned against
 * different code. That is a strictly worse failure than the whole-tree digest
 * it replaces, which is why declared opt-in stays at zero until this contract
 * exists.
 */
const declaredClosure = (input: {
  readonly repoRoot: string
  readonly id: string
  readonly source: string
  readonly read: (id: string) => string | undefined
}): ClosureResult => {
  const entries = new Map<string, string>([[input.id, digestOf(input.source)]])
  const queue: readonly string[][] = [[input.id, input.source]] as readonly string[][]
  const pending = [...queue]
  while (pending.length > 0) {
    const [current, source] = pending.shift() as readonly string[] as [string, string]
    if (current !== input.id && FORBIDDEN.test(source)) {
      return { kind: "forbidden", entries: [], detail: current }
    }
    const edges = resolveEdges(input.repoRoot, current, source, input.read)
    if (edges.kind === "unresolved") {
      return { kind: "unresolved", entries: [], detail: edges.detail }
    }
    for (const id of edges.ids) {
      if (entries.has(id)) continue
      const body = input.read(id) as string
      entries.set(id, digestOf(body))
      pending.push([id, body])
    }
  }
  return {
    kind: "ok",
    entries: [...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, sha256]) => ({ path, sha256 })),
    detail: "",
  }
}

export const certifyDeclaredInputs = (input: {
  readonly id: string
  readonly source: string
  readonly optIn: ReadonlySet<string>
  readonly repoRoot?: string
  readonly read?: (id: string) => string | undefined
}): Certification => {
  if (!input.optIn.has(input.id)) {
    return { kind: "whole-tree", reason: "not-opted-in" }
  }
  if (FORBIDDEN.test(input.source)) {
    return { kind: "whole-tree", reason: "forbidden-edge" }
  }
  const repoRoot = input.repoRoot ?? REPO_ROOT
  const closure = declaredClosure({
    repoRoot,
    id: input.id,
    source: input.source,
    read: input.read ?? readRepoFile(repoRoot),
  })
  if (closure.kind === "unresolved") {
    return { kind: "whole-tree", reason: `unresolved-import:${closure.detail}` }
  }
  if (closure.kind === "forbidden") {
    return { kind: "whole-tree", reason: `forbidden-edge-in-closure:${closure.detail}` }
  }
  return {
    kind: "declared-v1",
    files: [input.id],
    reason: "certified",
    closure: closure.entries,
  }
}

export const hashDeclaredInputs = (certifications: readonly Certification[]): string => {
  if (certifications.length === 0 || certifications.some((row) => row.kind === "whole-tree")) {
    return digestOf("whole-tree")
  }
  return digestOf(JSON.stringify(certifications))
}

export const WHOLE_TREE_INPUT_SCOPE_SHA256 = hashDeclaredInputs([])

/**
 * The files EVERY worker loads whatever the chunk contains.
 *
 * `bunfig.toml` preloads `tests/setup.ts` into every test process, and the
 * dependency lock decides which package bytes those imports resolve to.
 * Under the whole-tree digest they were covered for free; a declared scope
 * that dropped them would replay greens across a changed preload or a changed
 * lockfile. They are content-hashed but NOT forbidden-edge checked: they are
 * runner infrastructure that legitimately touches fs and env, they are
 * identical for every chunk, and their bytes are in the digest.
 */
export const RUNNER_BASE_INPUTS = [
  "bunfig.toml",
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "tests/setup.ts",
  "tests/preload-clean-source-js.ts",
] as const

export const runnerBaseScopeSha256 = (
  repoRoot: string,
  read: (id: string) => string | undefined = readRepoFile(repoRoot),
): string =>
  digestOf(
    JSON.stringify(
      RUNNER_BASE_INPUTS.map((id) => {
        const body = read(id)
        return { path: id, sha256: body === undefined ? "<absent>" : digestOf(body) }
      }),
    ),
  )

export const declaredInputOptIn = (overridesPath = OVERRIDES_PATH): ReadonlySet<string> =>
  new Set(
    loadPolicyOverrides(overridesPath)
      .overrides.filter((row) => row.inputScope === "declared")
      .map((row) => row.id),
  )

export const certifyChunkInputs = (
  repoRoot: string,
  ids: readonly string[],
  optIn: ReadonlySet<string> = declaredInputOptIn(),
  read: (id: string) => string | undefined = readRepoFile(repoRoot),
): readonly Certification[] =>
  ids.map((id) => {
    if (!optIn.has(id)) return certifyDeclaredInputs({ id, source: "", optIn })
    const source = read(id)
    if (source === undefined) return { kind: "whole-tree", reason: `unreadable:${id}` }
    return certifyDeclaredInputs({ id, source, optIn, repoRoot, read })
  })

export const chunkInputScopeSha256 = (
  repoRoot: string,
  ids: readonly string[],
  optIn: ReadonlySet<string> = declaredInputOptIn(),
  read: (id: string) => string | undefined = readRepoFile(repoRoot),
): string => {
  const certifications = certifyChunkInputs(repoRoot, ids, optIn, read)
  if (certifications.length === 0 || certifications.some((row) => row.kind === "whole-tree")) {
    return WHOLE_TREE_INPUT_SCOPE_SHA256
  }
  return digestOf(
    JSON.stringify({ base: runnerBaseScopeSha256(repoRoot, read), files: certifications }),
  )
}
