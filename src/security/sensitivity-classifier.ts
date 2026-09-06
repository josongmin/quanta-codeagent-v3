/**
 * Source classification (Layer 1 of the secret-redaction content-plane
 * invariant — ADR-0078). Maps a file path OR a shell-command shape to a
 * closed-enum {@link SensitivityClass}. NEITHER layer is heuristic:
 *   - paths match against an EXPLICIT list of dotfiles / config locations;
 *   - commands match on the FIRST TOKEN + a structural arg shape — no
 *     fuzzy keyword search of the whole command line.
 *
 * `"secret"` is the strongest signal: the redaction layer replaces the
 * entire tool output with a single `[REDACTED:source_class_secret]`
 * placeholder when the source classifies as `"secret"`, BEFORE running
 * format-regex matching. This is structural — we KNOW these paths and
 * commands can ONLY produce secrets — so we never let the raw bytes touch
 * the model context, the JSONL envelope, or the memory distill input.
 */
export type SensitivityClass = "public" | "internal" | "secret"

/**
 * Normalize an absolute path: collapse `~` against the supplied `home`,
 * resolve no `..` (callers pass absolute paths, this is a single-pass
 * normalizer). Returns the canonical form used by `classifyPath`.
 */
const expandHome = (absolutePath: string, home: string): string => {
  if (absolutePath === "~") return home
  if (absolutePath.startsWith("~/")) return `${home}/${absolutePath.slice(2)}`
  return absolutePath
}

/** Lowercased file extension or empty string. */
const ext = (p: string): string => {
  const last = p.lastIndexOf(".")
  if (last < 0) return ""
  // Avoid matching a leading dot on a dotfile with no extension (`.env`).
  const slash = p.lastIndexOf("/")
  if (last < slash) return ""
  if (last === slash + 1) return ""
  return p.slice(last).toLowerCase()
}

/** Basename portion after the last `/`. */
const basename = (p: string): string => {
  const slash = p.lastIndexOf("/")
  return slash < 0 ? p : p.slice(slash + 1)
}

/**
 * Match an absolute path against a fixed list of secret locations. Order:
 *   1. dotfile basenames (`.env`, `.env.local`, `.netrc`, `.pgpass`,
 *      `.python_history`, …);
 *   2. extension matches (`.pem`, `.key`, `.p12`, `.pfx`);
 *   3. SSH private key shapes (`~/.ssh/id_*`, `~/.ssh/*_rsa` — but NOT
 *      `~/.ssh/known_hosts` or `~/.ssh/*.pub`);
 *   4. specific config files (`~/.aws/credentials`, `~/.aws/config`,
 *      `~/.docker/config.json`, `~/.config/gh/hosts.yml`, `~/.kube/config`);
 *   5. tree matches (`~/.gnupg/**`).
 */
/** Context a path rule matches against: the rooted path, its basename and
 *  its lowercased extension. Computed ONCE so the ~25 rules below cannot
 *  disagree about what they are looking at. */
type PathFacts = { readonly p: string; readonly bn: string; readonly e: string }

/** One secret-path rule. `why` is the ADR-0078 justification, carried in the
 *  table so a rule can never drift away from its reason. */
type PathRule = { readonly why: string; readonly match: (f: PathFacts) => boolean }

/** Dotfile basenames that ALWAYS hold secrets, matched exactly. */
const SECRET_DOTFILE_BASENAMES: ReadonlySet<string> = new Set([
  ".env",
  ".netrc",
  ".pgpass",
  ".python_history",
  ".bash_history",
  ".zsh_history",
  ".dockercfg",
  ".git-credentials",
  ".npmrc",
])

/** Private-key / keystore extensions. */
const SECRET_EXTENSIONS: ReadonlySet<string> = new Set([".pem", ".key", ".p12", ".pfx"])

/** `~/.ssh/` entries that are public by design: `known_hosts`, any `*.pub`
 *  public key, and `config` (host preferences). Kept as its own predicate
 *  because it is an EXCLUSION — the only place in this table where matching
 *  the tree does not imply secret. */
const isSshPublicArtifact = (bn: string): boolean =>
  bn === "known_hosts" || bn.endsWith(".pub") || bn === "config"

