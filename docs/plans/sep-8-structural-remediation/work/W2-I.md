# W2-I receipt

Status: **integrated**. W2 findings are `implemented` on merged source. Not W7 `verified` 39/39.

Merge order: **R05 → R13 → R11**, then reserved/I wiring. `--group R05|R13|R11` undeclared-write checks: PASS. No commit.

Source HEAD at integration: `16cabfde464e354a4c3e98f3b7ffbc6e57f1086f` plus W1 follow-up. All of that is now **committed on local `main` `29d7e4ff1a2df3e925c1f3854432e3a741f5d2d7`**.

## Findings

| ID | Result |
|---|---|
| H-SA-02 | both backers share `createDaemonEngine`; `wakesDone` once per wake terminal |
| H-SA-01 | null → `no_finding`, throw/import → `failed`; no synthetic finding in the feed |
| G-F5 | ProMax skips shim only, always `setupBoxForFamily`; warm probe is profile-derived |
| G-F5.4 | **OPEN local-only gap** — fake SSH only; no RunInstances |
| C-F1 | `IsolatedMcpTransport` + factory flag; DXT `dxt-ready-line` vs MCP `process-ready` |
| C-F9 | reauth is create→start→initialize→initialized→publish; `tools/call` not auto-replayed |

## I applied

R05:

- `src/side-agent/index.ts` — `createDaemonEngine` / `validateSideAgentSpec` / `normalizeRunnerResult`
- `src/host/runtime/agent-config-assembler.ts` — process registry gets the same `setInterval`/`clearInterval` ports as in-process. Event-bus for process-backed `trigger.kind === "event"` is still uninjected (`invalid-spec` without `events`).

R11:

- `src/mcp/index.ts` — `IsolatedMcpTransport`, `isolatedMcpEnabledFromEnv` (IsolatedMcpClient stays off the barrel)
- `src/plugin-isolation/index.ts` — `IsolatedReadyMode`
- `src/host/mcp-composition.ts` / `src/agent/mcp-bridge.ts` — comments: absent `transportFor` uses `defaultTransportFor` (flag-aware). No second IsolatedMcpClient constructor.
- `src/agent/plugin-mcp-launcher/isolated-launcher-port.ts` — `McpClient` + `IsolatedMcpTransport` (`dxt-ready-line`)
- `src/agent/plugin-mcp-launcher/types.ts` / `src/agent/skill-mcp-wire.ts` — comments
- `tools/feature-catalog/features/09-integration/162-mcp-isolated-spawn.yaml` + `bun fc validate` + `bun fc build`

R13: no integrationScopes.

Integrator typecheck fixes after merge (worker-local bun test did not run `tsc --noEmit`):

- `normalizeRunnerResult` / charter runner: `readonly T[]` vs `Array.isArray` narrowing
- process-registry: `exactOptionalPropertyTypes` on `failed.reason`; `supervisor` not readonly

## Tests on merged source

- R05 owner + side-agent hellgates: **69 pass**
- R13 owner + colocated bench: **78 pass**
- R11 owner + MCP/plugin hellgates + auto-wire: **92 pass**
- `god-code-ratchet`: **9 pass** (cohort did not grow)
- `bun run typecheck`: **pass**
- biome on touched I/owner files: **pass**

Worker-local PASS is not the closeout; the counts above are integrated-source.

## God-code after W2

| File | before | after |
|---|---:|---:|
| `ec2-lifecycle.ts` | 934 | **799** (left 900–999) |
| `client.ts` | 888 | **875** (reauth sibling; not in band) |
| `http-sse.ts` | 789 | 791 (comment) |
| `bun-spawner.ts` | 613 | 655 (ready-mode + `trySend`) |
| `registry.ts` / `process-registry.ts` | 394 / 327 | 254 / 392 |

Allowlist/ceiling not raised. Cohort max still 24.

## Remaining gap

- **G-F5.4** actual EC2 provision/reuse proof is OPEN. Fake SSH is contract proof only. Do not auto-start RunInstances.
- Event-triggered daemons stay `invalid-spec` without an injected publisher (ADR-0483: empty bus = permanently-asleep zombie). Interval re-wake works. Not a silent skip.
- W0.3–W0.4 (W3 R02), W0.6 R10 half (W4), W3+ packages remain.
- Global `prepush` not claimed as W2 closeout.
- Worktrees `sep8-w2-r05` / `r13` / `r11` still exist; not deleted.
- No W7 verified 39/39 claim.

Follow-up on merged source (not a new finding ID):

- `box up` / `pool` now call `withResolvedFamilyBootstrap` (owner: `box-session/family-bootstrap-resolve.ts`). Fresh `setupBoxForFamily` refuses a declaring family with no payload, matching warm reuse.
