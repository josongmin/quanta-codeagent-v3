/**
 * `quanta-codeagent/sdk` — the ONE public door for embedding quanta's agent
 * loop in-process (jul-4 SDK embed DX plan).
 *
 * Consumers import ONLY from here. Nothing under `src/sdk/**` may import
 * `@/apps/cli`, `@/apps/bench`, or `@/apps/agent` (enforced by
 * `tests/unit/sdk/boundary.slice.test.ts`), and the export set below is the
 * pinned public surface (audit C: no 133-field `AgentConfig` leak).
 */

// ── Tool authoring (Phase 5 re-export) ──
export { defineTool } from "@/tool"
export { defineToolAsync } from "@/tool/async-helper"
// ── Façade ──
export { type AnalysisAgent, type AnalysisAgentOptions, createAnalysisAgent } from "./embed"
// ── Errors ──
export { NoCredentialError, ToolRegistrationError } from "./errors"
// ── Event narrowing ──
export { isDone, isError, isText, isThinking, isToolCall, isToolResult, isUsage } from "./events"
export { type AnalysisProfile, DEFAULT_PROFILE } from "./profiles"
export { type AgentRun, DEFAULT_EVENT_BUFFER, type RunHooks } from "./run"
// ── Test harness (Phase 6) ──
export { type FakeCompletion, fakeLlm, RecordingStream } from "./testing"
// ── Curated types ──
export type {
  AgentEvent,
  AgentOutcome,
  LLMPort,
  Message,
  StopReason,
  Tool,
  ToolContext,
  ToolEvent,
} from "./types"

// ── Version ──
export { version } from "./version"
