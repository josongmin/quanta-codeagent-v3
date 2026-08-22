/**
 * AI-generated session title — opt-in, cheap-model, fire-and-forget titler
 * (RFC `docs/plans/jun-6-ai-session-title.md`).
 *
 * On the FIRST turn only, an opted-in composition root kicks this off WITHOUT
 * awaiting it: a cheap injected `LLMPort` summarizes the first user prompt into
 * a ≤N-word title which is written to `SessionMeta.title` via an injected
 * `rename` adapter. Three hard invariants:
 *
 *   1. Default-OFF — the port is built ONLY when the knob is set; absent ⇒ the
 *      loop never calls it ⇒ byte-identical (the gating lives at the root).
 *   2. Never blocks — `maybeTitle` returns `void` synchronously; the real work
 *      runs on a detached promise the turn never awaits. A slow/hung/failed
 *      call is swallowed and abandoned via `timeoutMs`.
 *   3. Don't clobber — before writing, the titler RE-READS the current title
 *      via the injected `currentTitle` reader; if a human already renamed the
 *      session (the title is no longer a placeholder per the injected
 *      `isPlaceholder` predicate) the write is SKIPPED — manual rename wins.
 *
 * Closed-port: this leaf imports ONLY `@/llm` types and consumes everything
 * else (rename writer, title reader, placeholder predicate, clock) as injected
 * ports. It does NOT import `@/session` store internals or `@/agent` loop
 * internals — the composition root wires the real adapters.
 */
import { assembleFromEvents, type LLMPort, type StreamEvent } from "@/llm"
import { errMessage, sliceWholeChars } from "@/shared"

/** Injected collaborators for {@link createAutoTitlePort}. */
export interface AutoTitlePorts {
  /** Cheap-model port (pinned to `QUANTA_SESSION_TITLE_MODEL` at the root). */
  readonly llm: LLMPort
  /** Adapter over `renameSession(id, title)`. */
  readonly rename: (id: string, title: string) => Promise<void>
  /** Fresh read of the session's CURRENT title (for the don't-clobber check).
   *  Returns `undefined` when the session is gone / unreadable. */
  readonly currentTitle: (id: string) => Promise<string | undefined>
  /** TRUE ⇒ the title is still an auto/placeholder value (safe to overwrite);
   *  FALSE ⇒ a human has set it and the auto-title MUST yield. Injected so the
   *  leaf never encodes the seeded-title shape. */
  readonly isPlaceholder: (title: string) => boolean
  /** Injected monotonic clock in ms (no `Date.now` in the leaf). */
  readonly clock: () => number
  /** Best-effort debug sink (e.g. a tracer). Swallowed; never throws. */
  readonly debug?: (message: string) => void
  /** Max words in the generated title (default {@link DEFAULT_MAX_WORDS}). */
  readonly maxWords?: number
  /** Abandon the LLM call after this many ms (default {@link DEFAULT_TIMEOUT_MS}). */
  readonly timeoutMs?: number
  /** Truncate the first prompt to this many chars before sending (bounds input
   *  cost regardless of prompt size; default {@link DEFAULT_MAX_INPUT_CHARS}). */
  readonly maxInputChars?: number
}

/** The duck-typed seam the loop holds. Absent ⇒ feature inert. */
export interface AutoTitlePort {
  /** Fire-and-forget: kicks off the cheap title call for the first turn and
   *  returns IMMEDIATELY. The turn never awaits this. ALL failures swallowed. */
  maybeTitle(sessionId: string, firstPrompt: string): void
}

export const DEFAULT_MAX_WORDS = 6
export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_MAX_INPUT_CHARS = 2_000
/** Cap the sanitized title so a runaway model can't write an unbounded string
 *  into session metadata. */
export const MAX_TITLE_CHARS = 80

const buildTitlePrompt = (firstPrompt: string, maxWords: number, maxInputChars: number): string => {
  const clipped =
    firstPrompt.length > maxInputChars ? sliceWholeChars(firstPrompt, maxInputChars) : firstPrompt
  return (
    `Summarize this request as a title of at most ${maxWords} words. ` +
    `Respond with ONLY the title — no quotes, no punctuation, no preamble:\n\n` +
    clipped
  )
}

/** Strip newlines, collapse whitespace, drop wrapping quotes, clamp to
 *  {@link maxWords} words and {@link MAX_TITLE_CHARS} chars. Returns "" when
 *  nothing usable remains (caller then skips the write). */
