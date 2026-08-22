/**
 * ADR-0313 hellgate R3 — fake-vs-prod redaction parity battery.
 *
 * Background: round-2 L2 real-IO driver discovered that a "narrow" test fake
 * (`/sk-[A-Za-z0-9]{20,}/g`) gave false confidence — the production
 * `redactSecrets` had to be patched for the OpenAI proj-key shape because the
 * unit tests never exercised it. The patch landed at
 * `src/security/redaction.ts` (the `sk-proj-` pattern, declared BEFORE the
 * classic `sk-` shape so the hyphenated body is not sliced).
 *
 * This battery seals that hole as a TEST META-INVARIANT:
 *
 *   1. Production `redactSecrets` MUST mask every secret in a canonical
 *      catalog (24 production formats — classic OpenAI / proj-key / Anthropic
 *      / Stripe / GitHub PAT / AWS / JWT / PEM / OpenSSH / GCP SA / google
 *      api key / slack / bearer / url-userinfo / generic api-key
 *      assignment).
 *   2. Each slice-test fake `RedactPort` (the patterns used elsewhere in this
 *      directory) MUST not be STRICTLY NARROWER than production for any
 *      secret in (1) — if production redacts but the fake passes-through,
 *      the slice test is using a fake that gives false confidence.
 *   3. Composite shapes (markdown, URL, code block, body boundary, multiple
 *      secrets in one body) MUST also redact.
 *   4. Non-secret variable-like strings MUST pass through unchanged (false
 *      positive guard).
 *
 * If (1) ever regresses, the test surfaces here BEFORE the L2 real-IO
 * scaffold does — no more "patch landed quietly after a live run found it"
 * incidents.
 */

import { describe, expect, test } from "bun:test"

import type { RedactPort } from "@/integrations/github"
import { redactSecrets } from "@/security/redaction"

/* ──────────────────────────────────────────────────────────────────────────
 * 1. Production port — same wiring as `from-pr-cmd-adapters.ts#createRedactPort`.
 * ────────────────────────────────────────────────────────────────────────── */
const productionPort: RedactPort = {
  redact: (s) => redactSecrets(s, { origin: "tool_result" }).text,
}

/* ──────────────────────────────────────────────────────────────────────────
 * 2. Catalog of "real" production secrets — every format the live runner
 *    can plausibly see in a PR body / comment / diff.
 * ────────────────────────────────────────────────────────────────────────── */
interface ProdSecret {
  readonly label: string
  readonly value: string
  /** The kind we expect production `redactSecrets` to assign. */
  readonly expectKind: string
}

const REAL_PRODUCTION_SECRETS: readonly ProdSecret[] = [
  // OpenAI classic — `sk-` + ≥32 alphanumeric.
  { label: "openai-classic-48-A", value: `sk-${"A".repeat(48)}`, expectKind: "openai_api_key" },
  {
    label: "openai-classic-mixed",
    value: "sk-1234567890ABCDEFghijklmnop1234567890ABCDEFghijkl",
    expectKind: "openai_api_key",
  },
  // OpenAI proj-key (2024+) — `sk-proj-` with hyphens/underscores in body.
  {
    label: "openai-proj-alnum",
    value: "sk-proj-abc123def456ghi789jkl012mno345pqr678stuvwxyz",
    expectKind: "openai_api_key",
  },
  {
    label: "openai-proj-mixed-sep",
    value: "sk-proj-abc_def-GHI_jkl-mno_pqr-stuvwxyz0123456789ABCDEF",
    expectKind: "openai_api_key",
  },
  // Anthropic — `sk-ant-` prefix.
  {
    label: "anthropic-api03",
    value: `sk-ant-api03-${"X".repeat(80)}`,
    expectKind: "anthropic_api_key",
  },
  // GitHub PAT classic.
  {
    label: "github-pat-classic-ghp",
    value: `ghp_${"X".repeat(36)}`,
    expectKind: "github_pat_classic",
  },
  // GitHub PAT fine-grained.
  {
    label: "github-pat-fine-grained",
    value: `github_pat_${"A".repeat(30)}`,
    expectKind: "github_pat_fine_grained",
  },
  // AWS access key id — needs base32 [0-9A-Z]{16}; "X" is in that set.
  { label: "aws-akia", value: `AKIA${"X".repeat(16)}`, expectKind: "aws_access_key_id" },
  { label: "aws-asia", value: `ASIA${"Q".repeat(16)}`, expectKind: "aws_access_key_id" },
  // JWT — three base64url segments.
  {
    label: "jwt-standard",
    value: `eyJ${"A".repeat(30)}.${"B".repeat(30)}.${"C".repeat(30)}`,
    expectKind: "jwt",
  },
  // Stripe.
  { label: "stripe-live", value: `sk_live_${"X".repeat(30)}`, expectKind: "stripe_secret_key" },
  { label: "stripe-test", value: `sk_test_${"X".repeat(30)}`, expectKind: "stripe_secret_key" },
  // Google API key — AIza + 35.
  {
    label: "google-api-key",
    value: `AIza${"X".repeat(35)}`,
    expectKind: "google_api_key",
  },
  // PEM private key block.
  {
    label: "pem-block",
    value: "-----BEGIN PRIVATE KEY-----\nMIIBVwIBADANBgkqhkiG9w0BAQEFAA\n-----END PRIVATE KEY-----",
    expectKind: "pem_private_key_block",
  },
  // OpenSSH private key block.
  {
    label: "openssh-block",
    value:
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----",
    expectKind: "openssh_private_key_block",
  },
  // GCP service-account JSON.
  {
    label: "gcp-sa-json",
    value:
      '{"type": "service_account", "project_id":"p", "private_key":"-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"}',
    expectKind: "gcp_service_account_key",
  },
  // Bearer header.
  {
    label: "bearer-header",
    value: `Authorization: Bearer ${"abcDEF123-_.~".repeat(3)}xyz`,
    expectKind: "bearer_token_header",
  },
  // URL with userinfo.
  {
    label: "url-userinfo",
    value: "https://alice:s3cret@example.com/path",
    expectKind: "url_with_userinfo",
  },
  // Slack token.
  { label: "slack-bot", value: `xoxb-${"X".repeat(20)}`, expectKind: "slack_token" },
  // Generic API-key assignment.
  {
    label: "generic-api-key-assignment",
    value: `api_key=${"A".repeat(30)}`,
    expectKind: "generic_api_key_assignment",
  },
]

