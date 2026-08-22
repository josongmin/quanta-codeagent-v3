/**
 * trajectory-timeline — Phase 3 analysis tool.
 *
 * Reads bench-trajectory.jsonl (or a time-sliced arm file) and renders a
 * per-instance turn-by-turn timeline as Markdown.
 *
 * Usage:
 *   bun tools/trajectory-timeline.ts [options]
 *
 * Options:
 *   --file <path>      trajectory JSONL to read (default: ./bench-trajectory.jsonl)
 *   --from <ms>        filter records with metadata.recordedAt >= ms
 *   --to   <ms>        filter records with metadata.recordedAt < ms
 *   --instance <id>    only render this instance (substring match on instanceId)
 *   --out  <dir>       write one <instanceId>.md per instance + INDEX.md
 *                      (default: stdout)
 *   --format compact|full
 *                      compact = tool names only; full = args truncated 300 chars
 *                      (default: full)
 *   --help             print usage and exit 0
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

if (hasFlag("--help") || hasFlag("-h")) {
  process.stdout.write(`trajectory-timeline — render bench trajectory as per-instance Markdown

Usage:
  bun tools/trajectory-timeline.ts [options]

Options:
  --file <path>      JSONL file to read (default: ./bench-trajectory.jsonl)
  --from <ms>        filter records with metadata.recordedAt >= ms
  --to   <ms>        filter records with metadata.recordedAt < ms
  --instance <id>    only render instances whose id contains this substring
  --out  <dir>       write one <instanceId>.md per instance + INDEX.md
  --format compact|full
                     compact = tool names only; full = tool args (default: full)
  --help             show this help
`)
  process.exit(0)
}

const filePath = argValue("--file") ?? "./bench-trajectory.jsonl"
const fromMs = argValue("--from") !== undefined ? Number(argValue("--from")) : undefined
const toMs = argValue("--to") !== undefined ? Number(argValue("--to")) : undefined
const instanceFilter = argValue("--instance")
const outDir = argValue("--out")
const formatArg = argValue("--format") ?? "full"
const format: "compact" | "full" = formatArg === "compact" ? "compact" : "full"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrajectoryEvent {
  type: string
  /** text_delta / thinking_delta content */
  text?: string
  /** text_delta stream chunk */
  delta?: string
  /** tool_use_start / tool_use_delta / tool_use_end id */
  id?: string
  /** tool_use_start name */
  name?: string
  /** tool_use_end parsed input */
  input?: unknown
  /** usage token counts */
  inputTokens?: number
  outputTokens?: number
  model?: string
}

interface TrajectoryMetadata {
  recordedAt?: number
  model?: string
  durationMs?: number
  instanceId?: string
  partial?: boolean
  error?: unknown
}

interface TrajectoryRecord {
  id?: string
  request?: {
    messages?: Array<{ role: string; content: unknown }>
    system?: unknown
  }
  events?: TrajectoryEvent[]
  metadata?: TrajectoryMetadata
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: string; text: string } => typeof c === "object" && c !== null)
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join(" ")
  }
  return ""
}

// ---------------------------------------------------------------------------
// JSONL loading
// ---------------------------------------------------------------------------

if (!existsSync(filePath)) {
  process.stderr.write(`Error: trajectory file not found: ${filePath}\n`)
  process.exit(1)
}

const lines = readFileSync(filePath, "utf8").split("\n")
const rawRecords: TrajectoryRecord[] = []
let malformedCount = 0

for (const line of lines) {
  const trimmed = line.trim()
  if (!trimmed) continue
  try {
    rawRecords.push(JSON.parse(trimmed) as TrajectoryRecord)
  } catch {
    malformedCount++
    process.stderr.write(`warn: skipped malformed line: ${trunc(trimmed, 80)}\n`)
  }
}

if (malformedCount > 0) {
  process.stderr.write(`warn: ${malformedCount} malformed lines skipped\n`)
}

// ---------------------------------------------------------------------------
// Filter by time window
// ---------------------------------------------------------------------------

const filteredRecords = rawRecords.filter((r) => {
  const ts = r.metadata?.recordedAt
  if (fromMs !== undefined && (ts === undefined || ts < fromMs)) return false
  if (toMs !== undefined && (ts === undefined || ts >= toMs)) return false
  return true
})

// ---------------------------------------------------------------------------
// Instance segmentation
// ---------------------------------------------------------------------------

// Labeled mode: metadata.instanceId present → group by it directly.
// Unlabeled mode: detect boundaries by messages.length === 1 (localize turn =
//   fresh conversation start). The pattern is:
//     msgs=1 → localize (first turn of a new instance)
//     msgs=2,4,6,... → repair turns (same instance)
//     msgs=1 again → next instance starts

