/**
 * WS-F move 2 (UUX-3-06 / UUX-5-07 / UUX-5-24) — the ConnectionState machine.
 *
 * One pure transition function drives the whole connection UX: bootstrap
 * retry is CAPPED (→ `failed` + retry CTA instead of "Connecting…" forever),
 * a hydrate `!resp.ok` degrades with a banner instead of a silent empty
 * transcript, and the empty-state copy / composer enablement derive from the
 * same state. Exhaustive transition-table test (every state × every event).
 */

import { describe, expect, it } from "vitest"
import type { ConnectionState } from "../types/protocol"
import {
  BOOTSTRAP_MAX_ATTEMPTS,
  bootstrapRetryDelayMs,
  composerEnabled,
  connectionBanner,
  emptyStateCopyFor,
  INITIAL_UI_CONNECTION,
  transitionUiConnection,
  type UiConnectionEvent,
  type UiConnectionState,
} from "./connection-state"

/* ------------------------------------------------------------------ */
/* Fixtures — one instance of every state and every event              */
/* ------------------------------------------------------------------ */

const CONNECTING: UiConnectionState = { phase: "connecting", attempt: 3 }
const CONNECTED: UiConnectionState = { phase: "connected" }
const DEGRADED: UiConnectionState = { phase: "degraded", reason: "history unavailable (HTTP 500)" }
const FAILED: UiConnectionState = { phase: "failed", reason: "bootstrap gave up" }

const socket = (s: ConnectionState): UiConnectionEvent => ({ type: "socket-changed", socket: s })
const SOCKET_CONNECTED = socket({ kind: "connected" })
const SOCKET_CONNECTING = socket({ kind: "connecting", attempt: 7 })
const SOCKET_DISCONNECTED = socket({ kind: "disconnected", attempt: 4, retryInMs: 800 })
const SOCKET_CLOSED = socket({ kind: "closed" })
const BOOT_FAILED: UiConnectionEvent = { type: "bootstrap-attempt-failed", attempt: 5 }
const BOOT_GAVE_UP: UiConnectionEvent = {
  type: "bootstrap-gave-up",
  reason: "no daemon after 20 attempts",
}
const HYDRATE_FAILED: UiConnectionEvent = { type: "hydrate-failed", reason: "HTTP 500" }
const HYDRATE_RECOVERED: UiConnectionEvent = { type: "hydrate-recovered" }
const RETRY: UiConnectionEvent = { type: "retry-requested" }

