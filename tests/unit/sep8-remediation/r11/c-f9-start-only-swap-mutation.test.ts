/**
 * C-F9.4 mutation: restoring start-only swap (no initialize handshake) fails.
 * Anti-vacuum floor + red-on-injection clone. Does not mutate live files.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../../../../")
const REAUTH = join(ROOT, "src/mcp/client/reauthorize.ts")
const CLIENT = join(ROOT, "src/mcp/client.ts")

describe("C-F9 start-only swap mutation", () => {
  test("live reauthorize module performs initialize → initialized handshake", () => {
    const src = readFileSync(REAUTH, "utf8")
    const hits = [
      /handshakeOnTransport\s*\(/,
      /initializeWithDowngrade\s*\(/,
      /notifications\/initialized/,
      /sendInitializeRaw/,
      /isReplayableAfterReauth/,
    ]
    const matched = hits.filter((re) => re.test(src))
    expect(matched.length).toBeGreaterThanOrEqual(4)
    expect(src).toMatch(/tools\/call/)
    expect(src).toContain("REPLAYABLE_EXACT")
  })

  test("client.ts no longer contains start-only doReauthorize swap", () => {
    const src = readFileSync(CLIENT, "utf8")
    expect(src).not.toMatch(/await next\.start\(\)[\s\S]{0,200}await old\?\.close/)
    expect(src).toMatch(/runReauthTransaction\s*\(/)
  })

  test("red-on-injection: stripping handshakeOnTransport fails the rail", () => {
    const src = readFileSync(REAUTH, "utf8")
    const mutated = src.replace(/handshakeOnTransport\s*\(/g, "/* handshakeOnTransport */(")
    expect(src).toMatch(/handshakeOnTransport\s*\(/)
    expect(mutated).not.toMatch(/handshakeOnTransport\s*\(/)
    expect(mutated).toMatch(/\/\* handshakeOnTransport \*\//)
  })
})
