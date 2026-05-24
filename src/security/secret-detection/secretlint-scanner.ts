/**
 * secretlint-backed adapter (ADR-0173; supersedes ADR-0164 internals).
 *
 * Wraps the canonical JS-world secret scanner {@link
 * https://github.com/secretlint/secretlint} behind our local {@link
 * SecretScanner} port so all existing callers (a future `secret_scan` tool, a
 * pre-commit hook, a CI gate) see the same byte-identical `SecretFinding[]`
 * shape they always have.
 *
 * Why secretlint rather than another hand-roll: the recommended preset ships
 * with vendor-maintained, false-positive-resistant rules for AWS / Anthropic /
 * OpenAI / GCP / GitHub / Slack / Stripe / PEM private-key + ten more, with
 * structured `messages[]` that carry `ruleId`, `messageId`, `loc.start.{line,
 * column}`, and `range`. That gives us a wider catalog AND active maintenance
 * for the cost of one translation table. The sibling pattern + entropy adapters
 * stay shipped (zero-dep callers + composite fallback path).
 *
 * Plane discipline: imports ONLY `@secretlint/core`, `@secretlint/types`,
 * `@secretlint/secretlint-rule-preset-recommend`, and `node:fs/promises`. No
 * other quanta slice — keeps the scanner portable to a Tauri sidecar / worker.
 */
import { readFile } from "node:fs/promises"
import { lintSource } from "@secretlint/core"
import { creator as recommendedPreset } from "@secretlint/secretlint-rule-preset-recommend"
import type {
  SecretLintCoreConfig,
  SecretLintCoreResultMessage,
} from "@secretlint/types"
import {
  DEFAULT_MAX_FINDINGS,
  mask,
  type SecretFinding,
  type SecretKind,
  type SecretScanner,
  type SecretScannerOpts,
} from "./port"

/**
 * Options for the secretlint adapter. Extends the port's base bag; adds a
 * `kinds` allowlist (when set, ONLY findings whose translated kind is in the
 * set are returned — matches the documented filter pattern used by other
 * scanners in this slice).
 */
export interface SecretlintScannerOpts extends SecretScannerOpts {
  /** Restrict output to these kinds. Default: all kinds emitted. */
  readonly kinds?: ReadonlyArray<SecretKind>
  /**
   * Override the secretlint config. Default: the recommended preset with
   * AWS `enableIDScanRule: true` so `AKIA…` access-key IDs are reported (the
   * preset's default is OFF to favor secret-key over key-id precision; for
   * a pre-commit hook we want both signals).
   */
  readonly config?: SecretLintCoreConfig
}

/**
 * The default secretlint config wired by this adapter. Splitting it out lets
 * the hellgate suite assert "default-on AWS ID scan" without re-instantiating
 * the preset binding.
 */
export const DEFAULT_SECRETLINT_CONFIG: SecretLintCoreConfig = {
  rules: [
    {
      id: "@secretlint/secretlint-rule-preset-recommend",
      rule: recommendedPreset,
      rules: [
        {
          id: "@secretlint/secretlint-rule-aws",
          options: { enableIDScanRule: true },
        },
      ],
    },
  ],
}

/**
 * Translation table: secretlint (ruleId, messageId) → our {@link SecretKind}.
 *
 * Coverage map (9 of our 10 non-entropy kinds; `google-api-key` is not in the
 * recommended preset so it falls through to the fallback below):
 *
 *   aws-access-key      ← @secretlint/secretlint-rule-aws / AWSAccessKeyID
 *   aws-secret-key      ← @secretlint/secretlint-rule-aws / AWSSecretAccessKey
 *   openai-api-key      ← @secretlint/secretlint-rule-openai / OPENAI_TOKEN
 *   anthropic-api-key   ← @secretlint/secretlint-rule-anthropic / ANTHROPIC_API_KEY
 *   github-token        ← @secretlint/secretlint-rule-github / GITHUB_TOKEN
 *   gcp-service-account ← @secretlint/secretlint-rule-gcp / PrivateKeyJSON | PrivateKeyP12
 *   slack-token         ← @secretlint/secretlint-rule-slack / SLACK_TOKEN
 *   stripe-key          ← @secretlint/secretlint-rule-stripe / STRIPE_*
 *   private-key-block   ← @secretlint/secretlint-rule-privatekey / PrivateKey
 *
 * Any other secretlint rule (1password, cloudflare, docker, figma, basicauth,
 * databricks, gitlab, grafana, groq, hashicorp-vault, huggingface, linear,
 * notion, npm, shopify, sendgrid, tailscale, vercel, database-connection-
 * string) lacks a precise mapping in our closed {@link SecretKind} union and
 * is reported as `generic-high-entropy` with `confidence: "medium"` so the
 * caller still sees the signal without breaking the typed catalog.
 */
