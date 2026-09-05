# SEP5-03 — secret detector three-plane parity

**Priority:** P1
**Status:** PLANNED
**Depends on:** SEP5-00
**Finding coverage:** D1

## Goal

Every high-value named secret shape covered by either redactor must also be
detected by the production composite scanner without relying on entropy. Preserve
the distinct output contracts of redaction hits, boolean trajectory masking, and
scanner findings.

## Current failure

The existing parity test covers `redactValue` and `redactSecrets` only.
`pattern-scanner.ts` lacks named patterns for GitLab PAT, JWT, OpenAI
service-account keys, bearer headers, and URL userinfo. Composite entropy catches
some fabricated examples as `generic-high-entropy`, but URL userinfo is a current
false negative and entropy behavior changes with thresholds/allowlists.

## Design

Use a test-contract corpus as the behavioral SSOT first:

```ts
export interface SecretShapeCase {
  readonly label: string
  readonly sample: string
  readonly scannerKind: SecretKind
  readonly redactionKind?: RedactionKind
}

export const HIGH_VALUE_SECRET_SHAPES: readonly SecretShapeCase[] = [
  // fabricated provider-shaped values only; never live credentials
]
```

Do not immediately force all three production implementations to consume one
regex table. Their match span, ordering, classification, and false-positive
contracts differ. The first structural requirement is behavioral parity with a
named signature finding, not byte-identical regex source.

## Write set

| File | Change |
|---|---|
| `src/security/secret-detection/pattern-scanner.ts` | Add missing named signatures and stable `SecretKind` mappings |
| `src/security/secret-detection/port.ts` | Extend the closed kind union only where a distinct operational kind is required |
| `tests/_support/secret-shape-corpus.ts` | New fabricated corpus shared by security tests |
| `tests/unit/redaction-parity-hellgate.test.ts` | Consume the corpus for both redactors |
| `tests/unit/secret-detection-hellgate.test.ts` | Require pattern and composite named findings for every case |
| `tests/unit/secret-sink-parity-hellgate.test.ts` | New three-plane matrix, threshold/allowlist and negative controls |

If existing test support cannot be imported cleanly, place the corpus under a
test-only security support directory. Do not put fabricated fixtures in runtime
exports.

## Required signatures

- GitLab `glpat-...`
- JWT with bounded three base64url segments beginning `eyJ`
- OpenAI `sk-svcacct-...`
- full `Authorization: Bearer ...` header
- URL with explicit `scheme://user:password@host`
- all existing AWS/GitHub/Google/Anthropic/Stripe/OpenAI/Slack/PEM/GCP cases

Keep patterns ordered from structurally specific to generic. Bound all repeated
classes and avoid nested catastrophic backtracking.

## RED rails

1. URL userinfo currently produces zero composite findings.
2. Raising entropy threshold must not remove a named provider finding.
3. Adding the sample to scanner allowlist must exercise documented allowlist
   semantics explicitly; it must not accidentally prove pattern absence.
4. Benign URLs without passwords, dotted identifiers, UUIDs, hashes, public
   keys, and the word `Bearer` alone remain clean.
5. Removing any one signature fails exactly its corpus row.
6. The corpus has a minimum known-case floor so an empty import cannot pass.

## Test and ratchet implementation

- Grow `HIGH_VALUE_SECRET_SHAPES` to at least 17 rows. Each row declares the
  exact expected named scanner kind; `generic-high-entropy` is never accepted as
  parity for a provider-shaped row.
- For every row, assert `redactValue(sample) !== sample`,
  `redactSecrets(sample) !== sample`, the pattern scanner returns the declared
  kind, and `compositeSecretScanner({ entropyThreshold: Infinity })` returns the
  same named kind.
- Add at least eight benign rows: passwordless URL, dotted identifier, UUID,
  hex hash, public-key label, bare `Bearer`, ordinary email, and short token.
  Assert zero pattern/composite findings and unchanged redaction.
- Implement the signature table validator as a pure test helper. Clone the
  table, remove each signature one at a time, and require that exactly its
  declared corpus row becomes uncovered. Assert the corpus and signature-table
  floors before looping.
- Mutation control: delete URL-userinfo or service-account signature from the
  runtime table while leaving its kind/import intact. The corresponding row
  must fail with zero named findings. A failure caused only by entropy settings
  is invalid proof.
- Keep allowlist behavior in a separate table: document whether an allowlisted
  full match suppresses the composite result, while the raw pattern-scanner
  assertion continues to prove the signature exists.

## Reachability boundary

`compositeSecretScanner()` is used by `check_secrets` and plaintext HTTP egress.
HTTPS CONNECT remains opaque without TLS MITM; this ticket must not claim HTTPS
body/header coverage.

## Proof rails

```sh
bun test tests/unit/redaction-parity-hellgate.test.ts
bun test tests/unit/secret-detection-hellgate.test.ts
bun test tests/unit/secret-sink-parity-hellgate.test.ts
bun test tests/integration/header-rewrite-proxy-e2e.test.ts
bun run typecheck
bun run lint:debt
```

## Definition of done

- Every corpus secret is redacted by both redactors.
- Every corpus secret is detected by the pattern scanner with its named kind.
- Composite detection remains green when entropy is effectively disabled.
- Negative controls and max-finding behavior remain green.
- Documentation explicitly retains the plaintext-only egress limitation.

## Stop conditions

- A proposed shared table changes masking spans or match priority silently.
- A new regex causes unbounded backtracking or material false positives.
- A test passes only because entropy catches the fixture.
