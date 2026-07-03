/**
 * `container_write_file` — reliable file authoring on the terminal surface (B2, RFC jul-3).
 *
 * WHY. The terminal surface's only pre-B2 write path was a heredoc typed through `container_exec`
 * (`cat > f <<'EOF' …`) — which mangles exactly the content that matters on file-is-the-deliverable
 * tasks (polyglot / code-from-image): EOF-marker collisions, quote nesting, trailing-newline drift,
 * shell interpolation of `$`/backtick in "unquoted-EOF" heredocs. Competitor surfaces ship a
 * dedicated write/apply-patch tool for this reason.
 *
 * MECHANISM (no new transport): content travels through the SAME injected {@link ContainerExec}
 * port, base64-encoded host-side — the payload on the wire is inert bytes (`[A-Za-z0-9+/=]` only,
 * no shell metacharacters), decoded in-container by `base64 -d`. The one exec round-trip then
 * echoes `wc -c < path` so the tool FRESH-READS the written byte count and verifies it equals the
 * intended content's byte length (overwrite mode) — a write that silently truncated or landed on a
 * full disk is a typed failure, never a claimed success.
 *
 * SECURITY. The constructed shell command is exposed via `extractShellCommand`, so the host's
 * HARD_DENY categorical screen sees EXACTLY what will run (same posture as `container_exec` — a
 * shell-equivalent tool that hides its command evades the gate). The path is validated fail-closed
 * (single-quotable: no `'`, no newline/CR/NUL) instead of escape-quoting games; content needs no
 * validation because it never touches the shell as syntax (base64). Container-bound by
 * construction: the port is the same docker-exec / orchestrator-env transport — NO host path.
 *
 * BOUNDED: content is capped at {@link MAX_WRITE_BYTES} per call (the JSON-line duplex carries the
 * whole command as one line; unbounded lines would balloon the brain↔hands frame). Larger files
 * chunk explicitly via `append: true` — the typed over-cap failure says so.
 */
import { z } from "zod"
import { errMessage } from "@/shared"
import type { Tool, ToolEvent, ToolResult } from "../types"
import type { ContainerExec } from "./port"

/** Per-call raw-content cap (bytes, pre-base64). 512 KiB raw ≈ 683 KiB b64 — comfortably inside a
 *  JSON line / `ARG_MAX`, large enough that real deliverables land in 1-2 calls. Over-cap is a
 *  TYPED failure steering to `append` chunking, never a silent truncation. */
export const MAX_WRITE_BYTES = 512 * 1024

/** Fail-closed path guard: must be single-quotable verbatim (no `'`, no newline/CR/NUL). We
 *  REJECT rather than escape — quoting games are where write tools historically leak. */
const PATH_OK = /^[^'\n\r\0]+$/

/** Build the exact in-container command (PURE — shared by `execute` and `extractShellCommand` so
 *  the HARD_DENY screen sees precisely what runs). Overwrite mode appends a `wc -c` readback for
 *  the byte-count integrity check; append mode skips it (the total is not knowable host-side). */
export const buildWriteCommand = (path: string, b64: string, append: boolean): string => {
  const redirect = append ? ">>" : ">"
  const readback = append ? "" : ` && wc -c < '${path}'`
  return `mkdir -p "$(dirname '${path}')" && printf '%s' '${b64}' | base64 -d ${redirect} '${path}'${readback}`
}

const schema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Container path to write (parent directories are created automatically)."),
  content: z.string().describe("Exact file content (UTF-8). Written verbatim — no shell mangling."),
  append: z
    .boolean()
    .optional()
    .describe("Append to the file instead of overwriting (use to chunk files over the size cap)."),
})
export type ContainerWriteFileInput = z.infer<typeof schema>

const one = (result: ToolResult): AsyncIterable<ToolEvent> => ({
  async *[Symbol.asyncIterator]() {
    yield { type: "result", result }
  },
})

/** Best-effort input mirror for the categorical command screen: on unparseable input there is no
 *  command to screen (execute will reject it as invalid before any exec). */
const commandForScreen = (input: unknown): string => {
  const parsed = schema.safeParse(input)
  if (!parsed.success) return ""
  if (!PATH_OK.test(parsed.data.path)) return ""
  const b64 = Buffer.from(parsed.data.content, "utf8").toString("base64")
  return buildWriteCommand(parsed.data.path, b64, parsed.data.append === true)
}

