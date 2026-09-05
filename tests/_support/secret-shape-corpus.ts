/**
 * Fabricated high-value secret shapes shared by redaction and scanner tests.
 * Never live credentials. `generic-high-entropy` is never a valid scannerKind.
 */
import type { RedactionKind } from "@/security/redaction"
import type { SecretKind } from "@/security/secret-detection/port"

export interface SecretShapeCase {
  readonly label: string
  readonly sample: string
  readonly scannerKind: Exclude<SecretKind, "generic-high-entropy">
  readonly redactionKind?: RedactionKind
}

export const HIGH_VALUE_SECRET_SHAPES: readonly SecretShapeCase[] = [
  {
    label: "stripe-live",
    sample: "sk_live_51H8xQ2eZvKYlo2C0abcdefghij",
    scannerKind: "stripe-key",
    redactionKind: "stripe_secret_key",
  },
  {
    label: "stripe-restricted",
    sample: "rk_live_51H8xQ2eZvKYlo2C0klmnopqrst",
    scannerKind: "stripe-key",
    redactionKind: "stripe_secret_key",
  },
  {
    label: "openai-proj",
    sample: "sk-proj-abcdEFGH1234ijklMNOP5678qrst",
    scannerKind: "openai-api-key",
    redactionKind: "openai_api_key",
  },
  {
    label: "openai-svcacct",
    sample: "sk-svcacct-abcdEFGH1234ijklMNOP5678qrstUV",
    scannerKind: "openai-api-key",
    redactionKind: "openai_api_key",
  },
  {
    label: "anthropic",
    sample: "sk-ant-api03-abcdEFGH1234ijklMNOP5678qrstUVWX",
    scannerKind: "anthropic-api-key",
    redactionKind: "anthropic_api_key",
  },
  {
    label: "github-classic",
    sample: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    scannerKind: "github-token",
    redactionKind: "github_pat_classic",
  },
  {
    label: "github-finegrained",
    sample: "github_pat_11ABCDEFG0abcdefghijKLMNOP",
    scannerKind: "github-token",
    redactionKind: "github_pat_fine_grained",
  },
  {
    label: "slack-bot",
    sample: "xoxb-1234567890-ABCDEFGHIJKLMNOP",
    scannerKind: "slack-token",
    redactionKind: "slack_token",
  },
  {
    label: "gitlab-pat",
    sample: "glpat-abcdEFGH1234ijklMNOP",
    scannerKind: "gitlab-pat",
    redactionKind: "gitlab_pat",
  },
  {
    label: "google-api",
    sample: "AIzaSyAbcdEFGH1234ijklMNOP5678qrstUVWXY",
    scannerKind: "google-api-key",
    redactionKind: "google_api_key",
  },
  {
    label: "aws-akid",
    sample: "AKIAIOSFODNN7EXAMPLE",
    scannerKind: "aws-access-key",
    redactionKind: "aws_access_key_id",
  },
  {
    label: "aws-session",
    sample: "ASIAIOSFODNN7EXAMPLE",
    scannerKind: "aws-access-key",
    redactionKind: "aws_access_key_id",
  },
  {
    label: "bearer-header",
    sample: "Authorization: Bearer abcdEFGH1234ijklMNOP5678qrst",
    scannerKind: "bearer-token",
    redactionKind: "bearer_token_header",
  },
  {
    label: "jwt",
    sample:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJxdWFudGEtZml4dHVyZSJ9.abcdefghijklmnopqrstuv",
    scannerKind: "jwt",
    redactionKind: "jwt",
  },
  {
    label: "url-userinfo",
    sample: "https://fixture-user:fixture-pass-not-live@example.com/webhook",
    scannerKind: "url-userinfo",
    redactionKind: "url_with_userinfo",
  },
  {
    label: "aws-secret-assignment",
    sample: "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    scannerKind: "aws-secret-key",
    redactionKind: "aws_secret_access_key_assignment",
  },
  {
    label: "pem-block",
    sample:
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC fixture-not-a-real-key\n-----END PRIVATE KEY-----",
    scannerKind: "private-key-block",
    redactionKind: "pem_private_key_block",
  },
]

export const BENIGN_SECRET_SHAPES: readonly { readonly label: string; readonly sample: string }[] =
  [
    { label: "passwordless-url", sample: "https://example.com/path?q=1" },
    { label: "dotted-identifier", sample: "com.example.ServiceName" },
    { label: "uuid", sample: "550e8400-e29b-41d4-a716-446655440000" },
    { label: "hex-hash", sample: "deadbeefcafebabe0123456789abcdef01234567" },
    { label: "public-key-label", sample: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI fixture" },
    { label: "bare-bearer", sample: "Bearer" },
    { label: "ordinary-email", sample: "operator@example.com" },
    { label: "short-token", sample: "tok_ab" },
  ]
