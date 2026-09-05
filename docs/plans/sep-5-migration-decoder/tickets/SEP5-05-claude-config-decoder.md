# SEP5-05 — one pure Claude MCP/hooks decoder

**Priority:** P2
**Status:** PLANNED
**Depends on:** SEP5-00
**Finding coverage:** D5

## Goal

Remove duplicated object-shape decoding while preserving the two entrypoints'
different file I/O and error contracts.

## Current duplication

`external-config/convert.ts` and `translators/claude-code-config.ts` separately
implement `asObject`, transport classification, string-args filtering, command
hook extraction, and hook-map traversal. The former returns typed warnings and
enforces a 4 MiB pre-read cap; the latter maps absent/malformed files to empty
results and propagates other read failures.

## Canonical decoder

Add a pure module inside `@/migration`:

```ts
export interface ClaudeMcpServerShape {
  readonly name: string
  readonly transport: "http" | "sse" | "stdio" | "unknown"
  readonly command?: string
  readonly args?: readonly string[]
}

export interface ClaudeHookShape {
  readonly event: string
  readonly commands: readonly string[]
  readonly matcher?: string
}

export const decodeClaudeMcpServers = (value: unknown): ClaudeMcpServerShape[] => { /* pure */ }
export const decodeClaudeHookMap = (value: unknown): ClaudeHookShape[] => { /* pure */ }
```

The decoder drops credential-bearing MCP `env`, unknown object keys, non-string
args, non-command hooks, and empty command groups exactly as the current code.

## Write set

| File | Change |
|---|---|
| `src/migration/claude-config-decode.ts` | New pure object decoder and canonical intermediate shapes |
| `src/migration/translators/claude-code-config.ts` | Keep path/read policy; adapt decoded shapes to `Translated*` |
| `src/migration/external-config/convert.ts` | Keep stat/read/warning policy and hooks.json selection; adapt to `Converted*` |
| `src/migration/index.ts` | Export only if another migration module needs the decoder; avoid public API expansion otherwise |
| `tests/unit/migration/claude-config-decode.test.ts` | Table/property tests over unknown input |
| `tests/unit/migration/claude-config-entrypoint-parity.test.ts` | Same valid bytes produce equivalent modeled fields |
| existing external-config/importer tests | Preserve distinct absent/malformed/unreadable behavior |

## Implementation steps

1. Freeze representative `.mcp.json`, `settings.json#hooks`, and standalone
   `hooks.json` fixtures.
2. Add RED parity assertions over successful modeled output only.
3. Extract `asObject`, `asStringList`, transport classification, and hook-map
   traversal into the pure decoder.
4. Map intermediate shapes to the existing `Translated*` and `Converted*`
   result types at each boundary.
5. Delete only the duplicated pure branches. Retain `readJsonIfPresent`,
   `readJson`, warning construction, size cap, and path selection.

## RED rails

- Explicit `type` wins over inferred URL/command in both entrypoints.
- URL infers HTTP; command infers stdio; missing both yields unknown.
- MCP `env` never appears in either output.
- Hook order, event, matcher, and command order are identical.
- Non-string args and non-command hooks are dropped identically.
- External converter still returns typed warning for oversized/malformed input.
- Legacy translator still returns empty on absent/malformed and propagates
  non-ENOENT read errors per its current contract.

## Test and ratchet implementation

- Freeze at least six successful fixture families: explicit transport types,
  inferred URL, inferred command, unknown transport, mixed/malformed entries,
  and hook matcher with multiple commands. Feed the same bytes through both
  public entrypoints and compare only normalized modeled fields.
- Keep error-policy tests separate: absent file, malformed JSON, oversized input,
  `EACCES`, and generic I/O error. Assert each entrypoint's current return/throw/
  warning contract explicitly; parity is not expected for this table.
- Assert source `env` objects and unknown keys never appear in either modeled
  output. Include mixed string/non-string args and command/non-command hooks.
- Call the pure decoder directly with `null`, scalars, arrays, cyclic objects,
  and property-based unknown values; it must settle synchronously without
  reading the filesystem.
- Mutation A restores URL/command classification in exactly one adapter; its
  corresponding parity row must differ. Mutation B reverses explicit-vs-inferred
  precedence in the owner; both public entrypoint rows must fail identically.
- Anti-vacuum floors require six valid fixture families, both entrypoints, both
  MCP and hook projections, and all five error-policy cases. The parity test
  must assert the fixture count before iterating.

## Proof rails

```sh
bun test tests/unit/migration/claude-config-decode.test.ts
bun test tests/unit/migration/claude-config-entrypoint-parity.test.ts
bun test tests/unit/external-config-migration-hellgate.test.ts
bun test tests/unit/migration-config-translators.test.ts tests/unit/migration-import-roundtrip-hellgate.test.ts
bun run typecheck
bun run lint:debt
```

## Definition of done

- One pure decoder owns every shared branch.
- Both file entrypoints preserve their current error and size behavior.
- No credential-bearing MCP env crosses the migration boundary.
- Reverting either entrypoint to a local decoder makes parity RED.

## Stop conditions

- The refactor makes the converter call an async filesystem translator.
- Error-policy differences are normalized away.
- Intermediate shapes become a second public migration domain model.
