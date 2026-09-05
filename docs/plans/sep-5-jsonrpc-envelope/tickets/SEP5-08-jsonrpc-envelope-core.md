# SEP5-08 — shared JSON-RPC envelope core

**Priority:** P2
**Status:** LANDED
**Depends on:** SEP5-00
**Finding coverage:** D19

## Goal

Share JSON-RPC 2.0 envelope types and validation between MCP and LSP while
keeping framing, byte caps, transport lifecycle, and error recovery in their
own slices.

## Canonical core

Place the protocol-neutral shape in `@/shared` because both `@/mcp` and `@/lsp`
are peer leaves allowed to import shared:

```ts
export type JsonRpcId = string | number | null

export interface JsonRpcErrorObject {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export type JsonRpcEnvelope =
  | { readonly jsonrpc: "2.0"; readonly id?: JsonRpcId; readonly method: string; readonly params?: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly error: JsonRpcErrorObject }

export const isJsonRpcEnvelope = (value: unknown): value is JsonRpcEnvelope => {
  // object + jsonrpc literal + request/response discriminant checks
}
```

Freeze exact compatibility first: current MCP/LSP types may allow a looser
shape than this sketch. Do not tighten runtime acceptance incidentally.

## Write set

| File | Change |
|---|---|
| `src/shared/jsonrpc-envelope.ts` | New protocol-neutral types and guard |
| `src/shared/index.ts` | Export the core |
| `src/mcp/jsonrpc.ts` | Alias/use shared envelope; retain newline reader and 10 MiB cap |
| `src/mcp/transports/http-sse.ts` | Remove its additional local envelope guard if behavior is identical |
| `src/lsp/adapters/jsonrpc.ts` | Alias/use shared envelope; retain Content-Length reader and 32 MiB cap |
| `tests/unit/shared/jsonrpc-envelope.test.ts` | Shared positive/negative/mutation battery |
| existing MCP/LSP framing tests | Prove framing behavior is unchanged |

## Non-goals

- Do not unify `LineReader` with LSP `MessageReader`.
- Do not unify `MAX_LINE_BYTES` and `MAX_FRAME_BYTES`.
- Do not move MCP/LSP transport state or request correlators into shared.
- Do not broaden accepted JSON-RPC versions or guess malformed messages.

## RED rails

- Missing/wrong `jsonrpc`, scalar/null, malformed error, and conflicting
  result+error shapes are rejected according to the frozen current contract.
- Valid request, notification, success, and error messages pass both adapters.
- Removing the shared guard call makes at least one real decoder test fail.
- MCP still recovers after an over-cap newline frame.
- LSP still parses split/multiple Content-Length frames.

## Test and ratchet implementation

- The shared table has at least four positives: request with id, notification,
  success response, and error response. It has at least eight negatives:
  null/scalar, missing version, wrong version, malformed id, missing method,
  malformed error, result+error conflict, and response without required id.
- Feed every envelope row through `isJsonRpcEnvelope` and the real MCP and LSP
  decode surfaces after their existing framing step. Freeze compatibility
  exceptions as explicit adapter expectations instead of weakening the shared
  table silently.
- Keep framing fixtures separate: MCP over-cap newline recovery and LSP split,
  coalesced, malformed, and over-cap Content-Length cases remain in their current
  suites and retain current limits.
- Mutation A changes the literal check to accept any string; the wrong-version
  row must fail across both adapters. Mutation B allows result+error; the
  conflict row must fail. Mutation C bypasses the shared guard in one adapter;
  that adapter's malformed row must diverge and fail.
- Anti-vacuum floors require positives >= 4, negatives >= 8, and adapter
  projections = 2. Tests import the shared guard but prove it through real
  decoder behavior; an import-only assertion is prohibited.

## Proof rails

```sh
bun test tests/unit/shared/jsonrpc-envelope.test.ts
bun test tests/unit/mcp/jsonrpc-line-cap-hellgate.test.ts
bun test tests/unit/mcp/transport-port-hellgate.test.ts
bun test tests/unit/lsp
bun run typecheck
bun run lint:debt
bun test tests/unit/mcp-slice-boundary.test.ts tests/unit/lsp-slice-boundary.test.ts
```

## Definition of done

- JSON-RPC envelope shape and validator have one owner.
- MCP and LSP keep separate framing and lifecycle code.
- Current valid and malformed fixtures produce the same observable outcomes.
- No peer-slice import is introduced.

## Stop conditions

- The shared type is stricter than one current public adapter without an
  explicit compatibility decision.
- Framing constants or parser recovery are merged.
- Shared begins importing MCP or LSP.