type InstanceGroup = {
  instanceId: string
  records: TrajectoryRecord[]
}

function segmentLabeled(records: TrajectoryRecord[]): InstanceGroup[] {
  const byId = new Map<string, TrajectoryRecord[]>()
  const order: string[] = []
  for (const r of records) {
    const id = r.metadata?.instanceId ?? "unlabeled"
    if (!byId.has(id)) {
      byId.set(id, [])
      order.push(id)
    }
    byId.get(id)?.push(r)
  }
  return order.map((id) => ({ instanceId: id, records: byId.get(id) ?? [] }))
}

function segmentUnlabeled(records: TrajectoryRecord[]): InstanceGroup[] {
  const groups: InstanceGroup[] = []
  let current: TrajectoryRecord[] = []
  let instanceCounter = 0

  const flush = () => {
    if (current.length === 0) return
    instanceCounter++
    groups.push({ instanceId: `instance-${instanceCounter}`, records: current })
    current = []
  }

  for (const r of records) {
    const msgLen = r.request?.messages?.length ?? 0
    if (msgLen === 1 && current.length > 0) {
      flush()
    }
    current.push(r)
  }
  flush()
  return groups
}

function segmentInstances(records: TrajectoryRecord[]): InstanceGroup[] {
  if (records.some((r) => r.metadata?.instanceId)) {
    return segmentLabeled(records)
  }
  return segmentUnlabeled(records)
}

const allGroups = segmentInstances(filteredRecords)

// ---------------------------------------------------------------------------
// Extract instance ID from content heuristic (for unlabeled records)
// ---------------------------------------------------------------------------

