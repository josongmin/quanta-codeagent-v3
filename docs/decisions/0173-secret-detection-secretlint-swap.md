# ADR-0173: Secret-detection — swap internals to secretlint

- Status: Accepted (supersedes ADR-0164 internals; pattern + entropy adapters
  retained as zero-dep fallbacks)
- Date: 2026-05-25
- Related: ADR-0164 (original hand-rolled pattern + entropy + composite slice)
- SOTA reference: `secretlint` (Sider AI; canonical JS-world secret scanner)
  + `@secretlint/secretlint-rule-preset-recommend` (13+ vendor-maintained
  rules: aws / anthropic / openai / gcp / github / gitlab / slack / stripe /
  privatekey / cloudflare / docker / figma / databricks / hashicorp-vault /
  huggingface / linear / notion / npm / shopify / sendgrid / tailscale /
  vercel / database-connection-string / 1password / grafana / groq /
  basicauth / filter-comments).

## Context

ADR-0164 shipped a self-implemented secret-detection slice: 10 regex patterns
+ Shannon entropy + composite dedup, ~600 LOC, hand-tuned against trufflehog
and git-secrets references. Every kind addition requires a new regex, a
matching test, and ongoing maintenance against vendor key-format drift.

`secretlint` is the JS-world canonical alternative — active maintenance, a
recommended preset that ships 13+ vendor-maintained rules (covering 9 of our
10 typed kinds out of the box), structured `messages[]` carrying `ruleId`,
`messageId`, `loc.start.{line, column}`, `range`, and false-positive
resistance baked in (it rejects AWS docs' "EXAMPLE" tokens, demands the
PKCS-magic-byte prefix `MI` for PEM blocks, and requires the literal
`T3BlbkFJ` marker — base64 of "OpenAI" — for OpenAI keys).

User principle: "외부에 잘 만들어진 거 있으면 외부 거 써."

The cost of adoption is one translation table from secretlint's
`(ruleId, messageId)` to our closed `SecretKind` union — ~150 LOC of adapter
code wrapping ~80% of our previous rule surface for free.

## Decision

A NEW `secretlintScanner` adapter in `src/security/secret-detection/
secretlint-scanner.ts` that:

1. Calls `lintSource` from `@secretlint/core` with the recommended preset,
   plus `enableIDScanRule: true` on the AWS rule so `AKIA…` access-key IDs
   are reported (the preset's default is OFF to favor secret-key precision;
   for a pre-commit hook we want both signals).
2. Translates each `LintResult.messages[i]` via a `(ruleId, messageId) →
   SecretKind` map. Unmapped rules (cloudflare, docker, figma, …) degrade
   gracefully to `generic-high-entropy` with `confidence: "medium"` —
   preserves the signal without breaking the closed `SecretKind` union.
3. Honors the same `allowlist` / `maxFindings` / `kinds` filter the sibling
   adapters expose, and emits identically-shaped `SecretFinding` records.
4. Wires `ext` from the file path into the secretlint `source` so rules that
   gate on extension (notably the GCP rule, which only fires for `.json` and
   `.p12` files) work uniformly across `scanText` (no path) and `scanFile`.
5. Returns `Promise<SecretFinding[]>` from `scanText` — `lintSource` is
   async, and we keep that honesty rather than fake a sync facade. Strict-
   sync callers should reach for `patternScanner` /
   `compositeSecretScanner`, which we keep shipped.

Sibling files (`port.ts`, `pattern-scanner.ts`, `entropy-scanner.ts`,
`composite-scanner.ts`) are NOT touched. The barrel re-exports the new
adapter alongside the existing ones; callers pick.

### Coverage of the typed `SecretKind` union

| SecretKind            | Mapped secretlint rule                                          |
|-----------------------|-----------------------------------------------------------------|
| `aws-access-key`      | `@secretlint/secretlint-rule-aws` / `AWSAccessKeyID`            |
| `aws-secret-key`      | `@secretlint/secretlint-rule-aws` / `AWSSecretAccessKey`        |
| `openai-api-key`      | `@secretlint/secretlint-rule-openai` / `OPENAI_TOKEN`           |
| `anthropic-api-key`   | `@secretlint/secretlint-rule-anthropic` / `ANTHROPIC_API_KEY`   |
| `github-token`        | `@secretlint/secretlint-rule-github` / `GITHUB_TOKEN`           |
| `google-api-key`      | NOT in recommended preset → falls through to generic-high-entropy |
| `gcp-service-account` | `@secretlint/secretlint-rule-gcp` / `PrivateKeyJSON|P12`        |
| `slack-token`         | `@secretlint/secretlint-rule-slack` / `SLACK_TOKEN`             |
| `stripe-key`          | `@secretlint/secretlint-rule-stripe` / `STRIPE_*` (4 variants)  |
| `private-key-block`   | `@secretlint/secretlint-rule-privatekey` / `PrivateKey`         |
| `generic-high-entropy`| native: unmapped secretlint rules + fallback for ALL other findings |

