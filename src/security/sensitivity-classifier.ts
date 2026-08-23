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
export const classifyPath = (absolutePath: string, home: string): SensitivityClass => {
  // aug-23 audit — ROOT A RELATIVE PATH BEFORE MATCHING. Every tree rule below
  // is written as `p.includes("/.ssh/")` etc., which silently misses the
  // relative form an agent actually types (`.ssh/id_rsa`, `.gnupg/secring`).
  // The basename rules already worked relative; the tree rules did not, so the
  // two halves of this classifier disagreed on the same file depending only on
  // how it was spelled. Prefixing "/" makes a relative path match exactly as
  // its resolved form would — it can only ADD matches, never remove one.
  const expanded = expandHome(absolutePath, home)
  const p = expanded.startsWith("/") ? expanded : `/${expanded}`
  const bn = basename(p)
  const e = ext(p)

  // 1. dotfile basenames that ALWAYS hold secrets.
  if (
    bn === ".env" ||
    bn.startsWith(".env.") ||
    bn === ".netrc" ||
    bn === ".pgpass" ||
    bn === ".python_history" ||
    bn === ".bash_history" ||
    bn === ".zsh_history"
  ) {
    return "secret"
  }

  // 2. extension matches — private key / keystore shapes.
  if (e === ".pem" || e === ".key" || e === ".p12" || e === ".pfx") {
    return "secret"
  }

  // 3. SSH private key shapes.
  if (p.includes("/.ssh/")) {
    if (bn === "known_hosts" || bn.endsWith(".pub") || bn === "config") {
      // known_hosts is public by design; `.pub` is public-key; `config` is
      // non-secret host preferences. Drop to default classification below.
    } else if (
      bn.startsWith("id_") ||
      bn.endsWith("_rsa") ||
      bn.endsWith("_dsa") ||
      bn.endsWith("_ecdsa") ||
      bn.endsWith("_ed25519")
    ) {
      return "secret"
    }
  }

  // 4. specific secret-bearing config files.
  if (p.endsWith("/.aws/credentials") || p.endsWith("/.aws/config")) return "secret"
  if (p.endsWith("/.docker/config.json")) return "secret"
  // Legacy docker auth file (`~/.dockercfg`) — base64 registry credentials.
  if (bn === ".dockercfg") return "secret"
  // git credential store — plaintext `https://user:pass@host` lines.
  if (bn === ".git-credentials") return "secret"
  if (p.endsWith("/.config/gh/hosts.yml") || p.endsWith("/.config/gh/hosts.yaml")) return "secret"
  if (p.endsWith("/.kube/config")) return "secret"
  // gcloud Application Default Credentials — holds a refresh token. Lives
  // under ~/.config/gcloud so it would otherwise fall through to "internal".
  if (p.endsWith("/application_default_credentials.json")) return "secret"
  // aug-22 audit — OUR OWN token stores. This list protected every other
  // tool's credentials (~/.aws, ~/.docker, ~/.kube, gh, gcloud) while quanta's
  // and codex's own OAuth records classified as `public`, so `cat
  // ~/.quanta/auth/chatgpt.json` was never whole-file redacted. The records
  // hold a `refresh_token`, which mints access tokens indefinitely — strictly
  // more valuable than the access token Layer-2 already masks.
  if (p.includes("/.quanta/auth/")) return "secret"
  if (p.includes("/.quanta/mcp-oauth/")) return "secret"
  if (p.endsWith("/.codex/auth.json")) return "secret"
  // npm registry auth (`//registry.npmjs.org/:_authToken=…`).
  if (bn === ".npmrc") return "secret"

  // 5. tree matches — anything under ~/.gnupg/ is a key ring.
  if (p.includes("/.gnupg/")) return "secret"
  if (p.includes("/.password-store/")) return "secret"
  if (p.includes("/.aws/sso/cache/")) return "secret"

  // Internal (non-secret) home config / cache.
  if (p.includes("/.config/") || p.includes("/.cache/") || p.includes("/.local/share/")) {
    return "internal"
  }

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
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!
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
      if (buf.length > 0) {
        out.push(buf)
        buf = ""
      }
      continue
    }
    buf += c
  }
  if (buf.length > 0) out.push(buf)
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

export const classifyCommandShape = (cmd: string): SensitivityClass => {
  const head = firstToken(cmd)
  if (head.length === 0) return "public"
  const tokens = tokenize(cmd)

  // bare `printenv` / `env` with no args.
  if ((head === "printenv" || head === "env") && tokens.length === 1) return "secret"

  // File-reading command (`cat` / pager / dumper) against a secret path.
  // Any of these prints raw file bytes to stdout, so a secret-classified
  // path argument leaks the same way `cat` does (`head ~/.ssh/id_rsa`,
  // `less ~/.aws/credentials`, `xxd ~/.netrc`, …).
  if (FILE_READERS.has(head) && tokens.length >= 2) {
    // Inspect EVERY non-flag arg — `cat -A ~/.env` should still flag.
    for (let i = 1; i < tokens.length; i++) {
      const arg = tokens[i]!
      if (arg.startsWith("-")) continue
      if (isSecretReaderPathArg(arg)) return "secret"
    }
  }

  // password-manager CLIs (single-token base or known sub-shapes).
  if (head === "keychain") return "secret"
  if (head === "pass" && tokens.length >= 2) return "secret"
  if (head === "op" && tokens[1] === "read") return "secret"

  // `security find-generic-password ...` (macOS keychain dump).
  if (head === "security" && tokens[1] === "find-generic-password") return "secret"

  // AWS CLI credential-printing shapes.
  if (head === "aws") {
    const t1 = tokens[1]
    const t2 = tokens[2]
    if (t1 === "configure" && (t2 === "list-profiles" || t2 === "list")) return "secret"
    if (t1 === "sts" && t2 === "get-caller-identity") return "secret"
  }

  // gcloud auth token printers.
  if (head === "gcloud") {
    const t1 = tokens[1]
    const t2 = tokens[2]
    if (t1 === "auth" && (t2 === "print-access-token" || t2 === "print-identity-token")) {
      return "secret"
    }
  }

  // GitHub CLI token printers.
  if (head === "gh" && tokens[1] === "auth" && (tokens[2] === "status" || tokens[2] === "token")) {
    return "secret"
  }

  return "public"
}

// Re-exported for tests that want to assert behavior on the helpers; the
// public API is `classifyPath` / `classifyCommandShape`.
export const _internals = { expandHome, ext, basename, firstToken, rest, tokenize }
