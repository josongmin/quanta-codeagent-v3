import type { SensitivityClass } from "./sensitivity-classifier"

/**
 * Secret redaction — content-plane invariant (ADR-0078).
 *
 * Single SoT for masking known-format secrets out of:
 *   1. tool result text (model-facing observation),
 *   2. JSONL envelope writes (on-disk persistence),
 *   3. memory distill input (long-term memory ingest).
 *
 * Two structural layers — NEITHER heuristic:
 *   - Layer 1: source-class classification (path / command shape) →
 *     {@link SensitivityClass}. When `"secret"`, the entire output is
 *     replaced with a single placeholder; we do not pattern-match further.
 *   - Layer 2: deterministic format regex against KNOWN secret formats
 *     (AWS key id, GitHub PAT, PEM header, …). Each pattern matches a
 *     fixed shape — no fuzzy-English keyword search.
 *
 * Discriminated union {@link RedactionKind} is closed: `exhaustiveSwitch`
 * uses a TS `never` default so adding a kind without wiring the matcher is
 * a type error. Each match emits a {@link RedactionHit} so the user / audit
 * can see WHAT was hidden AND WHERE (no silent redaction).
 */

export type RedactionKind =
  | "aws_access_key_id"
  | "aws_secret_access_key_assignment"
  | "github_pat_classic"
  | "github_pat_fine_grained"
  | "google_api_key"
  | "gcp_service_account_key"
  | "openai_api_key"
  | "anthropic_api_key"
  | "stripe_secret_key"
  | "bearer_token_header"
  | "pem_private_key_block"
  | "openssh_private_key_block"
  | "url_with_userinfo"
  | "generic_api_key_assignment"
  | "slack_token"
  | "jwt"
  | "source_class_secret"

export interface RedactionHit {
  readonly kind: RedactionKind
  readonly span: readonly [start: number, end: number]
  readonly placeholder: string
}

export type RedactionOrigin = "tool_result" | "envelope_jsonl" | "memory_distill"

export interface RedactOptions {
  readonly origin: RedactionOrigin
  readonly sourceClass?: SensitivityClass
  readonly whitelist?: ReadonlyArray<RegExp>
  /** Optional originating path or command, used in the source-class-secret
   *  replacement message so the user/audit can see WHERE the redacted
   *  output came from. */
  readonly sourceLabel?: string
}

export interface RedactResult {
  readonly text: string
  readonly hits: ReadonlyArray<RedactionHit>
  readonly unchanged: boolean
}

const placeholderFor = (kind: RedactionKind): string => `[REDACTED:${kind}]`

const exhaustive = (x: never): never => {
  throw new Error(`unhandled redaction kind: ${String(x)}`)
}

/**
 * The closed set of format patterns. Each entry's `regex` matches the
 * KNOWN secret format (NOT an English sentence) — global + case-sensitive
 * unless the secret format is itself case-insensitive. Order matters when
 * patterns overlap; we apply them in this declared order and each match
 * consumes its span before later patterns are evaluated.
 *
 * Switch over `kind` is exhaustive so adding a kind without wiring a
 * matcher is a type error at compile time (see `exhaustive(x)` default).
 */
interface Pattern {
  readonly kind: Exclude<RedactionKind, "source_class_secret">
  readonly regex: RegExp
}

