/**
 * `tools/dev/pty-slash-submit` — type a line into a PTY-driven CLI, and when it
 * is a SLASH COMMAND, confirm the leading `/` actually registered.
 *
 * # Why this exists
 * Two PTY suites each carried a copy of a helper whose only defence against a
 * dropped leading `/` was `sleep(500)`. The `/` races raw-input arming; when it
 * loses, the rest of the line submits as an ordinary model prompt. That is
 * invisible at the call site and expensive downstream: the replay cassette
 * hashes every request to a constant, so it is a strict one-record budget, and
 * the unintended turn exhausts it — the run then dies ~60s later as a
 * `ReplayMissError`, nowhere near the keystroke that caused it.
 *
 * A sleep cannot be right. Too short under contention, pure latency otherwise,
 * and it never reports the thing it failed to prevent. Registration is
 * OBSERVABLE instead: the between-turns prompt paints `› ` (U+203A,
 * `prompt-pipeline.ts`) and a typed slash shows up in that lane, so the helper
 * polls for it, retypes a bounded number of times, and if the slash never
 * appears it throws AT the drop rather than letting an un-prefixed line submit.
 *
 * Injected `sleep` so a unit test drives the whole contract with no terminal.
 */

/** The slice of a PTY handle this helper needs. */
export interface PtyLineSink {
  send(data: string): void
  screen(): string
}

export interface SubmitPtyLineOpts {
  /** Injected delay (tests pass a no-op). */
  readonly sleep?: (ms: number) => Promise<void>
  /** Per-keystroke settle delay for the non-leading characters. */
  readonly keyDelayMs?: number
  /** How many times to retype an unregistered leading slash. */
  readonly slashAttempts?: number
  /** Polls per attempt while watching for the slash to appear. */
  readonly slashPolls?: number
  readonly slashPollMs?: number
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Has a leading slash appeared in the input lane? The prompt glyph anchors it,
 *  so an unrelated `/` elsewhere on screen cannot be mistaken for the keystroke. */
const slashRegistered = (sink: PtyLineSink): boolean => /›\s*\//.test(sink.screen())

const confirmLeadingSlash = async (
  sink: PtyLineSink,
  sleep: (ms: number) => Promise<void>,
  opts: SubmitPtyLineOpts,
): Promise<void> => {
  const attempts = opts.slashAttempts ?? 5
  const polls = opts.slashPolls ?? 10
  const pollMs = opts.slashPollMs ?? 50
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    sink.send("/")
    for (let poll = 0; poll < polls; poll += 1) {
      await sleep(pollMs)
      if (slashRegistered(sink)) return
    }
  }
  throw new Error(
    `submitPtyLine: the leading "/" never registered after ${attempts} attempts — ` +
      "raw input is not armed, and submitting now would send the line as an ordinary " +
      `model prompt. Last screen: ${JSON.stringify(sink.screen().slice(-200))}`,
  )
}

/**
 * Type `line` and submit it. A leading `/` is confirmed before the rest is typed;
 * every other line is typed verbatim with no probing (byte-identical to the
 * previous helper for non-slash input).
 */
export const typePtyLine = async (
  sink: PtyLineSink,
  line: string,
  opts: SubmitPtyLineOpts = {},
): Promise<void> => {
  const sleep = opts.sleep ?? defaultSleep
  const keyDelayMs = opts.keyDelayMs ?? 15
  const rest = line.startsWith("/") ? line.slice(1) : line
  if (line.startsWith("/")) await confirmLeadingSlash(sink, sleep, opts)
  for (const character of rest) {
    sink.send(character)
    await sleep(keyDelayMs)
  }
}

/** {@link typePtyLine} then Enter. Split because one suite deliberately types a
 *  draft it never submits, and that case must not grow a submit. */
export const submitPtyLine = async (
  sink: PtyLineSink,
  line: string,
  opts: SubmitPtyLineOpts = {},
): Promise<void> => {
  await typePtyLine(sink, line, opts)
  sink.send("\r")
}
