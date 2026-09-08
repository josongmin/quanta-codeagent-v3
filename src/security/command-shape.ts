/**
 * Structural command-line shape helpers for Layer-1 source classification.
 * Not a POSIX parser: basename + flag clusters + pipeline/redirect/prefix
 * segments only. Unparseable suspicious env/interpreter tokens fail closed
 * at the caller, not here.
 */

/** First non-empty token of a command line (stops at the first whitespace). */
export const firstToken = (cmd: string): string => {
  const trimmed = cmd.trim()
  if (trimmed.length === 0) return ""
  const m = trimmed.match(/^(\S+)/)
  return m ? (m[1] ?? "") : ""
}

/** Rest of the command line after the first token, trimmed. */
export const rest = (cmd: string): string => {
  const trimmed = cmd.trim()
  const space = trimmed.search(/\s/)
  if (space < 0) return ""
  return trimmed.slice(space + 1).trim()
}

/** Tokenize a simple command line (no shell quoting magic — used only for
 *  structural arg-shape matching, NOT for execution). */
export const tokenize = (cmd: string): string[] => {
  const trimmed = cmd.trim()
  if (trimmed.length === 0) return []
  const out: string[] = []
  let buf = ""
  let quote: '"' | "'" | null = null
  const flush = (): void => {
    if (buf.length > 0) {
      out.push(buf)
      buf = ""
    }
  }
  for (const c of trimmed) {
    if (quote) {
      if (c === quote) {
        quote = null
        continue
      }
      buf += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (/\s/.test(c)) {
      flush()
      continue
    }
    buf += c
  }
  flush()
  return out
}

/** Executable basename: `/bin/bash` → `bash`, `bash.exe` → `bash`. */
export const executableBasename = (token: string): string => {
  const cut = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"))
  const name = cut < 0 ? token : token.slice(cut + 1)
  return name.toLowerCase().endsWith(".exe") ? name.slice(0, -4) : name
}

/** Closed set of shells whose `-c` payload is the real command. */
export const SHELL_WRAPPER_HEADS: ReadonlySet<string> = new Set(["bash", "sh", "zsh"])

export const INTERPRETER_EVAL_HEADS: ReadonlySet<string> = new Set([
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "ruby",
])

export const INTERPRETER_EVAL_FLAGS: ReadonlySet<string> = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-c",
])

const COMMAND_OPERATORS: ReadonlySet<string> = new Set(["|", "||", "&&", ";", "&", "|&"])

/** Split a tokenized line on pipeline / list operators. */
export const splitCommandSegments = (tokens: readonly string[]): readonly (readonly string[])[] => {
  const segments: string[][] = []
  let current: string[] = []
  for (const t of tokens) {
    if (COMMAND_OPERATORS.has(t)) {
      if (current.length > 0) segments.push(current)
      current = []
      continue
    }
    current.push(t)
  }
  if (current.length > 0) segments.push(current)
  return segments
}

const redirectMetaIndex = (t: string): number => {
  const gt = t.indexOf(">")
  const lt = t.indexOf("<")
  if (gt < 0) return lt
  if (lt < 0) return gt
  return Math.min(gt, lt)
}

/** A redirect operator or fd-redirect token (`>`, `2>&1`, `2>file`). */
export const isRedirectToken = (t: string): boolean => {
  const idx = redirectMetaIndex(t)
  if (idx < 0) return false
  const prefix = t.slice(0, idx)
  return prefix === "" || /^\d+$/.test(prefix)
}

const redirectNeedsNext = (t: string): boolean => {
  const last = Math.max(t.lastIndexOf(">"), t.lastIndexOf("<"))
  return last >= 0 && t.slice(last + 1).length === 0
}

/** Drop redirect operators and their targets. */
export const stripRedirects = (tokens: readonly string[]): readonly string[] => {
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === undefined) continue
    if (!isRedirectToken(t)) {
      out.push(t)
      continue
    }
    if (redirectNeedsNext(t)) i++
  }
  return out
}

const isAssignment = (t: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)

/** Skip leading `NAME=value` prefixes (`FOO=1 printenv`). */
export const skipLeadingAssignments = (tokens: readonly string[]): readonly string[] => {
  let i = 0
  while (i < tokens.length && isAssignment(tokens[i] ?? "")) i++
  return tokens.slice(i)
}

/** After `env`, skip flags and assignments so the remainder is the inner command. */
export const skipEnvPrefixArgs = (tokens: readonly string[]): readonly string[] => {
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i] ?? ""
    if (t.startsWith("-") || isAssignment(t)) {
      i++
      continue
    }
    break
  }
  return tokens.slice(i)
}

/**
 * Payload after a command-string flag. Accepts `-c`, `-lc`, `-xc`, and
 * other short-option clusters that contain `c`. Long options (`--login`)
 * are never treated as `-c`.
 */
export const shellCommandPayload = (tokens: readonly string[]): string | undefined => {
  for (let i = 1; i < tokens.length; i++) {
    const flag = tokens[i]
    if (flag === undefined || flag.startsWith("--") || !flag.startsWith("-")) continue
    const letters = flag.slice(1)
    const cIndex = letters.indexOf("c")
    if (cIndex < 0) continue
    const inline = letters.slice(cIndex + 1)
    if (inline.length > 0) return inline
    const payload = tokens[i + 1]
    return payload !== undefined && payload.length > 0 ? payload : undefined
  }
  return undefined
}

/** Source string after the first interpreter eval flag (`-e` / `--eval` / `-c`). */
export const interpreterEvalSource = (tokens: readonly string[]): string | undefined => {
  for (let i = 1; i < tokens.length; i++) {
    const flag = tokens[i]
    if (flag === undefined || !INTERPRETER_EVAL_FLAGS.has(flag)) continue
    const source = tokens[i + 1]
    return source !== undefined && source.length > 0 ? source : undefined
  }
  return undefined
}

const META = /[|;&<>]/

/**
 * Token that glues a known wrapper/dump head to a metacharacter
 * (`printenv|cat`, `printenv>out`) — unparseable as separate tokens.
 */
export const gluedSuspiciousHead = (token: string, secretHeads: ReadonlySet<string>): boolean => {
  const idx = token.search(META)
  if (idx <= 0) return false
  const head = executableBasename(token.slice(0, idx))
  return secretHeads.has(head)
}
