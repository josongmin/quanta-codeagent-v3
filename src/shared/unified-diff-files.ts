/** Unified diff path extraction shared by bench/local selection authorities.
 *
 * Contract:
 *   - Regular edits use the post-image `+++ b/...` path.
 *   - Pure deletions fall back to the pre-image `--- a/...` path.
 *   - Pure renames/copies (no `---` / `+++` image headers) fall back to the
 *     post-image path from `diff --git a/... b/...`.
 *   - Git-quoted paths (`"a/path with space.py"`) are unquoted and C-unescaped.
 *
 * No filesystem / git exec: pure string scanning only.
 */

const DIFF_GIT_PREFIX = "diff --git "

const normalizeGitHeaderPath = (raw: string, side: "a" | "b"): string | null => {
  const path = raw.replace(/\\/g, "/")
  if (path === "" || path === "/dev/null") return null
  return path.startsWith(`${side}/`) ? path.slice(2) : path
}

const unquoteGitPath = (path: string): string => {
  if (!(path.startsWith('"') && path.endsWith('"') && path.length >= 2)) return path
  return path
    .slice(1, -1)
    .replace(/\\([0-7]{1,3}|.)/g, (_m, esc: string) =>
      /^[0-7]{1,3}$/.test(esc) ? String.fromCharCode(Number.parseInt(esc, 8)) : esc,
    )
}

const readDiffGitToken = (
  text: string,
  start: number,
): { readonly token: string; readonly next: number } | null => {
  let i = start
  while (i < text.length && text[i] === " ") i += 1
  if (i >= text.length) return null
  if (text[i] !== '"') {
    let end = i
    while (end < text.length && text[end] !== " ") end += 1
    return { token: text.slice(i, end), next: end }
  }
  let end = i + 1
  let escaped = false
  while (end < text.length) {
    const ch = text[end]
    end += 1
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === '"') {
      const token = unquoteGitPath(text.slice(i, end))
      return { token, next: end }
    }
  }
  return null
}

const parseDiffGitPaths = (
  line: string,
): { readonly a: string | null; readonly b: string | null } | null => {
  if (!line.startsWith(DIFF_GIT_PREFIX)) return null
  const payload = line.slice(DIFF_GIT_PREFIX.length)
  const a = readDiffGitToken(payload, 0)
  if (a === null) return null
  const b = readDiffGitToken(payload, a.next)
  if (b === null) return null
  return {
    a: normalizeGitHeaderPath(unquoteGitPath(a.token), "a"),
    b: normalizeGitHeaderPath(unquoteGitPath(b.token), "b"),
  }
}

const parseImageHeaderPath = (
  line: string,
  prefix: "--- " | "+++ ",
  side: "a" | "b",
): string | null | undefined => {
  if (!line.startsWith(prefix)) return undefined
  const raw = unquoteGitPath(line.slice(prefix.length).trim())
  return normalizeGitHeaderPath(raw, side)
}

/** Repo-relative files a unified diff touches. */
export const filesFromUnifiedDiff = (patch: string): string[] => {
  const files = new Set<string>()
  let fallbackPath: string | undefined
  let preImagePath: string | undefined
  let emittedFromImages = false
  const flush = (): void => {
    if (!emittedFromImages && fallbackPath !== undefined) files.add(fallbackPath)
    fallbackPath = undefined
    preImagePath = undefined
    emittedFromImages = false
  }
  for (const line of patch.split("\n")) {
    if (line.startsWith(DIFF_GIT_PREFIX)) {
      flush()
      const parsed = parseDiffGitPaths(line)
      fallbackPath = (parsed?.b ?? parsed?.a) ?? undefined
      continue
    }
    const pre = parseImageHeaderPath(line, "--- ", "a")
    if (pre !== undefined) {
      preImagePath = pre ?? undefined
      continue
    }
    const post = parseImageHeaderPath(line, "+++ ", "b")
    if (post !== undefined) {
      const path = post ?? preImagePath ?? fallbackPath
      if (path !== undefined) files.add(path)
      emittedFromImages = true
      fallbackPath = undefined
      preImagePath = undefined
    }
  }
  flush()
  return [...files]
}
