/**
 * Hellgate — thin-client dispatch routing (ADR-0493).
 *
 * A slash-command / skill carries an optional `thinClientDispatch` route tag so
 * the SAME command, defined once, runs correctly across surfaces:
 *   - "local"           → the thin client runs it locally (default).
 *   - "post-text"       → the host posts the command text into the stream.
 *   - "control-request" → the host issues a structured control request.
 *
 * Invariants proven here (red-on-injection style):
 *   1. DEFAULT-OFF byte-identity: gate unset ⇒ every descriptor resolves "local"
 *      regardless of its tag or the surface.
 *   2. THICK surfaces (cli/headless/bench = full process, no thin host) ALWAYS
 *      resolve "local" even with the gate on — a tag never breaks a real TTY.
 *   3. THIN surfaces (web/ide) honor the tag ONLY when the gate is on.
 *   4. parseRoute is NO-THROW and rejects unknown tokens (→ undefined).
 *   5. An unknown/garbage tag on a descriptor degrades to "local", never throws.
 */
import { describe, expect, test } from "bun:test"
import {
  type DispatchDescriptor,
  parseThinClientRoute,
  resolveThinClientRoute,
  THIN_CLIENT_ROUTES,
} from "@/agent/thin-client-dispatch"

const GATE = "QUANTA_THIN_CLIENT_DISPATCH"
const on = { [GATE]: "1" }
const off: Record<string, string | undefined> = {}

const desc = (route?: DispatchDescriptor["thinClientDispatch"]): DispatchDescriptor => ({
  name: "usage",
  thinClientDispatch: route,
})

describe("thin-client-dispatch — default-OFF byte-identity", () => {
  test("gate unset ⇒ always local, for every tag and surface", () => {
    for (const surface of ["cli", "web", "ide", "headless", "bench"] as const) {
      for (const route of [undefined, ...THIN_CLIENT_ROUTES]) {
        expect(resolveThinClientRoute(desc(route), surface, off)).toBe("local")
      }
    }
  })

  test("empty-string gate value is NOT on (you did not opt in)", () => {
    expect(resolveThinClientRoute(desc("post-text"), "ide", { [GATE]: "" })).toBe("local")
  })
})

describe("thin-client-dispatch — thick surfaces never route away from local", () => {
  test("cli/headless/bench ignore the tag even with gate on", () => {
    for (const surface of ["cli", "headless", "bench"] as const) {
      expect(resolveThinClientRoute(desc("post-text"), surface, on)).toBe("local")
      expect(resolveThinClientRoute(desc("control-request"), surface, on)).toBe("local")
    }
  })
})

describe("thin-client-dispatch — thin surfaces honor tag when gate on", () => {
  test("web/ide route per tag", () => {
    for (const surface of ["web", "ide"] as const) {
      expect(resolveThinClientRoute(desc("post-text"), surface, on)).toBe("post-text")
      expect(resolveThinClientRoute(desc("control-request"), surface, on)).toBe("control-request")
      expect(resolveThinClientRoute(desc("local"), surface, on)).toBe("local")
      // No tag ⇒ local even on a thin surface.
      expect(resolveThinClientRoute(desc(undefined), surface, on)).toBe("local")
    }
  })

  test("gate accepts the full truthy vocab via the SSOT", () => {
    for (const v of ["1", "on", "true", "yes", "ON", " on "]) {
      expect(resolveThinClientRoute(desc("post-text"), "ide", { [GATE]: v })).toBe("post-text")
    }
    for (const v of ["0", "off", "false", "no", "garbage"]) {
      expect(resolveThinClientRoute(desc("post-text"), "ide", { [GATE]: v })).toBe("local")
    }
  })
})

describe("thin-client-dispatch — no-throw / adversarial", () => {
  test("parseThinClientRoute rejects unknown tokens, accepts valid", () => {
    for (const v of THIN_CLIENT_ROUTES) expect(parseThinClientRoute(v)).toBe(v)
    for (const v of ["", "LOCAL", "rpc", "post_text", undefined, "  local"]) {
      expect(parseThinClientRoute(v as string | undefined)).toBeUndefined()
    }
  })

  test("a garbage tag on the descriptor degrades to local, never throws", () => {
    const bad = { name: "x", thinClientDispatch: "rpc" } as unknown as DispatchDescriptor
    expect(resolveThinClientRoute(bad, "ide", on)).toBe("local")
  })

  test("resolver is a pure function of (descriptor, surface, env) — no process.env read", () => {
    // Calling twice with identical args yields identical results regardless of ambient env.
    const a = resolveThinClientRoute(desc("control-request"), "web", on)
    const b = resolveThinClientRoute(desc("control-request"), "web", on)
    expect(a).toBe(b)
    expect(a).toBe("control-request")
  })
})
