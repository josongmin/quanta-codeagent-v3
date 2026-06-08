/** Browser tool — input schemas (ADR-0427). */

import { z } from "zod"

export const navigateSchema = z.object({
  url: z.string().describe("https/http URL to navigate to"),
})
export type NavigateInput = z.infer<typeof navigateSchema>

export const snapshotSchema = z.object({})
export type SnapshotInput = z.infer<typeof snapshotSchema>

export const clickSchema = z.object({
  ref: z.string().describe("element ref from a prior browser_snapshot (e.g. e7)"),
})
export type ClickInput = z.infer<typeof clickSchema>

export const typeSchema = z.object({
  ref: z.string().describe("element ref from a prior browser_snapshot"),
  text: z.string().describe("text to type into the element"),
  clear: z.boolean().optional().describe("clear the field before typing"),
})
export type TypeInput = z.infer<typeof typeSchema>

export const screenshotSchema = z.object({})
export type ScreenshotInput = z.infer<typeof screenshotSchema>

export const cdpSchema = z.object({
  method: z.string().describe("CDP method (allowlist-gated; only read-only introspection)"),
  params: z.record(z.unknown()).optional().describe("CDP params object"),
})
export type CdpInput = z.infer<typeof cdpSchema>

export const fillSchema = z.object({
  ref: z.string().describe("element ref from a prior browser_snapshot"),
  value: z.string().describe("value to set (replaces the field's contents)"),
})
export type FillInput = z.infer<typeof fillSchema>

export const selectOptionSchema = z.object({
  ref: z.string().describe("a <select> element ref from a prior browser_snapshot"),
  // min(1): an empty array would silently deselect every option (R3 audit [11]).
  values: z.array(z.string()).min(1).describe("option value(s) to select"),
})
export type SelectOptionInput = z.infer<typeof selectOptionSchema>

export const scrollSchema = z.object({
  ref: z.string().optional().describe("scroll this element into view; omit to scroll the page"),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  amount: z.number().optional().describe("pixels (default 400); ignored when ref is set"),
})
export type ScrollInput = z.infer<typeof scrollSchema>

export const pressKeySchema = z.object({
  key: z.string().describe('a key name: "Enter" | "Escape" | "Tab" | "ArrowDown" | single char'),
})
export type PressKeyInput = z.infer<typeof pressKeySchema>

export const dragSchema = z.object({
  sourceRef: z.string().describe("element ref to drag from"),
  targetRef: z.string().optional().describe("element ref to drop on"),
  // .finite(): NaN/Infinity JSON-serialize to null in the CDP envelope (R3 audit [10]).
  targetX: z.number().finite().optional().describe("viewport x to drop at (when no targetRef)"),
  targetY: z.number().finite().optional().describe("viewport y to drop at (when no targetRef)"),
})
export type DragInput = z.infer<typeof dragSchema>

export const mouseClickXySchema = z.object({
  x: z.number().finite().describe("viewport x"),
  y: z.number().finite().describe("viewport y"),
})
export type MouseClickXyInput = z.infer<typeof mouseClickXySchema>

export const consoleSchema = z.object({
  clear: z.boolean().optional().describe("drain the buffer after reading"),
})
export type ConsoleInput = z.infer<typeof consoleSchema>

export const waitSchema = z.object({
  selector: z.string().describe("CSS selector to wait for (e.g. '#result', '.error')"),
  timeoutMs: z.number().finite().optional().describe("max wait in ms (default 5000)"),
})
export type WaitInput = z.infer<typeof waitSchema>

export const readSchema = z.object({
  ref: z.string().describe("element ref from a prior browser_snapshot"),
  what: z.enum(["text", "attribute", "visible"]).describe("what to read off the element"),
  attr: z.string().optional().describe("attribute name (required when what=attribute)"),
})
export type ReadInput = z.infer<typeof readSchema>

// TICKET-24 Wave A — element bounding box + cosmetic highlight (default-OFF,
// gated at the toolset layer by QUANTA_BROWSER_BOUNDS / QUANTA_BROWSER_HIGHLIGHT).
export const elementBoundsSchema = z.object({
  ref: z.string().describe("element ref from a prior browser_snapshot (e.g. e7)"),
})
export type ElementBoundsInput = z.infer<typeof elementBoundsSchema>

export const highlightSchema = z.object({
  ref: z.string().describe("element ref from a prior browser_snapshot (e.g. e7)"),
  color: z.string().optional().describe("CSS outline color (default high-contrast magenta)"),
  durationMs: z.number().finite().optional().describe("auto-remove after N ms (default 1500)"),
})
export type HighlightInput = z.infer<typeof highlightSchema>
