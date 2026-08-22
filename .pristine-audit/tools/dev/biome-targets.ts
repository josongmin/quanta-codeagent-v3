import { existsSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const SOURCE_ROOTS = ["src", "tests"] as const
const JS_LIKE_RE = /\.(?:[cm]?js|jsx)$/i
const BIOME_EXT_RE = /\.(?:[cm]?js|jsx|ts|tsx|json|jsonc)$/i

const normalizeRel = (rel: string): string => rel.replaceAll("\\", "/")

const stripKnownExtension = (rel: string): string =>
  rel.replace(/\.(?:[cm]?js|jsx|ts|tsx|json|jsonc)$/i, "")

const hasTypeScriptTwin = (absPath: string): boolean => {
  const stem = absPath.replace(/\.(?:[cm]?js|jsx)$/i, "")
  return (
    existsSync(`${stem}.ts`) ||
    existsSync(`${stem}.tsx`) ||
    existsSync(`${stem}.mts`) ||
    existsSync(`${stem}.cts`)
  )
}

export const isMirrorJsArtifact = (repoRoot: string, relPath: string): boolean => {
  const rel = normalizeRel(relPath)
  if (!JS_LIKE_RE.test(rel)) return false
  if (!rel.startsWith("src/") && !rel.startsWith("tests/")) return false
  return hasTypeScriptTwin(join(resolve(repoRoot), rel))
}

export const shouldIncludeBiomeTarget = (repoRoot: string, relPath: string): boolean => {
  const rel = normalizeRel(relPath)
  if (!BIOME_EXT_RE.test(rel)) return false
  if (rel.endsWith(".d.ts")) return false
  if (rel.startsWith("tests/smoke/fixtures/")) return false
  const leaf = rel.split("/").at(-1) ?? rel
  if (leaf.includes(".from-worktree")) return false
  if (leaf.includes(".my-backup")) return false
  if (isMirrorJsArtifact(repoRoot, rel)) return false
  return true
}

const walk = (repoRoot: string, relDir: string, out: string[]): void => {
  const absDir = join(repoRoot, relDir)
  let entries: string[]
  try {
    entries = readdirSync(absDir)
  } catch {
    return
  }
  for (const name of entries) {
    const abs = join(absDir, name)
    let entryStat: ReturnType<typeof statSync>
    try {
      entryStat = statSync(abs)
    } catch {
      continue
    }
    const rel = normalizeRel(relative(repoRoot, abs))
    if (entryStat.isDirectory()) {
      walk(repoRoot, rel, out)
      continue
    }
    if (entryStat.isFile() && shouldIncludeBiomeTarget(repoRoot, rel)) out.push(rel)
  }
}

export const collectBiomeTargets = (
  repoRoot: string,
  roots: ReadonlyArray<string> = SOURCE_ROOTS,
): string[] => {
  const absRepoRoot = resolve(repoRoot)
  const out: string[] = []
  for (const root of roots) {
    walk(absRepoRoot, root, out)
  }
  out.sort((a, b) => {
    const aStem = stripKnownExtension(a)
    const bStem = stripKnownExtension(b)
    return aStem === bStem ? a.localeCompare(b) : aStem.localeCompare(bStem)
  })
  return out
}
