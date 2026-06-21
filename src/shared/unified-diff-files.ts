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

const decodeGitPathToken = (token: string): string | null => {
  const startsQuoted = token.startsWith('"')
  const endsQuoted = token.endsWith('"')
  if (startsQuoted !== endsQuoted) return null
  return startsQuoted ? unquoteGitPath(token) : token
}

const unquoteGitPath = (path: string): string => {
  if (!(path.startsWith('"') && path.endsWith('"') && path.length >= 2)) return path
  const body = path.slice(1, -1)
  const bytes: number[] = []
  const pushText = (text: string): void => {
    bytes.push(...Buffer.from(text, "utf8"))
  }
  const escapedByteOf = (esc: string): number[] => {
    switch (esc) {
      case "a":
        return [0x07]
      case "b":
        return [0x08]
      case "f":
        return [0x0c]
      case "n":
        return [0x0a]
      case "r":
        return [0x0d]
      case "t":
        return [0x09]
      case "v":
        return [0x0b]
      default:
        return [...Buffer.from(esc, "utf8")]
    }
  }
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === undefined) break
    if (ch !== "\\") {
      pushText(ch)
      continue
    }
    const a = body[i + 1]
    if (a === undefined) break
    if (/[0-7]/.test(a)) {
      const b = body[i + 2]
      const c = body[i + 3]
      const octal = `${a}${/[0-7]/.test(b ?? "") ? b : ""}${/[0-7]/.test(c ?? "") ? c : ""}`
      bytes.push(Number.parseInt(octal, 8))
      i += octal.length
      continue
    }
    bytes.push(...escapedByteOf(a))
    i += 1
  }
  return Buffer.from(bytes).toString("utf8")
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
  const decodedA = decodeGitPathToken(a.token)
  const decodedB = decodeGitPathToken(b.token)
  if (decodedA === null || decodedB === null) return null
  return {
    a: normalizeGitHeaderPath(decodedA, "a"),
    b: normalizeGitHeaderPath(decodedB, "b"),
  }
}

const parseImageHeaderPath = (
  line: string,
  prefix: "--- " | "+++ ",
  side: "a" | "b",
): string | null | undefined => {
  if (!line.startsWith(prefix)) return undefined
  const raw = decodeGitPathToken(line.slice(prefix.length).trim())
  if (raw === null) return null
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
