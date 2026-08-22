/**
 * ADR-0312 — webhook secret RESOLVER unit battery (pure, no HTTP).
 *
 * Crisp coverage of the PATH-routing discriminator + the config-parse edge
 * cases the host-level hellgate exercises only end-to-end: inline/file map
 * parsing, fail-closed degradation, precedence, and prototype-pollution safety
 * (keys flow through a Map, never object property access).
 */

import { describe, expect, test } from "bun:test"
import { extractAppKey, loadWebhookSecretConfig, type WebhookRequest } from "@/integrations/github"

const req = (path: string): WebhookRequest => ({
  method: "POST",
  path,
  headers: {},
  body: new Uint8Array(0),
})

describe("extractAppKey — PATH discriminator", () => {
  test("bare /webhook → undefined (legacy)", () => {
    expect(extractAppKey("/webhook")).toBeUndefined()
  })
  test("/webhook/appA → 'appA'", () => {
    expect(extractAppKey("/webhook/appA")).toBe("appA")
  })
  test("empty segment /webhook/ → undefined", () => {
    expect(extractAppKey("/webhook/")).toBeUndefined()
  })
  test("nested /webhook/a/b → undefined (single segment only — blocks traversal)", () => {
    expect(extractAppKey("/webhook/a/b")).toBeUndefined()
    expect(extractAppKey("/webhook/../etc")).toBeUndefined()
  })
  test("unrelated path → undefined", () => {
    expect(extractAppKey("/other")).toBeUndefined()
    expect(extractAppKey("/webhookx")).toBeUndefined()
  })
})

describe("loadWebhookSecretConfig — inline map", () => {
  test("parses key=secret pairs; resolver routes by path key", () => {
    const cfg = loadWebhookSecretConfig({
      env: { QUANTA_GITHUB_WEBHOOK_SECRETS: "appA=secretA,appB=secretB" },
    })
    expect(cfg.mode).toBe("map")
    expect([...cfg.appKeys].sort()).toEqual(["appA", "appB"])
    expect(cfg.resolver(req("/webhook/appA"))).toBe("secretA")
    expect(cfg.resolver(req("/webhook/appB"))).toBe("secretB")
    // unknown key + bare path → undefined (fail closed)
    expect(cfg.resolver(req("/webhook/ghost"))).toBeUndefined()
    expect(cfg.resolver(req("/webhook"))).toBeUndefined()
  })

  test("base64 secret with '=' padding survives (split on FIRST '=')", () => {
    const cfg = loadWebhookSecretConfig({
      env: { QUANTA_GITHUB_WEBHOOK_SECRETS: "k=YWJjZA==" },
    })
    expect(cfg.resolver(req("/webhook/k"))).toBe("YWJjZA==")
  })

  test("whitespace around entries is trimmed", () => {
    const cfg = loadWebhookSecretConfig({
      env: { QUANTA_GITHUB_WEBHOOK_SECRETS: "  appA = secretA , appB=secretB " },
    })
    expect(cfg.resolver(req("/webhook/appA"))).toBe("secretA")
    expect(cfg.resolver(req("/webhook/appB"))).toBe("secretB")
  })

  test("malformed entries (no '=', empty key, empty value) are dropped + logged (no value leak)", () => {
    const errs: string[] = []
    const cfg = loadWebhookSecretConfig({
      env: { QUANTA_GITHUB_WEBHOOK_SECRETS: "garbage,=noKey,emptyVal=,good=g" },
      onError: (m) => errs.push(m),
    })
    expect(cfg.mode).toBe("map")
    expect(cfg.appKeys).toEqual(["good"])
    expect(cfg.resolver(req("/webhook/good"))).toBe("g")
    expect(errs.length).toBeGreaterThanOrEqual(3)
    // the dropped SECRET values must never appear in diagnostics
    expect(errs.join("|").includes("noKey")).toBe(false)
  })

  test("duplicate key → BOTH refused (poisoned), siblings survive", () => {
    const errs: string[] = []
    const cfg = loadWebhookSecretConfig({
      env: { QUANTA_GITHUB_WEBHOOK_SECRETS: "dup=one,dup=two,ok=fine" },
      onError: (m) => errs.push(m),
    })
    expect(cfg.resolver(req("/webhook/dup"))).toBeUndefined()
    expect(cfg.resolver(req("/webhook/ok"))).toBe("fine")
    expect(errs.some((e) => e.includes("duplicate key 'dup'"))).toBe(true)
  })

  test("__proto__/constructor keys resolve via Map — no prototype pollution", () => {
    const cfg = loadWebhookSecretConfig({
      env: { QUANTA_GITHUB_WEBHOOK_SECRETS: "__proto__=p,constructor=c" },
    })
    expect(cfg.resolver(req("/webhook/__proto__"))).toBe("p")
    expect(cfg.resolver(req("/webhook/constructor"))).toBe("c")
    // global prototype is intact
    expect(({} as Record<string, unknown>).p).toBeUndefined()
  })
})

