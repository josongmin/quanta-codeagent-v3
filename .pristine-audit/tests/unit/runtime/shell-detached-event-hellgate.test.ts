/**
 * ★ HELLGATE — WS-H / UUX-6-05 + UUX-6-20: honest `detached` terminal event.
 *
 * At HEAD an INTENTIONAL background detach (consent-approved, consent-timeout
 * default, or plain auto-background) emits `{kind:"aborted", reason:"timeout"}`
 * — the same event as a REAL timeout kill. The painter then lies to the
 * operator ("[shell] aborted (timeout)") about a command that is alive and
 * healthy in the background registry.
 *
 * Fix under test: the detach paths emit a DISTINCT terminal
 * `{kind:"detached", reason: consent|consent_timeout|auto, detachedAt}`;
 * the consent-timeout default (D-5: kept, but ANNOUNCED) additionally carries
 * `consentWaitMs` so the surface can say "no answer in Ns".
 *
 * PAIRED CONTROLS (must stay byte-identical):
 *  - consent DECLINED ⇒ kill ⇒ `{kind:"aborted", reason:"timeout"}` unchanged.
 *  - legacy (no background seam) timeout kill ⇒ `aborted(timeout)` unchanged.
 *
 * Real `bash` children (POSIX only) — mirrors shell-background-detach-hellgate.
 */

import { describe, expect, test } from "bun:test"
import type { BackgroundDetachSeam, RunShellEvent } from "@/runtime"
import { runShell } from "@/runtime"

const POSIX = process.platform !== "win32"

const recordingSeam = (id = "bg-ev-1") => {
  const calls: Array<Parameters<BackgroundDetachSeam["adopt"]>[0]> = []
  const seam: BackgroundDetachSeam = {
    adopt: async (args) => {
      calls.push(args)
      return { id }
    },
  }
  return { seam, calls }
}

const reap = async (calls: ReturnType<typeof recordingSeam>["calls"]): Promise<void> => {
  calls[0]?.kill()
  await calls[0]?.exited.catch(() => 0)
}

const terminalsOf = (events: readonly RunShellEvent[]): RunShellEvent[] =>
  events.filter((e) => e.kind === "exit" || e.kind === "aborted" || e.kind === "detached")

describe.if(POSIX)(
  "UUX-6-05 — intentional detach emits `detached`, NOT `aborted (timeout)`",
  () => {
    test("consent APPROVED ⇒ terminal {kind:'detached', reason:'consent'} (RED at HEAD)", async () => {
      const { seam, calls } = recordingSeam()
      const events: RunShellEvent[] = []
      const r = await runShell("printf 'pre\\n'; sleep 5", {
        background: { ...seam, confirm: async () => true },
        timeoutMs: 120,
        onShellEvent: (e) => events.push(e),
      })
      expect(r.detached).toBeDefined()
      const terminals = terminalsOf(events)
      expect(terminals).toHaveLength(1) // observer never left open, never doubled
      expect(terminals[0]?.kind).toBe("detached") // ← RED at HEAD: "aborted"
      expect(terminals[0]?.kind === "detached" ? terminals[0].reason : undefined).toBe("consent")
      // ordering: terminal is LAST
      expect(events.at(-1)?.kind).toBe("detached")
      await reap(calls)
    })

    test("plain auto-background (no confirm) ⇒ {kind:'detached', reason:'auto'}", async () => {
      const { seam, calls } = recordingSeam()
      const events: RunShellEvent[] = []
      const r = await runShell("printf 'pre\\n'; sleep 5", {
        background: seam,
        timeoutMs: 120,
        onShellEvent: (e) => events.push(e),
      })
      expect(r.detached).toBeDefined()
      const terminals = terminalsOf(events)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.kind).toBe("detached")
      expect(terminals[0]?.kind === "detached" ? terminals[0].reason : undefined).toBe("auto")
      await reap(calls)
    })

    test("UUX-6-20 — consent prompt NEVER answered ⇒ default-detach announced as reason:'consent_timeout' + consentWaitMs", async () => {
      const { seam, calls } = recordingSeam()
      const events: RunShellEvent[] = []
      const r = await runShell("printf 'pre\\n'; sleep 5", {
        background: {
          ...seam,
          confirm: () => new Promise<boolean>(() => undefined), // operator walked away
          consentWaitMs: 150, // injectable wait (prod default: 60s named const)
        },
        timeoutMs: 120,
        onShellEvent: (e) => events.push(e),
      })
      expect(r.detached).toBeDefined() // D-5: the default STAYS detach
      const terminals = terminalsOf(events)
      expect(terminals).toHaveLength(1)
      const t = terminals[0]
      expect(t?.kind).toBe("detached")
      if (t?.kind === "detached") {
        expect(t.reason).toBe("consent_timeout") // …but it is ANNOUNCED, not silent
        expect(t.consentWaitMs).toBe(150)
      }
      await reap(calls)
    })
  },
)

describe.if(POSIX)(
  "PAIRED CONTROLS — real kills still paint aborted(timeout) byte-identically",
  () => {
    test("consent DECLINED ⇒ kill ⇒ terminal {kind:'aborted', reason:'timeout'} (unchanged)", async () => {
      const { seam, calls } = recordingSeam()
      const events: RunShellEvent[] = []
      const r = await runShell("printf 'pre\\n'; sleep 1", {
        background: { ...seam, confirm: async () => false },
        timeoutMs: 120,
        onShellEvent: (e) => events.push(e),
      })
      expect(r.detached).toBeUndefined()
      expect(r.timedOut).toBe(true)
      expect(calls).toHaveLength(0)
      const terminals = terminalsOf(events)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.kind).toBe("aborted")
      expect(terminals[0]?.kind === "aborted" ? terminals[0].reason : undefined).toBe("timeout")
    }, 15_000)

    test("legacy timeout (NO background seam) ⇒ {kind:'aborted', reason:'timeout'} (unchanged)", async () => {
      const events: RunShellEvent[] = []
      const r = await runShell("sleep 2", {
        timeoutMs: 120,
        onShellEvent: (e) => events.push(e),
      })
      expect(r.timedOut).toBe(true)
      const terminals = terminalsOf(events)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.kind).toBe("aborted")
      expect(terminals[0]?.kind === "aborted" ? terminals[0].reason : undefined).toBe("timeout")
    }, 15_000)
  },
)
