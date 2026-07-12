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
import { z } from "zod"

/** The closed set. Order is documentation-ordered (most-used first). */
export const SUBAGENT_6_TOOL_NAMES = [
  "exec_command",
  "write_stdin",
  "spawn_agent",
  "wait_agent",
  "close_agent",
  "send_input",
] as const

export type Subagent6ToolName = (typeof SUBAGENT_6_TOOL_NAMES)[number]

// ─── shared building blocks ────────────────────────────────────────────────

/** Common success/error discriminator. Every tool's output is a discriminated
 *  union on `kind: "success" | "error"` — that lets agent-loop dispatchers
 *  branch on a single field without per-tool special-cases. */
const SuccessDiscriminator = z.literal("success")
const ErrorDiscriminator = z.literal("error")

const ErrorShape = z
  .object({
    kind: ErrorDiscriminator,
    message: z.string().min(1),
    /** Optional structured cause hint. Free-form so tools can plug specifics
     *  (e.g. `"timeout"`, `"signal:SIGTERM"`, `"abort"`) without breaking the
     *  discriminator. */
    cause: z.string().optional(),
  })
  .strict()

// ─── exec_command ──────────────────────────────────────────────────────────

/** One-shot shell command. Synchronous from the LLM's POV: the loop blocks
 *  until exit (or `timeoutMs` elapses → error with cause:"timeout"). */
export const ExecCommandInputSchema = z
  .object({
    /** The command line. Interpreted by the host shell — caller is
     *  responsible for argv quoting; we do NOT auto-shell-escape. Capped at
     *  64KB so a hostile / oversized command cannot DoS the shell-arg buffer
     *  (Linux ARG_MAX ≈ 128KB; we leave headroom for env + argv0). */
    command: z.string().min(1).max(65536),
    /** Working directory. Required for explicitness — defaulting silently
     *  to cwd has bitten Codex sessions in the past. */
    cwd: z.string().min(1),
    /** Wall-clock timeout in ms. Must be a positive finite number. */
    timeoutMs: z.number().int().positive().finite(),
    /** If true, allocate a PTY so subsequent `write_stdin` calls can feed
     *  input. Default false (one-shot). */
    pty: z.boolean().optional(),
    /** Optional env overlay. Merged onto the inherited env. R4 audit-M closure:
     *  per-entry key/value caps + per-record entry cap. POSIX permits an env
     *  KEY up to 256 bytes (most kernels accept far more, but anything past
     *  that is a copy-paste accident); values are capped at 8 KB (matches
     *  send_input/mailbox-body discipline elsewhere in the closed 6-tool set).
     *  64 entries is well above any realistic overlay — a child shell that
     *  needs more than 64 NEW env vars on top of the inherited process env is
     *  almost certainly a hostile DoS attempt (`MALLOC_*`/`LD_*`/synthetic
     *  prefix spray). Without these caps a single `exec_command` could ship a
     *  multi-megabyte env block and trigger `E2BIG` on the kernel side after
     *  the dispatcher has already paid the allocation cost. */
    env: z
      .record(z.string().min(1).max(256), z.string().max(8192))
      .refine((rec) => Object.keys(rec).length <= 64, {
        message: "env may not contain more than 64 entries",
      })
      .optional(),
  })
  .strict()
export type ExecCommandInput = z.infer<typeof ExecCommandInputSchema>

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
])
export type ExecCommandOutput = z.infer<typeof ExecCommandOutputSchema>

// ─── write_stdin ───────────────────────────────────────────────────────────

/** Feed bytes to a long-running PTY started by an earlier `exec_command`
 *  with `pty:true`. */
export const WriteStdinInputSchema = z
  .object({
    pid: z.number().int().positive(),
    /** Bytes to feed to the PTY. Capped at 64KB so a single write_stdin
     *  cannot DoS the PTY ring buffer (the kernel's pipe buf is ~64KB on
     *  Linux + macOS; larger payloads should be chunked across calls). */
    data: z.string().max(65536),
    /** When true, append a `\n` to `data` (saves callers the chore for
     *  line-buffered REPLs). Default false. */
    appendNewline: z.boolean().optional(),
  })
  .strict()
export type WriteStdinInput = z.infer<typeof WriteStdinInputSchema>

export const WriteStdinOutputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: SuccessDiscriminator,
      bytesWritten: z.number().int().nonnegative(),
    })
    .strict(),
  ErrorShape,
])
export type WriteStdinOutput = z.infer<typeof WriteStdinOutputSchema>