describe("loadWebhookSecretConfig — JSON file map (injected reader)", () => {
  test("valid object resolves per key", () => {
    const cfg = loadWebhookSecretConfig({
      env: { QUANTA_GITHUB_WEBHOOK_SECRETS_FILE: "/x.json" },
      readFile: () => JSON.stringify({ appA: "sA", appB: "sB" }),
    })
    expect(cfg.mode).toBe("map")
    expect(cfg.resolver(req("/webhook/appA"))).toBe("sA")
  })

  test("invalid JSON → empty map → fail-closed 'none'", () => {
    const errs: string[] = []
    const cfg = loadWebhookSecretConfig({
      env: { QUANTA_GITHUB_WEBHOOK_SECRETS_FILE: "/x.json" },
      readFile: () => "{not json",
      onError: (m) => errs.push(m),
    })
    expect(cfg.mode).toBe("none")
    expect(errs.some((e) => e.includes("invalid JSON"))).toBe(true)
  })

  test("array / non-object JSON → none", () => {
    const cfg = loadWebhookSecretConfig({
      env: { QUANTA_GITHUB_WEBHOOK_SECRETS_FILE: "/x.json" },
      readFile: () => "[1,2,3]",
    })
    expect(cfg.mode).toBe("none")
  })

  test("non-string / empty values are skipped", () => {
    const cfg = loadWebhookSecretConfig({
      env: { QUANTA_GITHUB_WEBHOOK_SECRETS_FILE: "/x.json" },
      readFile: () => JSON.stringify({ a: "ok", b: 42, c: "" }),
    })
    expect(cfg.appKeys).toEqual(["a"])
    expect(cfg.resolver(req("/webhook/a"))).toBe("ok")
    expect(cfg.resolver(req("/webhook/b"))).toBeUndefined()
  })

  test("reader throws → fail-closed none", () => {
    const cfg = loadWebhookSecretConfig({
      env: { QUANTA_GITHUB_WEBHOOK_SECRETS_FILE: "/missing.json" },
      readFile: () => {
        throw new Error("ENOENT")
      },
    })
    expect(cfg.mode).toBe("none")
  })

  test("file configured but no reader available → none (logged)", () => {
    const errs: string[] = []
    const cfg = loadWebhookSecretConfig({
      env: { QUANTA_GITHUB_WEBHOOK_SECRETS_FILE: "/x.json" },
      onError: (m) => errs.push(m),
    })
    expect(cfg.mode).toBe("none")
    expect(errs.some((e) => e.includes("no file reader"))).toBe(true)
  })
})

describe("loadWebhookSecretConfig — precedence + fallback + fail-closed", () => {
  test("inline map WINS over file map", () => {
    const cfg = loadWebhookSecretConfig({
      env: {
        QUANTA_GITHUB_WEBHOOK_SECRETS: "appA=fromInline",
        QUANTA_GITHUB_WEBHOOK_SECRETS_FILE: "/x.json",
      },
      readFile: () => JSON.stringify({ appA: "fromFile" }),
    })
    expect(cfg.resolver(req("/webhook/appA"))).toBe("fromInline")
  })

  test("no map → single secret fallback (mode 'single', byte-compat)", () => {
    const cfg = loadWebhookSecretConfig({
      env: { QUANTA_GITHUB_WEBHOOK_SECRET: "shared" },
    })
    expect(cfg.mode).toBe("single")
    // single mode returns the one secret for ANY accepted path
    expect(cfg.resolver(req("/webhook"))).toBe("shared")
    expect(cfg.resolver(req("/webhook/whatever"))).toBe("shared")
  })

  test("map configured but ZERO usable entries → 'none' (NOT silent single-secret degrade)", () => {
    const cfg = loadWebhookSecretConfig({
      // map present but all-malformed AND a single secret also set: must NOT
      // silently fall back to the single secret — operator must fix the map.
      env: {
        QUANTA_GITHUB_WEBHOOK_SECRETS: "garbage,alsoGarbage",
        QUANTA_GITHUB_WEBHOOK_SECRET: "shared",
      },
    })
    expect(cfg.mode).toBe("none")
    expect(cfg.resolver(req("/webhook"))).toBeUndefined()
  })

  test("nothing configured → 'none', resolver yields undefined", () => {
    const cfg = loadWebhookSecretConfig({ env: {} })
    expect(cfg.mode).toBe("none")
    expect(cfg.resolver(req("/webhook"))).toBeUndefined()
  })
})