export const sanitizeTitle = (raw: string, maxWords: number): string => {
  const collapsed = raw
    // Strip C0/C1 control chars (NUL/BEL/ESC-introducer + the rest) so a
    // model-emitted ANSI escape or terminal-control sequence can never survive
    // into the title write — a transcript/terminal-escape injection defense.
    // `\t`/`\n`/`\r` are excluded here; the next `\s+` rule collapses them to a
    // single space rather than dropping them.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately stripping control chars
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    // Strip the Trojan-Source / visual-spoofing class the C0/C1 sweep misses:
    // bidi controls (ALM U+061C; LRM/RLM/LRE/RLE/PDF/LRO/RLO U+200E–U+202E;
    // LRI/RLI/FSI/PDI U+2066–U+2069) and zero-width / invisible formatters
    // (ZWSP U+200B, ZWNJ U+200C, ZWJ U+200D, WORD JOINER U+2060, BOM/ZWNBSP
    // U+FEFF). These are NOT whitespace, so the `\s+` collapse above does not
    // catch them — a malicious first prompt (or a compromised cheap title
    // model) could otherwise write a title that visually misrepresents itself
    // in the session list (CVE-2021-42574 / Trojan-Source class).
    .replace(/[؜​-‏⁠‪-‮⁦-⁩﻿]/g, "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
  if (collapsed === "") return ""
  const words = collapsed.split(" ").slice(0, maxWords).join(" ")
  return words.length > MAX_TITLE_CHARS ? sliceWholeChars(words, MAX_TITLE_CHARS).trim() : words
}

/** Drain `events` to joined assistant text. */
const eventsToText = (events: StreamEvent[]): string => {
  const { message } = assembleFromEvents(events)
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
}

/** Resolve `inner` but reject (best-effort) once `timeoutMs` of injected-clock
 *  time has elapsed. The timer is polled against the injected clock so tests
 *  with a fake clock are deterministic. */
const withTimeout = <T>(inner: Promise<T>, timeoutMs: number, clock: () => number): Promise<T> => {
  const start = clock()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    inner.then(
      (v) => {
        if (settled) return
        settled = true
        clearInterval(timer)
        resolve(v)
      },
      (e) => {
        if (settled) return
        settled = true
        clearInterval(timer)
        reject(e)
      },
    )
    const timer = setInterval(() => {
      if (settled) return
      if (clock() - start >= timeoutMs) {
        settled = true
        clearInterval(timer)
        reject(new Error("auto-title: timed out"))
      }
    }, 5)
  })
}

/**
 * The titler core: stream a cheap title, sanitize, re-read the current title to
 * avoid clobbering a human rename, then write. Resolves `void`; EVERY failure
 * (LLM throw, timeout, rename throw, read throw) is caught and swallowed — it
 * NEVER propagates. Exported for direct hellgate coverage.
 */
export const generateSessionTitle = async (
  sessionId: string,
  firstPrompt: string,
  ports: AutoTitlePorts,
): Promise<void> => {
  const maxWords = ports.maxWords ?? DEFAULT_MAX_WORDS
  const timeoutMs = ports.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxInputChars = ports.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS
  try {
    if (firstPrompt.trim() === "") {
      ports.debug?.("auto-title: empty prompt, skipping")
      return
    }
    const drain = (async (): Promise<StreamEvent[]> => {
      const events: StreamEvent[] = []
      for await (const ev of ports.llm.stream({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildTitlePrompt(firstPrompt, maxWords, maxInputChars) },
            ],
          },
        ],
        tools: [],
      })) {
        events.push(ev)
      }
      return events
    })()
    const events = await withTimeout(drain, timeoutMs, ports.clock)
    const title = sanitizeTitle(eventsToText(events), maxWords)
    if (title === "") {
      ports.debug?.("auto-title: model returned empty title, skipping")
      return
    }
    // Don't-clobber: re-read just before writing. A human rename that landed
    // while the cheap call was in flight wins.
    const current = await ports.currentTitle(sessionId)
    if (current !== undefined && !ports.isPlaceholder(current)) {
      ports.debug?.(`auto-title: human title "${current}" present, not clobbering`)
      return
    }
    await ports.rename(sessionId, title)
    ports.debug?.(`auto-title: wrote "${title}" for ${sessionId}`)
  } catch (err) {
    ports.debug?.(`auto-title: swallowed ${errMessage(err)}`)
  }
}

/**
 * Build the fire-and-forget {@link AutoTitlePort} from injected ports. The
 * composition root calls this ONLY when `QUANTA_SESSION_AUTO_TITLE` is set AND
 * a cheap `QUANTA_SESSION_TITLE_MODEL` `LLMPort` is available; otherwise it
 * never builds the port and the loop branch is dead (byte-identical).
 */
export const createAutoTitlePort = (ports: AutoTitlePorts): AutoTitlePort => ({
  maybeTitle(sessionId: string, firstPrompt: string): void {
    // Detached: the turn never awaits this promise. `generateSessionTitle`
    // already swallows everything, but guard the kick-off itself too so a
    // synchronous throw can never escape into the loop.
    try {
      void generateSessionTitle(sessionId, firstPrompt, ports)
    } catch (err) {
      ports.debug?.(`auto-title: kick-off swallowed ${errMessage(err)}`)
    }
  },
})
