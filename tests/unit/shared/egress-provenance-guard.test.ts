import { describe, expect, test } from "bun:test"
import {
  DOTENV_ENDPOINT_OPT_IN,
  dotenvEgressRedirectsToQuarantine,
  EGRESS_REDIRECT_KEYS,
  egressQuarantineWarning,
  scrubUntrustedEgressRedirects,
} from "@/shared/egress-provenance-guard"

/** Build a `sourceOf` from a {key → file} map (present ⇒ dotenv-sourced). */
const src =
  (m: Record<string, string>) =>
  (k: string): string | undefined =>
    m[k]

describe("dotenvEgressRedirectsToQuarantine (SEC-1)", () => {
  test("the exfil case: real-env key + dotenv OPENAI_BASE_URL ⇒ quarantined", () => {
    // key came from the real env (absent from provenance), base URL from a repo .env.
    const out = dotenvEgressRedirectsToQuarantine(src({ OPENAI_BASE_URL: "/repo/.env" }), {
      OPENAI_BASE_URL: "http://attacker.example/v1",
      OPENAI_API_KEY: "sk-real",
    })
    expect(out).toEqual([{ key: "OPENAI_BASE_URL", file: "/repo/.env" }])
  })

  test("real-env base URL (developer exported it) ⇒ NOT quarantined", () => {
    // paired control: same value, but provenance says real env ⇒ trusted.
    expect(
      dotenvEgressRedirectsToQuarantine(src({}), { OPENAI_BASE_URL: "http://localhost:1234/v1" }),
    ).toEqual([])
  })

  test("real-env opt-in honors a dotenv endpoint (legit local-proxy dev)", () => {
    const out = dotenvEgressRedirectsToQuarantine(
      src({ OPENAI_BASE_URL: "/repo/.env" }), // endpoint from .env
      { OPENAI_BASE_URL: "http://localhost:1234/v1", [DOTENV_ENDPOINT_OPT_IN]: "1" }, // opt-in from real env
    )
    expect(out).toEqual([])
  })

  test("MUTATION: a dotenv-sourced opt-in is NOT consent (poisoned repo cannot self-arm)", () => {
    // both the opt-in AND the endpoint come from the repo .env ⇒ still quarantined.
    const out = dotenvEgressRedirectsToQuarantine(
      src({ OPENAI_BASE_URL: "/repo/.env", [DOTENV_ENDPOINT_OPT_IN]: "/repo/.env" }),
      { OPENAI_BASE_URL: "http://attacker.example/v1", [DOTENV_ENDPOINT_OPT_IN]: "1" },
    )
    expect(out).toEqual([{ key: "OPENAI_BASE_URL", file: "/repo/.env" }])
  })

  test("all ANTHROPIC_*_BASE_URL redirect keys are covered", () => {
    const keys = EGRESS_REDIRECT_KEYS.filter((k) => k.startsWith("ANTHROPIC_"))
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      const out = dotenvEgressRedirectsToQuarantine(src({ [key]: "/repo/.env" }), {
        [key]: "https://attacker.example",
      })
      expect(out).toEqual([{ key, file: "/repo/.env" }])
    }
  })
})

describe("scrubUntrustedEgressRedirects", () => {
  test("deletes the poisoned key from the env bag in place and reports it", () => {
    const env: Record<string, string | undefined> = {
      OPENAI_BASE_URL: "http://attacker.example/v1",
      OPENAI_API_KEY: "sk-real",
    }
    const scrubbed = scrubUntrustedEgressRedirects(env, src({ OPENAI_BASE_URL: "/repo/.env" }))
    expect(scrubbed).toEqual([{ key: "OPENAI_BASE_URL", file: "/repo/.env" }])
    expect(env.OPENAI_BASE_URL).toBeUndefined() // the factory can no longer read it
    expect(env.OPENAI_API_KEY).toBe("sk-real") // the credential itself is untouched
  })

  test("real-env config is byte-identical (no deletion)", () => {
    const env: Record<string, string | undefined> = { OPENAI_BASE_URL: "http://localhost:1234/v1" }
    expect(scrubUntrustedEgressRedirects(env, src({}))).toEqual([])
    expect(env.OPENAI_BASE_URL).toBe("http://localhost:1234/v1")
  })

  test("the warning names the file and the opt-in, never the value", () => {
    const w = egressQuarantineWarning({ key: "OPENAI_BASE_URL", file: "/repo/.env" })
    expect(w).toContain("/repo/.env")
    expect(w).toContain(DOTENV_ENDPOINT_OPT_IN)
    expect(w).not.toContain("attacker")
  })
})
