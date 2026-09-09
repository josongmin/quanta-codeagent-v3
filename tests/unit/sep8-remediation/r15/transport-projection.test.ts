import { describe, expect, test } from "bun:test"
import { defaultDoctorProbes } from "@/apps/cli/doctor/default-probes"
import { runDoctor } from "@/apps/cli/doctor/registry"
import type { DoctorProbes } from "@/apps/cli/doctor/types"
import { buildStatusCmd } from "@/apps/cli/status-cmd"
import {
  type LlmTransportProjection,
  projectLlmTransport,
  selectLlmTransport,
} from "@/runner/assemble"

const noSecrets = (p: LlmTransportProjection): void => {
  const blob = JSON.stringify(p)
  expect(blob).not.toContain("sk-")
  expect(blob).not.toContain("secret")
  expect(blob).not.toContain("https://")
}

describe("E-PROV-01 transport projection", () => {
  test("legacy control keeps credential provider distinct from transport", () => {
    const p = projectLlmTransport({
      transport: undefined,
      env: { ANTHROPIC_API_KEY: "sk-secret-anthropic" },
      credentialProvider: "anthropic",
    })
    expect(p.credentialProvider).toBe("anthropic")
    expect(p.effective).toEqual({ kind: "legacy" })
    expect(p.effectiveId).toBe("legacy")
    expect(p.reason).toBe("legacy-default")
    noSecrets(p)
  })

  test.each([
    ["bedrock", { ANTHROPIC_BEDROCK_BASE_URL: "https://secret.example/bedrock" }],
    ["vertex", { ANTHROPIC_VERTEX_BASE_URL: "https://secret.example/vertex" }],
    ["foundry", { ANTHROPIC_FOUNDRY_BASE_URL: "https://secret.example/foundry" }],
    ["mantle", { CLAUDE_CODE_USE_MANTLE: "1" }],
  ] as const)("%s env signal is effective transport, not the BYOK provider", (id, extra) => {
    const env = { ANTHROPIC_API_KEY: "sk-secret-key", ...extra }
    const p = projectLlmTransport({
      transport: undefined,
      env,
      credentialProvider: "anthropic",
    })
    expect(p.credentialProvider).toBe("anthropic")
    expect(p.effective).toEqual({ kind: "multicloud", providerId: id })
    expect(p.effectiveId).toBe(id)
    expect(p.reason).toBe("env-signal")
    expect(selectLlmTransport({ transport: undefined, env }).kind).toBe("multicloud")
    noSecrets(p)
  })

  test("explicit QUANTA_LLM_TRANSPORT wins and records requested", () => {
    const p = projectLlmTransport({
      transport: "vertex",
      env: { ANTHROPIC_BEDROCK_BASE_URL: "https://secret.example/bedrock" },
      credentialProvider: "openai",
    })
    expect(p.requestedTransport).toBe("vertex")
    expect(p.credentialProvider).toBe("openai")
    expect(p.effectiveId).toBe("vertex")
    expect(p.reason).toBe("explicit-transport")
    noSecrets(p)
  })
})

describe("E-PROV-01 status boot snapshot vs doctor current", () => {
  test("live status prints boot snapshot even when current env would differ", async () => {
    const boot = projectLlmTransport({
      transport: "bedrock",
      env: {},
      credentialProvider: "anthropic",
    })
    const out: string[] = []
    const cmd = buildStatusCmd({
      env: {
        QUANTA_PREFS_HOME: "/tmp/r15-missing-prefs",
        CODEX_HOME: "/tmp/r15-missing-codex",
        QUANTA_LLM_TRANSPORT: "vertex",
        ANTHROPIC_API_KEY: "sk-secret",
      },
      bootProjection: boot,
      nowMs: () => 0,
    })
    await cmd.run([], {
      out: (s) => out.push(s),
      err: () => {},
      cwd: "/tmp",
      prefsHome: "/tmp/r15-missing-prefs",
    } as never)
    const text = out.join("")
    expect(text).toContain("bedrock")
    expect(text).not.toContain("vertex")
    expect(text).not.toContain("sk-secret")
  })

  test("doctor auth detail uses current resolver transport", async () => {
    const probes: DoctorProbes = {
      now: () => 0,
      auth: async () => {
        const p = projectLlmTransport({
          transport: "foundry",
          env: {},
          credentialProvider: "anthropic",
        })
        return {
          provider: p.credentialProvider,
          keyPresent: true,
          effectiveTransport: p.effectiveId,
          transportReason: p.reason,
        }
      },
      terminal: () => ({ isTTY: true, columns: 80, rawModeAvailable: true }),
      mcp: async () => [],
      config: () => ({ loaded: true, warnings: [] }),
      stateDb: async () => ({ sessionsReadable: true, indexValid: true, memoryReadable: true }),
      storeHealth: async () => ({
        verdict: "healthy",
        total: 0,
        ok: 0,
        corrupt: 0,
        unreadable: 0,
      }),
    }
    const results = await runDoctor(probes)
    const auth = results.find((r) => r.id === "auth")
    expect(auth?.detail).toContain("anthropic")
    expect(auth?.detail).toContain("foundry")
    expect(auth?.detail).toContain("explicit-transport")
  })

  test("defaultDoctorProbes auth uses current resolver, not pickProvider as transport", async () => {
    const prev = {
      QUANTA_LLM_TRANSPORT: process.env.QUANTA_LLM_TRANSPORT,
      QUANTA_PROVIDER: process.env.QUANTA_PROVIDER,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_BEDROCK_BASE_URL: process.env.ANTHROPIC_BEDROCK_BASE_URL,
      ANTHROPIC_VERTEX_BASE_URL: process.env.ANTHROPIC_VERTEX_BASE_URL,
      ANTHROPIC_FOUNDRY_BASE_URL: process.env.ANTHROPIC_FOUNDRY_BASE_URL,
      CLAUDE_CODE_USE_MANTLE: process.env.CLAUDE_CODE_USE_MANTLE,
    }
    const restore = (key: keyof typeof prev): void => {
      const v = prev[key]
      if (v === undefined) delete process.env[key]
      else process.env[key] = v
    }
    try {
      process.env.QUANTA_PROVIDER = "anthropic"
      process.env.QUANTA_LLM_TRANSPORT = "vertex"
      process.env.ANTHROPIC_API_KEY = "sk-secret-doctor"
      delete process.env.ANTHROPIC_BEDROCK_BASE_URL
      delete process.env.ANTHROPIC_VERTEX_BASE_URL
      delete process.env.ANTHROPIC_FOUNDRY_BASE_URL
      delete process.env.CLAUDE_CODE_USE_MANTLE
      const probes = defaultDoctorProbes({
        out: () => {},
        err: () => {},
        cwd: "/tmp",
        prefsHome: "/tmp/r15-missing-prefs",
      })
      const auth = await probes.auth()
      expect(auth.provider).toBe("anthropic")
      expect(auth.effectiveTransport).toBe("vertex")
      expect(auth.transportReason).toBe("explicit-transport")
      expect(JSON.stringify(auth)).not.toContain("sk-secret-doctor")
    } finally {
      restore("QUANTA_LLM_TRANSPORT")
      restore("QUANTA_PROVIDER")
      restore("ANTHROPIC_API_KEY")
      restore("ANTHROPIC_BEDROCK_BASE_URL")
      restore("ANTHROPIC_VERTEX_BASE_URL")
      restore("ANTHROPIC_FOUNDRY_BASE_URL")
      restore("CLAUDE_CODE_USE_MANTLE")
    }
  })
})