const patterns: ReadonlyArray<Pattern> = [
  // PEM / OpenSSH key BLOCKS — match begin-to-end; placed FIRST so an
  // embedded `AKIA...`-shaped string inside a key block does not double-hit.
  {
    kind: "pem_private_key_block",
    regex:
      /-----BEGIN (?:RSA |EC |DSA |ENCRYPTED |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |ENCRYPTED |PGP )?PRIVATE KEY-----/g,
  },
  {
    kind: "openssh_private_key_block",
    regex: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g,
  },
  // GCP service-account JSON — `"type": "service_account"` co-located with
  // `"private_key"`. Match the SMALLEST enclosing object so we don't redact
  // an entire enclosing file by accident.
  {
    kind: "gcp_service_account_key",
    regex: /\{[^{}]*?"type"\s*:\s*"service_account"[^{}]*?"private_key"\s*:\s*"[^"]+"[^{}]*?\}/g,
  },
  // AWS access key id — exact-shape `AKIA` / `ASIA` / `AROA` / `AIDA` + 16 base32.
  {
    kind: "aws_access_key_id",
    regex: /\b(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}\b/g,
  },
  // AWS secret access key — `aws_secret_access_key = <40 char base64>` shape.
  // Anchor on the assignment so a 40-char identifier in normal prose doesn't trip.
  {
    kind: "aws_secret_access_key_assignment",
    regex: /aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}/gi,
  },
  // GitHub PAT — classic prefixes.
  {
    kind: "github_pat_classic",
    regex: /\b(?:ghp|gho|ghs|ghr|ghu)_[A-Za-z0-9]{36,255}\b/g,
  },
  // GitHub PAT — fine-grained.
  {
    kind: "github_pat_fine_grained",
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  // Google API key — `AIza` + 35 url-safe base64 chars.
  {
    kind: "google_api_key",
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
  },
  // Anthropic API key — `sk-ant-` prefix. Match BEFORE openai_api_key so
  // `sk-ant-…` is classified as anthropic rather than the generic `sk-` shape.
  {
    kind: "anthropic_api_key",
    regex: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g,
  },
  // Stripe live / test secret key.
  {
    kind: "stripe_secret_key",
    regex: /\b(?:sk_live_|sk_test_|rk_live_|rk_test_)[A-Za-z0-9]{20,}\b/g,
  },
  // OpenAI proj-key (2024+) — `sk-proj-` followed by a long mixed-class body
  // containing `_` / `-`. Order matters: matched BEFORE the classic shape so
  // a `sk-proj-…` does not get sliced at the first `-`.
  {
    kind: "openai_api_key",
    regex: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
  },
  // OpenAI classic API key — `sk-` followed by ≥32 alphanumeric (avoid clash
  // with anthropic above by negative-lookahead on `ant-`; avoid stripe by
  // ruling out `live_`/`test_`).
  {
    kind: "openai_api_key",
    regex: /\bsk-(?!ant-)(?!proj-)(?!live_)(?!test_)[A-Za-z0-9]{32,}\b/g,
  },
  // Authorization Bearer header.
  {
    kind: "bearer_token_header",
    regex: /\b[Aa]uthorization\s*:\s*Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g,
  },
  // URL with userinfo (`https://user:password@host/...`). The user side may
  // be empty (no `:`) — match only when a `:` IS present to avoid grabbing a
  // normal git-over-ssh URL like `git@github.com`.
  {
    kind: "url_with_userinfo",
    regex: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/g,
  },
  // Slack token — fixed `xox[bparse]-` prefix + ≥10 token chars. Slack's
  // documented token shapes (bot `xoxb`, user `xoxp`, app `xoxa`, refresh
  // `xoxr`, legacy `xoxs`, config `xoxe`). The prefix is distinctive enough
  // that this carries no realistic false-positive risk in source/prose.
  {
    kind: "slack_token",
    regex: /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/g,
  },
  // JWT — three base64url segments separated by dots. Anchored on `eyJ`,
  // which is the base64url encoding of `{"` and therefore the universal
  // start of a JWT header (`{"alg":...}`). Anchoring on `eyJ` (rather than a
  // bare 3-dot-segment shape) avoids tripping on ordinary dotted identifiers
  // or version strings. Each segment is a bounded char class with a literal
  // `.` separator — linear time, no backtracking.
  {
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  // Generic API-key assignment — last resort for `API_KEY = "abc..."` shapes
  // in dotenv files / shell exports / JSON config. Requires ≥20 alphanumerics
  // on the RHS so a short example value (`API_KEY=foo`) does not trip. The
  // optional `["']?` AFTER the key name lets the JSON object form
  // (`"api_key":"<secret>"`) match too — the key's own closing quote no
  // longer breaks the assignment anchor.
  {
    kind: "generic_api_key_assignment",
    regex:
      /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token|private[_-]?token)["']?\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}["']?/gi,
  },
]

/**
 * Apply Layer-2 format patterns to `text`. Each pattern runs ONCE with
 * sticky-global semantics; matches are recorded as `RedactionHit`s and the
 * input text is rebuilt with the placeholder inline. Overlapping matches
 * across patterns are resolved by the declared order — the first pattern
 * to claim a span wins; later patterns see the placeholder (which does not
 * match any of them).
 */
const applyFormatPatterns = (
  text: string,
  whitelist: ReadonlyArray<RegExp>,
): { text: string; hits: RedactionHit[] } => {
  let out = text
  const hits: RedactionHit[] = []
  for (const pat of patterns) {
    // Reset lastIndex each pass — `regex.exec` on a global regex is stateful.
    pat.regex.lastIndex = 0
    let match: RegExpExecArray | null = pat.regex.exec(out)
    const placeholder = placeholderFor(pat.kind)
    while (match !== null) {
      const matched = match[0]
      const matchStart = match.index
      const matchEnd = matchStart + matched.length

      // Honor whitelist — caller-provided structural override (e.g. a known-
      // public fixture token). Skip the match without recording a hit.
      if (whitelist.some((re) => re.test(matched))) {
        pat.regex.lastIndex = matchEnd
        match = pat.regex.exec(out)
        continue
      }

      hits.push({
        kind: pat.kind,
        span: [matchStart, matchEnd] as const,
        placeholder,
      })
      // Splice the placeholder in.
      out = out.slice(0, matchStart) + placeholder + out.slice(matchEnd)
      // Reset lastIndex so we don't skip overlapping matches further along
      // (placeholder length differs from match length).
      pat.regex.lastIndex = matchStart + placeholder.length
      match = pat.regex.exec(out)
    }
  }
  return { text: out, hits }
}

/**
 * Single SoT entry point. Returns a {@link RedactResult} with:
 *   - `text` — the redacted output (`===` to `input` when no changes);
 *   - `hits` — closed-enum kind, span, placeholder per match;
 *   - `unchanged` — `true` iff `hits.length === 0`.
 *
 * Behavior is deterministic — same input + same options ⇒ same output and
 * same hit order. No `Date.now()`, no randomness, no thresholds.
 *
 * When `opts.sourceClass === "secret"`: skip Layer-2 pattern matching and
 * REPLACE the entire output with `[REDACTED:source_class_secret] (origin:
 * <sourceLabel>)`. Emit exactly one hit of kind `"source_class_secret"`
 * covering the entire original text. This is the Layer-1 short-circuit.
 *
 * Type-level exhaustiveness: every `RedactionKind` is referenced in the
 * patterns table OR the source-class branch. Adding a kind without wiring
 * a matcher fails `applyFormatPatterns`'s pattern table OR the closing
 * `exhaustive(x)` switch (see `assertKindWired` below).
 */
export const redactSecrets = (input: string, opts: RedactOptions): RedactResult => {
  // Layer 1 — source class short-circuit. Replace entire output.
  if (opts.sourceClass === "secret") {
    const placeholder = placeholderFor("source_class_secret")
    const origin = opts.sourceLabel ? ` (origin: ${opts.sourceLabel})` : ""
    const text = `${placeholder}${origin}`
    const hit: RedactionHit = {
      kind: "source_class_secret",
      span: [0, input.length] as const,
      placeholder,
    }
    return Object.freeze({
      text,
      hits: Object.freeze([hit]) as ReadonlyArray<RedactionHit>,
      unchanged: false,
    })
  }

  // Layer 2 — format patterns. Fast path: empty input ⇒ unchanged.
  if (input.length === 0) {
    return Object.freeze({ text: input, hits: Object.freeze([]), unchanged: true })
  }
  const { text, hits } = applyFormatPatterns(input, opts.whitelist ?? [])
  return Object.freeze({
    text,
    hits: Object.freeze(hits) as ReadonlyArray<RedactionHit>,
    unchanged: hits.length === 0,
  })
}

/**
 * Compile-time exhaustiveness probe. Adding a new {@link RedactionKind}
 * without wiring a Layer-2 pattern (or treating it as a Layer-1 short-
 * circuit kind) is a type error because `exhaustive(k)` accepts `never`.
 *
 * The runtime function exists only so the type-checker exercises this
 * switch; it is NOT called from the redaction path.
 */
export const assertKindWired = (k: RedactionKind): string => {
  switch (k) {
    case "aws_access_key_id":
    case "aws_secret_access_key_assignment":
    case "github_pat_classic":
    case "github_pat_fine_grained":
    case "google_api_key":
    case "gcp_service_account_key":
    case "openai_api_key":
    case "anthropic_api_key":
    case "stripe_secret_key":
    case "bearer_token_header":
    case "pem_private_key_block":
    case "openssh_private_key_block":
    case "url_with_userinfo":
    case "generic_api_key_assignment":
    case "slack_token":
    case "jwt":
    case "source_class_secret":
      return placeholderFor(k)
    default:
      return exhaustive(k)
  }
}
