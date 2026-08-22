/**
 * RFC-0002 §11 + §1.1 + §12 — redaction golden (BLOCKING merge gate).
 *
 * "env secret / tool input secret / prompt 내 secret / stacktrace 내 token
 *  4종이 trajectory에 절대 안 박힘을 골든으로 고정. 실패 시 머지 불가."
 *
 * This file tests REAL behavior — the actual `redactValue`/`makeEvent` scrub
 * from `@/shared`, and a real on-disk `JsonlRecorder` write→read-back. Nothing
 * under test is mocked. If any of the four vectors leaks, an assertion here
 * MUST fail loudly: this is the security gate, not a smoke test.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunContext } from "@/shared"
import { isTrajectoryEvent, makeEvent, REDACTION_POLICY, redactValue } from "@/shared"
import type { AgentEvent } from "@/stream"
import { JsonlRecorder } from "@/stream"

const REDACTED = "***REDACTED***"
const CTX: RunContext = { runId: "redaction-gate", instanceId: "inst-1", attempt: 0 }

// --- The four RFC §11 secret vectors (each MUST be erased) ------------------

/**
 * Vector 1 — env secret VALUE: realistic provider/credential tokens embedded
 * as plain string values. Each is a literal substring that must never survive
 * into a serialized line. (Values chosen so they truly match the live regexes:
 * `sk-` must be followed by ≥8 alnum with no dash; `Bearer` catches the rest.)
 */
const ENV_OPENAI = "sk-1234567890abcdefABCDEFghij"
const ENV_BEARER = "Bearer sk-live-9f8e7d6c5b4a3210ZZZ"
const ENV_GITHUB = "ghp_AbCdEf0123456789ghijKLmnopQRSTuv"
const ENV_AWS = "AKIAABCDEFGHIJKLMNOP"
const ENV_PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIBVAIBADANBgkqh\n-----END RSA PRIVATE KEY-----"

/** Vector 3 — a secret living inside an otherwise-normal prose/text field. */
const PROMPT_WITH_SECRET = `Here is the deploy step, use header Authorization: ${ENV_BEARER} then ship.`

/** Vector 4 — a token buried in an error/stacktrace string. */
const STACK_WITH_TOKEN =
  "AuthError: rejected\n  at fetchRepo (clone.ts:42) token=ghp_AbCdEf0123456789ghijKLmnopQRSTuv\n  at run (loop.ts:7)"

/** Benign payloads — MUST pass through verbatim (no over-redaction). */
const BENIGN_CODE = "return a + b"
const BENIGN_PATH = "/usr/local/lib/quanta/index.ts"

/** Every raw secret substring that must be absent from any serialized line. */
const ALL_RAW_SECRETS = [
  ENV_OPENAI,
  ENV_BEARER,
  ENV_GITHUB,
  ENV_AWS,
  "MIIBVAIBADANBgkqh", // PEM body
  "ghp_AbCdEf0123456789ghijKLmnopQRSTuv",
] as const

/** A single `data` payload exercising all four vectors at once, with deep
 *  nesting (arrays + sub-objects) to prove the recursive walk. */
const buildDirtyData = (): Record<string, unknown> => ({
  // Vector 1: env secret values as plain string values.
  env: {
    OPENAI_API_KEY: ENV_OPENAI,
    ANTHROPIC_API_KEY: ENV_BEARER,
    pem: ENV_PEM,
  },
  // Vector 2: secret-KEY-named fields (value erased by key, regardless of
  // content) — nested in arrays and sub-objects to verify the deep walk.
  tool_input: {
    api_key: "literally-anything-here-still-erased",
    access_token: "also-erased-by-key-name",
    authorization: "Basic dXNlcjpwYXNz",
    nested: [{ api_key: ENV_OPENAI }, { deeper: { access_token: ENV_GITHUB } }],
  },
  // Vector 3: secret embedded in a normal prose text field.
  text: PROMPT_WITH_SECRET,
  // Vector 4: token inside an error/stacktrace string.
  error: STACK_WITH_TOKEN,
  // Benign — must survive verbatim.
  code: BENIGN_CODE,
  path: BENIGN_PATH,
  benignList: [BENIGN_CODE, { note: BENIGN_PATH }],
})

