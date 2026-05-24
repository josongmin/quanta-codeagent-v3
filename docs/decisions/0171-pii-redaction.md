# ADR-0171: PII-redaction scanner — port + pattern + Luhn + composite

- Status: Accepted
- Date: 2026-05-25
- SOTA reference: Microsoft Presidio (Python; ML + recogniser composition;
  heavy runtime), AWS Comprehend PII (managed service; network), Datadog
  Sensitive Data Scanner (pattern + Luhn; closed-source), Cloudflare
  Logflare/Logpush PII redaction (regex-only; no checksum).
- Sibling slice: **ADR-0164 secret-detection** — `src/security/secret-detection/`.
  Closes the OTHER half of agent-edited-content safety: secrets (machine
  credentials — AWS keys, GitHub PATs, PEM blocks) live there; **human
  identifiers** (email, phone, SSN, credit-card, IP, IBAN, passport,
  driver's-license) live here. Same hexagonal shape, same default-OFF
  posture, same plane discipline.

## Context

ADR-0078 redaction is the inline data-plane mask: it scrubs **known secret
shapes** out of tool-result / envelope / memory-distill streams as they flow.
ADR-0164 added the out-of-band secret scanner for the OTHER class of
machine credential. Neither slice catches the human-identifier class:

1. **Transcript / jsonl leaks.** When the agent writes a turn envelope to
   `~/.quanta/sessions/*.jsonl`, the model's response can carry a customer's
   email, phone, or credit-card pulled from a tool result. The redaction
   slice doesn't see that — its inputs are the tool-result write seam, not
   the post-LLM transcript.
2. **Telemetry-sink leaks.** OTel attribute exporters (`codex.tool.*`,
   `quanta.turn.*`) regularly carry user-supplied strings. A PII redactor
   in front of the exporter is the documented mitigation.
3. **Prompt logger leaks.** A debug `--save-prompts` flag writes the raw
   prompt blob to disk; the model only sees redacted forms.

None of the absorbed agents (Codex, Claude Desktop, Cursor) ships a typed,
default-OFF PII scanner the agent loop can opt into. Codex's prompt logger
writes raw user input verbatim. Cursor's hooks document a generic
"redaction" hook but the regex catalog is proprietary and the validator
slot (Luhn / mod-97 IBAN) is absent.

A regex-only catalog is insufficient — the credit-card class has a ~16-digit
false-positive cloud (order IDs, hashed prefixes, phone concatenations).
Without a structural checksum the scanner emits high-FP noise that callers
eventually have to mute, defeating the purpose. **Luhn** is the documented
mod-10 check for IINs and reduces the FP rate to ~1-in-10 on random digits
— the only practical filter that doesn't need a network call.

## Decision

A new hexagonal slice under `src/security/pii-redaction/`:

```
port.ts                — PiiKind enum (10 closed kinds), PiiFinding,
                          PiiScanner port, PiiScannerOpts, DEFAULT_REDACTION_
                          TEMPLATES table, ALL_PII_KINDS closed set.
pattern-scanner.ts     — runPatterns(text, kinds, allow, templates) →
                          ordered catalog of 10 regex per PiiKind with
                          confidence high/medium/low pre-declared per kind.
luhn-validator.ts      — isLuhnValid(digits) — pure mod-10 check; caller
                          MUST strip non-digits first.
composite-scanner.ts   — compositePiiScanner({kinds, allowlist,
                          redactionTemplate}) → {scanText, redactText};
                          luhnFilter → dedupOverlaps (longest wins, ties →
                          lower start) → spliceRedactions (start-DESC).
index.ts               — barrel.
```

The port carries **10 closed `PiiKind` variants**: `email`, `phone-us`,
`phone-international`, `ssn-us`, `credit-card`, `ipv4`, `ipv6`, `iban`,
`passport-us`, `drivers-license-us`. Each kind ships with a
pre-declared confidence tier (high for deterministic structural signatures,
medium for stable-but-FP-prone shapes, low for jurisdiction-variable
formats). `DEFAULT_REDACTION_TEMPLATES` is typed `Readonly<Record<PiiKind,
string>>` so an unwired kind is a TS error at compile time.

### Default-OFF

Nothing in `src/agent/**`, `src/runner/**`, `src/tool/**`, `src/llm/**`,
`src/lsp/**`, `src/storage/**`, `src/runtime/**`, `src/mcp/**`,
`src/observability/**`, or any dispatch / loop seam imports
`src/security/pii-redaction/**`. The slice is dormant until a caller
(jsonl recorder, telemetry sink, prompt logger, a future `pii_scan` tool)
opts in. Same posture as ADR-0164 secret-detection, ADR-0163 Foundry
watcher, ADR-0136 OS-sandbox helper.

### Plane discipline

The slice imports **only TypeScript types from its own directory** — no
`@/shared`, no `@/permission`, no other quanta slice. Pure /
deterministic / no IO. Keeps the scanner portable to a Tauri sidecar,
worker thread, or standalone redaction binary (e.g. a CI gate run as a
single-file bun build).

### Two-stage filtering for credit-card

The pattern scanner emits **every** 13-19 digit run that matches the
catalog regex as a `credit-card` finding. The composite layer applies
`isLuhnValid(digitsOnly(raw))` and drops invalid hits. Rationale: keeping
the pattern adapter pure (regex-only) lets future variants (e.g. an
HSM-verified scanner that calls into a card-network API) substitute or
strengthen the validator without touching the regex catalog. This mirrors
ADR-0164's pattern/entropy split, but with **Luhn instead of entropy**
because credit-card numbers have a deterministic structural property —
entropy isn't useful for a uniformly distributed 16-digit number.

### Overlap resolution: longest wins, ties → lower start

Two patterns CAN match overlapping spans. The canonical example is the
IPv4-suffix form of IPv6 (`::ffff:192.168.1.1`) — the IPv6 regex covers
the whole 18-char span; the IPv4 regex covers the trailing 11 chars. The
composite layer sorts findings by `(start ASC, length DESC, kind ASC)`
and walks keep-first: the longer span is kept; on equal length, the lower
`start` (already first by sort) wins. Returned findings are sorted by
`start` ASC for stable downstream consumers.

### redactText splicing — start-DESC

`redactText` re-sorts findings by `start` DESC and splices each
replacement in-place. The replacement length CAN differ from the raw
length (`[EMAIL]` is 7 chars; a 32-char email shrinks to 7). Processing
DESC ensures earlier-in-text findings still have valid offsets when their
turn comes. Equivalent to one immutable `String.replaceAll`, but
offset-stable for any caller that wants to feed the output back into an
offset-aware tool.

### Allowlist strategy

The allowlist accepts **exact-string matches** (`ReadonlyArray<string>`),
not hashes. Mirrors ADR-0164's posture for three reasons:

- Caller already has the PII in plaintext (it's a fixture they're
  whitelisting). Hashing is zero security and forces a hash helper.
- Pattern matches are exact strings (post regex match). Both layers can
  use one `Set<string>.has(raw)` check — one code path, one mental model.
- Hash-based allowlists are useful when you want to commit a fixture
  *name* to git without its *value*. That's a non-breaking extension via
  a future `hashedAllowlist?:` slot.

### Per-kind confidence

The pattern catalog pre-declares confidence per kind. Rationale: callers
downstream of `scanText` (a CI gate, a UI badge, a `pii_scan` tool) want
to gate on confidence without re-implementing the SOTA prior knowledge.
Distribution:

- **HIGH** (6): email, phone-us, phone-international, ssn-us, credit-card
  (after Luhn), ipv4, ipv6. Deterministic structural signature.
- **MEDIUM** (2): iban, passport-us. Stable shape but FP-prone in prose
  (a 9-digit order number trips passport-us; IBAN-shaped tokens appear in
  bank reference numbers).
- **LOW** (1): drivers-license-us. State formats vary widely; the regex
  is a loose superset.

## Hellgate

`tests/unit/pii-redaction-hellgate.test.ts` — 33 cases / 91 expect calls.

- **A (15)** — pattern precision: email/high; phone-us dot+dash; phone-
  international `+1 415 555 1234`; ssn-us; IPv4; IPv6; IBAN/medium;
  passport-us/medium; multi-PII; clean text; allowlist; kinds-restrict;
  empty; 10K-char perf budget; finding.redacted ↔ DEFAULT_REDACTION_TEMPLATES.
- **B (7)** — Luhn validator: valid Visa 16-digit; Luhn-fail with one
  digit flipped; Amex 15-digit; Diners 14-digit; <13 digits → no finding;
  >19 digits → no finding; dashed-form Luhn round-trip (composite strips,
  validator passes).
- **C (5)** — redactText splicing: single email → `[EMAIL]`; custom
  template overrides default; multiple findings preserved with surrounding
  text intact; overlapping ranges (longest wins); placeholder-length
  differs from raw, positions still correct.
- **D (3)** — composite pipeline: pattern + Luhn match → credit-card/high;
  Luhn-invalid bypassed → no finding; mixed PII (email + phone + valid
  CC) all redacted.
- **E (2)** — allowlist: valid CC allowlisted → no finding (validator
  AND allowlist both pass); email allowlisted → no finding.
- **F (1)** — closed-set sanity: `ALL_PII_KINDS` matches
  `DEFAULT_REDACTION_TEMPLATES` keys.

## SOTA matrix

| Agent                       | PII patterns | Checksum (Luhn / mod-97) | Overlap resolution | Default-OFF seam | Hellgate |
|-----------------------------|--------------|--------------------------|--------------------|------------------|----------|
| Microsoft Presidio          | yes (ML + regex)  | yes               | yes                | n/a (library)    | n/a      |
| AWS Comprehend PII          | yes (managed)     | yes               | yes                | n/a (service)    | n/a      |
| Datadog SDS                 | yes (rule-based)  | yes               | partial            | n/a (service)    | n/a      |
| Cloudflare Logpush          | yes (regex-only)  | NO                | NO                 | n/a (service)    | n/a      |
| Codex / Claude Code         | NO                | NO                | NO                 | n/a              | n/a      |
| Cursor                      | proprietary       | unknown           | unknown            | unknown          | n/a      |
| **quanta** (this ADR)       | **10 kinds**      | **Luhn**          | **longest-wins**   | **yes**          | **33**   |

## Alternatives rejected

- **Adopt Presidio as a sidecar.** Presidio is Python; bundling a Python
  runtime adds ~60 MB to a Tauri sidecar and a process boundary to every
  redaction call. The recogniser composition API is also unsuitable for
  the "redact this 4-KB string in 1 ms" call shape — Presidio targets
  document-corpus scanning, not per-turn redaction in a hot path. A native
  TypeScript slice is faster, lighter, and ports to the same surfaces the
  rest of v3 ships to.
- **Patterns-only (no Luhn).** Credit-card pattern hits would emit the
  FP cloud described in the Context. Order IDs (typically 16-18 digits),
  phone concatenations, hash prefixes all trip the regex. Without Luhn
  the credit-card kind is effectively unusable in prose — callers would
  mute it and lose the real-card signal too.
- **Reversible tokenization (e.g. format-preserving encryption).**
  Tokenization is a different threat model: it preserves the ability to
  un-redact later (e.g. for a compliance audit). It requires a KMS, a
  rotated key, and a tokenization vault — operational complexity that
  doesn't belong in a default-OFF safety primitive. A future
  `reversibleRedaction.ts` adapter can sit alongside the current one
  behind a new `ReversiblePiiScanner` port. Out of scope for the first
  cut.
- **Locale-aware patterns (e.g. UK NIN, Japan My-Number, France
  INSEE).** The first cut catalogs only US-format SSN/passport/DL and
  international phone. Locale expansion is a Phase-2 task gated by a
  user request — adding 30 country patterns up front bloats the regex
  catalog and slows the scanner without a calibrated demand signal.
  The closed `PiiKind` union is the seam: a future `ssn-uk` /
  `mynumber-jp` variant is a non-breaking addition.
- **Single mega-regex.** A union of 10 patterns into one `RegExp` removes
  the per-kind classification — every match would have to be re-examined
  to know what it was. The closed `PiiKind` union + per-kind regex is
  the only shape that gives compile-time exhaustiveness AND per-match
  attribution at zero runtime cost.
- **Auto-redact at the call site (eager mutation).** Actuation belongs to
  the caller — a jsonl recorder may want to ABORT the write on critical
  findings; a telemetry sink may want to COUNT findings and replace; a
  `pii_scan` tool may want to RETURN findings to the model. The scanner
  detects + offers `redactText` as a convenience; it does NOT enforce.

## Follow-up

- **Tool exposure** — wire a `pii_scan` tool through the closed
  `defineTool` seam so the model can scan a hunk before committing it to
  a transcript or a tool output. The tool stays default-OFF until
  registered in `apps/*/dispatch.ts`.
- **Telemetry-sink integration** — opt-in adapter that wraps the OTel
  exporter with a `compositePiiScanner` redaction pass on string
  attributes. Behind a `--redact-telemetry` flag on the agent run.
- **Locale Phase 2** — add UK NIN, EU passport, Canadian SIN, JP
  My-Number when a calibrated demand signal arrives. The closed
  `PiiKind` union is the seam; the matcher catalog is the only file
  that has to grow.
- **Hash-based allowlist** — non-breaking extension via a future
  `hashedAllowlist?: ReadonlyArray<string>` slot. Useful for committing
  fixture *names* to git without their *values*.
- **Reversible tokenization adapter** — a separate `ReversiblePiiScanner`
  port + adapter for compliance-audit use cases. Sits alongside the
  current irreversible-mask scanner; not a replacement.
- **Streaming API** — current `scanText(string)` allocates the full
  finding array eagerly. A future `scanStream(AsyncIterable<string>)`
  for MB-scale inputs would switch the overlap-resolution algorithm
  from O(n²) intersection to a sweep-line.
