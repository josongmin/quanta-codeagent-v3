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
  values: z.array(z.string()).describe("option value(s) to select"),
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
  targetX: z.number().optional().describe("viewport x to drop at (when no targetRef)"),
  targetY: z.number().optional().describe("viewport y to drop at (when no targetRef)"),
})
export type DragInput = z.infer<typeof dragSchema>

export const mouseClickXySchema = z.object({
  x: z.number().describe("viewport x"),
  y: z.number().describe("viewport y"),
})
export type MouseClickXyInput = z.infer<typeof mouseClickXySchema>
