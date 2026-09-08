# R11 integration delta — APPLIED (W2-I, `29d7e4ff1`)

Status: **applied**. Worker originally left reserved barrels/host/agent/catalog UNAPPLIED. W2-I applied barrel + host/bridge comments + plugin launcher `McpClient` + isolated transport (`dxt-ready-line`) + catalog YAML `162-mcp-isolated-spawn.yaml` (`bun fc validate` + `bun fc build`).

Live after W2 (no I yet):

- `defaultTransportFor` already reads `MCP_USE_ISOLATED_SPAWN` (`src/mcp/client/isolated-flag.ts`). Command config + flag ON → `IsolatedMcpTransport` **`process-ready`**. HTTP/`url` unchanged. Flag OFF → stdio.
- `new McpClient(config)` **without** an explicit `transport` already takes that factory. Host/bridge do not need a second IsolatedMcpClient constructor for the flag path.
- Plugin/DXT still `new IsolatedMcpClient` (`dxt-ready-line` facade). W0.5: I-stage must construct `McpClient` + isolated transport instead.

## 1. `src/mcp/index.ts` (reserved barrel)

Re-export the isolated **transport** so I-stage agent/host do not deep-import. Do **not** barrel-export `IsolatedMcpClient` (catalog backward-compat: default `@/mcp` path stays `McpClient`).

```ts
export {
  IsolatedMcpTransport,
  type IsolatedMcpTransportOpts,
  sanitiseIsolatedServiceName,
} from "./transports/isolated"
export { isolatedMcpEnabledFromEnv, ISOLATED_MCP_ENV_VAR } from "./client/isolated-flag"
```

## 2. `src/plugin-isolation/index.ts` (reserved barrel)

`IsolatedReadyMode` / `trySend` live on types already. Re-export the type:

```ts
export type {
  IsolatedProcess,
  IsolatedProcessSpawnerPort,
  IsolatedReadyMode,
  SpawnOpts,
} from "./types"
```

## 3. `src/host/mcp-composition.ts`

**No constructor change required.** `factory: (c) => new McpClient(c, clientOpts)` already omits `transport` unless `transportFor` is injected; the client then uses `defaultTransportFor`.

Replace the outdated comment at `mcpSupervisorDepsFor` (~L94–L99) that says isolated construction is out of scope / a separate wire:

```
The factory picks McpClient. When MCP_USE_ISOLATED_SPAWN is on,
defaultTransportFor selects IsolatedMcpTransport (process-ready) for
command servers. HTTP/url is unchanged. Do not construct IsolatedMcpClient
here.
```

Do **not** call `isolatedMcpEnabledFromEnv` in host (that would duplicate the factory). YAML/claim only: flag is owned by `src/mcp/client/isolated-flag.ts` + `transport-factory.ts`.

## 4. `src/agent/mcp-bridge.ts`

Same as host: `new McpClient(config, clientOpts)` with optional `opts.transportFor`. Absent transport → factory (flag-aware). Comment-only: ADR-0431 seam still wins when `transportFor` is supplied (tests).

No IsolatedMcpClient import.

## 5. `src/agent/plugin-mcp-launcher/isolated-launcher-port.ts`