9 of our 10 enumerated kinds are covered by the recommended preset directly.
`google-api-key` (`AIza…`) is not in the recommended preset; callers needing
it should layer the `compositeSecretScanner` (which retains the `AIza…`
pattern from ADR-0164) on top of the secretlint scan, OR install
`@secretlint/secretlint-rule-google-api-key` separately (follow-up).

### Default-OFF posture preserved

No production code path imports `src/security/secret-detection/**`. The
slice remains dormant until a caller (a future `secret_scan` tool, a CI
gate, a git pre-commit hook) opts in. Same posture as ADR-0164.

### Plane discipline preserved

The new adapter imports ONLY `@secretlint/core`,
`@secretlint/secretlint-rule-preset-recommend`, `@secretlint/types`,
`node:fs/promises`, and `node:path`. No other quanta slice — keeps the
scanner portable to a Tauri sidecar / worker thread / standalone CI binary.

### Backward compatibility

Public surface of the barrel (`src/security/secret-detection/index.ts`) is
strictly additive: `secretlintScanner` and `SecretlintScannerOpts` and
`DEFAULT_SECRETLINT_CONFIG` are NEW exports. All ADR-0164 exports
(`patternScanner`, `entropyScanner`, `compositeSecretScanner`,
`shannonEntropyBits`, `mask`, defaults, types) remain exported with
identical signatures and behavior. Hellgate from ADR-0164 (34 cases) still
runs green.

## Alternatives rejected

- **trufflehog (Go binary).** Requires installing an external binary,
  breaks bun-only environments and Tauri sidecar portability, and adds an
  out-of-process IPC surface to redact.
- **gitleaks (Go binary).** Same out-of-process objection; same Apple-
  Silicon vs x86 install surface as trufflehog.
- **detect-secrets (Python).** Language mismatch — the agent runs on bun;
  shelling out to a Python process for every staged hunk is unacceptable
  latency.
- **Remove the existing pattern/entropy adapters entirely.** Breaks zero-
  dep / strict-sync callers and would force every caller to wear a promise.
  Keep both: secretlint as the recommended path, hand-roll as fallback.
- **Replace the port with secretlint's native `SecretLintCoreResult`
  shape.** Couples every caller to a vendor type; defeats the hexagonal
  seam we shipped in ADR-0164.
- **Mega-regex of all secretlint patterns extracted.** Would freeze the
  rule set at one snapshot; defeats the "active maintenance" reason for
  the swap.

## SOTA realignment

SAME tier as ADR-0164. We already led on the agent-callable, default-OFF,
typed-port surface; only the backend implementation swaps from a hand-roll
to a vendored library. The translation table is the only new code; the
public contract is byte-identical.

## Hellgate

`tests/unit/secret-detection-secretlint-hellgate.test.ts` — 16 cases / 26
expect calls.

- **A (4)** — adapter parity with port: instance shape; AWS finding kind +
  mask preview; empty input → `[]`; scanFile carries `file` field +
  1-indexed line/column.
- **B (8)** — translation table: AWS access / AWS secret / GCP JSON / OpenAI
  / Anthropic / GitHub / PEM private-key / Stripe — each fires the right
  typed kind with `confidence: "high"`.
- **C (3)** — options: allowlist drops exact-string match; `maxFindings`
  cap respected; `kinds` filter restricts to requested kinds only.
- **D (1)** — `DEFAULT_SECRETLINT_CONFIG` enables AWS ID scan rule (so
  `AKIA…` is actually reported by default).

Existing ADR-0164 hellgate (34 cases) continues to pass unchanged — 50/50
in the combined run.

## Follow-up

- Pluggable rule preset (strict / recommended / loose). Today the adapter
  hard-codes recommended-with-AWS-IDs-enabled; expose a knob for callers
  that want a tighter or looser default.
- Secretlint custom rule for project-specific patterns (vendor keys we
  haven't catalogued yet). Compose with the recommended preset rather than
  replacing it.
- Install `@secretlint/secretlint-rule-google-api-key` (if it exists) or
  add a tiny custom secretlint rule for `AIza…` so `google-api-key`
  coverage moves out of the fallback bucket.
- Wire `secret_scan` tool through `defineTool` so the model can scan a
  hunk before committing (deferred per ADR-0164).
- Pre-commit hook integration — `quanta secret-scan --staged` walking
  `git diff --cached --name-only` and feeding each path to
  `secretlintScanner.scanFile`.