/** `~/.ssh/` entries whose NAME shape is a private key. */
const isSshPrivateKeyName = (bn: string): boolean =>
  bn.startsWith("id_") ||
  bn.endsWith("_rsa") ||
  bn.endsWith("_dsa") ||
  bn.endsWith("_ecdsa") ||
  bn.endsWith("_ed25519")

/**
 * The ordered, CLOSED list of secret-path rules. This is a table rather than
 * an if-chain because every entry is an independent predicate over the same
 * {@link PathFacts} — there is no control flow between them, only "does any
 * rule fire". Order is preserved from ADR-0078 for readability; the result is
 * order-independent since every rule yields the same verdict.
 */
const SECRET_PATH_RULES: readonly PathRule[] = [
  {
    why: "dotfile basenames that always hold secrets (.env family, histories, credential stores)",
    match: (f) => SECRET_DOTFILE_BASENAMES.has(f.bn) || f.bn.startsWith(".env."),
  },
  {
    why: "private key / keystore extensions",
    match: (f) => SECRET_EXTENSIONS.has(f.e),
  },
  {
    why: "SSH private key shapes, excluding known_hosts / *.pub / config",
    match: (f) => f.p.includes("/.ssh/") && !isSshPublicArtifact(f.bn) && isSshPrivateKeyName(f.bn),
  },
  {
    why: "AWS shared credential + config files",
    match: (f) => f.p.endsWith("/.aws/credentials") || f.p.endsWith("/.aws/config"),
  },
  {
    why: "docker registry auth",
    match: (f) => f.p.endsWith("/.docker/config.json"),
  },
  {
    why: "gh CLI OAuth host store",
    match: (f) => f.p.endsWith("/.config/gh/hosts.yml") || f.p.endsWith("/.config/gh/hosts.yaml"),
  },
  {
    why: "kubeconfig (embedded client certs / tokens)",
    match: (f) => f.p.endsWith("/.kube/config"),
  },
  {
    why: "gcloud Application Default Credentials — holds a refresh token",
    match: (f) => f.p.endsWith("/application_default_credentials.json"),
  },
  {
    why: "quanta's and codex's OWN OAuth records — refresh tokens mint access tokens indefinitely",
    match: (f) =>
      f.p.includes("/.quanta/auth/") ||
      f.p.includes("/.quanta/mcp-oauth/") ||
      f.p.endsWith("/.codex/auth.json"),
  },
  {
    why: "whole-tree key material: gnupg ring, pass store, AWS SSO token cache",
    match: (f) =>
      f.p.includes("/.gnupg/") ||
      f.p.includes("/.password-store/") ||
      f.p.includes("/.aws/sso/cache/"),
  },
]

/** Non-secret home config / cache trees, which classify `"internal"`. */
const isInternalHomeTree = (p: string): boolean =>
  p.includes("/.config/") || p.includes("/.cache/") || p.includes("/.local/share/")

/**
 * Root a possibly-relative path and derive the facts every rule matches on.
 *
 * aug-23 audit — ROOT A RELATIVE PATH BEFORE MATCHING. Every tree rule is
 * written as `p.includes("/.ssh/")` etc., which silently misses the relative
 * form an agent actually types (`.ssh/id_rsa`, `.gnupg/secring`). The basename
 * rules already worked relative; the tree rules did not, so the two halves of
 * this classifier disagreed on the same file depending only on how it was
 * spelled. Prefixing "/" makes a relative path match exactly as its resolved
 * form would — it can only ADD matches, never remove one.
 */
const pathFacts = (absolutePath: string, home: string): PathFacts => {
  const expanded = expandHome(absolutePath, home)
  const p = expanded.startsWith("/") ? expanded : `/${expanded}`
  return { p, bn: basename(p), e: ext(p) }
}

export const classifyPath = (absolutePath: string, home: string): SensitivityClass => {
  const facts = pathFacts(absolutePath, home)
  for (const rule of SECRET_PATH_RULES) {
    if (rule.match(facts)) return "secret"
  }
  if (isInternalHomeTree(facts.p)) return "internal"
  return "public"
}

/** First non-empty token of a command line (stops at the first whitespace). */
const firstToken = (cmd: string): string => {
  const trimmed = cmd.trim()
  if (trimmed.length === 0) return ""
  const m = trimmed.match(/^(\S+)/)
  return m ? (m[1] ?? "") : ""
}

