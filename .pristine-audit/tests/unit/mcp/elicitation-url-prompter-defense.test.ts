/** TICKET-22 follow-up (mcp finding [36]) — cliPrompter.promptUrl
 *  DEFENSE-IN-DEPTH. urlRequestSchema rejects non-http(s) urls at parse time,
 *  but a caller that constructs a `UrlRequest` directly (bypassing the schema)
 *  must STILL never have a `file:`/`javascript:`/`data:` url handed to the
 *  system opener. `validateUrl` exists for exactly this second layer; this pins
 *  that it is actually wired into the live prompter path.
 */
import { describe, expect, it } from "bun:test"
import { cliPrompter, type UrlRequest } from "@/mcp"

// A confirming IO: the user always answers "y" (open it).
const confirmingIo = () => ({ write: () => {}, read: async () => "y" })

describe("cliPrompter.promptUrl — non-http rejected past the schema", () => {
  it("a schema-bypassing non-http(s) url is NEVER opened (even on user confirm)", async () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://x",
    ]) {
      const opened: string[] = []
      const prompter = cliPrompter(confirmingIo(), (u) => opened.push(u))
      const r = await prompter.promptUrl({ prompt: "open?", url } as UrlRequest)
      expect(r.ok).toBe(false)
      expect(opened).toEqual([])
    }
  })

  it("a valid https url IS opened after confirmation (happy path intact)", async () => {
    const opened: string[] = []
    const prompter = cliPrompter(confirmingIo(), (u) => opened.push(u))
    const r = await prompter.promptUrl({
      prompt: "open?",
      url: "https://example.com",
    } as UrlRequest)
    expect(r.ok).toBe(true)
    expect(opened).toEqual(["https://example.com"])
  })
})
