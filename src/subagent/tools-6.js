/**
 * Subagent 6-tool standard (Cluster E / F15, ADR-0041).
 *
 * Codex absorbed: the empirical tool distribution over thousands of subagent
 * sessions is dominated by two tools:
 *   - `exec_command`  ~75%  (one-shot synchronous shell command)
 *   - `write_stdin`   ~24%  (write to a long-running PTY started by exec_command)
 * The remaining four are essential plumbing for spawning, awaiting, killing
 * and resuming child subagents:
 *   - `spawn_agent` / `wait_agent` / `close_agent` / `send_input`
 *
 * THIS MODULE IS CONTRACTS ONLY. Handlers live in `./registry.ts` /
 * `./agent-tool.ts` (in-flight on main); the contract surface here keeps
 * the standard stable while implementations evolve. Adding/removing a
 * tool requires an ADR amendment.
 *
 * Slice contract: this file only imports `zod`. It MUST NOT touch the
 * filesystem, the agent loop, or any other slice.
 */
import { z } from "zod";
/** The closed set. Order is documentation-ordered (most-used first). */
export const SUBAGENT_6_TOOL_NAMES = [
    "exec_command",
    "write_stdin",
    "spawn_agent",
    "wait_agent",
    "close_agent",
    "send_input",
];
// ─── shared building blocks ────────────────────────────────────────────────
/** Common success/error discriminator. Every tool's output is a discriminated
 *  union on `kind: "success" | "error"` — that lets agent-loop dispatchers
 *  branch on a single field without per-tool special-cases. */
const SuccessDiscriminator = z.literal("success");
const ErrorDiscriminator = z.literal("error");
const ErrorShape = z
    .object({
    kind: ErrorDiscriminator,
    message: z.string().min(1),
    /** Optional structured cause hint. Free-form so tools can plug specifics
     *  (e.g. `"timeout"`, `"signal:SIGTERM"`, `"abort"`) without breaking the
     *  discriminator. */
    cause: z.string().optional(),
})
    .strict();
// ─── exec_command ──────────────────────────────────────────────────────────
/** One-shot shell command. Synchronous from the LLM's POV: the loop blocks
 *  until exit (or `timeoutMs` elapses → error with cause:"timeout"). */
export const ExecCommandInputSchema = z
    .object({
    /** The command line. Interpreted by the host shell — caller is
     *  responsible for argv quoting; we do NOT auto-shell-escape. */
    command: z.string().min(1),
    /** Working directory. Required for explicitness — defaulting silently
     *  to cwd has bitten Codex sessions in the past. */
    cwd: z.string().min(1),
    /** Wall-clock timeout in ms. Must be a positive finite number. */
    timeoutMs: z.number().int().positive().finite(),
    /** If true, allocate a PTY so subsequent `write_stdin` calls can feed
     *  input. Default false (one-shot). */
    pty: z.boolean().optional(),
    /** Optional env overlay. Merged onto the inherited env. */
    env: z.record(z.string(), z.string()).optional(),
})
    .strict();
export const ExecCommandOutputSchema = z.discriminatedUnion("kind", [
    z
        .object({
        kind: SuccessDiscriminator,
        exitCode: z.number().int(),
        stdout: z.string(),
        stderr: z.string(),
        /** When the command was launched with `pty:true` and is still running
         *  (e.g. an interactive REPL), this PID lets `write_stdin` /
         *  `close_agent` reference it. Absent for finished one-shots. */
        pid: z.number().int().positive().optional(),
    })
        .strict(),
    ErrorShape,
]);
// ─── write_stdin ───────────────────────────────────────────────────────────
/** Feed bytes to a long-running PTY started by an earlier `exec_command`
 *  with `pty:true`. */
export const WriteStdinInputSchema = z
    .object({
    pid: z.number().int().positive(),
    data: z.string(),
    /** When true, append a `\n` to `data` (saves callers the chore for
     *  line-buffered REPLs). Default false. */
    appendNewline: z.boolean().optional(),
})
    .strict();
export const WriteStdinOutputSchema = z.discriminatedUnion("kind", [
    z
        .object({
        kind: SuccessDiscriminator,
        bytesWritten: z.number().int().nonnegative(),
    })
        .strict(),
    ErrorShape,
]);
// ─── spawn_agent ───────────────────────────────────────────────────────────
/** Create a child subagent. The child runs its own agent loop with its own
 *  registry / memory; the returned `agentId` is what `wait_agent` /
 *  `close_agent` / `send_input` reference. */
