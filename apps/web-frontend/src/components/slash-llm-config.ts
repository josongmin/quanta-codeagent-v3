/**
 * Slash commands that talk to the daemon's `POST /config` endpoint to
 * mutate LLM knobs at runtime. Pure helper — no React imports, no
 * coupling to SlashPalette's React layer beyond the `SlashCommand` shape.
 *
 * Wire: pass `httpUrl` (derived from the WS URL — same host/port, http
 * scheme) + optional bearer token. The factory returns a `SlashCommand[]`
 * suitable for splicing into `buildDefaultSlashCommands(...)`'s return.
 *
 * Side-channel by design: the slash command POSTs to the daemon, NOT
 * through the WS session protocol. Reason: the daemon's `LLMPort`
 * adapter (`src/llm/adapters/chatgpt-oauth.ts`) reads `process.env`
 * directly on each call — the POST mutates that env so the next turn
 * picks the new value up. A future iteration can move this onto a
 * proper `SessionCommand` once we add a `config.set` envelope upstream.
 */

import { planRetryWith } from "../lib/retry-with"
import type { UiMessage } from "../types/protocol"
import type { SlashCommand } from "./SlashPalette"

export interface LlmConfigEndpoint {
  /** Full HTTP base URL for the daemon, e.g. `http://127.0.0.1:4096`. */
  readonly httpUrl: string
  /** Bearer token from the WS auth handshake (same value). */
  readonly token?: string
  /** Optional toast hook so the host page can surface success / errors. */
  readonly onResult?: (msg: string, kind: "ok" | "err") => void
  /** P2 (UUX-4-18) — live transcript accessor for `/retry-with` (last user
   *  message). Threaded on by the catalogue when the App wires it; absent ⇒
   *  the entry reports "no prior turn". */
  readonly getMessages?: () => readonly UiMessage[]
  /** P2 (UUX-4-18) — resend a turn (the App's `sendTurn`), used by
   *  `/retry-with` after applying the model override. Absent ⇒ no resend. */
  readonly resend?: (text: string) => void
  /**
   * aug-28 — the OUT-OF-BAND control-request sender (`SessionClient
   * .sendControlRequest`). This is the ONLY door that actually changes the model:
   * the daemon's control port persists the pick and the next turn runs it.
   *
   * Absent (offline / no socket) ⇒ `/model <id>` says it cannot switch rather
   * than pretending. Returns false when the socket is not open.
   */
  readonly sendControlRequest?: (request: { kind: string; [k: string]: unknown }) => boolean
  /** aug-28 — print a readout body into the transcript (the `/model` listing
   *  shares the readout route rather than minting a second model vocabulary). */
  readonly showReadout?: (name: string) => Promise<void>
  /** aug-28 — READ a readout body without printing it, so `/model <id>` can wait
   *  for the switch to actually take before it reports (see `awaitModelApplied`).
   *  Absent ⇒ the command reports optimistically, as it did before. */
  readonly readReadout?: (name: string) => Promise<string | undefined>
  /** Injected sleep (test seam). Absent ⇒ a real timer. */
  readonly delay?: (ms: number) => Promise<void>
}

/** Wait (bounded) for the `/model` readout to report `slug` as the effective model.
 *
 *  Returns `true` once the readout's `model  <id>` line names it, `false` if the
 *  window elapses first, and `undefined` when the surface wired no reader (⇒ the
 *  caller stays optimistic, the pre-aug-28 behavior). The readout's first line is
 *  `model  <id>` (see `renderWebModelReadout`); matching that specific line rather
 *  than "the body contains the slug" is what keeps a CANDIDATE row — every id is
 *  listed — from reading as success. */
const awaitModelApplied = async (
  ep: LlmConfigEndpoint,
  slug: string,
): Promise<boolean | undefined> => {
  if (ep.readReadout === undefined) return undefined
  const sleep = ep.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // Bounded by ATTEMPTS, not by a wall clock: ~3s in production, and a test that
  // injects a no-op `delay` finishes instantly instead of busy-spinning to a
  // deadline. No clock read, so nothing here depends on timer resolution.
  const applied = new RegExp(`^model\\s+${escapeForRegExp(slug)}\\s*$`, "m")
  for (let attempt = 0; attempt < MODEL_APPLY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(MODEL_APPLY_INTERVAL_MS)
    const body = await ep.readReadout("model")
    if (body !== undefined && applied.test(body)) return true
  }
  return false
}

/** ~3s of polling (20 × 150ms) — long enough to cover a control-tick plus the
 *  fire-and-forget store write, short enough that a genuinely rejected id is
 *  reported while the operator is still looking at the command they typed. */
const MODEL_APPLY_ATTEMPTS = 20
const MODEL_APPLY_INTERVAL_MS = 150

