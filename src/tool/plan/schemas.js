/**
 * Shared zod schemas for the 4 plan-mode tools (ADR-0095 draft). Closed-shape
 * input validation at the dispatch boundary. Each tool re-uses these
 * fragments so the inputs the model sees stay consistent across tools.
 */
import { z } from "zod";
const statusSchema = z
    .enum(["pending", "in_progress", "completed", "cancelled", "blocked"])
    .describe("Todo lifecycle: pending → in_progress → {completed,cancelled,blocked}.");
const idSchema = z.string().min(1).describe("ULID-style opaque id of a todo or phase.");
const newTodoSchema = z.object({
    content: z.string().min(1).describe("What this todo describes."),
    status: statusSchema.optional(),
    dependencies: z.array(idSchema).optional().describe("Todo ids this depends on (DAG)."),
    phaseId: z.string().optional(),
    assignee: z.string().optional().describe("Subagent nickname (ADR-0042)."),
    verifyHint: z.string().optional().describe("How to verify completion (ADR-0013)."),
});
const newPhaseSchema = z.object({
    name: z.string().min(1),
    todoIndexes: z.array(z.number().int().min(0)).optional(),
});
export const createPlanSchema = z.object({
    name: z.string().min(1).describe("Short plan name."),
    overview: z.string().min(1).describe("Plan overview (markdown ok)."),
    isProject: z.boolean().optional().describe("Long-lived project plan vs ephemeral."),
    todos: z.array(newTodoSchema).describe("Initial todos."),
    phases: z.array(newPhaseSchema).optional().describe("Optional grouping."),
});
const todoPatchSchema = z.object({
    id: idSchema,
    content: z.string().optional(),
    status: statusSchema.optional(),
    dependencies: z.array(idSchema).optional(),
    phaseId: z.string().nullable().optional().describe("null clears, undefined preserves."),
    assignee: z.string().nullable().optional(),
    verifyHint: z.string().nullable().optional(),
});
export const updateTodosSchema = z.object({
    patches: z.array(todoPatchSchema).describe("Patches by todo id."),
    merge: z.boolean().describe("true = preserve unspecified fields; false = clear them."),
    expected_version: z.number().int().min(0).describe("CAS handle from current()."),
});
export const updatePlanSchema = z.object({
    name: z.string().optional(),
    overview: z.string().optional(),
    isProject: z.boolean().optional(),
    phase_order: z.array(idSchema).optional().describe("Phase ids in new order (full list)."),
    expected_version: z.number().int().min(0),
});
export const removeTodosSchema = z.object({
    ids: z.array(idSchema).min(1).describe("Todo ids to remove (atomic batch)."),
    expected_version: z.number().int().min(0),
});