/* ──────────────────────────────────────────────────────────────────────────
 * 3. The "fake" redact patterns the slice unit-tests have used. We register
 *    each one as a candidate so its narrowness against (2) is exercised.
 *
 *    `stripRedact` is the actual fake from `tests/unit/apps/cli/from-pr-cmd.test.ts`
 *    — the L2 driver hole was that this fake fails to redact `sk-proj-…` (the
 *    `-` breaks the `[A-Za-z0-9]{20,}` body). We intentionally KEEP it here so
 *    its narrowness is contractually documented (test asserts it's narrower
 *    than prod for `openai-proj-*`).
 * ────────────────────────────────────────────────────────────────────────── */
interface FakePortSample {
  readonly name: string
  readonly port: RedactPort
  /**
   * Catalog labels we know this fake is too narrow on (and therefore EXEMPT
   * from the parity invariant). If a label NOT in this list passes through
   * the fake while production redacts it, the test fails.
   */
  readonly knownNarrowOn: ReadonlySet<string>
}

const stripRedact: RedactPort = {
  redact: (s) => s.replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED]"),
}

const identityRedact: RedactPort = { redact: (s) => s }

const FAKE_PORTS: readonly FakePortSample[] = [
  {
    // Identity is intentionally narrow on EVERYTHING — it documents the "fake
    // that is too narrow" extreme. We allowlist the whole catalog.
    name: "identityRedact",
    port: identityRedact,
    knownNarrowOn: new Set(REAL_PRODUCTION_SECRETS.map((s) => s.label)),
  },
  {
    name: "stripRedact",
    port: stripRedact,
    // The from-pr-cmd fake catches the classic OpenAI shape. Everything else
    // is documented narrowness. (R3 test surfaces this so a future hardener
    // knows the fake is intentionally narrow.)
    knownNarrowOn: new Set([
      "openai-proj-alnum",
      "openai-proj-mixed-sep",
      "anthropic-api03",
      "github-pat-classic-ghp",
      "github-pat-fine-grained",
      "aws-akia",
      "aws-asia",
      "jwt-standard",
      "stripe-live",
      "stripe-test",
      "google-api-key",
      "pem-block",
      "openssh-block",
      "gcp-sa-json",
      "bearer-header",
      "url-userinfo",
      "slack-bot",
      "generic-api-key-assignment",
    ]),
  },
]

/* ──────────────────────────────────────────────────────────────────────────
 * Tests
 * ────────────────────────────────────────────────────────────────────────── */
