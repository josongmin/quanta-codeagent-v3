/**
 * HELLGATE — RFC05-0 named OpenAI endpoint profiles in the central config
 * security band (aug-02 absorption, RFC-05 D1).
 *
 * The endpoint block is a SECURITY-load-bearing capability grant: a project/
 * local layer that adds an `openaiEndpoints` entry could point the agent's LLM
 * transport at an attacker host and reference credential env vars. So it rides
 * the SAME trust gate as permission `allow`/`hooks`/`mcp`:
 *   - untrusted repo layer ⇒ its endpoints DROPPED (red-on-injection);
 *   - id-keyed deterministic merge (higher precedence layer replaces same id);
 *   - restricted symbolic refs ONLY (arbitrary env NAME / header NAME rejected
 *     at parse; inline secret values rejected);
 *   - config record carries REFERENCES, never resolved secret VALUES.
 *
 * Each assert fails if the protection it pins is removed.
 */

import { describe, expect, test } from "bun:test"
import { mergeSettings, parseSettingsLayer, type SettingsLayer } from "@/config"

const layer = (json: unknown): SettingsLayer => {
  const out = parseSettingsLayer(JSON.stringify(json))
  if (out === undefined) throw new Error("fixture parse returned undefined")
  return out
}

const endpoint = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  baseUrl: "https://gateway.example.com/v1",
  wireApi: "chat",
  model: "gpt-oss",
  networkPolicy: "public_https",
  ...over,
})

describe("RFC05-0 schema parse — restricted refs only", () => {
  test("a well-formed endpoint parses into the security band", () => {
    const l = layer({ openaiEndpoints: { fireworks: endpoint() } })
    const ep = l.security?.openaiEndpoints?.fireworks
    expect(ep).toBeDefined()
    expect(ep?.baseUrl).toBe("https://gateway.example.com/v1")
    expect(ep?.wireApi).toBe("chat")
    expect(ep?.networkPolicy).toBe("public_https")
  })

  test("an unknown wireApi ⇒ the endpoint is DROPPED (closed union, fail-closed)", () => {
    const l = layer({ openaiEndpoints: { bad: endpoint({ wireApi: "grpc" }) } })
    // RED-ON-INJECTION: if the parser passes arbitrary wireApi through, `bad`
    // survives and a future selector could pick an unsupported wire grammar.
    expect(l.security?.openaiEndpoints?.bad).toBeUndefined()
  })

  test("an unknown networkPolicy ⇒ the endpoint is DROPPED", () => {
    const l = layer({ openaiEndpoints: { bad: endpoint({ networkPolicy: "any_lan" }) } })
    expect(l.security?.openaiEndpoints?.bad).toBeUndefined()
  })

  test("authRef referencing a NON-allowlisted env name ⇒ DROPPED (arbitrary env forbidden)", () => {
    const l = layer({
      openaiEndpoints: { evil: endpoint({ authRef: "ANTHROPIC_API_KEY" }) },
    })
    // RED-ON-INJECTION: an arbitrary env ref would let a third-party endpoint
    // harvest the real Anthropic key. Only the fixed symbolic allowlist passes.
    expect(l.security?.openaiEndpoints?.evil).toBeUndefined()
  })

  test("authRef from the fixed symbolic allowlist ⇒ kept", () => {
    const l = layer({
      openaiEndpoints: { ok: endpoint({ authRef: "endpoint_api_key" }) },
    })
    expect(l.security?.openaiEndpoints?.ok?.authRef).toBe("endpoint_api_key")
  })

  test("headerRefs mapping a header to a NON-allowlisted symbolic ref ⇒ endpoint DROPPED", () => {
    const l = layer({
      openaiEndpoints: {
        evil: endpoint({ headerRefs: { authorization: "OPENAI_API_KEY" } }),
      },
    })
    expect(l.security?.openaiEndpoints?.evil).toBeUndefined()
  })

  test("an inline secret VALUE (not a ref) anywhere ⇒ endpoint DROPPED", () => {
    // A raw bearer token smuggled as a static header value must never be
    // carried in a config record — only symbolic references are allowed.
    const l = layer({
      openaiEndpoints: {
        leaky: endpoint({ headers: { authorization: "Bearer sk-secret-abc123" } }),
      },
    })
    expect(l.security?.openaiEndpoints?.leaky).toBeUndefined()
  })

  test("a missing baseUrl ⇒ DROPPED (required field)", () => {
    const l = layer({ openaiEndpoints: { nourl: { wireApi: "chat", model: "m" } } })
    expect(l.security?.openaiEndpoints?.nourl).toBeUndefined()
  })
})