describe("transitionUiConnection — exhaustive table", () => {
  const table: readonly {
    name: string
    from: UiConnectionState
    event: UiConnectionEvent
    to: UiConnectionState
  }[] = [
    // connecting ----------------------------------------------------
    {
      name: "connecting + socket connected → connected",
      from: CONNECTING,
      event: SOCKET_CONNECTED,
      to: { phase: "connected" },
    },
    {
      name: "connecting + socket connecting → connecting (attempt follows socket)",
      from: CONNECTING,
      event: SOCKET_CONNECTING,
      to: { phase: "connecting", attempt: 7 },
    },
    {
      name: "connecting + socket disconnected → connecting (auto-retry in flight)",
      from: CONNECTING,
      event: SOCKET_DISCONNECTED,
      to: { phase: "connecting", attempt: 4 },
    },
    {
      name: "connecting + socket closed → connecting (pre-connect closed is noise)",
      from: CONNECTING,
      event: SOCKET_CLOSED,
      to: CONNECTING,
    },
    {
      name: "connecting + bootstrap-attempt-failed → connecting (attempt advances)",
      from: CONNECTING,
      event: BOOT_FAILED,
      to: { phase: "connecting", attempt: 5 },
    },
    {
      name: "connecting + bootstrap-gave-up → FAILED (the UUX-3-06 cap)",
      from: CONNECTING,
      event: BOOT_GAVE_UP,
      to: { phase: "failed", reason: "no daemon after 20 attempts" },
    },
    {
      name: "connecting + hydrate-failed → degraded",
      from: CONNECTING,
      event: HYDRATE_FAILED,
      to: { phase: "degraded", reason: "HTTP 500" },
    },
    {
      name: "connecting + hydrate-recovered → connecting (no-op)",
      from: CONNECTING,
      event: HYDRATE_RECOVERED,
      to: CONNECTING,
    },
    {
      name: "connecting + retry → connecting attempt 0",
      from: CONNECTING,
      event: RETRY,
      to: { phase: "connecting", attempt: 0 },
    },
    // connected -----------------------------------------------------
    {
      name: "connected + socket connected → connected",
      from: CONNECTED,
      event: SOCKET_CONNECTED,
      to: CONNECTED,
    },
    {
      name: "connected + socket connecting → connecting (reconnect visible)",
      from: CONNECTED,
      event: SOCKET_CONNECTING,
      to: { phase: "connecting", attempt: 7 },
    },
    {
      name: "connected + socket disconnected → connecting",
      from: CONNECTED,
      event: SOCKET_DISCONNECTED,
      to: { phase: "connecting", attempt: 4 },
    },
    {
      name: "connected + socket closed → connecting (deliberate reconnect cycle)",
      from: CONNECTED,
      event: SOCKET_CLOSED,
      to: { phase: "connecting", attempt: 0 },
    },
    {
      name: "connected + stale bootstrap-attempt-failed → connected",
      from: CONNECTED,
      event: BOOT_FAILED,
      to: CONNECTED,
    },
    {
      name: "connected + stale bootstrap-gave-up → connected",
      from: CONNECTED,
      event: BOOT_GAVE_UP,
      to: CONNECTED,
    },
    {
      name: "connected + hydrate-failed → DEGRADED (the UUX-5-07 banner)",
      from: CONNECTED,
      event: HYDRATE_FAILED,
      to: { phase: "degraded", reason: "HTTP 500" },
    },
    {
      name: "connected + hydrate-recovered → connected",
      from: CONNECTED,
      event: HYDRATE_RECOVERED,
      to: CONNECTED,
    },
    {
      name: "connected + retry → connecting attempt 0",
      from: CONNECTED,
      event: RETRY,
      to: { phase: "connecting", attempt: 0 },
    },
    // degraded (sticky against socket churn) ------------------------
    {
      name: "degraded + socket connected → degraded (banner survives)",
      from: DEGRADED,
      event: SOCKET_CONNECTED,
      to: DEGRADED,
    },
    {
      name: "degraded + socket connecting → degraded",
      from: DEGRADED,
      event: SOCKET_CONNECTING,
      to: DEGRADED,
    },
    {
      name: "degraded + socket disconnected → degraded",
      from: DEGRADED,
      event: SOCKET_DISCONNECTED,
      to: DEGRADED,
    },
    {
      name: "degraded + socket closed → degraded",
      from: DEGRADED,
      event: SOCKET_CLOSED,
      to: DEGRADED,
    },
    {
      name: "degraded + bootstrap-attempt-failed → degraded",
      from: DEGRADED,
      event: BOOT_FAILED,
      to: DEGRADED,
    },
    {
      name: "degraded + bootstrap-gave-up → failed (failure dominates)",
      from: DEGRADED,
      event: BOOT_GAVE_UP,
      to: { phase: "failed", reason: "no daemon after 20 attempts" },
    },
    {
      name: "degraded + hydrate-failed → degraded (latest reason)",
      from: DEGRADED,
      event: { type: "hydrate-failed", reason: "HTTP 404" },
      to: { phase: "degraded", reason: "HTTP 404" },
    },
    {
      name: "degraded + hydrate-recovered → connected (banner clears)",
      from: DEGRADED,
      event: HYDRATE_RECOVERED,
      to: { phase: "connected" },
    },
    {
      name: "degraded + retry → connecting attempt 0",
      from: DEGRADED,
      event: RETRY,
      to: { phase: "connecting", attempt: 0 },
    },
    // failed (sticky except retry / live socket) --------------------
    {
      name: "failed + socket connected → connected (honest recovery)",
      from: FAILED,
      event: SOCKET_CONNECTED,
      to: { phase: "connected" },
    },
    {
      name: "failed + socket connecting → failed (no zombie spinner)",
      from: FAILED,
      event: SOCKET_CONNECTING,
      to: FAILED,
    },
    {
      name: "failed + socket disconnected → failed",
      from: FAILED,
      event: SOCKET_DISCONNECTED,
      to: FAILED,
    },
    { name: "failed + socket closed → failed", from: FAILED, event: SOCKET_CLOSED, to: FAILED },
    {
      name: "failed + stale bootstrap-attempt-failed → failed",
      from: FAILED,
      event: BOOT_FAILED,
      to: FAILED,
    },
    {
      name: "failed + bootstrap-gave-up → failed (latest reason)",
      from: FAILED,
      event: { type: "bootstrap-gave-up", reason: "still down" },
      to: { phase: "failed", reason: "still down" },
    },
    {
      name: "failed + hydrate-failed → failed (failed dominates degrade)",
      from: FAILED,
      event: HYDRATE_FAILED,
      to: FAILED,
    },
    {
      name: "failed + hydrate-recovered → failed",
      from: FAILED,
      event: HYDRATE_RECOVERED,
      to: FAILED,
    },
    {
      name: "failed + retry → connecting attempt 0 (the CTA)",
      from: FAILED,
      event: RETRY,
      to: { phase: "connecting", attempt: 0 },
    },
  ]

  for (const row of table) {
    it(row.name, () => {
      expect(transitionUiConnection(row.from, row.event)).toEqual(row.to)
    })
  }

  it("initial state is connecting attempt 0", () => {
    expect(INITIAL_UI_CONNECTION).toEqual({ phase: "connecting", attempt: 0 })
  })
})