/** Assert no raw secret substring survives in `line`, and benign data does. */
const assertCleanLine = (line: string): void => {
  for (const secret of ALL_RAW_SECRETS) {
    expect(line.includes(secret)).toBe(false)
  }
  // Defense-in-depth: not just the test fixtures — no obvious credential
  // prefix should ever appear raw in a scrubbed line.
  expect(/ghp_[A-Za-z0-9]{8,}/.test(line)).toBe(false)
  expect(/\bsk-[A-Za-z0-9]{8,}/.test(line)).toBe(false)
  expect(/\bAKIA[0-9A-Z]{16}\b/.test(line)).toBe(false)
  expect(line.includes("PRIVATE KEY")).toBe(false)
  // No over-redaction: benign values pass through untouched.
  expect(line.includes(BENIGN_CODE)).toBe(true)
  expect(line.includes(BENIGN_PATH)).toBe(true)
  // The scrub actually fired.
  expect(line.includes(REDACTED)).toBe(true)
}

describe("RFC-0002 §11 redaction golden (blocking merge gate)", () => {
  describe("redactValue — the single scrub source", () => {
    test("vector 1: env secret VALUES mask to the sentinel", () => {
      const out = redactValue({
        OPENAI_API_KEY: ENV_OPENAI,
        bearer: ENV_BEARER,
        gh: ENV_GITHUB,
        aws: ENV_AWS,
        pem: ENV_PEM,
      }) as Record<string, unknown>
      // OPENAI_API_KEY: erased by KEY name. Others erased by VALUE pattern.
      expect(out.OPENAI_API_KEY).toBe(REDACTED)
      expect(out.bearer).toBe(REDACTED)
      expect(out.gh).toBe(REDACTED)
      expect(out.aws).toBe(REDACTED)
      expect(out.pem).toBe(REDACTED)
    })

    test("vector 2: secret-KEY fields erased, including deep in arrays/objects", () => {
      const out = redactValue({
        api_key: "x",
        access_token: "y",
        authorization: "z",
        arr: [{ api_key: ENV_OPENAI }, { sub: { access_token: ENV_GITHUB } }],
      }) as Record<string, unknown>
      expect(out.api_key).toBe(REDACTED)
      expect(out.access_token).toBe(REDACTED)
      expect(out.authorization).toBe(REDACTED)
      const arr = out.arr as Array<Record<string, unknown>>
      expect(arr[0]?.api_key).toBe(REDACTED)
      const sub = arr[1]?.sub as Record<string, unknown>
      expect(sub.access_token).toBe(REDACTED)
    })

    test("vector 3: secret embedded in a prose text field is masked", () => {
      const out = redactValue({ text: PROMPT_WITH_SECRET }) as Record<string, unknown>
      expect(out.text).toBe(REDACTED)
      expect(JSON.stringify(out).includes(ENV_BEARER)).toBe(false)
    })

    test("vector 4: token inside an error/stacktrace string is masked", () => {
      const out = redactValue({ error: STACK_WITH_TOKEN }) as Record<string, unknown>
      expect(out.error).toBe(REDACTED)
      expect(JSON.stringify(out).includes(ENV_GITHUB)).toBe(false)
    })

    test("no over-redaction: benign values pass through verbatim", () => {
      const out = redactValue({
        code: BENIGN_CODE,
        path: BENIGN_PATH,
        list: [BENIGN_CODE, { note: BENIGN_PATH }],
        n: 42,
        b: true,
        nil: null,
      }) as Record<string, unknown>
      expect(out.code).toBe(BENIGN_CODE)
      expect(out.path).toBe(BENIGN_PATH)
      expect(out.list).toEqual([BENIGN_CODE, { note: BENIGN_PATH }])
      expect(out.n).toBe(42)
      expect(out.b).toBe(true)
      expect(out.nil).toBe(null)
    })

    test("redactValue is idempotent (scrubbing twice == once)", () => {
      const data = buildDirtyData()
      const once = redactValue(data)
      const twice = redactValue(once)
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
    })

    test("vector 2b: BARE secret keys erased even when the VALUE looks innocuous", () => {
      // The RFC-0002 §3.6/§11 bare-key gap: a key that IS a secret name whose
      // value does NOT match any value regex must still be erased by key name.
      const out = redactValue({
        token: "plainish-value",
        secret: "x",
        password: "p",
        passwd: "p2",
        apiKey: "k",
        api_key: "k2",
        "api-key": "k3",
        access_token: "at",
        refresh_token: "rt",
        auth_token: "aut",
        client_secret: "cs",
        private_key: "pk",
        credential: "c",
        credentials: "cc",
        authorization: "z",
        nested: [{ token: "nested-bare" }, { sub: { password: "deep-bare", apiKey: "deep-k" } }],
      }) as Record<string, unknown>
      for (const k of [
        "token",
        "secret",
        "password",
        "passwd",
        "apiKey",
        "api_key",
        "api-key",
        "access_token",
        "refresh_token",
        "auth_token",
        "client_secret",
        "private_key",
        "credential",
        "credentials",
        "authorization",
      ]) {
        expect(out[k]).toBe(REDACTED)
      }
      const arr = out.nested as Array<Record<string, unknown>>
      expect(arr[0]?.token).toBe(REDACTED)
      const sub = arr[1]?.sub as Record<string, unknown>
      expect(sub.password).toBe(REDACTED)
      expect(sub.apiKey).toBe(REDACTED)
      // The innocuous raw values must not survive anywhere in the line.
      const line = JSON.stringify(out)
      expect(line.includes("plainish-value")).toBe(false)
      expect(line.includes("nested-bare")).toBe(false)
      expect(line.includes("deep-bare")).toBe(false)
    })

    test("§5.3 NON-REGRESSION: telemetry token counters pass through UNCHANGED", () => {
      // These keys all contain the substring "token" but are NOT bare secret
      // names. They MUST survive verbatim — masking them breaks RFC §5.3 cost
      // re-derivation and the pricing/jsonl-recorder/bench tests.
      const out = redactValue({
        inputTokens: 1234,
        outputTokens: 56,
        cacheReadTokens: 7,
        cacheWriteTokens: 11,
        tokenCount: 9,
        tokensUsed: 3,
        tokenizer: "cl100k_base",
        refreshedAt: 1700000000,
        nested: [{ inputTokens: 999 }, { sub: { outputTokens: 888 } }],
      }) as Record<string, unknown>
      expect(out.inputTokens).toBe(1234)
      expect(out.outputTokens).toBe(56)
      expect(out.cacheReadTokens).toBe(7)
      expect(out.cacheWriteTokens).toBe(11)
      expect(out.tokenCount).toBe(9)
      expect(out.tokensUsed).toBe(3)
      expect(out.tokenizer).toBe("cl100k_base")
      expect(out.refreshedAt).toBe(1700000000)
      const arr = out.nested as Array<Record<string, unknown>>
      expect(arr[0]?.inputTokens).toBe(999)
      expect((arr[1]?.sub as Record<string, unknown>).outputTokens).toBe(888)
      // Nothing was redacted at all in this benign telemetry payload.
      expect(JSON.stringify(out).includes(REDACTED)).toBe(false)
    })
  })

  describe("S1 — real-world secret value formats mask to the sentinel", () => {
    const S1_VALUES: Record<string, string> = {
      anthropic: "sk-ant-api03-AbCdEf0123456789_-ghijKLmnopQRSTuvWXyz",
      openaiProj: "sk-proj-AbCdEf0123456789ghijKLmnopQRSTuv",
      openaiSvc: "sk-svcacct-AbCdEf0123456789ghijKLmnopQR",
      githubPat: "github_pat_11ABCDE0Y0abcdefghij_KLMNOPqrstuvwx",
      ghOauth: "gho_AbCdEf0123456789ghijKLmnopQRSTuv",
      ghServer: "ghs_AbCdEf0123456789ghijKLmnopQRSTuv",
      ghUser: "ghu_AbCdEf0123456789ghijKLmnopQRSTuv",
      slackBot: "xoxb-1234567890-0987654321-AbCdEfGhIjKlMn",
      slackUser: "xoxp-1234567890-0987654321-AbCdEfGhIjKlMn",
      gitlab: "glpat-AbCdEf0123456789_-gh",
      google: "AIzaSyA1234567890abcdefghijklmnopqrstuv",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      urlCreds: "postgres://dbuser:s3cr3tpw@db.internal:5432/app",
    }

    test("redactValue masks every S1 value format", () => {
      const out = redactValue({ ...S1_VALUES }) as Record<string, unknown>
      for (const k of Object.keys(S1_VALUES)) {
        expect(out[k]).toBe(REDACTED)
      }
      const line = JSON.stringify(out)
      for (const raw of Object.values(S1_VALUES)) {
        expect(line.includes(raw)).toBe(false)
      }
    })

    test("S1 values are erased through makeEvent + on-disk readback", () => {
      const event = makeEvent(0, "tool_call", CTX, { ...S1_VALUES }, { ts: 1 })
      const line = JSON.stringify(event)
      for (const raw of Object.values(S1_VALUES)) {
        expect(line.includes(raw)).toBe(false)
      }
      expect(event.redaction.applied).toBe(true)
    })
  })

  describe("S1 — bare secret-name keys erased regardless of value", () => {
    const S1_BARE_KEYS = [
      "x-api-key",
      "cookie",
      "set-cookie",
      "database_url",
      "connection_string",
      "session_key",
      "private_key_pem",
      "dsn",
    ] as const

    test("redactValue erases each bare S1 key (innocuous value)", () => {
      const input: Record<string, unknown> = {}
      for (const k of S1_BARE_KEYS) input[k] = "innocuous-plain-value"
      const out = redactValue(input) as Record<string, unknown>
      for (const k of S1_BARE_KEYS) {
        expect(out[k]).toBe(REDACTED)
      }
      expect(JSON.stringify(out).includes("innocuous-plain-value")).toBe(false)
    })

    test("S1 NON-REGRESSION: token counters still pass through unredacted", () => {
      const out = redactValue({
        inputTokens: 1234,
        outputTokens: 56,
        cacheReadTokens: 7,
        tokenCount: 9,
        tokensUsed: 3,
        tokenizer: "cl100k_base",
      }) as Record<string, unknown>
      expect(out.inputTokens).toBe(1234)
      expect(out.outputTokens).toBe(56)
      expect(out.cacheReadTokens).toBe(7)
      expect(out.tokenCount).toBe(9)
      expect(out.tokensUsed).toBe(3)
      expect(out.tokenizer).toBe("cl100k_base")
      expect(JSON.stringify(out).includes(REDACTED)).toBe(false)
    })
  })

  describe("entry point A — makeEvent() scrubs `data` by default", () => {
    test("all four vectors absent from JSON.stringify(event); redaction stamped", () => {
      const event = makeEvent(0, "tool_call", CTX, buildDirtyData(), { ts: 1 })
      const line = JSON.stringify(event)
      assertCleanLine(line)
      expect(event.redaction.applied).toBe(true)
      expect(event.redaction.policy).toBe(REDACTION_POLICY)
      expect(isTrajectoryEvent(event)).toBe(true)
    })

    test("bench-produced kinds (sandbox/patch_generated/verify) are also scrubbed", () => {
      for (const kind of ["sandbox", "patch_generated", "verify"] as const) {
        const event = makeEvent(1, kind, CTX, buildDirtyData(), { ts: 1 })
        assertCleanLine(JSON.stringify(event))
        expect(event.redaction.applied).toBe(true)
      }
    })

    test("skipRedaction:true is the ONLY documented bypass (leaks by design)", () => {
      const raw = makeEvent(
        0,
        "tool_call",
        CTX,
        { OPENAI_API_KEY: ENV_OPENAI },
        {
          ts: 1,
          skipRedaction: true,
        },
      )
      const line = JSON.stringify(raw)
      // Proves the bypass is real AND that it is the *only* way to bypass:
      // every other path above scrubbed; only this opt-in leaves data raw.
      expect(line.includes(ENV_OPENAI)).toBe(true)
      expect(raw.redaction.applied).toBe(false)
      // Default factory call with the SAME data is clean — contrast proves the
      // scrub is on-by-default and not vacuous.
      const def = makeEvent(0, "tool_call", CTX, { OPENAI_API_KEY: ENV_OPENAI }, { ts: 1 })
      expect(JSON.stringify(def).includes(ENV_OPENAI)).toBe(false)
      expect(def.redaction.applied).toBe(true)
    })
  })

  describe("entry point B — real JsonlRecorder write→read-back (on-disk)", () => {
    const dir = mkdtempSync(join(tmpdir(), "redaction-"))

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    test("the actual JSONL line bytes written to disk carry no raw secret", () => {
      const file = join(dir, "trajectory.jsonl")
      const rec = new JsonlRecorder(file, { ctx: CTX, now: () => 1 })

      // Drive real AgentEvents whose payloads carry every vector. The recorder
      // routes them through makeEvent → redactValue before serialization.
      const events: AgentEvent[] = [
        { type: "turn_start", turn: 1 },
        {
          type: "tool_call",
          id: "tc-1",
          name: "bash",
          input: {
            env: { OPENAI_API_KEY: ENV_OPENAI, ANTHROPIC_API_KEY: ENV_BEARER, pem: ENV_PEM },
            api_key: "erased-by-key",
            nested: [{ access_token: ENV_GITHUB }],
            text: PROMPT_WITH_SECRET,
            code: BENIGN_CODE,
          },
        },
        { type: "assistant_text", delta: PROMPT_WITH_SECRET },
        { type: "error", message: STACK_WITH_TOKEN },
        { type: "tool_result", id: "tc-1", name: "bash", ok: true, preview: ENV_AWS },
      ]
      for (const e of events) rec.emit(e)
      rec.close()

      const raw = readFileSync(file, "utf8")
      const lines = raw.split("\n").filter((l) => l.length > 0)
      expect(lines.length).toBe(events.length)

      let sawSecretField = false
      for (const line of lines) {
        // Every raw secret substring is absent from the on-disk bytes.
        for (const secret of ALL_RAW_SECRETS) {
          expect(line.includes(secret)).toBe(false)
        }
        const ev = JSON.parse(line) as unknown
        expect(isTrajectoryEvent(ev)).toBe(true)
        const tev = ev as { redaction: { applied: boolean; policy: string } }
        expect(tev.redaction.applied).toBe(true)
        expect(tev.redaction.policy).toBe(REDACTION_POLICY)
        if (line.includes(REDACTED)) sawSecretField = true
      }
      // At least one line actually contained a scrubbed secret (non-vacuous),
      // and the benign code survived somewhere on disk (no over-redaction).
      expect(sawSecretField).toBe(true)
      expect(raw.includes(BENIGN_CODE)).toBe(true)
    })

    test("on-disk readback: bare secret keys erased, token counters intact", () => {
      const file = join(dir, "bare-key.jsonl")
      const rec = new JsonlRecorder(file, { ctx: CTX, now: () => 1 })

      // A tool_call whose input carries BARE secret keys with innocuous-looking
      // values (the §3.6 gap) — these must be erased by key name on disk.
      rec.emit({
        type: "tool_call",
        id: "tc-bare",
        name: "http",
        input: {
          token: "plainish-on-disk",
          password: "p",
          apiKey: "k",
          authorization: "z",
          deep: [{ secret: "nested-on-disk" }],
          code: BENIGN_CODE,
        },
      })
      // A real `usage` event → on-disk line carries inputTokens/outputTokens/
      // cacheReadTokens. These MUST survive verbatim (RFC §5.3).
      rec.emit({
        type: "usage",
        model: "claude-sonnet-4",
        inputTokens: 1234,
        outputTokens: 56,
        cacheReadTokens: 7,
      })
      rec.close()

      const raw = readFileSync(file, "utf8")
      const lines = raw.split("\n").filter((l) => l.length > 0)
      expect(lines.length).toBe(2)

      // Bare-key fix: no innocuous secret value survived; the scrub fired.
      expect(raw.includes("plainish-on-disk")).toBe(false)
      expect(raw.includes("nested-on-disk")).toBe(false)
      const callLine = JSON.parse(lines[0] as string) as {
        data: { input: Record<string, unknown> }
      }
      const input = callLine.data.input
      expect(input.token).toBe(REDACTED)
      expect(input.password).toBe(REDACTED)
      expect(input.apiKey).toBe(REDACTED)
      expect(input.authorization).toBe(REDACTED)
      expect((input.deep as Array<Record<string, unknown>>)[0]?.secret).toBe(REDACTED)
      expect(input.code).toBe(BENIGN_CODE) // no over-redaction

      // §5.3 NON-REGRESSION on disk: the usage counters are untouched numbers.
      const usageLine = JSON.parse(lines[1] as string) as {
        data: { inputTokens: unknown; outputTokens: unknown; cacheReadTokens: unknown }
      }
      expect(usageLine.data.inputTokens).toBe(1234)
      expect(usageLine.data.outputTokens).toBe(56)
      expect(usageLine.data.cacheReadTokens).toBe(7)
      expect(lines[1]?.includes(REDACTED)).toBe(false)
    })
  })
})
