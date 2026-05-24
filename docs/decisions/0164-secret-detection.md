# ADR-0164: Secret-detection scanner — port + pattern + entropy + composite

- Status: Accepted
- Date: 2026-05-24
- SOTA reference: git-secrets (AWS official; pattern-based), trufflehog
  (entropy + optional vendor verification), GitHub secret scanning
  (signature-only against partner-issued tokens).
- Sibling slice: ADR-0078 redaction (Layer-2 inline mask for tool-result /
  envelope / memory-distill streams). This ADR is the **out-of-band** scanner
  consumed by a future pre-commit hook / `secret_scan` tool, not the runtime
  redactor.

## Context

The redaction slice (ADR-0078) masks secrets inline on the live data planes
(tool results, jsonl envelopes, memory distill). It is intentionally limited
to deterministic format regex against KNOWN secret shapes — perfect for
"never let a secret reach the model or disk" but unsuitable for two adjacent
threats:

1. **Pre-commit cred leak.** When the agent edits a file (an `apply_patch`,
   a `write` tool, an `lsp` workspace edit), the resulting diff may carry a
   hardcoded AWS key the model invented as a placeholder. The redactor does
   not see this — its inputs are tool results / envelope writes, not the
   target file's post-edit contents. Without an out-of-band scanner the agent
   can commit `AKIA…` straight into git.
2. **Novel secret formats.** Pure regex misses internal-vendor keys whose
   prefix we haven't catalogued. trufflehog handles this with a Shannon
   entropy detector; git-secrets does not (pattern-only). We want both
   signals + a clean way to dedup.

Neither v3 nor any of the absorbed agents (Codex, Claude Desktop, Cursor)
exposes a typed, default-OFF secret scanner the agent loop can opt into.
Cursor's "secret-detection" reference in its hooks catalog is proprietary
and the signal shape is unknown.

## Decision

A new hexagonal slice under `src/security/secret-detection/`:

```
port.ts                — SecretKind enum, SecretFinding, SecretScanner port,
                          defaults (max 100, threshold 4.5 b/c, minLen 20),
                          mask() helper.
pattern-scanner.ts     — closed-set regex catalog → confidence "high".
entropy-scanner.ts     — Shannon entropy + structural skip → confidence "medium".
composite-scanner.ts   — runs both, dedups same (file, line, column) cells
                          with pattern winning; returns sorted findings.
index.ts               — barrel.
```

The port carries 11 closed `SecretKind` variants (AWS access/secret, OpenAI,
Anthropic, GitHub, Google, GCP service-account, Slack, Stripe, PEM private-
key block, generic-high-entropy). Adding a kind without a matcher is a
compile-time TS error via the `Exclude<SecretKind, "generic-high-entropy">`
pattern catalog type.

### Default-OFF

Nothing in `src/agent/**`, `src/runner/**`, `src/tool/**`, or any dispatch
seam imports `src/security/secret-detection/**`. The slice is dormant until
a caller (a future `secret_scan` tool, a CI gate, a git pre-commit hook)
opts in. The same posture as ADR-0163 Foundry watcher and ADR-0136 OS-sandbox
helper — a security primitive shipped behind a single point of integration
the operator owns.

### Plane discipline

The slice imports ONLY `node:fs/promises` (for `scanFile`) and the closed
set of TypeScript types from its own `port.ts`. No `@/shared`, no
`@/permission`, no other quanta slice — keeps the scanner portable to a
Tauri sidecar / worker thread / standalone CI binary.

### Entropy tuning rationale

The 4.5 bits/char threshold mirrors the trufflehog "base64 detector" cut-
off. Three calibration points:

- **English prose** ≈ 3.0 b/c (well below threshold — no FP on docstrings).
- **Hex SHA-256** ≈ 4.0 b/c on the 16-symbol alphabet (would fire — caught
  by the structural-skip filter instead, see below).
- **40-char uniform base64** ≈ 5.5–6.0 b/c (firmly above threshold).

The structural-skip filter drops any token of exact length 32/40/64/128
that is pure hex (MD5/SHA1/SHA256/SHA512) plus the canonical 8-4-4-4-12
UUID shape. This kills the dominant FP class without resorting to a higher
threshold that would also miss real 40-char base64 secrets. A 33-char hex
string IS reported — operators who hash-prefix tokens for reference cards
deliberately get the entropy warning.

### Composite dedup

Pattern findings populate a `(file, line, column)` map first; entropy
findings only insert when the cell is empty. This preserves the precision
guarantee — a known-format secret (AWS, GitHub PAT) never shows up as
`generic-high-entropy` just because both adapters caught it.

Findings are returned sorted by `(file, line, column)` for stable rendering
in CLI output, PR threads, and JSON dumps.

### Allowlist strategy

The allowlist accepts **exact-string matches** (a `ReadonlyArray<string>`),
not hashes. Three reasons:

- Caller already has the secret in plaintext (it's the value they want to
  whitelist as a fixture). Hashing it adds zero security and forces every
  caller to ship a hash helper.
- Pattern matches are exact strings (post regex match); entropy tokens are
  exact strings (post tokenize). Both adapters can use the same
  `Set<string>.has()` check — one code path, one mental model.
