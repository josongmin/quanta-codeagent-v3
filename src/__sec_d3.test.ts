import { describe, expect, it } from "bun:test"
import { buildPtyEnv } from "@/host/runtime/pty-backend"

describe("D3 PTY env scrub", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    OPENAI_API_KEY: "sk-secret",
    AWS_SECRET_ACCESS_KEY: "topsecret",
    GITHUB_TOKEN: "ghp_x",
    RANDOM_VAR: "v",
  }

  it("scrubbed default drops secrets even when declared tries to smuggle", () => {
    const env = buildPtyEnv({
      parentEnv: parent,
      declared: { PATH: "/attacker", SECRET_KEY: "x", OPENAI_API_KEY: "sk2" },
      inheritEnv: false,
    })
    expect(env.SECRET_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.RANDOM_VAR).toBeUndefined()
    // allowlisted PATH overlay DOES pass (model controls argv anyway)
    expect(env.PATH).toBe("/attacker")
  })

  it("inheritEnv opt-out passes full env including secrets (documented escape hatch)", () => {
    const env = buildPtyEnv({ parentEnv: parent, declared: undefined, inheritEnv: true })
    expect(env.OPENAI_API_KEY).toBe("sk-secret")
  })

  it("case-variant secret name is NOT dropped if not in allowlist comparison", () => {
    // probe: lowercase / mixed-case secret-ish names
    const env = buildPtyEnv({
      parentEnv: { ...parent, openai_api_key: "lower", Aws_Secret: "mixed" },
      declared: undefined,
      inheritEnv: false,
    })
    // these are not in the allowlist so should be dropped (allowlist is exact)
    expect(env.openai_api_key).toBeUndefined()
    expect(env.Aws_Secret).toBeUndefined()
  })
})
