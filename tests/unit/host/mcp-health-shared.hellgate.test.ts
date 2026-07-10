/**
 * P4 (jul-11) — MCP health registry is SURFACE-NEUTRAL (@/host).
 *
 * The MCP config-read + load-assembly path (`internal/mcp.ts`) is slice-neutral
 * EXCEPT for one apps/cli-local dependency: `McpHealthHolder`. Promoting the
 * pure holder (markDown/downServers — no pill/terminal coupling) to @/host is
 * step 1 of moving the whole assembly to a surface-shared layer so BOTH the CLI
 * and the web daemon compose MCP from ONE source. The pill-render overlay
 * (`overlayServerHealth`, McpPillServer-coupled) stays CLI-only.
 *
 * Pins: the holder lives at @/host/mcp-health; the CLI barrel re-exports it
 * (no CLI consumer breaks); the holder is genuinely pure (a down mark is keyed
 * by the sanitized server name, last-reason-wins).
 */
import { describe, expect, test } from "bun:test"
import { createMcpHealthHolder } from "@/host/mcp-health"

describe("P4 — @/host/mcp-health (surface-neutral holder)", () => {
  test("markDown sanitizes the key + last reason wins; downServers reflects it", () => {
    const h = createMcpHealthHolder()
    h.markDown("my server!", "boot failed")
    h.markDown("my server!", "exited")
    const down = h.downServers()
    expect(down.get("my_server_")).toBe("exited")
    expect([...down.keys()]).toEqual(["my_server_"])
  })

  test("empty holder has no down servers", () => {
    expect(createMcpHealthHolder().downServers().size).toBe(0)
  })

  test("the CLI barrel still re-exports the holder (no consumer breaks)", async () => {
    const cli = await import("@/apps/cli/mcp-health")
    expect(typeof cli.createMcpHealthHolder).toBe("function")
    // overlayServerHealth (pill-render) stays available on the CLI barrel too.
    expect(typeof cli.overlayServerHealth).toBe("function")
  })
})
