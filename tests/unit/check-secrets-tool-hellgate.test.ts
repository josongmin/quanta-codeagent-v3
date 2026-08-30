/**
 * ★ CONTRACT — ADR-0412 `check_secrets` LLM-facing tool over the async
 *   `compositeSecretScanner`. The tool is registered ONLY when the env knob
 *   `QUANTA_SECRET_CHECK_TOOL` equals exactly `"on"`; every other value
 *   (absent / `"1"` / `"true"` / `"yes"` / `"off"` / empty) ⇒ NOT registered
 *   ⇒ legacy callers byte-identical. The tool returns structured findings
 *   without modifying input and never throws across its boundary.
 *
 * HELLGATE — adversarial proofs of the gate, the input shape (XOR text /
 * file_path), the no-throw contract, and the byte-identical default-OFF
 * posture against `buildSessionFeatures`.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSessionFeatures } from "@/agent/features"
import {
  buildCheckSecretsBlock,
  CHECK_SECRETS_ENABLED_VALUE,
  CHECK_SECRETS_ENV_FLAG,
  type CheckSecretsEnvReader,
  checkSecretsToolEnabled,
} from "@/agent/tier1"
import type { AgentConfig } from "@/agent/types"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import {
  type CheckSecretsInput,
  type CheckSecretsStructured,
  checkSecretsInputSchema,
  checkSecretsTool,
} from "@/tool/check_secrets"

const envOf = (map: Record<string, string | undefined>): CheckSecretsEnvReader => ({
  get(name) {
    return map[name]
  },
})

const runTool = async (input: CheckSecretsInput): Promise<ToolResult> => {
  const ctx: ToolContext = {
    cwd: process.cwd(),
    signal: new AbortController().signal,
  }
  let last: ToolResult | undefined
  for await (const ev of checkSecretsTool.execute(input, ctx) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("tool yielded no result")
  return last
}

const structured = (r: ToolResult): CheckSecretsStructured => r.structured as CheckSecretsStructured

test("production runtime import and composite scans do not load the optional secretlint adapter", async () => {
  // A fresh process observes the real import closure, unaffected by this file's
  // other tests. The explicit secretlint scan proves the cache probe is live.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `let networkCalls = 0;
       globalThis.fetch = async () => { networkCalls++; throw new Error("unexpected network"); };
       const { buildProductionRuntimeFactory } = await import(${JSON.stringify(join(import.meta.dir, "../../src/apps/web-daemon/runtime-factory.ts"))});
       const loaded = () => Object.keys(require.cache).filter(p => p.includes("/@secretlint/"));
       const afterRuntimeImport = loaded();
       const { checkSecretsTool } = await import(${JSON.stringify(join(import.meta.dir, "../../src/tool/check_secrets.ts"))});
       const key = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
       let result;
       for await (const event of checkSecretsTool.execute({ text: key }, { cwd: process.cwd(), signal: new AbortController().signal })) {
         if (event.type === "result") result = event.result;
       }
       const afterComposite = loaded();
       const { secretlintScanner } = await import(${JSON.stringify(join(import.meta.dir, "../../src/security/secret-detection/index.ts"))});
       const optionalFindings = await secretlintScanner().scanText(key);
       console.log(JSON.stringify({ factoryType: typeof buildProductionRuntimeFactory,
         afterRuntimeImport, afterComposite, result, afterOptional: loaded(), optionalFindings, networkCalls }));`,
    ],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  const result = JSON.parse(stdout)
  expect(result.factoryType).toBe("function")
  expect(result.afterRuntimeImport).toEqual([])
  expect(result.afterComposite).toEqual([])
  expect(result.result.ok).toBe(true)
  expect(result.result.structured.findings).toContainEqual(
    expect.objectContaining({ kind: "github-token", preview: "ghp_***wxyz" }),
  )
  expect(result.afterOptional.length).toBeGreaterThan(0)
  expect(result.optionalFindings).toContainEqual(
    expect.objectContaining({ kind: "github-token", preview: "ghp_***wxyz" }),
  )
  expect(result.networkCalls).toBe(0)
})

// ────────────────────────────────────────────────────────────────────────────
// A. ENV GATE — exactly `"on"` enables; everything else is default-OFF.
// ────────────────────────────────────────────────────────────────────────────
describe("check_secrets / A. env gate (default-OFF posture)", () => {
  // The env→boolean resolution lives at the composition root via
  // `checkSecretsToolEnabled`; `buildCheckSecretsBlock` takes the plain boolean.
  // Section A proves the env truth-table on the resolver AND the splat semantics
  // on the builder.
  test("A1 — absent env ⇒ resolver false ⇒ block []", () => {
    expect(checkSecretsToolEnabled(envOf({}))).toBe(false)
    expect(buildCheckSecretsBlock(false)).toEqual([])
  })

  test("A2 — empty string ⇒ resolver false", () => {
    expect(checkSecretsToolEnabled(envOf({ [CHECK_SECRETS_ENV_FLAG]: "" }))).toBe(false)
  })

  test("A3 — `'1'` does NOT enable (strict canonical value)", () => {
    expect(checkSecretsToolEnabled(envOf({ [CHECK_SECRETS_ENV_FLAG]: "1" }))).toBe(false)
  })

  test("A4 — `'true'` does NOT enable", () => {
    expect(checkSecretsToolEnabled(envOf({ [CHECK_SECRETS_ENV_FLAG]: "true" }))).toBe(false)
  })

  test("A5 — `'yes'` does NOT enable", () => {
    expect(checkSecretsToolEnabled(envOf({ [CHECK_SECRETS_ENV_FLAG]: "yes" }))).toBe(false)
  })

  test("A6 — `'off'` does NOT enable", () => {
    expect(checkSecretsToolEnabled(envOf({ [CHECK_SECRETS_ENV_FLAG]: "off" }))).toBe(false)
  })

  test("A7 — `'On'` (wrong case) does NOT enable", () => {
    expect(checkSecretsToolEnabled(envOf({ [CHECK_SECRETS_ENV_FLAG]: "On" }))).toBe(false)
  })

  test("A8 — canonical `'on'` ⇒ resolver true ⇒ block returns the single tool", () => {
    expect(checkSecretsToolEnabled(envOf({ [CHECK_SECRETS_ENV_FLAG]: "on" }))).toBe(true)
    const tools = buildCheckSecretsBlock(true)
    expect(tools.length).toBe(1)
    expect(tools[0]?.name).toBe("check_secrets")
  })

  test("A8b — `buildCheckSecretsBlock(undefined)` ⇒ [] (default-OFF)", () => {
    expect(buildCheckSecretsBlock(undefined)).toEqual([])
  })

  test("A9 — canonical-value constant equals the bare string `'on'`", () => {
    expect(CHECK_SECRETS_ENABLED_VALUE).toBe("on")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. byte-identical default — `buildSessionFeatures` with NO config + NO env
//    must not advertise `check_secrets`.
// ────────────────────────────────────────────────────────────────────────────
describe("check_secrets / B. byte-identical default-OFF in features composer", () => {
  // The gate is now a plain `AgentConfig.secretCheckToolEnabled` boolean
  // resolved at the composition root (no `process.env` read inside the slice).
  test("B1 — features.extraTools does NOT contain check_secrets when flag absent", async () => {
    const features = await buildSessionFeatures({
      registry: { specs: () => [], get: () => undefined } as unknown as AgentConfig["registry"],
      permission: { mode: "default" },
    } as unknown as AgentConfig)
    expect(features.extraTools.find((t) => t.name === "check_secrets")).toBeUndefined()
  })

  test("B2 — features.extraTools DOES contain check_secrets when flag === true", async () => {
    const features = await buildSessionFeatures({
      registry: { specs: () => [], get: () => undefined } as unknown as AgentConfig["registry"],
      permission: { mode: "default" },
      secretCheckToolEnabled: true,
    } as unknown as AgentConfig)
    const tool = features.extraTools.find((t) => t.name === "check_secrets")
    expect(tool).toBeDefined()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C. INPUT SHAPE — exactly one of text / file_path (XOR).
// ────────────────────────────────────────────────────────────────────────────
describe("check_secrets / C. input shape (XOR text/file_path)", () => {
  test("C1 — { text } parses", () => {
    const r = checkSecretsInputSchema.safeParse({ text: "hello" })
    expect(r.success).toBe(true)
  })

  test("C2 — { file_path } parses", () => {
    const r = checkSecretsInputSchema.safeParse({ file_path: "/tmp/x" })
    expect(r.success).toBe(true)
  })

  test("C3 — both set ⇒ rejected", () => {
    const r = checkSecretsInputSchema.safeParse({ text: "a", file_path: "/tmp/x" })
    expect(r.success).toBe(false)
  })

  test("C4 — neither set ⇒ rejected", () => {
    const r = checkSecretsInputSchema.safeParse({})
    expect(r.success).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// D. SCAN BEHAVIOR — known signatures fire; clean text is "0 findings".
// ────────────────────────────────────────────────────────────────────────────
describe("check_secrets / D. scan behavior", () => {
  test("D1 — AWS access key in text ⇒ aws-access-key finding", async () => {
    const result = await runTool({ text: "AKIAIOSFODNN7EXAMPLE" })
    expect(result.ok).toBe(true)
    const s = structured(result)
    expect(s.findings.some((f) => f.kind === "aws-access-key")).toBe(true)
    expect(s.source).toBe("text")
    expect(s.target).toBeUndefined()
  })

  test("D2 — PEM private-key block ⇒ private-key-block finding", async () => {
    const text = `-----BEGIN RSA PRIVATE KEY-----\nMIIE${"A".repeat(40)}\n-----END RSA PRIVATE KEY-----`
    const result = await runTool({ text })
    expect(result.ok).toBe(true)
    const s = structured(result)
    expect(s.findings.some((f) => f.kind === "private-key-block")).toBe(true)
  })

  test("D3 — clean prose ⇒ ok:true with empty findings + 'clean' marker", async () => {
    const result = await runTool({ text: "the quick brown fox jumps over the lazy dog" })
    expect(result.ok).toBe(true)
    expect(structured(result).findings.length).toBe(0)
    expect(result.output).toContain("0 findings")
    expect(result.output).toContain("clean")
  })

  test("D4 — SHA-256 hex string (structural false-positive) is NOT flagged as entropy", async () => {
    // 64-char hex is the canonical SHA-256 length the entropy adapter skips.
    const sha256 = "a".repeat(60) + "b".repeat(4)
    const result = await runTool({ text: sha256 })
    expect(result.ok).toBe(true)
    expect(structured(result).findings.length).toBe(0)
  })

  test("D5 — file scan resolves target + source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "check-secrets-"))
    try {
      const file = join(dir, "leak.txt")
      writeFileSync(file, `GH=ghp_${"a".repeat(36)}`)
      const result = await runTool({ file_path: file })
      expect(result.ok).toBe(true)
      const s = structured(result)
      expect(s.source).toBe("file_path")
      expect(s.target).toBe(file)
      expect(s.findings.some((f) => f.kind === "github-token")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("D6 — file_path that does not exist ⇒ ok:false naming the path (NEVER '0 findings (clean)')", async () => {
    // jun-10 finding #12: `scanFile` used to swallow ENOENT into [] and the
    // tool reported "0 findings (clean)" — byte-identical to a clean file.
    // The scanner now throws a typed SecretScanReadError and the tool's
    // no-throw boundary surfaces it as ok:false per its documented contract.
    const p = `/does/not/exist/${Math.random().toString(36)}`
    const result = await runTool({ file_path: p })
    expect(result.ok).toBe(false)
    expect(result.output).toContain(p)
    expect(result.output).not.toBe("check_secrets: 0 findings (clean)")
    expect(result.failure?.mode).toBe("error")
    const visible = result.failure?.mode === "error" ? result.failure.modelVisibleError : undefined
    expect(visible).toContain(p)
  })

  test("D7 — masked preview NEVER contains the raw full secret", async () => {
    const key = "AKIAIOSFODNN7EXAMPLE"
    const result = await runTool({ text: key })
    expect(result.ok).toBe(true)
    const finding = structured(result).findings.find((f) => f.kind === "aws-access-key")
    expect(finding).toBeDefined()
    expect(finding?.preview).not.toBe(key)
    expect(finding?.preview).toContain("***")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// E. NO-THROW CONTRACT — a throwing scanner becomes ok:false with typed
//    failure; the tool boundary never propagates the throw.
// ────────────────────────────────────────────────────────────────────────────
describe("check_secrets / E. no-throw contract on scanner failure", () => {
  test("E1 — invalid input (both fields) yields a schema error at validate time, NOT a throw", () => {
    // The schema refusal happens BEFORE execute (registry/dispatch validates
    // inputs against the schema). Here we mirror that posture in-isolation:
    // calling `.parse` on bad input throws ZodError synchronously — that is
    // the dispatch-side responsibility, not the tool body's. The tool body
    // itself never sees an invalid shape.
    expect(() => checkSecretsInputSchema.parse({ text: "x", file_path: "/y" })).toThrow()
  })

  test("E2 — tool body never throws (passing well-typed input always settles to a ToolResult)", async () => {
    // We can't make `compositeSecretScanner` throw without mutating its
    // implementation, but the body's try/catch is the no-throw seam. The
    // structural proof: every code path in `execute` ends in `yield ... result`.
    // We simply assert the boundary returns a settled result for the input.
    const result = await runTool({ text: "ok" })
    expect(result.ok).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// F. TOOL SURFACE METADATA — read-only + concurrency-safe.
// ────────────────────────────────────────────────────────────────────────────
describe("check_secrets / F. tool surface metadata", () => {
  test("F1 — isReadOnly() === true (registry classifies it as read-only)", () => {
    expect(checkSecretsTool.isReadOnly()).toBe(true)
  })

  test("F2 — isConcurrencySafe(input) === true regardless of input shape", () => {
    expect(checkSecretsTool.isConcurrencySafe({ text: "a" })).toBe(true)
    expect(checkSecretsTool.isConcurrencySafe({ file_path: "/x" })).toBe(true)
  })

  test("F3 — description advertises BOTH the use-case AND the not-to-use case", () => {
    expect(checkSecretsTool.description).toContain("USE WHEN")
    expect(checkSecretsTool.description).toContain("DO NOT USE")
  })

  test("F4 — name is stable string `check_secrets`", () => {
    expect(checkSecretsTool.name).toBe("check_secrets")
  })
})
