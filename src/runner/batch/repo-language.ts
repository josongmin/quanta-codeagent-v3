export type RepoLanguage = "python" | "go" | "js" | "ts"

export const normalizeRepoLanguage = (raw: string | undefined): RepoLanguage | undefined => {
  const lang = (raw ?? "").trim().toLowerCase()
  if (lang === "") return undefined
  if (lang.startsWith("python") || lang === "py" || lang === "cpython") return "python"
  if (lang === "go") return "go"
  if (lang === "js" || lang === "javascript") return "js"
  if (lang === "ts" || lang === "typescript") return "ts"
  return undefined
}

export const normalizeRepoLanguageWithPythonDefault = (
  raw: string | undefined,
): RepoLanguage | undefined => {
  const normalized = normalizeRepoLanguage(raw)
  if (normalized !== undefined) return normalized
  return (raw ?? "").trim() === "" ? "python" : undefined
}

export const isJsLikeRepoLanguage = (raw: string | undefined): boolean => {
  const lang = normalizeRepoLanguage(raw)
  return lang === "js" || lang === "ts"
}
