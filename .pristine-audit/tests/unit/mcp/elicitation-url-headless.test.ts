/** TICKET-22 hellgate (NEW, red-first) — the URL elicitation variant
 *  (`promptUrl`) under HEADLESS conditions.
 *
 *  The url variant renders a server-supplied URL and offers to open it in the
 *  user's browser. In a headless session there is no TTY and the safe default
 *  is the same as every other prompt: a typed `headless-denied` failure — and,
 *  critically, NO process is ever spawned (no surprise `open`/`xdg-open`).
 *
 *  Coverage:
 *   - headlessRejecter.promptUrl → { ok:false, reason:'headless-denied' };
 *   - SPAWN-SPY: a `node:child_process.spawn` spy proves NO process launched on
 *     the headless path (RED-ON-INJECTION — fails if the rejecter ever opens a
 *     browser);
 *   - schema SECURITY: non-http(s) urls (file:/javascript:/data:) are rejected
 *     by `urlRequestSchema`, http/https accepted.
 */

import { describe, expect, it, spyOn } from "bun:test"
import childProcess from "node:child_process"
import { headlessRejecter, type UrlRequest, urlRequestSchema } from "@/mcp"

describe("TICKET-22 — headlessRejecter.promptUrl", () => {
  it("resolves to ok:false reason:headless-denied", async () => {
    const r = await headlessRejecter.promptUrl({ prompt: "open?", url: "https://example.com" })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toBe("headless-denied")
  })

  it("RED-ON-INJECTION: spawn-spy proves NO process was launched on the headless path", async () => {
    const spawnSpy = spyOn(childProcess, "spawn")
    try {
      const r = await headlessRejecter.promptUrl({ prompt: "open?", url: "https://example.com" })
      expect(r.ok).toBe(false)
      // The headless rejecter must NEVER open a browser — zero spawns.
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      spawnSpy.mockRestore()
    }
  })
})

describe("TICKET-22 — urlRequestSchema SECURITY (http/https only)", () => {
  it("accepts http and https urls", () => {
    expect(urlRequestSchema.safeParse({ prompt: "p", url: "https://example.com" }).success).toBe(
      true,
    )
    expect(
      urlRequestSchema.safeParse({ prompt: "p", url: "http://localhost:3000/x" }).success,
    ).toBe(true)
  })

  it("rejects file:/javascript:/data: and non-url garbage", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "ftp://example.com",
      "not a url",
      "",
    ]) {
      expect(urlRequestSchema.safeParse({ prompt: "p", url }).success).toBe(false)
    }
  })

  it("a parsed UrlRequest is structurally what the prompter consumes", () => {
    const parsed = urlRequestSchema.safeParse({
      prompt: "Open the dashboard?",
      title: "dashboard",
      url: "https://example.com/dash",
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) throw new Error("unreachable")
    const req: UrlRequest = parsed.data
    expect(req.url).toBe("https://example.com/dash")
    expect(req.title).toBe("dashboard")
  })
})