describe("bootstrap retry cap + backoff (UUX-3-06)", () => {
  it("caps attempts at a finite bound (not unbounded 200ms-forever)", () => {
    expect(BOOTSTRAP_MAX_ATTEMPTS).toBeGreaterThanOrEqual(5)
    expect(BOOTSTRAP_MAX_ATTEMPTS).toBeLessThanOrEqual(50)
  })

  it("backs off monotonically and is bounded", () => {
    let prev = 0
    for (let attempt = 0; attempt < BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
      const d = bootstrapRetryDelayMs(attempt)
      expect(d).toBeGreaterThanOrEqual(prev)
      expect(d).toBeLessThanOrEqual(10_000)
      prev = d
    }
    expect(bootstrapRetryDelayMs(0)).toBeGreaterThanOrEqual(100)
  })

  it("driving the machine through MAX failed attempts then gave-up lands in failed", () => {
    let state = INITIAL_UI_CONNECTION
    for (let attempt = 1; attempt <= BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
      state = transitionUiConnection(state, { type: "bootstrap-attempt-failed", attempt })
      expect(state.phase).toBe("connecting")
    }
    state = transitionUiConnection(state, { type: "bootstrap-gave-up", reason: "cap reached" })
    expect(state).toEqual({ phase: "failed", reason: "cap reached" })
  })
})

describe("derived UI facets", () => {
  it("composer: enabled for connected + degraded, disabled for connecting + failed", () => {
    expect(composerEnabled(CONNECTED)).toBe(true)
    expect(composerEnabled(DEGRADED)).toBe(true)
    expect(composerEnabled(CONNECTING)).toBe(false)
    expect(composerEnabled(FAILED)).toBe(false)
  })

  it("empty-state copy: connected/degraded invite, connecting/failed are honest (UUX-5-24)", () => {
    expect(emptyStateCopyFor("connected").title).toBe("Start a conversation")
    expect(emptyStateCopyFor("degraded").title).toBe("Start a conversation")
    expect(emptyStateCopyFor("connecting").title.toLowerCase()).toContain("connecting")
    expect(emptyStateCopyFor("failed").title.toLowerCase()).toContain("not connected")
    expect(emptyStateCopyFor("connecting").title).not.toBe("Start a conversation")
  })

  it("banner: degraded explains, failed explains + offers retry, others render nothing", () => {
    expect(connectionBanner(CONNECTED)).toBeNull()
    expect(connectionBanner(CONNECTING)).toBeNull()
    const degraded = connectionBanner(DEGRADED)
    expect(degraded?.text).toContain("HTTP 500")
    expect(degraded?.retry).toBe(false)
    const failed = connectionBanner(FAILED)
    expect(failed?.text).toContain("bootstrap gave up")
    expect(failed?.retry).toBe(true)
  })
})