// ─── spawn_agent ───────────────────────────────────────────────────────────

/** Create a child subagent. The child runs its own agent loop with its own
 *  registry / memory; the returned `agentId` is what `wait_agent` /
 *  `close_agent` / `send_input` reference. */
export const SpawnAgentInputSchema = z
  .object({
    /** Child agent's seed prompt. Capped at 32KB — a single subagent prompt
     *  larger than that should be staged via memory/skills instead of
     *  inlined into the spawn arg. */
    prompt: z.string().min(1).max(32768),
    /** Optional named profile (e.g. "Explore", "Plan"). Absent ⇒ default. */
    agent_type: z.string().min(1).optional(),
    /** Explicit tool-name allowlist filtering the child's registry. */
    tool_filter: z.array(z.string().min(1)).optional(),
    /** Hard cap on recursion depth — child registers at parent depth + 1 and
     *  the registry refuses spawns that would exceed this. */
    max_depth: z.number().int().nonnegative().optional(),
    // ── parity with the foreground `agent` tool (ADR-0451 + Codex seed
    //    augmentation): every field below is already honored by the runner —
    //    these expose them to the model so a background spawn can request the
    //    SAME per-child controls the foreground tool already could. Field names
    //    are snake_case to match the `agent` tool + spawn_batch (one convention
    //    across every spawn surface so the model never guesses the casing).
    /** `"worktree"` runs the child in an isolated git worktree (own write
     *  scope). REQUIRES the workspace to be a git repo — otherwise falls back to
     *  no isolation (shares the parent cwd). Absent ⇒ shares the parent cwd. */
    isolation: z.enum(["none", "worktree"]).optional(),
    /** Files/paths the child should confine reads/edits to. ADVISORY — injected
     *  into the child's seed as intent guidance, NOT enforced by the tool layer.
     *  Pair with `isolation:"worktree"` for a hard (filesystem) write boundary. */
    owned_surfaces: z.array(z.string().min(1)).max(128).optional(),
    /** Files/paths the child should avoid. ADVISORY (seed guidance, NOT
     *  system-enforced); pairs with `owned_surfaces`. */
    forbidden_surfaces: z.array(z.string().min(1)).max(128).optional(),
    /** Coarse role: `read` / `edit` / `review` — derives a default tool
     *  allowlist when `tool_filter` is absent. */
    task_kind: z.enum(["read", "edit", "review"]).optional(),
    /** One-line spec for the shape of the child's final answer (injected into
     *  the seed so the parent can parse it without bespoke extraction). */
    result_shape: z.string().min(1).max(2000).optional(),
    /** Per-child turn budget. */
    max_turns: z.number().int().positive().optional(),
    /** Per-child token budget (provider-counted). */
    max_tokens: z.number().int().positive().optional(),
    /** Run the child on this specific model id (must be an enabled candidate;
     *  unknown id fails the spawn). Highest precedence over `role`/parent. */
    model: z.string().min(1).optional(),
    /** Dispatch role used to resolve a per-role model when `model` is unset. */
    role: z.string().min(1).optional(),
    /** Effort tier capping the child's thinking budget. */
    effort: z.enum(["default", "low", "medium", "high", "max"]).optional(),
    /** Prior settled task id to WARM-START from — its finalText is prepended to
     *  the child's seed. Ownership-gated: only a task launched by THIS agent's
     *  lineage can be continued (cross-lineage read is denied). */
    continue_from: z.string().min(1).optional(),
    /** When true, the child is told to periodically write interim findings to
     *  `<cwd>/.subagent-state/<task_id>.md` so the parent can monitor/recover.
     *  Ignored together with `isolation:"worktree"` (parent cannot read inside a
     *  throwaway worktree). */
    checkpoint: z.boolean().optional(),
    /** Codex `fork_turns` (C5059-04) — how much of the parent transcript the
     *  child inherits: `"none"` (cold start, default) / `"all"` (full) / N (last
     *  N turns). Composed by the shared `forkPrompt` closure so the child preamble
     *  is BYTE-IDENTICAL to the trio `agent` tool. This schema is kept EXACTLY in
     *  sync with the trio `agent` tool's `fork_turns` (`agent-tool.ts`) —
     *  `min(0)` (not `positive()`) so `0` parses (≡ `"none"`, since
     *  `selectForkTurns` maps ≤0 ⇒ []); a stricter 6-tool schema would break
     *  ALBB-16 trio↔6-tool parity (the model could pass `0` to one and have only
     *  the other reject). `.describe(...)` (mirrored from trio) is REQUIRED so the
     *  field is model-visible in the generated JSON schema, not just a doc-comment.
     *  Absent ⇒ `"none"` (byte-identical legacy spawn path). */
    fork_turns: z
      .union([z.literal("none"), z.literal("all"), z.number().int().min(0)])
      .optional()
      .describe(
        "Inherit the parent's recent conversation: 'none' (cold start, default), " +
          "'all', or N (the last N turns). The inherited transcript is REDACTED and " +
          "framed as data; use it so the child starts with context instead of cold.",
      ),
  })
  .strict()