W0.5: switch production plugin spawn from `IsolatedMcpClient` to `McpClient` + isolated transport. Keep **`dxt-ready-line`** (plugin/DXT default — not the factory's process-ready).

Replace the IsolatedMcpClient construction (~L32, L88–L95):

```ts
import { McpClient } from "@/mcp"
import {
  IsolatedMcpTransport,
  type IsolatedMcpTransportOpts,
} from "@/mcp/transports/isolated"
// after barrel patch, prefer: import { IsolatedMcpTransport, McpClient, type IsolatedMcpTransportOpts } from "@/mcp"
import type { McpServerConfig } from "@/mcp/types"
import { errMessage } from "@/shared"
import type { McpLauncherPort, McpLaunchOpts, McpServerHandle, PluginMcpServerSpec } from "./types"

export interface IsolatedMcpLauncherPortOpts {
  readonly transportOpts?: IsolatedMcpTransportOpts
}

export const createIsolatedMcpLauncherPort = (
  opts: IsolatedMcpLauncherPortOpts = {},
): McpLauncherPort => {
  const transportOpts = opts.transportOpts
  return {
    launch: async (spec, launchOpts): Promise<McpServerHandle> => {
      const serverId = composeServerId(launchOpts.pluginId, launchOpts.serverName)
      let client: McpClient | null = null
      try {
        const cfg = toMcpConfig(spec, launchOpts.pluginId, launchOpts.serverName)
        const transport = new IsolatedMcpTransport(cfg, {
          ...(transportOpts ?? {}),
          readyMode: "dxt-ready-line",
        })
        client = new McpClient(cfg, { transport })
        await client.start()
        const startedClient = client
        return {
          serverId,
          ready: true,
          shutdown: async () => {
            try {
              await startedClient.stop()
            } catch {
              // McpClient.stop is idempotent; defense-in-depth.
            }
          },
        }
      } catch (e) {
        if (client !== null) {
          try {
            await client.stop()
          } catch {
            // already in error path
          }
        }
        return {
          serverId,
          ready: false,
          error: errMessage(e),
          shutdown: async () => {},
        }
      }
    },
  }
}
```

Keep `toMcpConfig` / `composeServerId` / NO-THROW `ready: false` contract. HTTP plugin specs with `url` still must not take this stdio isolated transport — existing `toMcpConfig` can emit `url`; I must not spawn isolated stdio for url-only servers (today IsolatedMcpClient also required a command). Leave url-only as start-failure → `ready: false`, same as now.

Update file header comments: production is `McpClient` + `IsolatedMcpTransport` (`dxt-ready-line`), not IsolatedMcpClient.

## 6. `src/agent/plugin-mcp-launcher/types.ts`

Comment patches only:

- production: wrapping `@/mcp` `McpClient` + `IsolatedMcpTransport` (`dxt-ready-line`).
- `McpServerHandle.shutdown` / `McpLauncherPort` docs: `McpClient.stop()` (still idempotent). Adapter authors may still inject a mock; IsolatedMcpClient facade remains for existing hellgates until callers migrate.

## 7. `src/agent/skill-mcp-wire.ts`

Stdio skill deps already go through `createIsolatedMcpLauncherPort()`. After §5, they automatically become `McpClient` + isolated `dxt-ready-line`. **No extra constructor in this file.**

HTTP path stays `HttpSseMcpTransport` + `McpClient` (unchanged). Comment line ~7: stdio ➝ launcher (`McpClient` + isolated transport), not IsolatedMcpClient.

## 8. Catalog YAML + MD build

`tools/feature-catalog/features/09-integration/162-mcp-isolated-spawn.yaml`

Rewrite claim: flag-gated **factory path**, not a second IsolatedMcpClient protocol core.

Suggested purpose/knobs/evidence:

```yaml
title: Isolated MCP transport — opt-in process-ready spawn (ADR-0162)
purpose: |
  When MCP_USE_ISOLATED_SPAWN=1 (also true/yes), McpClient's defaultTransportFor
  selects IsolatedMcpTransport in process-ready mode for command servers.
  HTTP/url selection is unchanged. Flag unset → StdioMcpTransport (byte-identical).
  IsolatedMcpClient is a delegating facade (dxt-ready-line) for plugin/DXT
  launchers until they construct McpClient + isolated transport directly.
  Adds vs stdio: typed spawn timeout, SIGTERM→SIGKILL grace, ASCII serviceName
  via QUANTA_SERVICE_NAME. Send failures (dead/oversize) surface as Error on
  McpTransport.send; DXT IsolatedProcess.send stays NO-THROW.
evidence:
  code:
    - src/mcp/client/transport-factory.ts
    - src/mcp/client/isolated-flag.ts
    - src/mcp/transports/isolated.ts
    - src/mcp/isolated-client.ts
    - src/plugin-isolation/bun-spawner.ts
  tests:
    unit:
      - tests/unit/sep8-remediation/r11/c-f1-factory-seam.test.ts
      - tests/unit/plugin-isolation-mcp-integration-hellgate.test.ts
    integration:
      - tests/integration/sep8-remediation/r11/c-f1-process-ready-stdio.test.ts
knobs:
  - name: MCP_USE_ISOLATED_SPAWN
    where: src/mcp/client/isolated-flag.ts (isolatedMcpEnabledFromEnv)
    default: ""
    purpose: opt-in factory switch (accepts '1' | 'true' | 'yes')
```

Then `bun fc validate` + `bun fc build` (regenerates `docs/10.feature-catalog.md`). Do not hand-edit the MD.

## What this worker did NOT claim

- Host reading `isolatedMcpEnabledFromEnv` (factory already does).
- Plugin launcher constructor switch (I-stage above).
- Barrel re-exports.
- Catalog YAML/MD rebuild.
- Auto-replay of `tools/call` after 401 (forbidden by W0.5; stays refused).