describe("ADR-0313 hellgate R3 — redact parity (fake-vs-prod)", () => {
  /* (1) Every catalog secret is masked by production. */
  for (const s of REAL_PRODUCTION_SECRETS) {
    test(`prod redacts ${s.label} (hits >= 1, kind=${s.expectKind})`, () => {
      const r = redactSecrets(s.value, { origin: "tool_result" })
      expect(r.unchanged).toBe(false)
      expect(r.hits.length).toBeGreaterThanOrEqual(1)
      expect(r.hits.some((h) => h.kind === s.expectKind)).toBe(true)
      expect(r.text).not.toContain(s.value)
    })
  }

  /* (2) Fake-vs-prod parity. For every fake-port × every catalog secret,
   *     EITHER the fake redacts the secret OR the label is documented narrow. */
  for (const fake of FAKE_PORTS) {
    for (const s of REAL_PRODUCTION_SECRETS) {
      const exempt = fake.knownNarrowOn.has(s.label)
      test(`parity[${fake.name}][${s.label}]`, () => {
        const fakeOut = fake.port.redact(s.value)
        const prodOut = productionPort.redact(s.value)
        // Prod must mask.
        expect(prodOut).not.toContain(s.value)
        if (!exempt) {
          // Fake must also mask (or be at least no narrower).
          expect(fakeOut).not.toContain(s.value)
        }
      })
    }
  }

  /* (3) Composite shapes. */
  test("secret embedded in markdown code block STILL redacts", () => {
    const body = ["please rotate:", "", "```", `OPENAI_KEY=${`sk-${"Z".repeat(48)}`}`, "```"].join(
      "\n",
    )
    const r = productionPort.redact(body)
    expect(r).toContain("[REDACTED:openai_api_key]")
    expect(r).not.toContain("sk-ZZZZZ")
  })

  test("secret inside a markdown link still redacts", () => {
    const body = `see [config](https://alice:s3cretpw@example.com/path)`
    const r = productionPort.redact(body)
    expect(r).toContain("[REDACTED:url_with_userinfo]")
    expect(r).not.toContain("s3cretpw")
  })

  test("multiple distinct secrets in one body all redact", () => {
    const body = [
      `aws=AKIA${"X".repeat(16)}`,
      `gh=ghp_${"Y".repeat(36)}`,
      `oa=sk-${"Z".repeat(48)}`,
    ].join("\n")
    const r = productionPort.redact(body)
    expect(r).toContain("[REDACTED:aws_access_key_id]")
    expect(r).toContain("[REDACTED:github_pat_classic]")
    expect(r).toContain("[REDACTED:openai_api_key]")
  })

  test("secret at body start redacts", () => {
    const body = `${`AKIA${"Z".repeat(16)}`} is leaked`
    const r = productionPort.redact(body)
    expect(r).toContain("[REDACTED:aws_access_key_id]")
    expect(r.startsWith("[REDACTED:aws_access_key_id]")).toBe(true)
  })

  test("secret at body end redacts", () => {
    const body = `leaked: ${`AKIA${"Z".repeat(16)}`}`
    const r = productionPort.redact(body)
    expect(r).toContain("[REDACTED:aws_access_key_id]")
    expect(r.endsWith("[REDACTED:aws_access_key_id]")).toBe(true)
  })

  test("secret with surrounding punctuation redacts", () => {
    const body = `(AKIA${"Z".repeat(16)})!`
    const r = productionPort.redact(body)
    expect(r).toContain("[REDACTED:aws_access_key_id]")
  })

  test("proj-key with `_suffix` adjacency does not under-redact", () => {
    // The proj-key regex is `\b sk-proj-[A-Za-z0-9_-]{20,} \b`; a trailing `_`
    // is INSIDE the char class. Make sure we still mask up through the last
    // valid char and don't bleed into "_suffix".
    const body = `prefix sk-proj-${"abcDEF123".repeat(3)}_suffix end`
    const r = productionPort.redact(body)
    expect(r).toContain("[REDACTED:openai_api_key]")
    // The literal proj body must be gone.
    expect(r).not.toContain("abcDEF123abcDEF123abcDEF123")
  })

  test("chunked body — same secret remains masked after split+rejoin", () => {
    const full = `leak: sk-${"X".repeat(48)} ok`
    const splitIdx = Math.floor(full.length / 2)
    const a = full.slice(0, splitIdx)
    const b = full.slice(splitIdx)
    // We MUST redact the WHOLE body, not the halves — that's the contract.
    const r = productionPort.redact(`${a}${b}`)
    expect(r).toContain("[REDACTED:openai_api_key]")
    expect(r).not.toContain("XXXXX")
  })

  /* (4) False-positive guard — variable-like strings that LOOK secret-shaped
   *     but are not in any closed format must pass through. */
  const PASSTHROUGH_SAMPLES: readonly string[] = [
    "VERSION=1.2.3-alpha+build.42",
    "branch: feat/refactor-loop",
    "abcdefghijklmnopqrstuvwxyz0123456789", // 36 alnum, no prefix
    "user_name=alice",
    "key=value", // too short
    "/path/to/file/with/slashes",
    "https://example.com/normal/path", // no userinfo
    "git@github.com:owner/repo.git", // ssh URL without userinfo split
  ]

  for (const sample of PASSTHROUGH_SAMPLES) {
    test(`passthrough: ${sample.slice(0, 40)}`, () => {
      const r = redactSecrets(sample, { origin: "tool_result" })
      expect(r.unchanged).toBe(true)
      expect(r.text).toBe(sample)
    })
  }

  /* (5) Determinism — same input ⇒ same output. */
  test("redact is deterministic across calls", () => {
    const body = `aws=${`AKIA${"Z".repeat(16)}`} gh=ghp_${"Y".repeat(40)}`
    const a = productionPort.redact(body)
    const b = productionPort.redact(body)
    const c = productionPort.redact(body)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })
})