/** Rest of the command line after the first token, trimmed. */
const rest = (cmd: string): string => {
  const trimmed = cmd.trim()
  const space = trimmed.search(/\s/)
  if (space < 0) return ""
  return trimmed.slice(space + 1).trim()
}

/** Tokenize a simple command line (no shell quoting magic — used only for
 *  structural arg-shape matching, NOT for execution). */
const tokenize = (cmd: string): string[] => {
  const trimmed = cmd.trim()
  if (trimmed.length === 0) return []
  // Split on whitespace, drop empties. Quoted args are kept as a single
  // token sans quotes (good enough for shape-matching, e.g. `pass "my key"`).
  const out: string[] = []
  let buf = ""
  let quote: '"' | "'" | null = null
  // Emit the pending token and clear the buffer. A no-op on an empty buffer, which is
  // what keeps a run of whitespace — and a trailing separator — from producing empty
  // tokens; both the separator branch and the end-of-input tail need exactly this.
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

/**
 * Structural command-shape classifier. Matches on the FIRST token + a
 * declared arg shape — not a fuzzy keyword search of the whole command
 * line. Returns `"secret"` for the explicit list of CLIs that print
 * credentials, `"public"` otherwise.
 *
 * Notes:
 *   - `aws configure list-profiles` / `aws configure list` / `aws sts
 *     get-caller-identity` — show profile names + credentials masking.
 *   - `gcloud auth print-access-token` / `print-identity-token` — prints
 *     a bearer token to stdout.
 *   - `gh auth status` / `gh auth token` — prints OAuth tokens.
 *   - `cat ~/.env*` / `cat ~/.aws/*` / `cat ~/.ssh/id_*` — direct file
 *     read of a known-secret location.
 *   - `printenv` / `env` with NO ARGS — dumps the whole environment
 *     (which frequently contains API keys); WITH args it prints one var
 *     and is treated as public (the caller is the audit responsible).
 *   - `keychain` / `security find-generic-password` / `pass *` /
 *     `op read *` — password-manager CLIs.
 */
/** Commands that stream raw file bytes to stdout — any secret-classified
 *  path argument leaks identically to `cat`. Kept as an explicit closed set
 *  (no fuzzy matching) so the rule stays structural. */
const FILE_READERS: ReadonlySet<string> = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "xxd",
  "od",
  "hexdump",
  "strings",
  "nl",
])

/** Command-only secret-path forms documented by ADR-0078 that may contain
 *  shell glob tokens rather than a single concrete path. Kept as a CLOSED
 *  structural set so command-shape classification does not widen into fuzzy
 *  `.env` / `.aws` substring matching. */
const isSecretReaderPathArg = (arg: string): boolean => {
  // aug-23 audit — RELATIVE paths count too. This gate used to require a `/`
  // or `~/` prefix, which dropped the single most common shape an agent types:
  // `cat .env` from the repo root classified `public`, so Layer-1's whole-output
  // substitution never fired on it (`cat ~/.env` was covered, `cat .env` was
  // not). `classifyPath` already answers `secret` for a bare `.env`; only this
  // prefix guard was discarding the answer.
  //
  // The widening is BOUNDED by `classifyPath` itself — it matches an explicit
  // closed set of secret basenames/trees, so `package.json`, `src/index.ts`,
  // `.gitignore` and `.envrc` stay `public` (pinned by the paired control in
  // `tests/unit/security/sensitivity-classifier.test.ts`). Only the two
  // GLOB forms below still need an absolute/`~` anchor, because a bare `.env*`
  // token is a shell glob rather than a path and must not widen fuzzily.
  if (classifyPath(arg, "~") === "secret") return true
  if (!(arg.startsWith("/") || arg.startsWith("~/") || arg === "~")) return false

  const p = expandHome(arg, "~")
  const bn = basename(p)

  // `cat ~/.env*` — glob that expands to the explicit `.env*` family from
  // ADR-0078. Match the glob token itself only; `.envrc` / `.env-backup`
  // stay public unless they hit another explicit rule.
  if (bn === ".env*") return true

  // `cat ~/.aws/*` — wildcard read of the AWS credential/config directory.
  if (p.endsWith("/.aws/*")) return true

  return false
}

/** One command-shape rule: given the tokenized command line (token 0 being
 *  the head this rule is keyed by), does the shape print credentials? */
type CommandShapeRule = (tokens: readonly string[]) => boolean

