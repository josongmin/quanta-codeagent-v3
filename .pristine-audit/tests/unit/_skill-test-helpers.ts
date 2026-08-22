import { expect } from "bun:test"
import type { Skill } from "@/skill"

export const expectAllowedToolsList = (
  value: string | string[] | undefined,
  label: string,
): string[] => {
  expect(Array.isArray(value), `[${label}] allowedTools must be a string[]`).toBe(true)
  if (!Array.isArray(value)) {
    throw new Error(`[${label}] allowedTools must be a string[]`)
  }
  return value
}

export const expectSkillTools = (
  skill: Pick<Skill, "name" | "tools"> | undefined,
  label: string,
): string[] => {
  expect(skill, `[${label}] discovered skill must be defined`).toBeDefined()
  if (!skill) {
    throw new Error(`[${label}] discovered skill must be defined`)
  }
  expect(skill.tools, `[${label}] discovered skill must declare tools`).toBeDefined()
  if (!skill.tools) {
    throw new Error(`[${label}] discovered skill must declare tools`)
  }
  return skill.tools
}
