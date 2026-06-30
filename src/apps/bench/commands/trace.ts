/**
 * `quanta-bench trace` / `trace-url` — the live OTEL waterfall receiver + UI
 * deep-link. Extracted from cli.ts (ADR-0536 P0). Moved verbatim.
 */
import { errMessage, logger } from "@/shared"
import { traceViewerUrl } from "../otel"
import { runTraceSink } from "../otel-trace-sink"
import { fileSpanSink, resolveSpanSink } from "../span-sink"
import { argValue, positionals } from "./shared"

/** Best-effort open a URL in the OS default browser. Never throws — a headless
 *  box (no opener) just leaves the operator to click the printed URL. */
const openBrowser = (url: string): void => {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url]
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" })
  } catch (e) {
    // no opener on this host — the URL is already printed; operator opens it.
    logger.info(`[trace] could not auto-open a browser (${errMessage(e)}); open ${url} manually`)
  }
}

/** The run id for a trace deep-link: explicit `--run <id>` wins, else the first
 *  positional after the subcommand (`quanta-bench trace <run-id>`). Blank ⇒ none. */
const traceRunId = (): string | undefined => {
  const flag = argValue("--run")
  if (flag !== undefined && flag.trim() !== "") return flag.trim()
  const pos = positionals()[0]
  return pos !== undefined && pos.trim() !== "" ? pos.trim() : undefined
}

/** `quanta-bench trace-url [run-id] [--port N]` — print (+ open) the trace-viewer
 *  deep-link for a run WITHOUT launching a receiver. Use this when the sink is
 *  ALREADY running (the common case: a live campaign streams to one sink and you
 *  want to focus on one run/arm). `quanta-bench trace <run-id>` launches a fresh
 *  sink instead — use that when nothing is listening yet. */
export const cmdTraceUrl = (): void => {
  const portArg = argValue("--port")
  const port = portArg !== undefined ? Number(portArg) : 4318
  const runId = traceRunId()
  if (runId === undefined) {
    logger.info("usage: quanta-bench trace-url <run-id> [--port N] [--no-open]")
    logger.info("  (run-id = the QUANTA_OTEL_RUN_ID the bench/campaign ran under)")
    return
  }
  const url = traceViewerUrl(port, runId)
  logger.info(`[trace] run ${runId} → ${url}`)
  if (!process.argv.includes("--no-open")) openBrowser(url)
}

/** `quanta-bench trace` — launch the live OTEL waterfall receiver + UI (the same
 *  `./otel-trace-sink.ts` the full-remote box ships spans to) and open it in
 *  the browser. Run this, then point any bench at it with
 *  `QUANTA_OTEL_ENDPOINT=http://127.0.0.1:<port>`; spans stream into the
 *  waterfall live (click a span to see the tool input / LLM prompt + response).
 *
 *  Flags: --port N (default 4318) · --save <file.jsonl> (tee spans for offline
 *  replay) · --metrics (also print metric points) · --no-open (don't launch a
 *  browser). The process stays alive serving the UI until Ctrl-C. */
export const cmdTrace = (): void => {
  const portArg = argValue("--port")
  const save = argValue("--save")
  // `--save <file>` is the explicit file override; otherwise resolve the durable
  // sink from env so `QUANTA_OTEL_SINK=s3://bucket/prefix quanta-bench trace`
  // streams to S3 too (not just a local file).
  const spanSink = save !== undefined ? fileSpanSink(save) : resolveSpanSink(process.env)
  const sinkLabel =
    save !== undefined
      ? `file:${save}`
      : (process.env.QUANTA_OTEL_SINK ??
        (process.env.QUANTA_OTEL_SAVE !== undefined && process.env.QUANTA_OTEL_SAVE !== ""
          ? `file:${process.env.QUANTA_OTEL_SAVE}`
          : undefined))
  const { port, uiUrl } = runTraceSink({
    ...(portArg !== undefined ? { port: Number(portArg) } : {}),
    spanSink,
    ...(sinkLabel !== undefined ? { sinkLabel } : {}),
    showMetrics: process.argv.includes("--metrics"),
  })
  // A run id (`quanta-bench trace <id>` / `--run <id>`) deep-links the opened UI
  // to just that run's spans (`?run=<id>`); the operator should then point the
  // bench at it with a matching QUANTA_OTEL_RUN_ID so the spans carry that id.
  const runId = traceRunId()
  const openUrl = traceViewerUrl(port, runId)
  logger.info(`[trace] live waterfall UI → ${runId !== undefined ? openUrl : uiUrl}`)
  logger.info(
    `[trace] point a bench at it: QUANTA_OTEL_ENDPOINT=http://127.0.0.1:${port}${
      runId !== undefined ? ` QUANTA_OTEL_RUN_ID=${runId}` : ""
    }`,
  )
  if (!process.argv.includes("--no-open")) {
    openBrowser(openUrl)
    logger.info("[trace] opened in browser — Ctrl-C to stop")
  }
}
