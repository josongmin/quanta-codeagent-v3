import { isJsLikeRepoLanguage, normalizeRepoLanguage } from "../repo-language"

const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`
const shellWord = (s: string): string => (/^[A-Za-z0-9_./:=+-]+$/.test(s) ? s : shellQuote(s))

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const parseStringList = (value: unknown): readonly string[] | undefined => {
  let parsed: unknown
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      return undefined
    }
  } else {
    parsed = value
  }
  if (!Array.isArray(parsed)) return undefined
  const items = parsed.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
  )
  return items.length > 0 ? items : undefined
}

/** Go `selected_test_files_to_run` entries are TEST/FUZZ selectors, not file paths.
 *  They frequently include subtest / seed suffixes with spaces, commas, `#`, etc.
 *  (`TestX/subcase, punctuation#1`, `FuzzY/seed#0`). Accept those PUBLIC selector
 *  names verbatim, but stay fail-closed on other families (`Benchmark*`, random
 *  paths, malformed control chars). */
const isGoRunnableSelector = (entry: string): boolean => /^(?:Test|Fuzz)[^\r\n\0]*$/.test(entry)

const isNodeTestPath = (entry: string): boolean =>
  /(^|\/)[^/\s]+\.(?:[cm]?[jt]sx?)$/i.test(entry) || entry.includes("/")

const buildGoVerifierCommand = (entries: readonly string[]): string | undefined => {
  if (!entries.every(isGoRunnableSelector)) return undefined
  const exact = `^(?:${entries.map(escapeRegex).join("|")})$`
  return `go test -count=1 ./... -run ${shellQuote(exact)}`
}

const buildNodeVerifierCommand = (entries: readonly string[]): string | undefined => {
  if (!entries.every(isNodeTestPath)) return undefined
  return `npm test -- ${entries.map(shellWord).join(" ")}`
}

export const parseSelectedTestFilesToRun = (value: unknown): readonly string[] | undefined =>
  parseStringList(value)

export const selectedTestFilesVerifierCommand = (args: {
  readonly repoLanguage: string | undefined
  readonly selectedTestFilesToRun: unknown
}): string | undefined => {
  const lang = normalizeRepoLanguage(args.repoLanguage)
  if (lang === undefined || lang === "python") return undefined
  const entries = parseSelectedTestFilesToRun(args.selectedTestFilesToRun)
  if (entries === undefined) return undefined
  if (lang === "go") return buildGoVerifierCommand(entries)
  if (isJsLikeRepoLanguage(lang)) return buildNodeVerifierCommand(entries)
  return undefined
}
