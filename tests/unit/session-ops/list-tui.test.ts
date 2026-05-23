/**
 * Unit tests for the surface-agnostic `session list` rich TUI renderer.
 *
 * These tests target the pure `renderSessionList` / `applyListPipeline`
 * functions directly — no on-disk I/O, no env mucking — so they stay
 * fast and deterministic. End-to-end backward-compat (the `cmdLs`
 * dispatcher path) is covered by the existing
 * `tests/unit/cli-session-commands.test.ts` and
 * `tests/integration/session-ux-e2e.test.ts` batteries.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { SessionMeta } from "@/session"
import { setColorPolicy } from "@/ui"
import {
  applyListPipeline,
  buildSessionListEntries,
  renderSessionList,
  type SessionListEntry,
} from "../../../src/runner/session-ops/list-tui"

const HOUR = 3600
const DAY = 24 * HOUR

const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => {
  const now = 1_700_000_000_000
  return {
    id: overrides.id ?? "abcdef0123",
    title: overrides.title ?? "demo session",
    cwd: overrides.cwd ?? "/tmp/work",
    createdAt: overrides.createdAt ?? now,
    lastTouched: overrides.lastTouched ?? now,
    archived: overrides.archived ?? false,
    ...(overrides.gitSha !== undefined ? { gitSha: overrides.gitSha } : {}),
    ...(overrides.gitBranch !== undefined ? { gitBranch: overrides.gitBranch } : {}),
    ...(overrides.gitOriginUrl !== undefined ? { gitOriginUrl: overrides.gitOriginUrl } : {}),
  }
}

const mkEntry = (
  metaOverrides: Partial<SessionMeta> = {},
  extra: Partial<Omit<SessionListEntry, "meta">> = {},
): SessionListEntry => {
  const meta = mkMeta(metaOverrides)
  return {
    meta,
    archived: extra.archived ?? meta.archived,
    ageSeconds: extra.ageSeconds ?? 60,
    ...(extra.turns !== undefined ? { turns: extra.turns } : {}),
    ...(extra.totalTokens !== undefined ? { totalTokens: extra.totalTokens } : {}),
  }
}

describe("renderSessionList", () => {
  beforeEach(() => {
    // Force colour OFF so assertions against substrings are not contaminated
    // by ANSI escape sequences. Individual tests that want colour on can
    // override via setColorPolicy("on").
    setColorPolicy("off")
  })
  afterEach(() => {
    setColorPolicy(null)
  })

  test("rich format includes header + git fingerprint + age + turns + tokens", () => {
    const entries: SessionListEntry[] = [
      mkEntry(
        {
          id: "d2f8e10000",
          title: "feature/auth refactor",
          cwd: "/Users/me/work",
          gitBranch: "feat/auth-v2",
          gitOriginUrl: "https://github.com/me/repo.git",
        },
        { ageSeconds: 2 * HOUR, turns: 8, totalTokens: 12_300 },
      ),
    ]
    const out = renderSessionList(entries, { format: "rich" })
    expect(out).toContain("Quanta sessions (1 active)")
    expect(out).toContain("d2f8e1")
    expect(out).toContain("feature/auth refactor")
    expect(out).toContain("[repo:feat/auth-v2]")
    expect(out).toContain("2h ago")
    expect(out).toContain("8 turns")
    expect(out).toContain("~12.3k tok")
    expect(out).toContain("/Users/me/work")
  })

  test("plain format matches the legacy ID/TITLE/CWD/LAST/ARCH header", () => {
    const entries: SessionListEntry[] = [
      mkEntry({ id: "plain-id-1", title: "T1", cwd: "/x" }, { ageSeconds: 90 }),
    ]
    const out = renderSessionList(entries, { format: "plain" })
    // Exact header (with column widths) and "no" archived flag column.
    expect(out).toContain("ID")
    expect(out).toContain("TITLE")
    expect(out).toContain("CWD")
    expect(out).toContain("LAST")
    expect(out).toContain("ARCH")
    expect(out).toContain("plain-id-1")
    expect(out).toContain("T1")
    expect(out).toMatch(/ {2}no\n$/)
  })

  test("plain format preserves byte-identical empty-state line", () => {
    const out = renderSessionList([], { format: "plain" })
    expect(out).toBe("(no sessions)\n")
  })

  test("rich format empty-state collapses to the same legacy string", () => {
    // Defensive: dispatcher short-circuits earlier, but the renderer must
    // still produce a usable line for direct callers.
    const out = renderSessionList([], { format: "rich" })
    expect(out).toBe("(no sessions)\n")
  })

  test("status badges: idle (<24h), recent (<7d), old (>7d), archived", () => {
    const entries: SessionListEntry[] = [
      mkEntry({ id: "idle-12345" }, { ageSeconds: 3 * HOUR }),
      mkEntry({ id: "recent6789" }, { ageSeconds: 3 * DAY }),
      mkEntry({ id: "old1234567" }, { ageSeconds: 30 * DAY }),
      mkEntry({ id: "arch987654", archived: true }, { ageSeconds: 12 * DAY, archived: true }),
    ]
    const out = renderSessionList(entries, { format: "rich", showArchived: true })
    // Each badge glyph is present (we use the canonical Unicode codepoints
    // — colour is OFF so escape codes don't intrude).
    expect(out).toContain("◐") // idle
    expect(out).toContain("◇") // recent
    expect(out).toContain("◯") // old
    expect(out).toContain("✗") // archived
    // Archived split header.
    expect(out).toContain("archived")
  })

  test("rich format omits git badge when fingerprint absent", () => {
    const entries: SessionListEntry[] = [
      mkEntry({ id: "nogit12345", title: "no git", cwd: "/no/repo" }),
    ]
    const out = renderSessionList(entries, { format: "rich" })
    expect(out).not.toMatch(/\[[^\]]+:[^\]]+\]/)
    expect(out).toContain("nogit1")
  })

  test("rich format footer announces filter + sort + show settings", () => {
    const entries: SessionListEntry[] = [mkEntry({ id: "foo-12345" })]
    const out = renderSessionList(entries, {
      format: "rich",
      filterCwd: "/work",
      filterBranch: "feat",
      sortBy: "title",
      lastN: 5,
    })
    expect(out).toContain("cwd=/work")
    expect(out).toContain("branch=feat")
    expect(out).toContain("sort=title")
    expect(out).toContain("show: top 5")
    expect(out).toContain("archived=hidden")
  })
})

describe("applyListPipeline", () => {
  test("filterCwd narrows to substring match", () => {
    const entries: SessionListEntry[] = [
      mkEntry({ id: "a", cwd: "/Users/me/quanta" }),
      mkEntry({ id: "b", cwd: "/Users/me/other" }),
      mkEntry({ id: "c", cwd: "/tmp/quanta-side" }),
    ]
    const out = applyListPipeline(entries, { filterCwd: "quanta" })
    expect(out.map((e) => e.meta.id).sort()).toEqual(["a", "c"])
  })

  test("filterBranch matches gitBranch substring; sessions without branch dropped", () => {
    const entries: SessionListEntry[] = [
      mkEntry({ id: "a", gitBranch: "feat/login" }),
      mkEntry({ id: "b", gitBranch: "main" }),
      mkEntry({ id: "c" }), // no branch
    ]
    const out = applyListPipeline(entries, { filterBranch: "feat" })
    expect(out.map((e) => e.meta.id)).toEqual(["a"])
  })

  test("lastN caps the list after sorting (recent first)", () => {
    const now = 1_700_000_000_000
    const entries: SessionListEntry[] = [
      mkEntry({ id: "old", lastTouched: now - 30 * DAY * 1000 }),
      mkEntry({ id: "mid", lastTouched: now - 3 * DAY * 1000 }),
      mkEntry({ id: "new", lastTouched: now - 1 * HOUR * 1000 }),
    ]
    const out = applyListPipeline(entries, { lastN: 2, sortBy: "recent" })
    expect(out.map((e) => e.meta.id)).toEqual(["new", "mid"])
  })

  test("sortBy=title is lexicographic A→Z", () => {
    const entries: SessionListEntry[] = [
      mkEntry({ id: "1", title: "charlie" }),
      mkEntry({ id: "2", title: "alpha" }),
      mkEntry({ id: "3", title: "bravo" }),
    ]
    const out = applyListPipeline(entries, { sortBy: "title" })
    expect(out.map((e) => e.meta.title)).toEqual(["alpha", "bravo", "charlie"])
  })

  test("sortBy=size orders by turns desc; missing turns treated as 0", () => {
    const entries: SessionListEntry[] = [
      mkEntry({ id: "small" }, { turns: 2 }),
      mkEntry({ id: "huge" }, { turns: 50 }),
      mkEntry({ id: "absent" }), // no turns -> 0
      mkEntry({ id: "mid" }, { turns: 20 }),
    ]
    const out = applyListPipeline(entries, { sortBy: "size" })
    expect(out.map((e) => e.meta.id)).toEqual(["huge", "mid", "small", "absent"])
  })

  test("archived hidden by default; showArchived=true keeps them", () => {
    const entries: SessionListEntry[] = [
      mkEntry({ id: "a" }),
      mkEntry({ id: "b", archived: true }, { archived: true }),
    ]
    const hidden = applyListPipeline(entries, {})
    expect(hidden.map((e) => e.meta.id)).toEqual(["a"])
    const shown = applyListPipeline(entries, { showArchived: true })
    expect(shown.map((e) => e.meta.id).sort()).toEqual(["a", "b"])
  })
})

describe("buildSessionListEntries", () => {
  test("computes ageSeconds from injected now", async () => {
    const now = 1_700_000_000_000
    const metas: SessionMeta[] = [
      mkMeta({ id: "x", lastTouched: now - 7200 * 1000 }), // 2h
    ]
    const out = await buildSessionListEntries(metas, { now })
    expect(out[0]?.ageSeconds).toBe(7200)
  })

  test("turnsById injection populates turns column", async () => {
    const now = 1_700_000_000_000
    const metas: SessionMeta[] = [mkMeta({ id: "x", lastTouched: now })]
    const out = await buildSessionListEntries(metas, {
      now,
      turnsById: new Map([["x", 42]]),
    })
    expect(out[0]?.turns).toBe(42)
  })

  test("missing token estimate stays undefined (no on-disk file)", async () => {
    // We point QUANTA_SESSIONS_DIR at a guaranteed-empty path so the
    // stat() calls inside estimateTokens all fail → totalTokens omitted.
    const prev = process.env.QUANTA_SESSIONS_DIR
    process.env.QUANTA_SESSIONS_DIR = "/nonexistent/quanta-test-empty"
    try {
      const metas: SessionMeta[] = [mkMeta({ id: "ghost-id-zzz" })]
      const out = await buildSessionListEntries(metas, {
        now: Date.now(),
        withTokenEstimates: true,
      })
      expect(out[0]?.totalTokens).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.QUANTA_SESSIONS_DIR
      else process.env.QUANTA_SESSIONS_DIR = prev
    }
  })
})

describe("color OFF parity", () => {
  test("plain format never emits ANSI codes regardless of policy", () => {
    setColorPolicy("on")
    try {
      const entries: SessionListEntry[] = [mkEntry({ id: "p-no-color" })]
      const out = renderSessionList(entries, { format: "plain" })
      // No ESC byte anywhere.
      expect(out.includes(String.fromCharCode(27))).toBe(false)
    } finally {
      setColorPolicy(null)
    }
  })

  test("rich format with colour OFF emits no ESC bytes", () => {
    setColorPolicy("off")
    const entries: SessionListEntry[] = [
      mkEntry(
        { id: "rich-noc", gitBranch: "main" },
        { ageSeconds: HOUR, turns: 3, totalTokens: 800 },
      ),
    ]
    const out = renderSessionList(entries, { format: "rich" })
    expect(out.includes(String.fromCharCode(27))).toBe(false)
  })
})
