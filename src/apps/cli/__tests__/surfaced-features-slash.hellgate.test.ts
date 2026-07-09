/**
 * jul-03 CLI-surfacing hellgate — the landed-but-unreachable features get slash
 * commands that (a) REGISTER in the assembled BUILTINS, (b) render REAL state
 * when their ctx slot is wired ON, and (c) print a clean "not wired" / omit their
 * section when the slot is unset (default-OFF byte-identical).
 *
 * Every case drives the COMMAND through the real `runSlashCommand` dispatcher
 * against the assembled `BUILTINS` (proving registration), with a hand-built
 * `SlashContext` wiring exactly the slot the surface composes.
 *
 * Covered: S3 /context, S2 /activity item rows, A3 /kb, B4 /mcp-resources,
 * S1 /browser-net, B2 /cron + /schedule + /inbox, B1 /onboard.
 */

import { describe, expect, test } from "bun:test"
import { runSlashCommand } from "../slash-commands"
import type { SlashContext } from "../slash-contract"

const buildCtx = (
  partial?: Partial<SlashContext>,
): { ctx: SlashContext; out: () => string; err: () => string } => {
  let stdout = ""
  let stderr = ""
  const ctx: SlashContext = {
    out: (s) => {
      stdout += s
    },
    err: (s) => {
      stderr += s
    },
    cwd: "/tmp",
    ...partial,
  }
  return { ctx, out: () => stdout, err: () => stderr }
}

// ── registration: every new command is in the assembled BUILTINS ─────────────

describe("jul-03 CLI-surfacing — registration + not-wired defaults", () => {
  // Wave-4 (D-6, UUX-2-22/4-27): a not-wired command exits 2 (never 0 — that
  // claimed success) and, when a KNOWN env gate wires the slot, prints a
  // machine-greppable `hint: set <GATE>=1` line.
  const cases: ReadonlyArray<{ name: string; gate?: string }> = [
    { name: "/kb", gate: "QUANTA_PROJECTS_KB" },
    { name: "/mcp-resources" },
    { name: "/browser-net", gate: "QUANTA_BROWSER_NETWORK" },
    { name: "/cron", gate: "QUANTA_AUTOMATION" },
    { name: "/schedule", gate: "QUANTA_AUTOMATION" },
    { name: "/inbox", gate: "QUANTA_AUTOMATION" },
    { name: "/onboard" },
  ]
  for (const c of cases) {
    test(`${c.name} is registered AND prints the not-wired posture (exit 2${c.gate !== undefined ? ` + ${c.gate} hint` : ""}) when its slot is absent`, async () => {
      const { ctx, out } = buildCtx()
      const code = await runSlashCommand(c.name, ctx)
      // Registered ⇒ NOT the dispatcher's unknown-command path.
      expect(out().toLowerCase()).not.toContain("unknown")
      // Default-OFF: a "not wired" style message and NOTHING crashes.
      expect(out().toLowerCase()).toContain("not wired")
      if (c.gate !== undefined) {
        expect(code).toBe(2)
        expect(out()).toContain(`hint: set ${c.gate}=1`)
      } else if (c.name === "/onboard") {
        expect(code).toBe(2) // D-6 adopted (UUX-4-27), no env gate to hint
      } else {
        expect(code).toBe(0) // not yet adopted (no KNOWN gate; protocol-pending)
      }
    })
  }
})

// ── S3 /context — codex `% context left` gauge over the live seam ────────────

describe("S3 /context — live segmented gauge (codex % context left)", () => {
  test("renders the segmented usage incl. codex `Context N% left` when the seam is wired", async () => {
    const { ctx, out } = buildCtx({
      contextUsage: () => ({
        segments: [
          { id: "System", tokens: 40_000 },
          { id: "Conversation", tokens: 20_000 },
        ],
        total: 60_000,
        max: 200_000,
        model: "gpt-5",
        reasoningTokens: 12_000,
      }),
    })
    const code = await runSlashCommand("/context", ctx)
    expect(code).toBe(0)
    // 30% used ⇒ 70% left (codex form).
    expect(out()).toContain("Context 70% left")
    // tokens-left annotation + the reasoning split.
    expect(out()).toContain("tokens left in this context window")
    expect(out()).toContain("Reasoning")
  })

  test("falls back to the legacy placeholder when the seam is absent (byte-identical)", async () => {
    const { ctx, out } = buildCtx()
    const code = await runSlashCommand("/context", ctx)
    expect(code).toBe(0)
    expect(out()).toContain("no prompt assembled yet")
    expect(out()).not.toContain("context left")
  })
})