/**
 * Head-keyed table of credential-printing command shapes. A MAP rather than an
 * if-chain because every entry is `head === X && <arg shape>` — the head test
 * is pure dispatch and belongs in the lookup, leaving each rule to state only
 * its arg shape. Closed set: an unlisted head can never classify `"secret"`
 * through this path.
 */
const SECRET_COMMAND_RULES: ReadonlyMap<string, CommandShapeRule> = new Map<
  string,
  CommandShapeRule
>([
  // bare `printenv` / `env` with NO ARGS dumps the whole environment; WITH
  // args it prints one var and is treated as public (the caller is the audit
  // responsible).
  ["printenv", (t) => t.length === 1],
  ["env", (t) => t.length === 1],
  // password-manager CLIs.
  ["keychain", () => true],
  ["pass", (t) => t.length >= 2],
  ["op", (t) => t[1] === "read"],
  // macOS keychain dump.
  ["security", (t) => t[1] === "find-generic-password"],
  // AWS CLI credential-printing shapes.
  [
    "aws",
    (t) =>
      (t[1] === "configure" && (t[2] === "list-profiles" || t[2] === "list")) ||
      (t[1] === "sts" && t[2] === "get-caller-identity"),
  ],
  // gcloud auth token printers.
  [
    "gcloud",
    (t) => t[1] === "auth" && (t[2] === "print-access-token" || t[2] === "print-identity-token"),
  ],
  // GitHub CLI token printers.
  ["gh", (t) => t[1] === "auth" && (t[2] === "status" || t[2] === "token")],
])

/**
 * Does a file-reading command line name a secret path? Inspects EVERY
 * non-flag arg — `cat -A ~/.env` should still flag. Its own unit because the
 * file-reader family is the one rule that scans arguments rather than
 * matching fixed positions.
 */
const readsSecretPathArg = (tokens: readonly string[]): boolean => {
  for (const arg of tokens.slice(1)) {
    if (arg.startsWith("-")) continue
    if (isSecretReaderPathArg(arg)) return true
  }
  return false
}

/** Closed set of shells whose `-c` / `-lc` payload is the real command. */
const SHELL_WRAPPER_HEADS: ReadonlySet<string> = new Set(["bash", "sh"])
/** Closed set of flags that introduce a command-string payload. */
const SHELL_COMMAND_FLAGS: ReadonlySet<string> = new Set(["-c", "-lc"])
/** One unwrap only — never walk nested `bash -c "bash -c …"` wrappers. */
const MAX_SHELL_UNWRAP_DEPTH = 1

/** Payload after the first `-c` / `-lc` flag, or undefined when absent/empty. */
const shellCommandPayload = (tokens: readonly string[]): string | undefined => {
  for (let i = 1; i < tokens.length; i++) {
    const flag = tokens[i]
    if (flag === undefined || !SHELL_COMMAND_FLAGS.has(flag)) continue
    const payload = tokens[i + 1]
    return payload !== undefined && payload.length > 0 ? payload : undefined
  }
  return undefined
}

const classifyCommandShapeAt = (cmd: string, unwrapDepth: number): SensitivityClass => {
  const head = firstToken(cmd)
  if (head.length === 0) return "public"
  const tokens = tokenize(cmd)

  // File-reading command (`cat` / pager / dumper) against a secret path.
  // Any of these prints raw file bytes to stdout, so a secret-classified
  // path argument leaks the same way `cat` does (`head ~/.ssh/id_rsa`,
  // `less ~/.aws/credentials`, `xxd ~/.netrc`, …).
  if (FILE_READERS.has(head) && readsSecretPathArg(tokens)) return "secret"

  const rule = SECRET_COMMAND_RULES.get(head)
  if (rule?.(tokens) === true) return "secret"

  if (unwrapDepth < MAX_SHELL_UNWRAP_DEPTH && SHELL_WRAPPER_HEADS.has(head)) {
    const payload = shellCommandPayload(tokens)
    if (payload !== undefined) return classifyCommandShapeAt(payload, unwrapDepth + 1)
  }
  return "public"
}

export const classifyCommandShape = (cmd: string): SensitivityClass =>
  classifyCommandShapeAt(cmd, 0)

// Re-exported for tests that want to assert behavior on the helpers; the
// public API is `classifyPath` / `classifyCommandShape`.
export const _internals = { expandHome, ext, basename, firstToken, rest, tokenize }