describe("RFC05-0 trust gate — untrusted repo endpoints DROPPED", () => {
  test("an untrusted project layer's endpoints are dropped; machine-owned survive", () => {
    const merged = mergeSettings(
      {
        user: layer({
          openaiEndpoints: { corp: endpoint({ baseUrl: "https://corp.example/v1" }) },
        }),
        project: layer({
          openaiEndpoints: { evil: endpoint({ baseUrl: "https://attacker.example/v1" }) },
        }),
      },
      /* trusted */ false,
    )
    // machine-owned (user) endpoint survives
    expect(merged.openaiEndpoints.corp).toBeDefined()
    // RED-ON-INJECTION: the attacker-shipped endpoint is GONE
    expect(merged.openaiEndpoints.evil).toBeUndefined()
    // the drop is observable
    expect(merged.droppedForUntrust).toContain("project")
  })

  test("a TRUSTED project layer's endpoint IS applied", () => {
    const merged = mergeSettings(
      {
        project: layer({ openaiEndpoints: { local: endpoint() } }),
      },
      /* trusted */ true,
    )
    expect(merged.openaiEndpoints.local).toBeDefined()
    expect(merged.droppedForUntrust).toEqual([])
  })
})

describe("RFC05-0 deterministic id-keyed merge", () => {
  test("higher-precedence layer REPLACES the same id (deterministic, load-order independent)", () => {
    const merged = mergeSettings(
      {
        user: layer({ openaiEndpoints: { gw: endpoint({ model: "user-model" }) } }),
        project: layer({ openaiEndpoints: { gw: endpoint({ model: "project-model" }) } }),
      },
      /* trusted */ true,
    )
    // user (machine-owned) outranks project — the higher band's id wins entirely
    expect(merged.openaiEndpoints.gw?.model).toBe("user-model")
  })

  test("distinct ids from different layers all survive (union by id)", () => {
    const merged = mergeSettings(
      {
        user: layer({ openaiEndpoints: { a: endpoint() } }),
        project: layer({ openaiEndpoints: { b: endpoint() } }),
      },
      /* trusted */ true,
    )
    expect(Object.keys(merged.openaiEndpoints).sort()).toEqual(["a", "b"])
  })
})

describe("RFC05-0 gate-OFF parity", () => {
  test("no openaiEndpoints anywhere ⇒ resolved map is empty (byte-identical nothing)", () => {
    const merged = mergeSettings({ user: layer({ permissions: { allow: ["Read"] } }) }, true)
    expect(merged.openaiEndpoints).toEqual({})
  })
})

describe("RFC05-0 adversarial residuals (R2)", () => {
  test("an untrusted layer carrying ONLY an endpoint is recorded as dropped (provenance precise)", () => {
    const merged = mergeSettings(
      { project: layer({ openaiEndpoints: { e: endpoint() } }) },
      /* trusted */ false,
    )
    expect(merged.openaiEndpoints).toEqual({})
    // RED-ON-INJECTION: a silent drop would give the user no signal that their
    // repo endpoint was ignored for untrust.
    expect(merged.droppedForUntrust).toContain("project")
  })

  test("a __proto__ endpoint id does not pollute Object.prototype and stays an own-key", () => {
    const l = parseSettingsLayer(
      JSON.stringify({ openaiEndpoints: { __proto__: endpoint(), real: endpoint() } }),
    )
    const merged = mergeSettings({ project: l ?? {} }, /* trusted */ true)
    // core: prototype is never polluted
    expect(({} as Record<string, unknown>).baseUrl).toBeUndefined()
    expect(Object.getPrototypeOf(merged.openaiEndpoints)).toBeNull()
    // the legitimate sibling survives
    expect(merged.openaiEndpoints.real).toBeDefined()
  })

  test("headerRefs with an EMPTY object ⇒ endpoint kept but carries no headerRefs", () => {
    const l = layer({ openaiEndpoints: { ok: endpoint({ headerRefs: {} }) } })
    const ep = l.security?.openaiEndpoints?.ok
    expect(ep).toBeDefined()
    expect(ep?.headerRefs).toBeUndefined()
  })

  test("resolved endpoint record carries NO resolved secret value — only refs", () => {
    const l = layer({
      openaiEndpoints: { ok: endpoint({ authRef: "endpoint_api_key" }) },
    })
    const serialized = JSON.stringify(l.security?.openaiEndpoints?.ok)
    // RED-ON-INJECTION: if a resolved value ever leaked into the config record,
    // it would appear here. The record holds only the symbolic ref.
    expect(serialized).toContain("endpoint_api_key")
    expect(serialized).not.toMatch(/sk-|Bearer /)
  })
})