/** The `container_write_file` tool bound to a {@link ContainerExec} transport. */
export const containerWriteFileTool = (port: ContainerExec): Tool<ContainerWriteFileInput> => ({
  name: "container_write_file",
  description:
    "Write a file INSIDE the task container with exact bytes (no heredoc/quoting mangling). " +
    "Creates parent directories, overwrites by default, verifies the written byte count. " +
    "Use `append: true` to add to an existing file (chunking for large content).",
  inputSchema: schema,
  isReadOnly: () => false, // mutates container state
  isConcurrencySafe: () => false,
  // Expose the EXACT constructed command to the host HARD_DENY denylist — same posture as
  // `container_exec` (a shell-equivalent tool that hides its command evades the categorical gate).
  extractShellCommand: commandForScreen,
  execute(input, ctx) {
    const parsed = schema.safeParse(input)
    if (!parsed.success) return one({ ok: false, output: `invalid input: ${parsed.error.message}` })
    const { path, content } = parsed.data
    const append = parsed.data.append === true
    if (!PATH_OK.test(path)) {
      return one({
        ok: false,
        output:
          "invalid path: must not contain single quotes, newlines, or NUL (fail-closed — rename the target)",
        failure: { mode: "rejected", reason: "path fails the single-quotable guard" },
      })
    }
    const contentBytes = Buffer.byteLength(content, "utf8")
    if (contentBytes > MAX_WRITE_BYTES) {
      return one({
        ok: false,
        output:
          `content is ${contentBytes} bytes — over the ${MAX_WRITE_BYTES}-byte per-call cap. ` +
          "Write the first chunk, then continue with `append: true` calls.",
        failure: { mode: "rejected", reason: "content over per-call byte cap" },
      })
    }
    if (ctx.signal.aborted) return one({ ok: false, output: "aborted before start" })
    const b64 = Buffer.from(content, "utf8").toString("base64")
    const command = buildWriteCommand(path, b64, append)
    return {
      async *[Symbol.asyncIterator]() {
        let result: ToolResult
        try {
          const r = await port.exec(command, ctx.signal)
          if (r.timedOut === true) {
            result = {
              ok: false,
              output: `write timed out before completing (deadline kill) — the file state is UNKNOWN; re-check before relying on it`,
              failure: { mode: "timeout" },
              evidence: { exitCode: r.code, executedCommand: command, timedOut: true },
            }
          } else if (r.code !== 0) {
            const stderr = (r.stderr ?? "").trim()
            result = {
              ok: false,
              output: `write failed (exit ${r.code})${stderr ? `\nstderr:\n${stderr.slice(0, 2000)}` : ""}`,
              failure: { mode: "error", modelVisibleError: `write failed with exit ${r.code}` },
              evidence: {
                exitCode: r.code,
                executedCommand: command,
                ...(stderr ? { stderr } : {}),
              },
            }
          } else if (!append) {
            // Fresh-readback integrity: the in-container `wc -c` total must equal the intended
            // byte length — catches silent truncation (full disk / quota / decode failure).
            const written = Number.parseInt((r.stdout ?? "").trim(), 10)
            if (!Number.isFinite(written) || written !== contentBytes) {
              result = {
                ok: false,
                output: `write INCOMPLETE: expected ${contentBytes} bytes, container reports ${Number.isFinite(written) ? written : "unreadable"} — do not trust the file; re-write it`,
                failure: { mode: "error", modelVisibleError: "written byte count mismatch" },
                evidence: { exitCode: r.code, executedCommand: command },
              }
            } else {
              result = {
                ok: true,
                output: `wrote ${contentBytes} bytes to ${path} (byte count verified in-container)`,
                evidence: { exitCode: r.code, executedCommand: command },
              }
            }
          } else {
            result = {
              ok: true,
              output: `appended ${contentBytes} bytes to ${path}`,
              evidence: { exitCode: r.code, executedCommand: command },
            }
          }
        } catch (e) {
          const msg = errMessage(e)
          result = {
            ok: false,
            output: `container_write_file backend error: ${msg}`,
            failure: { mode: "error", modelVisibleError: msg },
          }
        }
        yield { type: "result", result }
      },
    }
  },
})
