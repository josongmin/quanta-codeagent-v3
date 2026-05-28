# ADR-0406 — Bash output truncation delegated to registry `capToolOutput`

**Status:** Accepted (2026-05-28)
**Slice:** `src/tool/bash/index.ts` (cap removal in `formatRunBody` +
`buildBackgroundCompletedResult`) + hellgate
**Default-ON:** Yes — pure deletion of an upstream cap. The registry's
head+tail `capToolOutput` (ADR-0060 / `src/tool/output-spill.ts`) was already
the **second** truncator in the pipeline; bash's own cap was redundant AND
defeated head+tail by discarding the tail before the registry could see it.

## Context

The bash tool used to slice its combined stdout/stderr to the **head**
30 000 chars before returning:

```ts
const MAX_OUTPUT = 30_000
let body = [r.stdout, r.stderr].filter(Boolean).join("\n").trimEnd()
if (body.length > MAX_OUTPUT) {
  body = `${body.slice(0, MAX_OUTPUT)}\n… (truncated, ${body.length - MAX_OUTPUT} more chars)`
}
```

The exact same pattern lived in `buildBackgroundCompletedResult`.

The tool registry already runs `capToolOutput(result.output, …)` on every
tool result with a default `maxChars = 200_000`, which:

- preserves **both head (8 K) and tail (4 K)** of the full payload — the
  determinator (`error: …`, exit summary, last diff hunk) is in the tail;
- persists the **full** output to `.quanta/tool-output/<uuid>.txt` and
  surfaces a `<persisted-output>` marker the model can dereference with
  `Read`;
- uniformly applies across every tool (web_fetch, read_image, plan tools,
  MCP run, …) — bash was the lone outlier with a tool-specific format.

Because bash's slice ran **first**, the registry's head+tail layer always
saw a body ≤ 30 K and had nothing left to spill. The tail-bearing
determinator was discarded before any other layer could see it. The
`(truncated, N more chars)` banner also pretended a 30 K-byte budget existed
when the actual system budget is 200 K — confusing for the model and the
operator.

## Decision

Delete the head-only cap from both bash paths. Return the raw buffered
body. The registry's `capToolOutput` is the single authoritative truncator
for tool output, applied uniformly across the whole tool surface.

**Two paths changed:**

| Function                            | Before                          | After                            |
| ----------------------------------- | ------------------------------- | -------------------------------- |
| `formatRunBody`                     | Head-only slice at 30 K + banner | Raw body (registry caps)         |
| `buildBackgroundCompletedResult`    | Head-only slice at 30 K + banner | Raw body (registry caps)         |

**Two paths intentionally unchanged:**

| Function                              | Cap kept                                 | Reason                                                                                                       |
| ------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `buildBackgroundPlaceholderResult`    | TAIL-only via `tailMaxOutput` (30 K)     | Samples an in-flight, unbounded streaming buffer (not a completed result) — tail is the right slice here.    |
| `bash_await` / `bash_kill`            | TAIL-only via `tail()` (30 K)            | Same as above — these read live snapshots of running shells; the registry will cap the eventual emit again.   |

## Memory analysis

`runShell` already buffers stdout/stderr into in-memory strings before
returning a `ShellResult`. The deleted slice ran AFTER that buffering, so
removing it is **memory-neutral**: the bytes were already resident; bash
just used to throw away the tail. For a hypothetical multi-GB log, peak
memory is bounded by `runShell`'s buffering policy, not by anything bash
does here. The registry's `capToolOutput` reads `output.length` and writes
the full body to a spill file when over cap — bounded streaming-to-disk,
not bounded growth.

## Consequences

- **+** Determinator-bearing tails (exit summaries, last diff hunk, final
  error line) now survive into the model-facing output.
- **+** Bash output now uses the same `<persisted-output>` wrapper as every
  other tool — one truncation contract across the surface.
- **+** Outputs ≤ 200 K are emitted verbatim (no spurious banner on the
  35 K – 200 K band).
- **−** Outputs > 200 K still trip the registry's spill path; the model now
  gets the `<persisted-output>` marker instead of the old
  `(truncated, N more chars)` banner. Any consumer parsing the old banner
  string would break — none exist in the tree.
- **−** A consumer that was implicitly capacity-budgeting on the legacy
  30 K bash output now needs to budget against the 200 K registry cap. The
  registry was always the real budget; we just stopped lying about it.

## Hellgate

`tests/unit/bash-output-cap-delegation-hellgate.test.ts` (8 cases):

1. Sub-cap byte-identical (no truncation banner).
2. 60 K stdout: full body preserved (legacy head-only would cut at 30 K).
3. `capToolOutput` preserves a tail-only determinator on a long body.
4. 35 K stdout ending in `END`: tail marker survives the bash path.
5. `DEFAULT_TOOL_OUTPUT_MAX ≥ 30_000` — delegation contract.
6. `DEFAULT_TOOL_OUTPUT_MAX === 200_000` — pin the canonical default.
7. Routed through `ToolRegistry`: sub-cap byte-identical.
8. Background COMPLETED result preserves full body (no head-only banner).

All 95 existing bash tests pass unchanged (regression: 0).

## Alternatives considered

- **Raise `MAX_OUTPUT` to 1 MB inside bash.** Rejected — keeps the
  duplicate-cap problem (still ahead of registry head+tail) and still
  diverges the banner format. Pure delegation is cleaner.
- **Delete `capToolOutput` from the registry and keep bash's cap.**
  Rejected — `capToolOutput` covers every tool, with persisted spill,
  uniform marker, and OS-level disk budgeting. Bash is not special.
