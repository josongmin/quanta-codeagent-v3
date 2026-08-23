# ADR-0549 — The verify gate reads the canonical vocabulary, and the MCP writer and reader resolve one effective path

Status: Accepted (2026-08-24)
Slice: `src/apps/cli/internal.ts` · `src/host/mcp-composition.ts` · `src/apps/web-daemon/runtime-factory/daemon-mcp.ts`
Feature: `verify-gate-and-mcp-path-truth` (feature-catalog §10-app)
Related: `src/shared/env-flag.ts` (`gateOn`, the one gate vocabulary) · the dangerous-gate strict ratchet (the standing guard against exactly this drift) · ADR-0011 (verify guard)

## Context

### A gate that read presence, not value

`buildVerifyGuardConfig` read `process.env.QUANTA_VERIFY_GUARD !== undefined`. Measured, every value except `undefined` enabled the guard: `0`, `off`, `false`, `no` and `""` all turned it **ON**, the exact opposite of what an operator typing `0` means.

The repo already has one vocabulary for this — `gateOn` over `1|on|true|yes`, with `0|off|false|no` falsy, an empty export deliberately **not** an opt-in, and unrecognized values not an opt-in — and a standing ratchet against this precise drift for the dangerous-command gate. This gate had simply never been migrated.

### The MCP writer and reader disagreed about which file is the config

The connector installer writes to `QUANTA_MCP_CONFIG ?? <cwd>/.mcp.json`. The reader resolved `QUANTA_MCP_CONFIG` / `QUANTA_BROWSER_MCP_CONFIG` / `QUANTA_BROWSER_MCP_PLUGIN_DIR` and returned `undefined` otherwise — whereupon `readMcpConfig` does `if (!path) return []`.

So in the default configuration — no env var set — an install wrote `<cwd>/.mcp.json` and the next launch read nothing. The connector silently did not exist. "Install" has to round-trip or it is a lie.

## Decision

`verifyGuardEnabled(env)` reads the gate through `gateOn`, and is exported so the truth table is testable without touching the process env. Default-OFF is preserved: unset is still off.

`resolveMcpConfigPath(env, projectRoot?)` falls back to `<projectRoot>/.mcp.json` — the same file the installer writes — after the three explicit env resolutions, whose precedence is unchanged. `readMcpConfig` threads the root, and the CLI and the web daemon both pass `process.cwd()`.

The parameter is **optional on purpose**: omitted, resolution is env-only exactly as before, so every existing call site and any caller that genuinely has no project root is byte-identical.

## Consequences

- The truth table is asserted value-by-value, including `garbage` (must not enable a guard), `ON` (case-insensitive) and `"  1  "` (trimmed), so a future reader swap that quietly widens the vocabulary fails here.
- The round-trip is asserted through the **real** `readMcpConfig`, not just the path resolver — the resolver agreeing with the writer is necessary but not sufficient when the reader short-circuits on `!path`.
- The red-on-injection control is the old behavior preserved: with no project root the same file is still invisible, which is what shows the fix is the threading and not an unrelated change.