/** A model id is provider-supplied text, so it is escaped before it becomes part
 *  of a pattern — an id containing regex metacharacters must not change what the
 *  match means. (`src/shared/untrusted.ts` has the same one-liner as a private
 *  helper, but this is a separate Vite app: the slice fence forbids importing
 *  `@/shared` here, so a local copy is the only option, not a duplication.) */
const escapeForRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const postConfig = async (
  ep: LlmConfigEndpoint,
  body: Record<string, string | null>,
): Promise<void> => {
  try {
    const res = await fetch(`${ep.httpUrl.replace(/\/+$/, "")}/config`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(ep.token !== undefined ? { authorization: `Bearer ${ep.token}` } : {}),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      ep.onResult?.(`config failed (${res.status}): ${text.slice(0, 120)}`, "err")
      return
    }
    const label = Object.entries(body)
      .map(([k, v]) => `${k}=${v ?? "(cleared)"}`)
      .join(" ")
    // NOT "applied". The POST sets the key in the daemon's `process.env`, and these
    // values are resolved ONCE at the composition root and threaded into the LLM
    // adapter as constructor config — `resolveWebBootLLM(env)` runs before the server
    // listens, and the adapter's own contract says it "never reads process.env". So
    // the running session cannot see the change.
    //
    // This printed `applied: <keys>` in green on the strength of a docstring in
    // `web-daemon/server/http.ts` that claimed "the adapter layer reads these on every
    // LLM call". That claim was false and is corrected there. Same shape as the CLI's
    // `/knobs set`, which told the operator to run `/knobs save` and restart when
    // nothing reads the file: a green confirmation for a change that does not land.
    ep.onResult?.(
      `${label} — stored for the NEXT daemon start; the running session keeps its ` +
        `current adapter. Export it and restart the daemon to apply it now.`,
      "ok",
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    ep.onResult?.(`config network error: ${msg}`, "err")
  }
}

/**
 * Build the LLM-config slash command set. Splice into
 * `buildDefaultSlashCommands(...)`'s return array.
 *
 *   /fast            → service_tier = priority
 *   /standard        → service_tier cleared (backend default)
 *   /flex            → service_tier = flex (slow + cheap)
 *   /effort <level>  → reasoning_effort = low|medium|high
 *   /model <slug>    → model override
 */
export const buildLlmConfigSlashCommands = (ep: LlmConfigEndpoint): readonly SlashCommand[] => [
  {
    slug: "fast",
    aliases: ["speed", "priority"],
    description: "Fast mode — service_tier=priority (1.5× speed, more usage)",
    kind: "local",
    action: async () => {
      await postConfig(ep, { QUANTA_FAST: "1", QUANTA_SERVICE_TIER: null })
      return ""
    },
  },
  {
    slug: "standard",
    aliases: ["normal"],
    description: "Standard mode — clear fast/service_tier overrides",
    kind: "local",
    action: async () => {
      await postConfig(ep, { QUANTA_FAST: null, QUANTA_SERVICE_TIER: null })
      return ""
    },
  },
  {
    slug: "flex",
    description: "Flex tier — slower + cheaper queue",
    kind: "local",
    action: async () => {
      await postConfig(ep, { QUANTA_FAST: null, QUANTA_SERVICE_TIER: "flex" })
      return ""
    },
  },
  {
    slug: "effort",
    description: "Set reasoning effort — usage: /effort low|medium|high",
    kind: "local",
    action: async (rest) => {
      const level = rest.trim().toLowerCase()
      if (level !== "low" && level !== "medium" && level !== "high") {
        ep.onResult?.("usage: /effort low|medium|high", "err")
        return `/effort `
      }
      await postConfig(ep, { QUANTA_REASONING_EFFORT: level })
      return ""
    },
  },
  {
    // aug-28 — REAL model switching. This entry used to `POST /config
    // {QUANTA_MODEL}`, which changes nothing: the daemon builds its port ONCE at
    // boot via `tryCreateLLM(provider, {}, env)` and `createLLM` resolves the slug
    // as `opts.model ?? DEFAULT_MODEL[provider]` — it never reads `QUANTA_MODEL`.
    // So the operator typed `/model x`, saw no error, and kept talking to the
    // default model. The live door is the `controlRequest` frame (ADR-0496), which
    // the daemon persists into the sticky store the next turn reads.
    slug: "model",
    description: "Show or switch the model — /model (list) | /model <id> (switch)",
    kind: "local",
    action: async (rest) => {
      const slug = rest.trim()
      // No argument ⇒ the LISTING, served by the daemon's own `/model` readout
      // (effective model + every id `set_model` will accept). One vocabulary, one
      // source; the palette does not keep a second model list.
      if (slug.length === 0) {
        if (ep.showReadout === undefined) {
          ep.onResult?.("/model: no daemon connection — cannot list models", "err")
          return ""
        }
        await ep.showReadout("model")
        return ""
      }
      if (ep.sendControlRequest === undefined) {
        ep.onResult?.("/model: no live session socket — cannot switch models", "err")
        return ""
      }
      if (!ep.sendControlRequest({ kind: "set_model", model: slug })) {
        ep.onResult?.("/model: socket not open — the switch was not sent", "err")
        return ""
      }
      // HONEST CONFIRMATION: the daemon acks nothing on this channel, and an
      // off-catalog id is rejected server-side. So re-read the readout, which
      // reports the EFFECTIVE model — the operator sees what actually took.
      //
      // POLLED, not read once. The switch is applied out-of-band: the frame is
      // drained on the loop's next control tick and the store write is
      // fire-and-forget. A single immediate read-back therefore reported the OLD
      // model nearly always, under a line that said "reading back the effective
      // model" — i.e. the UI told the operator their switch had failed while it
      // was in fact landing a moment later.
      ep.onResult?.(`/model: requested ${slug}; reading back the effective model…`, "ok")
      const applied = await awaitModelApplied(ep, slug)
      await ep.showReadout?.("model")
      if (applied === false) {
        // Still not showing it after the window: say so plainly rather than
        // leaving the operator to compare two lines of output themselves.
        ep.onResult?.(
          `/model: ${slug} is still not the effective model — the daemon rejected it ` +
            `(off-catalog) or the switch has not applied yet`,
          "err",
        )
      }
      return ""
    },
  },
  {
    // P2 (jul-11, UUX-4-18) — /retry-with <slug>: the CLI re-runs the last turn
    // with a different model. The web protocol carries NO per-turn model
    // (TurnRunCommand is an empty envelope), so the HONEST parity is a two-step:
    // apply the model override THEN resend the last user message. The live
    // transcript + send path arrive endpoint-carried (getMessages/resend);
    // absent ⇒ "no prior turn". ONE retry-with impl, no parallel builder.
    slug: "retry-with",
    description: "Re-run the last turn with a different model — usage: /retry-with <slug>",
    kind: "local",
    action: async (rest) => {
      const plan = planRetryWith(rest ?? "", ep.getMessages?.() ?? [])
      if (!plan.ok) {
        ep.onResult?.(
          plan.reason === "no_slug"
            ? "usage: /retry-with <slug>  (e.g. /retry-with gpt-5)"
            : "/retry-with: no prior user message to resend",
          "err",
        )
        return plan.reason === "no_slug" ? "/retry-with " : ""
      }
      // Route the override through `set_model`, the SAME live door `/model` uses.
      //
      // This used to `postConfig(ep, { QUANTA_MODEL: plan.slug })` — the exact write
      // the comment on the `/model` entry above says "changes nothing: the daemon
      // builds its port ONCE at boot ... it never reads QUANTA_MODEL". So the resend
      // went out under the OLD model and the toast said "model override + resend".
      // `/model` was migrated to `set_model` in aug-28 and this entry was left behind.
      if (ep.sendControlRequest === undefined) {
        ep.onResult?.("/retry-with: no live session socket — cannot switch models", "err")
        return ""
      }
      if (!ep.sendControlRequest({ kind: "set_model", model: plan.slug })) {
        ep.onResult?.("/retry-with: socket not open — nothing was sent", "err")
        return ""
      }
      // The switch applies out-of-band, so WAIT for it before resending. Resending
      // first is what made the old path silently use the previous model.
      const applied = await awaitModelApplied(ep, plan.slug)
      if (applied === false) {
        ep.onResult?.(
          `/retry-with: ${plan.slug} did not become the effective model — the daemon ` +
            `rejected it (off-catalog) or the switch has not applied yet; nothing was resent`,
          "err",
        )
        return ""
      }
      ep.resend?.(plan.resendText)
      ep.onResult?.(
        `retrying last message under ${plan.slug} (switch confirmed, then resend)`,
        "ok",
      )
      return ""
    },
  },
]

/** Derive an HTTP base URL from a WebSocket URL (same host + port). */
export const httpUrlFromWsUrl = (wsUrl: string): string => {
  try {
    const u = new URL(wsUrl)
    const scheme = u.protocol === "wss:" ? "https:" : "http:"
    return `${scheme}//${u.host}`
  } catch {
    return wsUrl.replace(/^wss?:/, "http:")
  }
}

/** P2 (jul-11, UUX-4-18) — /retry-with deps: the palette entry needs the live
 *  transcript (last user message) and the composer's send path. Thin getters
 *  so the catalogue memo does not re-assemble per message. */
/** P2 (UUX-4-18) — the App-side deps the catalogue threads onto the shared
 *  endpoint so the (endpoint-carried) `/retry-with` reads the live transcript +
 *  resends. Kept as the wiring contract; there is ONE retry-with impl (baked
 *  into {@link buildLlmConfigSlashCommands}), no parallel builder. */
export interface RetryWithDeps {
  readonly getMessages: () => readonly UiMessage[]
  readonly sendUserTurn: (text: string) => void
}