export const SpawnAgentInputSchema = z
    .object({
    prompt: z.string().min(1),
    /** Optional named profile (e.g. "Explore", "Plan"). Absent ⇒ default. */
    agentType: z.string().min(1).optional(),
    /** Explicit tool-name allowlist filtering the child's registry. */
    toolFilter: z.array(z.string().min(1)).optional(),
    /** Hard cap on recursion depth — child registers at parent depth + 1 and
     *  the registry refuses spawns that would exceed this. */
    maxDepth: z.number().int().nonnegative().optional(),
})
    .strict();
export const SpawnAgentOutputSchema = z.discriminatedUnion("kind", [
    z
        .object({
        kind: SuccessDiscriminator,
        agentId: z.string().min(1),
    })
        .strict(),
    ErrorShape,
]);
// ─── wait_agent ────────────────────────────────────────────────────────────
/** Block (with optional timeout) until the named child reaches a terminal
 *  state. On timeout, returns `kind:"error"` with `cause:"timeout"` — the
 *  child remains running and may be re-awaited or closed. */
export const WaitAgentInputSchema = z
    .object({
    agentId: z.string().min(1),
    timeoutMs: z.number().int().positive().finite().optional(),
})
    .strict();
export const WaitAgentOutputSchema = z.discriminatedUnion("kind", [
    z
        .object({
        kind: SuccessDiscriminator,
        status: z.enum(["completed", "failed", "stopped"]),
        finalText: z.string(),
        turns: z.number().int().nonnegative(),
    })
        .strict(),
    ErrorShape,
]);
// ─── close_agent ───────────────────────────────────────────────────────────
/** Terminate a running child. Idempotent: closing an already-settled agent
 *  succeeds with `wasRunning:false`. */
export const CloseAgentInputSchema = z
    .object({
    agentId: z.string().min(1),
})
    .strict();
export const CloseAgentOutputSchema = z.discriminatedUnion("kind", [
    z
        .object({
        kind: SuccessDiscriminator,
        wasRunning: z.boolean(),
    })
        .strict(),
    ErrorShape,
]);
// ─── send_input ────────────────────────────────────────────────────────────
/** Forward a user-supplied message to a paused child (i.e. one that called
 *  the parent back asking for clarification). Different from `write_stdin`:
 *  this is conversational input into the child's loop, not bytes into a PTY. */
export const SendInputInputSchema = z
    .object({
    agentId: z.string().min(1),
    message: z.string().min(1),
})
    .strict();
export const SendInputOutputSchema = z.discriminatedUnion("kind", [
    z
        .object({
        kind: SuccessDiscriminator,
        delivered: z.literal(true),
    })
        .strict(),
    ErrorShape,
]);
export const SUBAGENT_6_TOOL_CONTRACTS = Object.freeze({
    exec_command: {
        name: "exec_command",
        inputSchema: ExecCommandInputSchema,
        outputSchema: ExecCommandOutputSchema,
        semantics: "Run a single shell command synchronously (optionally allocating a PTY for follow-up write_stdin).",
    },
    write_stdin: {
        name: "write_stdin",
        inputSchema: WriteStdinInputSchema,
        outputSchema: WriteStdinOutputSchema,
        semantics: "Write bytes to the stdin of a long-running PTY started by exec_command.",
    },
    spawn_agent: {
        name: "spawn_agent",
        inputSchema: SpawnAgentInputSchema,
        outputSchema: SpawnAgentOutputSchema,
        semantics: "Create a child subagent with its own loop and return its agentId.",
    },
    wait_agent: {
        name: "wait_agent",
        inputSchema: WaitAgentInputSchema,
        outputSchema: WaitAgentOutputSchema,
        semantics: "Block (optionally with timeout) for a child subagent to reach a terminal state.",
    },
    close_agent: {
        name: "close_agent",
        inputSchema: CloseAgentInputSchema,
        outputSchema: CloseAgentOutputSchema,
        semantics: "Terminate a running child subagent (idempotent on already-settled agents).",
    },
    send_input: {
        name: "send_input",
        inputSchema: SendInputInputSchema,
        outputSchema: SendInputOutputSchema,
        semantics: "Forward a user-supplied conversational message to a paused child subagent.",
    },
});
