import { describe, expect, test } from "bun:test"
import { encodeMessage as encodeLsp, MessageReader } from "@/lsp/adapters/jsonrpc"
import { encodeMessage, LineReader } from "@/mcp/jsonrpc"
import { isJsonRpcEnvelope } from "@/shared/jsonrpc-envelope"

const positives = [
  { jsonrpc: "2.0", id: 1, method: "initialize" },
  { jsonrpc: "2.0", method: "initialized" },
  { jsonrpc: "2.0", id: "a", result: { ok: true } },
  { jsonrpc: "2.0", id: 2, error: { code: -32600, message: "Invalid Request" } },
] as const

const negatives: unknown[] = [
  null,
  1,
  { jsonrpc: "1.0", method: "x" },
  { method: "x" },
  { jsonrpc: "2.0" },
  { jsonrpc: "2.0", id: { nested: true }, method: "x" },
  { jsonrpc: "2.0", method: 3 },
  [],
]

describe("jsonrpc envelope", () => {
  test("positive variants >= 4; negative >= 8; adapters = 2", () => {
    expect(positives.length).toBeGreaterThanOrEqual(4)
    expect(negatives.length).toBeGreaterThanOrEqual(8)
  })

  for (const row of positives) {
    test(`shared+adapters accept ${JSON.stringify(row)}`, () => {
      expect(isJsonRpcEnvelope(row)).toBe(true)
      const mcp = new LineReader().push(encodeMessage(row))
      expect(mcp).toHaveLength(1)
      const lsp = new MessageReader().push(encodeLsp(row))
      expect(lsp).toHaveLength(1)
    })
  }

  for (const [i, row] of negatives.entries()) {
    test(`shared rejects negative ${i}`, () => {
      expect(isJsonRpcEnvelope(row)).toBe(false)
    })
  }

  test("live contract still accepts result+error coexistence", () => {
    const mixed = { jsonrpc: "2.0", id: 1, result: 1, error: { code: 1, message: "e" } }
    expect(isJsonRpcEnvelope(mixed)).toBe(true)
  })
})