const INSTANCE_ID_RE = /\b([a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+-\d+)\b/

function guessInstanceId(group: InstanceGroup): string {
  if (!group.instanceId.startsWith("instance-")) return group.instanceId

  for (const r of group.records) {
    const sysText = extractText(r.request?.system)
    const m = INSTANCE_ID_RE.exec(sysText)
    if (m?.[1]) return m[1]

    for (const msg of (r.request?.messages ?? []).slice(0, 3)) {
      const text = extractText(msg.content)
      const m2 = INSTANCE_ID_RE.exec(text)
      if (m2?.[1]) return m2[1]
    }
  }
  return group.instanceId
}

// Resolve final IDs (deduplicate if multiple groups map to same guessed id)
const idCount = new Map<string, number>()
const resolvedGroups = allGroups.map((g) => {
  const guessed = guessInstanceId(g)
  const count = (idCount.get(guessed) ?? 0) + 1
  idCount.set(guessed, count)
  return { ...g, instanceId: count > 1 ? `${guessed}-${count}` : guessed }
})

// Apply --instance filter
const groupsToRender = instanceFilter
  ? resolvedGroups.filter((g) => g.instanceId.includes(instanceFilter))
  : resolvedGroups

if (groupsToRender.length === 0) {
  process.stderr.write(
    `warn: no instances matched${instanceFilter ? ` filter "${instanceFilter}"` : ""}\n`,
  )
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Per-turn parsing
// ---------------------------------------------------------------------------

interface TurnInfo {
  turnN: number
  msgsLen: number
  deltaMsFromPrev: number | null
  reasoning: string
  toolCalls: Array<{ name: string; argsJson: string }>
  text: string
  promptTokens: number | null
  completionTokens: number | null
  model: string | null
}

type ToolAcc = { name: string; deltaBuf: string; finalInput: unknown }

function collectReasoning(events: TrajectoryEvent[]): string {
  return events
    .filter((e) => e.type === "thinking_delta" && typeof e.text === "string")
    .map((e) => e.text ?? "")
    .join("")
}

function applyToolEvent(
  e: TrajectoryEvent,
  toolMap: Map<string, ToolAcc>,
  toolOrder: string[],
): void {
  if (e.type === "tool_use_start" && e.id) {
    toolMap.set(e.id, { name: e.name ?? "(unknown)", deltaBuf: "", finalInput: undefined })
    toolOrder.push(e.id)
  } else if (e.type === "tool_use_delta" && e.id && typeof e.delta === "string") {
    const acc = toolMap.get(e.id)
    if (acc) acc.deltaBuf += e.delta
  } else if (e.type === "tool_use_end" && e.id) {
    const acc = toolMap.get(e.id)
    if (acc) acc.finalInput = e.input
  }
}

function accumulateToolMap(events: TrajectoryEvent[]): {
  toolMap: Map<string, ToolAcc>
  toolOrder: string[]
} {
  const toolMap = new Map<string, ToolAcc>()
  const toolOrder: string[] = []
  for (const e of events) applyToolEvent(e, toolMap, toolOrder)
  return { toolMap, toolOrder }
}

function resolveToolArgs(acc: ToolAcc): string {
  if (acc.finalInput !== undefined && acc.finalInput !== null) {
    try {
      return JSON.stringify(acc.finalInput)
    } catch {
      return acc.deltaBuf
    }
  }
  return acc.deltaBuf
}

function collectToolCalls(events: TrajectoryEvent[]): Array<{ name: string; argsJson: string }> {
  const { toolMap, toolOrder } = accumulateToolMap(events)
  return toolOrder.map((id) => {
    const acc = toolMap.get(id)
    if (!acc) return { name: "(unknown)", argsJson: "" }
    return { name: acc.name, argsJson: resolveToolArgs(acc) }
  })
}

function collectText(events: TrajectoryEvent[]): string {
  return events
    .filter((e) => e.type === "text_delta")
    .map((e) => (typeof e.delta === "string" ? e.delta : typeof e.text === "string" ? e.text : ""))
    .join("")
}

function collectUsage(
  events: TrajectoryEvent[],
  fallbackModel: string | null,
): { promptTokens: number | null; completionTokens: number | null; model: string | null } {
  let promptTokens: number | null = null
  let completionTokens: number | null = null
  let model: string | null = fallbackModel

  for (const e of events) {
    if (e.type === "usage") {
      promptTokens = e.inputTokens ?? null
      completionTokens = e.outputTokens ?? null
      if (e.model) model = e.model
    }
  }
  return { promptTokens, completionTokens, model }
}

function parseTurn(r: TrajectoryRecord, prevTs: number | null, turnN: number): TurnInfo {
  const events = r.events ?? []
  const msgsLen = r.request?.messages?.length ?? 0
  const ts = r.metadata?.recordedAt ?? null
  const deltaMsFromPrev = prevTs !== null && ts !== null ? ts - prevTs : null

  const reasoning = collectReasoning(events)
  const toolCalls = collectToolCalls(events)
  const text = collectText(events)
  const { promptTokens, completionTokens, model } = collectUsage(events, r.metadata?.model ?? null)

  return {
    turnN,
    msgsLen,
    deltaMsFromPrev,
    reasoning,
    toolCalls,
    text,
    promptTokens,
    completionTokens,
    model,
  }
}

// ---------------------------------------------------------------------------
// Per-turn rendering
// ---------------------------------------------------------------------------

function renderTurnHeader(t: TurnInfo): string {
  const label =
    t.msgsLen === 1 ? "localize" : t.deltaMsFromPrev !== null ? `+${t.deltaMsFromPrev}ms` : ""
  return `### Turn ${t.turnN} (msgs=${t.msgsLen}${label ? `, ${label}` : ""})`
}

function renderTurnBody(t: TurnInfo): string[] {
  const parts: string[] = []

  if (t.reasoning) parts.push(`**Reasoning:** ${trunc(t.reasoning, 500)}`)

  for (const tc of t.toolCalls) {
    parts.push(
      format === "compact"
        ? `**Tool:** \`${tc.name}(…)\``
        : `**Tool:** \`${tc.name}(${trunc(tc.argsJson, 300)})\``,
    )
  }

  if (t.text) {
    parts.push(`**Text:** ${trunc(t.text, 200)}`)
  } else if (t.toolCalls.length === 0 && !t.reasoning) {
    parts.push("**Text:** (none)")
  }

  if (t.promptTokens !== null || t.completionTokens !== null) {
    const usageParts: string[] = []
    if (t.promptTokens !== null) usageParts.push(`prompt=${t.promptTokens}`)
    if (t.completionTokens !== null) usageParts.push(`completion=${t.completionTokens}`)
    parts.push(`Usage: ${usageParts.join(" ")}`)
  }

  return parts
}

function renderTurn(t: TurnInfo): string {
  return [renderTurnHeader(t), ...renderTurnBody(t)].join("\n")
}

// ---------------------------------------------------------------------------
// Instance rendering
// ---------------------------------------------------------------------------

interface InstanceSummary {
  instanceId: string
  runId: string
  turns: number
  toolCallCount: number
  reasoningChars: number
  localizeFile: string
  model: string
  patchBytes: number | null
}

function emptyInstanceResult(instanceId: string): { md: string; summary: InstanceSummary } {
  return {
    md: `## Instance: ${instanceId}\n\n(no records)\n`,
    summary: {
      instanceId,
      runId: "",
      turns: 0,
      toolCallCount: 0,
      reasoningChars: 0,
      localizeFile: "",
      model: "",
      patchBytes: null,
    },
  }
}

function computeInstanceStats(turns: TurnInfo[]): {
  totalToolCalls: number
  totalReasoningChars: number
  localizeFile: string
  patchBytes: number | null
} {
  const totalToolCalls = turns.reduce((s, t) => s + t.toolCalls.length, 0)
  const totalReasoningChars = turns.reduce((s, t) => s + t.reasoning.length, 0)

  let localizeFile = ""
  const t0 = turns[0]
  if (t0 !== undefined && t0.msgsLen === 1 && t0.text) {
    const m = /FILE:\s*(\S+)/.exec(t0.text)
    if (m?.[1]) localizeFile = m[1]
  }

  let patchBytes: number | null = null
  for (const t of turns) {
    for (const tc of t.toolCalls) {
      if (/apply_patch|edit|write_file/i.test(tc.name)) {
        patchBytes = (patchBytes ?? 0) + tc.argsJson.length
      }
    }
  }

  return { totalToolCalls, totalReasoningChars, localizeFile, patchBytes }
}

function buildInstanceMd(
  instanceId: string,
  turns: TurnInfo[],
  runId: string,
  model: string,
  stats: ReturnType<typeof computeInstanceStats>,
): string {
  const { totalToolCalls, localizeFile, patchBytes } = stats
  const headerParts = [
    `run: ${runId}`,
    `${turns.length} turns`,
    `${totalToolCalls} tool calls`,
    model,
  ]
  const md: string[] = [`## Instance: ${instanceId} (${headerParts.join(" | ")})`]

  const firstTurn = turns[0]
  if (firstTurn !== undefined && firstTurn.msgsLen === 1 && firstTurn.text) {
    const firstLine = firstTurn.text.split("\n")[0] ?? ""
    md.push(`**Localize:** ${trunc(firstLine, 200)}`)
  }
  if (localizeFile) md.push(`**Top file:** ${localizeFile}`)
  if (patchBytes !== null) md.push(`**Patch:** ~${patchBytes} bytes (args length)`)

  md.push("")
  for (const t of turns) {
    md.push(renderTurn(t))
    md.push("")
  }
  return md.join("\n")
}

function renderInstance(group: InstanceGroup): { md: string; summary: InstanceSummary } {
  const { instanceId, records } = group
  if (records.length === 0) return emptyInstanceResult(instanceId)

  const firstTs = records[0]?.metadata?.recordedAt
  const runId = firstTs !== undefined ? `run-${firstTs}` : "run-unknown"

  let model = ""
  for (const r of records) {
    if (r.metadata?.model) {
      model = r.metadata.model
      break
    }
  }

  const turns: TurnInfo[] = []
  let prevTs: number | null = null
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue
    turns.push(parseTurn(rec, prevTs, i + 1))
    prevTs = rec.metadata?.recordedAt ?? prevTs
  }

  const stats = computeInstanceStats(turns)
  const md = buildInstanceMd(instanceId, turns, runId, model, stats)

  return {
    md,
    summary: {
      instanceId,
      runId,
      turns: turns.length,
      toolCallCount: stats.totalToolCalls,
      reasoningChars: stats.totalReasoningChars,
      localizeFile: stats.localizeFile,
      model,
      patchBytes: stats.patchBytes,
    },
  }
}

// ---------------------------------------------------------------------------
// Render all instances
// ---------------------------------------------------------------------------

const rendered = groupsToRender.map(renderInstance)

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (outDir) {
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true })
  }

  const indexLines: string[] = ["# Trajectory Index", "", `File: \`${filePath}\``]
  if (fromMs !== undefined) indexLines.push(`From: ${fromMs}`)
  if (toMs !== undefined) indexLines.push(`To: ${toMs}`)
  indexLines.push(
    "",
    "| Instance | Run | Turns | Tools | Reasoning chars | Localized file | Model |",
    "| -------- | --- | ----- | ----- | --------------- | -------------- | ----- |",
  )

  for (const { md, summary: s } of rendered) {
    const fileName = `${s.instanceId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.md`
    writeFileSync(join(outDir, fileName), md, "utf8")
    indexLines.push(
      `| [${s.instanceId}](./${fileName}) | ${s.runId} | ${s.turns} | ${s.toolCallCount} | ${s.reasoningChars} | ${s.localizeFile} | ${s.model} |`,
    )
  }

  writeFileSync(join(outDir, "INDEX.md"), `${indexLines.join("\n")}\n`, "utf8")
  process.stderr.write(`Wrote ${rendered.length} instance files + INDEX.md to ${outDir}\n`)
} else {
  process.stdout.write(`${rendered.map((r) => r.md).join("\n---\n\n")}\n`)
}