// ── S2 /activity — item rows fold into the tree render ───────────────────────

describe("S2 /activity — bounded ItemStore rows are VISIBLE", () => {
  test("appends a Subagent items section when activityItems yields rows", async () => {
    const { ctx, out } = buildCtx({
      activityItems: () => [
        { itemId: "item-subagent-a1", itemType: "subagent", phase: "started" },
        {
          itemId: "item-subagent-b2",
          itemType: "subagent",
          phase: "completed",
          text: JSON.stringify({ status: "done", turns: 3, description: "fix tests" }),
        },
      ],
    })
    const code = await runSlashCommand("/activity", ctx)
    expect(code).toBe(0)
    expect(out()).toContain("Subagent items")
    // the join key is shown verbatim (wire-plane taxonomy)
    expect(out()).toContain("item-subagent-a1")
    // the settled drilldown is rendered from the JSON body
    expect(out()).toContain("done")
    expect(out()).toContain("3 turns")
  })

  test("omits the Subagent items section when activityItems is empty AND when absent", async () => {
    // present-but-empty ⇒ section omitted
    const withEmpty = buildCtx({ activityItems: () => [] })
    expect(await runSlashCommand("/activity", withEmpty.ctx)).toBe(0)
    expect(withEmpty.out()).not.toContain("Subagent items")
    // absent slot + no other activity source ⇒ plain "not wired"
    const absent = buildCtx()
    expect(await runSlashCommand("/activity", absent.ctx)).toBe(0)
    expect(absent.out()).toContain("not wired")
  })
})

// ── A3 /kb — Projects knowledge-base accounting ──────────────────────────────

describe("A3 /kb — Projects knowledge-base accounting", () => {
  test("renders the byte-budget accounting + doc count when wired", async () => {
    const { ctx, out } = buildCtx({
      projectsKb: {
        docCount: () => 2,
        knowledge: () => ({
          knowledge_size: 300_000,
          max_knowledge_size: 4_194_304,
          search_threshold: 262_144,
          rag_active: true,
          remaining_budget: 3_894_304,
        }),
      },
    })
    const code = await runSlashCommand("/kb", ctx)
    expect(code).toBe(0)
    expect(out()).toContain("Projects KB")
    expect(out()).toContain("2 docs")
    expect(out()).toContain("RAG")
    expect(out().toLowerCase()).toContain("active")
  })

  test("prints an empty-state line (not the accounting panel) when zero docs offloaded", async () => {
    const { ctx, out } = buildCtx({
      projectsKb: {
        docCount: () => 0,
        knowledge: () => ({
          knowledge_size: 0,
          max_knowledge_size: 4_194_304,
          search_threshold: 262_144,
          rag_active: false,
          remaining_budget: 4_194_304,
        }),
      },
    })
    expect(await runSlashCommand("/kb", ctx)).toBe(0)
    expect(out()).toContain("no documents offloaded")
  })
})

// ── B4 /mcp-resources — fetched dirs + blob paths ────────────────────────────

describe("B4 /mcp-resources — fetched resource dirs + blob paths", () => {
  test("renders the fetched dirs, children, and blob-to-disk paths when wired", async () => {
    const { ctx, out } = buildCtx({
      mcpResources: () => [
        {
          uri: "file:///logs",
          children: [
            { uri: "file:///logs/app.log", name: "app.log", mimeType: "text/plain" },
            { uri: "file:///logs/sub", name: "sub", mimeType: "inode/directory" },
          ],
          blobPaths: ["/tmp/quanta/blob-1.bin"],
          at: 1000,
        },
      ],
    })
    const code = await runSlashCommand("/mcp-resources", ctx)
    expect(code).toBe(0)
    expect(out()).toContain("file:///logs")
    expect(out()).toContain("app.log")
    expect(out()).toContain("/tmp/quanta/blob-1.bin")
  })

  test("empty capture ⇒ empty-state line", async () => {
    const { ctx, out } = buildCtx({ mcpResources: () => [] })
    expect(await runSlashCommand("/mcp-resources", ctx)).toBe(0)
    expect(out()).toContain("no resource dirs fetched")
  })
})

// ── S1 /browser-net — last network-capture + locator summary ─────────────────

