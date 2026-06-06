/**
 * G1 (RFC jun-6-appgen-appshot) — composition-layer assembly of the real
 * {@link AppshotPort}.
 *
 * The appshot slice (`@/tool/appshot`) is fence-clean: it imports NO
 * `@/browser`, `@/llm`, `@/artifact`. The verify loop drives a CLOSED port whose
 * four arrows (scaffold/render/screenshot/verify) are wired HERE — the one layer
 * where the `BrowserPort` (render/screenshot) AND a judge `LLMPort` (verify) are
 * both in scope (the CDP browser is minted in `agent-config-assembler`; this
 * module is called from there). The jailed scaffold writer
 * ({@link makeJailedScaffold}) is the slice's own helper.
 *
 *   render     → `BrowserPort.navigate` (lazily spawns ONE session, reused)
 *   screenshot → `BrowserPort.screenshot` (PNG bytes; the loop enforces the cap)
 *   verify     → a CHEAP one-shot LLM-judge: the screenshot (as an image block) +
 *                the spec → a `PASS`/`FAIL` + critique verdict
 *   scaffold   → `makeJailedScaffold(cwd)` (single-file HTML through the FS jail)
 *
 * NO-THROW boundary: the loop catches every effect throw and maps it to a typed
 * outcome. So this adapter is free to THROW on a real failure (a dead browser, a
 * judge stream error) — the loop fail-closes, never crashes. Browser `Result`
 * `Err`s are surfaced as thrown `Error`s (the loop catches them).
 *
 * Session lifetime: the browser handle is owned by a {@link BrowserSession}
 * holder (lazy spawn, reuse, idempotent dispose). The caller (the tier-1 appshot
 * block) registers {@link AppshotPortWire.dispose} into session teardown
 * alongside the browser block's own dispose.
 */

import type { BrowserHandle, BrowserPort } from "@/browser"
import type { ImageBlock, LLMPort, Message, StreamEvent } from "@/llm"
import { assembleFromEvents } from "@/llm"
import { errMessage } from "@/shared"
import { type AppSpec, type AppshotPort, makeJailedScaffold, type VerifyVerdict } from "@/tool"
import { type BrowserSession, createBrowserSession } from "@/tool/browser/session-holder"

/** Wired port plus a session teardown hook. */
export interface AppshotPortWire {
  readonly port: AppshotPort
  /** Close the browser session this port lazily spawned (idempotent). */
  dispose(): Promise<void>
}

/** Dependencies for {@link buildAppshotPortWire}. Tests inject fakes for both
 *  effectful deps (a scripted `BrowserPort` + a scripted judge `LLMPort`) so the
 *  whole loop runs with NO Chrome + NO network. */
export interface AppshotPortWireDeps {
  /** The live browser (render/screenshot). In production this is the SAME CDP
   *  `BrowserPort` `maybeWireBrowser` minted into `cfg.browser`. */
  readonly browser: BrowserPort
  /** The judge model (verify). In production this is the session `cfg.llm`. */
  readonly judge: LLMPort
  /** Jail root for the scaffold writer (the session cwd). */
  readonly cwd: string
}

/** Media type the judge sees for a browser screenshot (CDP `Page.captureScreenshot`
 *  returns PNG). */
const SHOT_MEDIA_TYPE = "image/png"

/** Convert raw bytes to base64 WITHOUT a `data:` prefix (the {@link ImageBlock}
 *  wire shape). Uses Node's Buffer (available under Bun). */
const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

/** Build the judge user message: the screenshot as an image block + a precise,
 *  deterministic instruction. The leading token (`PASS` / `FAIL`) is the verdict;
 *  the remainder is the critique fed back into the next scaffold iteration. */