- Hash-based allowlists (the trufflehog approach) are useful when you
  WANT to commit the secret name to git without committing the value.
  That's a follow-up — a `hashedAllowlist?: ReadonlyArray<string>` slot
  is a non-breaking extension.

### Mask helper

`mask("AKIAIOSFODNN7EXAMPLE")` → `"AKIA***MPLE"`. Long secrets keep first-4
+ last-4 for triage; short secrets (< 8 chars) become all stars to avoid
revealing the whole value when the prefix would already give it away;
empty returns empty. Pure / deterministic / no allocation surprises.

## Hellgate

`tests/unit/secret-detection-hellgate.test.ts` — 34 cases / 63 expect calls.

- **A (12)** — pattern precision: AWS / OpenAI / Anthropic (NOT openai) /
  GitHub / Google / GCP-JSON / Slack / Stripe / PEM block detected with
  high confidence; English "password" word NOT detected; empty / clean
  text returns `[]`; multiple secrets in one blob yield multiple findings.
- **B (3)** — mask helper: long secret masked first4+***+last4; short < 8
  chars all-stars; empty empty.
- **C (7)** — entropy: 40-char b64 fires medium; SHA256 / UUID skipped;
  low-entropy and short tokens dropped; threshold override + minSecretLength
  override respected.
- **D (4)** — composite: AWS alone yields ONE finding (pattern wins);
  GitHub PAT at L1 stays high-confidence even though entropy also fires;
  pattern-L1 + entropy-L5 BOTH preserved; allowlist drops both adapter
  paths.
- **E (4)** — `scanFile`: real file with AWS key carries the `file` field;
  clean file returns `[]`; missing file returns `[]` (decode-fail
  tolerance); binary-ish bytes return an array without throwing.
- **F (3)** — `maxFindings` cap: 200 GitHub tokens + cap 10 → 10 returned;
  default cap of 100 honored; `shannonEntropyBits` sanity (empty=0,
  repeated=0, 4-distinct-equal ≈ 2 b/c).

## SOTA matrix

| Agent                  | Pattern catalog | Entropy detector | Structural skip | Default-OFF seam | Hellgate |
|------------------------|-----------------|------------------|-----------------|------------------|---------|
| git-secrets (AWS)      | yes (AWS-only)  | NO               | NO              | n/a (CLI)        | n/a     |
| trufflehog             | yes (300+)      | yes              | partial         | n/a (CLI)        | n/a     |
| GitHub secret scanning | yes (partner)   | NO               | NO              | n/a (service)    | n/a     |
| Cursor                 | proprietary     | unknown          | unknown         | unknown          | n/a     |
| Codex / Claude Code    | NO              | NO               | NO              | n/a              | n/a     |
| **quanta** (this ADR)  | **11 kinds**    | **yes (4.5 b/c)**| **SHA + UUID**  | **yes**          | **34**  |

## Alternatives rejected

- **Single mega-regex.** A union of 11 patterns into one `RegExp` would
  remove the per-kind classification — every match would have to be re-
  examined to know what it was. The closed `SecretKind` union + per-kind
  regex is the only shape that gives compile-time exhaustiveness AND
  per-match attribution at zero runtime cost.
- **Entropy-only.** Drops false-positive precision on hex hashes, UUIDs,
  and dense base64 data. The pattern catalog is the only thing that lets
  the scanner say "this is an AWS key" rather than "this is a high-entropy
  string". Both halves are required.
- **Pattern-only.** Misses novel internal-vendor key formats whose prefix
  we haven't catalogued. Entropy adapter is the catch-net.
- **Network verification (call AWS / GCP to check if the key is live).**
  trufflehog's "verifiers" feature. Privacy violation — the caller's
  secrets would be sent to the very vendor whose key was about to leak,
  often from a CI runner the caller does not own. Signal-only is the safe
  primitive; verification is a follow-up the operator can layer on top.
- **Auto-fix (replace match with `[REDACTED]`).** Actuation belongs to the
  caller — a pre-commit hook may want to ABORT the commit; a CI gate may
  want to OPEN A REVIEW; a `secret_scan` tool may want to RETURN findings
  to the model. The scanner detects; it does not mutate.
- **Hash-based allowlist as the only allowlist shape.** Forces every
  caller to wrap a hash helper for fixture tokens they already have in
  plaintext. Exact-string allowlist is the minimum; hash-based is a
  non-breaking extension via a future `hashedAllowlist?:` slot.

## Follow-up

- Tool exposure — wire a `secret_scan` tool through the closed
  `defineTool` seam so the model can scan a hunk before committing. The
  tool stays default-OFF until registered in `apps/*/dispatch.ts`.
- Pre-commit hook integration — a `quanta secret-scan --staged` CLI
  subcommand walking `git diff --cached --name-only`, feeding each path
  to `compositeSecretScanner.scanFile`. Behind a `--check-secrets` flag
  on `verify`.
- Vendor verification — opt-in, privacy-aware. A second adapter
  (`verified-secret-scanner.ts`) accepting a `verify(kind, secret)` port
  the operator wires to their own credentials proxy. Default-OFF, never
  ships network calls without explicit consent.
- Per-language tokenizer — entropy adapter currently splits on a fixed
  delimiter set. A TS-aware tokenizer could tighten false-positives on
  template literals; deferred until a real-world false-positive count
  justifies the complexity.