describe("S1 /browser-net — last network-capture + locator summary", () => {
  test("renders the network rows + locator summary when wired", async () => {
    const { ctx, out } = buildCtx({
      browserNet: () => ({
        pageUrl: "https://example.test/app",
        rows: [
          {
            method: "GET",
            url: "https://example.test/api/users",
            status: 200,
            mime: "application/json",
            size: 512,
          },
          { method: "POST", url: "https://example.test/api/login", status: 401 },
        ],
        locatorSummary: "42 refs (12 interactive)",
        at: 2000,
      }),
    })
    const code = await runSlashCommand("/browser-net", ctx)
    expect(code).toBe(0)
    expect(out()).toContain("https://example.test/api/users")
    expect(out()).toContain("401")
    expect(out()).toContain("42 refs (12 interactive)")
  })

  test("no capture yet ⇒ empty-state line", async () => {
    const { ctx, out } = buildCtx({ browserNet: () => undefined })
    expect(await runSlashCommand("/browser-net", ctx)).toBe(0)
    expect(out()).toContain("no browser capture")
  })
})

// ── B2 /cron + /schedule + /inbox — automation engine ────────────────────────

describe("B2 /cron + /schedule + /inbox — automation engine wire", () => {
  const wire = (): Partial<SlashContext> => {
    const rows = [
      {
        id: "cron-1",
        title: "nightly build",
        rule: "FREQ=DAILY",
        nextRunAt: 5000,
        prompt: "build",
      },
    ]
    return {
      now: () => 1000,
      automation: {
        list: async () => rows,
        create: async (title, rule) => ({
          ok: true,
          row: { id: "cron-2", title, rule, nextRunAt: 9000, prompt: title },
        }),
        inbox: async () => [
          { id: "ib-1", title: "build done", summary: "green", createdAt: 100, read: false },
        ],
      },
    }
  }

  test("/cron list renders the live schedules", async () => {
    const { ctx, out } = buildCtx(wire())
    expect(await runSlashCommand("/cron", ctx)).toBe(0)
    expect(out()).toContain("nightly build")
    expect(out()).toContain("FREQ=DAILY")
  })

  test("/cron create <RRULE> <title> creates via the engine", async () => {
    const { ctx, out } = buildCtx(wire())
    expect(await runSlashCommand("/cron create FREQ=WEEKLY weekly report", ctx)).toBe(0)
    expect(out()).toContain("created")
    expect(out()).toContain("weekly report")
    expect(out()).toContain("FREQ=WEEKLY")
  })

  test("/cron create with a missing title errors (exit 1)", async () => {
    const { ctx, err } = buildCtx(wire())
    expect(await runSlashCommand("/cron create FREQ=DAILY", ctx)).toBe(1)
    expect(err()).toContain("usage")
  })

  test("/schedule is an alias for /cron (same body)", async () => {
    const { ctx, out } = buildCtx(wire())
    expect(await runSlashCommand("/schedule", ctx)).toBe(0)
    expect(out()).toContain("nightly build")
  })

  test("/inbox reads the notification inbox (the banner references it)", async () => {
    const { ctx, out } = buildCtx(wire())
    expect(await runSlashCommand("/inbox", ctx)).toBe(0)
    expect(out()).toContain("build done")
    expect(out()).toContain("unread")
  })
})

// ── B1 /onboard — onboarding identity reachability ───────────────────────────

describe("B1 /onboard — onboarding identity reachability", () => {
  const identityWire = (accept: boolean): Partial<SlashContext> => ({
    identity: {
      get: () => "default",
      list: () => (accept ? ["default", "plan", "onboarding"] : ["default", "plan"]),
      set: (mode) =>
        mode === "onboarding" && accept
          ? "ok"
          : mode === "default" || mode === "plan"
            ? "ok"
            : {
                kind: "unknown",
                known: accept ? ["default", "plan", "onboarding"] : ["default", "plan"],
              },
    },
  })

  test("/onboard sets identity to onboarding when the wire accepts it", async () => {
    const { ctx, out } = buildCtx(identityWire(true))
    expect(await runSlashCommand("/onboard", ctx)).toBe(0)
    expect(out()).toContain("onboarding")
  })

  test("/onboard rejects cleanly (exit 1) when onboarding is not available", async () => {
    const { ctx, err } = buildCtx(identityWire(false))
    expect(await runSlashCommand("/onboard", ctx)).toBe(1)
    expect(err().toLowerCase()).toContain("not available")
  })

  test("/onboard prints not-wired + exit 2 when there is no identity wire at all (D-6, UUX-4-27)", async () => {
    const { ctx, out } = buildCtx()
    expect(await runSlashCommand("/onboard", ctx)).toBe(2)
    expect(out()).toContain("not wired")
  })
})