export type SpawnAgentInput = z.infer<typeof SpawnAgentInputSchema>

export const SpawnAgentOutputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: SuccessDiscriminator,
      agentId: z.string().min(1),
      // S17 (jul-7 audit): surface the unforgeable capability token to the OWNER so it
      // can authorize a later `close_agent`. Without this the model never receives a
      // token ⇒ close_agent could only fall back to host-authority cancel-by-id (the
      // cross-sibling DoS S17 forbids). Optional: a spawn that is never closed omits it.
      ownerToken: z.string().min(1).optional(),
    })
    .strict(),
  ErrorShape,
])
export type SpawnAgentOutput = z.infer<typeof SpawnAgentOutputSchema>

// ─── wait_agent ────────────────────────────────────────────────────────────

/** Block (with optional timeout) until the named child reaches a terminal
 *  state. On timeout, returns `kind:"error"` with `cause:"timeout"` — the
 *  child remains running and may be re-awaited or closed. */
export const WaitAgentInputSchema = z
  .object({
    agentId: z.string().min(1),
    timeoutMs: z.number().int().positive().finite().optional(),
  })
  .strict()
export type WaitAgentInput = z.infer<typeof WaitAgentInputSchema>

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
])
export type WaitAgentOutput = z.infer<typeof WaitAgentOutputSchema>

// ─── close_agent ───────────────────────────────────────────────────────────

/** Terminate a running child. Idempotent: closing an already-settled agent
 *  succeeds with `wasRunning:false`. */
export const CloseAgentInputSchema = z
  .object({
    agentId: z.string().min(1),
    // S17 (jul-7 audit): the owner presents the token it received from spawn_agent to
    // authorize the close. Absent ⇒ DENIED for an LLM caller (only trusted host code,
    // via an out-of-band hostAuthority flag, may close without it).
    owner_token: z.string().min(1).optional(),
  })
  .strict()
export type CloseAgentInput = z.infer<typeof CloseAgentInputSchema>

export const CloseAgentOutputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: SuccessDiscriminator,
      wasRunning: z.boolean(),
    })
    .strict(),
  ErrorShape,
])
export type CloseAgentOutput = z.infer<typeof CloseAgentOutputSchema>

// ─── send_input ────────────────────────────────────────────────────────────

/** Forward a user-supplied message to a paused child (i.e. one that called
 *  the parent back asking for clarification). Different from `write_stdin`:
 *  this is conversational input into the child's loop, not bytes into a PTY. */
export const SendInputInputSchema = z
  .object({
    agentId: z.string().min(1),
    /** Conversational message forwarded to a paused child. Capped at 8KB
     *  to mirror the mailbox body cap (`MAILBOX_BODY_MAX = 8000`) — a
     *  message larger than that is almost always a copy-paste accident. */
    message: z.string().min(1).max(8192),
  })
  .strict()
export type SendInputInput = z.infer<typeof SendInputInputSchema>

export const SendInputOutputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: SuccessDiscriminator,
      delivered: z.literal(true),
    })
    .strict(),
  ErrorShape,
])
export type SendInputOutput = z.infer<typeof SendInputOutputSchema>

// ─── dispatch table ────────────────────────────────────────────────────────

/** Contract record — input + output Zod schemas + a one-line semantic blurb.
 *  Handlers are NOT here (slice isolation; handler wiring is registry's job). */
export interface Subagent6ToolContract {
  readonly name: Subagent6ToolName
  readonly inputSchema: z.ZodTypeAny
  readonly outputSchema: z.ZodTypeAny
  readonly semantics: string
}

export const SUBAGENT_6_TOOL_CONTRACTS: Readonly<Record<Subagent6ToolName, Subagent6ToolContract>> =
  Object.freeze({
    exec_command: {
      name: "exec_command",
      inputSchema: ExecCommandInputSchema,
      outputSchema: ExecCommandOutputSchema,
      semantics:
        "Run a single shell command synchronously (optionally allocating a PTY for follow-up write_stdin).",
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
  })