const RULE_TO_KIND: ReadonlyMap<string, SecretKind> = new Map([
  ["@secretlint/secretlint-rule-openai|OPENAI_TOKEN", "openai-api-key" as const],
  [
    "@secretlint/secretlint-rule-anthropic|ANTHROPIC_API_KEY",
    "anthropic-api-key" as const,
  ],
  ["@secretlint/secretlint-rule-github|GITHUB_TOKEN", "github-token" as const],
  ["@secretlint/secretlint-rule-aws|AWSAccessKeyID", "aws-access-key" as const],
  [
    "@secretlint/secretlint-rule-aws|AWSSecretAccessKey",
    "aws-secret-key" as const,
  ],
  ["@secretlint/secretlint-rule-aws|AWSAccountID", "aws-access-key" as const],
  ["@secretlint/secretlint-rule-gcp|PrivateKeyJSON", "gcp-service-account" as const],
  ["@secretlint/secretlint-rule-gcp|PrivateKeyP12", "gcp-service-account" as const],
  ["@secretlint/secretlint-rule-slack|SLACK_TOKEN", "slack-token" as const],
  ["@secretlint/secretlint-rule-stripe|STRIPE_SECRET_KEY_LIVE", "stripe-key" as const],
  ["@secretlint/secretlint-rule-stripe|STRIPE_SECRET_KEY_TEST", "stripe-key" as const],
  [
    "@secretlint/secretlint-rule-stripe|STRIPE_RESTRICTED_KEY_LIVE",
    "stripe-key" as const,
  ],
  [
    "@secretlint/secretlint-rule-stripe|STRIPE_RESTRICTED_KEY_TEST",
    "stripe-key" as const,
  ],
  ["@secretlint/secretlint-rule-privatekey|PrivateKey", "private-key-block" as const],
])

const translate = (m: SecretLintCoreResultMessage): SecretKind => {
  const key = `${m.ruleId}|${m.messageId}`
  const mapped = RULE_TO_KIND.get(key)
  // Unmapped rules (anything secretlint catches that we don't have a typed
  // variant for) are reported as generic-high-entropy. This preserves the
  // signal without breaking the closed `SecretKind` union — exactly the
  // posture entropy hits already use.
  return mapped ?? "generic-high-entropy"
}

/**
 * Build a SecretFinding, honoring exactOptional `file`. Pattern findings get
 * `confidence: "high"`; fallback (unmapped rule → generic-high-entropy) gets
 * `"medium"` to match the entropy adapter's confidence band.
 */
const buildFinding = (
  kind: SecretKind,
  preview: string,
  line: number,
  column: number,
  file: string | undefined,
): SecretFinding => {
  const confidence: SecretFinding["confidence"] =
    kind === "generic-high-entropy" ? "medium" : "high"
  return file !== undefined
    ? { kind, file, line, column, preview, confidence }
    : { kind, line, column, preview, confidence }
}

interface ScanContext {
  readonly file: string | undefined
  readonly max: number
  readonly allow: ReadonlySet<string>
  readonly kinds: ReadonlySet<SecretKind> | null
  readonly config: SecretLintCoreConfig
}

const buildContext = (
  file: string | undefined,
  opts: SecretlintScannerOpts,
): ScanContext => ({
  file,
  max: opts.maxFindings ?? DEFAULT_MAX_FINDINGS,
  allow: new Set(opts.allowlist ?? []),
  kinds: opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null,
  config: opts.config ?? DEFAULT_SECRETLINT_CONFIG,
})

const sliceMatched = (text: string, range: readonly [number, number]): string => {
  const [start, end] = range
  if (start < 0 || end < start || end > text.length) return ""
  return text.slice(start, end)
}

const messageToFinding = (
  text: string,
  m: SecretLintCoreResultMessage,
  ctx: ScanContext,
): SecretFinding | null => {
  const matched = sliceMatched(text, m.range)
  if (ctx.allow.has(matched)) return null
  const kind = translate(m)
  if (ctx.kinds !== null && !ctx.kinds.has(kind)) return null
  // secretlint columns are 0-based per its types; our port is 1-based to
  // match `cat -n` / editor convention (see locate() in pattern-scanner.ts).
  // Add 1 so the same secret reports the same column across both adapters.
  return buildFinding(kind, mask(matched), m.loc.start.line, m.loc.start.column + 1, ctx.file)
}

const runSecretlint = async (
  text: string,
  ctx: ScanContext,
): Promise<SecretFinding[]> => {
  const result = await lintSource({
    source: {
      content: text,
      filePath: ctx.file ?? "<text>",
      contentType: "text",
    },
    options: {
      config: ctx.config,
      // We want messages from non-physical sources (in-memory blobs) to be
      // first-class — scanText is the dominant entry for tool callers.
      noPhysicFilePath: ctx.file === undefined,
    },
  })
  const findings: SecretFinding[] = []
  for (const m of result.messages) {
    if (findings.length >= ctx.max) break
    const f = messageToFinding(text, m, ctx)
    if (f !== null) findings.push(f)
  }
  return findings
}

/**
 * Construct a secretlint-backed SecretScanner. Returns a fresh instance per
 * call (no shared mutable state) so callers may hold per-context configs and
 * tests can run in parallel.
 *
 * Async surface: `scanText` returns `Promise<SecretFinding[]>` because the
 * underlying `lintSource` is async. The port's `scanText` signature is
 * `SecretFinding[]` (sync) — we deliberately keep this adapter on a promise
 * for honesty about the underlying I/O, and `index.ts` documents the seam
 * choice. Callers that need a strict sync `SecretScanner` should reach for
 * `patternScanner` / `compositeSecretScanner`.
 */
export const secretlintScanner = (
  opts: SecretlintScannerOpts = {},
): {
  scanText(text: string, scanOpts?: { file?: string }): Promise<SecretFinding[]>
  scanFile(path: string): Promise<SecretFinding[]>
} => ({
  async scanText(text, scanOpts) {
    return runSecretlint(text, buildContext(scanOpts?.file, opts))
  },
  async scanFile(path) {
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      // Binary / unreadable — match the documented contract of the sibling
      // pattern/entropy adapters: a pre-commit hook must not crash on a
      // stray PDF in the staging area.
      return []
    }
    return runSecretlint(text, buildContext(path, opts))
  },
})