const judgeMessage = (shot: Uint8Array, spec: AppSpec): Message => {
  const image: ImageBlock = { type: "image", data: toBase64(shot), mediaType: SHOT_MEDIA_TYPE }
  const instruction =
    "You are a strict UI verifier. The image is a screenshot of a rendered web app. " +
    "Decide whether the rendering satisfies this spec:\n\n" +
    `<spec>\n${spec.prompt}\n</spec>\n\n` +
    (spec.feedback.length > 0
      ? `Prior revision notes (already applied attempts):\n${spec.feedback
          .map((f, i) => `${i + 1}. ${f}`)
          .join("\n")}\n\n`
      : "") +
    "Reply with EXACTLY one line: start with `PASS` if it satisfies the spec, else " +
    "`FAIL`, followed by a one-sentence reason. Be terse."
  return { role: "user", content: [image, { type: "text", text: instruction }] }
}

/** Parse the judge's assistant text into a typed verdict. `PASS` (case-insensitive,
 *  leading token) ⇒ pass; anything else ⇒ fail. The remaining text is the critique.
 *  Empty text ⇒ a fail with a fixed note (never a throw). */
const parseVerdict = (text: string): VerifyVerdict => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { pass: false, notes: "judge returned an empty verdict" }
  const isPass = /^pass\b/i.test(trimmed)
  // Strip the leading PASS/FAIL token from the surfaced critique when present.
  const notes = trimmed.replace(/^(pass|fail)\b[\s:.\-—]*/i, "").trim() || trimmed
  return { pass: isPass, notes }
}

/** Run the judge once, assembling the streamed assistant text. Throws on a
 *  stream error (the loop's verify boundary catches it → `verify_failed`). */
const runJudge = async (
  judge: LLMPort,
  shot: Uint8Array,
  spec: AppSpec,
  signal?: AbortSignal,
): Promise<VerifyVerdict> => {
  const events: StreamEvent[] = []
  const input = {
    messages: [judgeMessage(shot, spec)],
    tools: [],
    ...(signal !== undefined ? { signal } : {}),
  }
  for await (const ev of judge.stream(input)) events.push(ev)
  const text = assembleFromEvents(events)
    .message.content.filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
  return parseVerdict(text)
}

/** Map a browser `Result` `Err` to a thrown `Error` carrying the error kind so
 *  the loop's per-arrow catch records a faithful message. */
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }, arrow: string): T => {
  if (r.ok) return r.value
  throw new Error(`appshot ${arrow}: browser ${describeBrowserErr(r.error)}`)
}

const describeBrowserErr = (e: unknown): string => {
  if (e !== null && typeof e === "object" && "kind" in e) {
    return String((e as { kind: unknown }).kind)
  }
  return errMessage(e)
}

/**
 * Assemble the production {@link AppshotPort} over a live browser + a judge LLM +
 * the jailed scaffold writer. The browser handle is spawned lazily on the first
 * `render` and reused across iterations; `dispose` closes it (idempotent).
 */
export const buildAppshotPortWire = (deps: AppshotPortWireDeps): AppshotPortWire => {
  const session: BrowserSession = createBrowserSession(deps.browser)
  const scaffold = makeJailedScaffold(deps.cwd)

  // The handle for the CURRENT session — `render` ensures it, `screenshot` reuses
  // the same one. Held in the closure so screenshot does not re-navigate.
  let handle: BrowserHandle | null = null

  const port: AppshotPort = {
    scaffold,
    async render(url, signal): Promise<void> {
      handle = unwrap(await session.ensure(signal), "render(spawn)")
      unwrap(await deps.browser.navigate(handle, url, signal), "render(navigate)")
    },
    async screenshot(signal): Promise<Uint8Array> {
      // Defensive: if render was somehow skipped (it never is in the loop), spawn.
      if (handle === null) handle = unwrap(await session.ensure(signal), "screenshot(spawn)")
      return unwrap(await deps.browser.screenshot(handle, signal), "screenshot")
    },
    async verify(shot, spec, signal): Promise<VerifyVerdict> {
      return runJudge(deps.judge, shot, spec, signal)
    },
  }

  return {
    port,
    async dispose(): Promise<void> {
      handle = null
      await session.dispose()
    },
  }
}
