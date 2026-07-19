import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { parseFrontmatter } from "../frontmatter"
import type { PlaybookRegistration, PlaybookRegistry } from "./auto-dispatch"
import { parsePlaybookFrontmatter } from "./frontmatter-parser"

export type DiskPlaybookRegistryIssueCode =
  | "root-not-found"
  | "root-not-dir"
  | "path-escape"
  | "not-file"
  | "read-error"
  | "invalid-frontmatter"
  | "missing-name"
  | "invalid-name"
  | "duplicate-name"
  | "io-error"

export interface DiskPlaybookRegistryIssue {
  readonly code: DiskPlaybookRegistryIssueCode
  readonly path: string
  readonly message: string
}

export type DiskPlaybookRegistryReloadResult =
  | { readonly ok: true; readonly loaded: number }
  | { readonly ok: false; readonly issues: readonly DiskPlaybookRegistryIssue[] }

/**
 * Mutable snapshot registry. Reloads are atomic: a failed scan preserves the
 * last good registrations, while a successful scan replaces the full set so
 * deleted files disappear immediately.
 */
export interface DiskPlaybookRegistry extends PlaybookRegistry {
  readonly reload: () => DiskPlaybookRegistryReloadResult
  readonly lastReload: () => DiskPlaybookRegistryReloadResult
}

const PLAYBOOK_NAME = /^[a-z0-9][a-z0-9-]*$/

const issue = (
  code: DiskPlaybookRegistryIssueCode,
  path: string,
  message: string,
): DiskPlaybookRegistryIssue => ({ code, path, message })

const isConfined = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

const canonicalRoot = (
  root: string,
): { ok: true; root: string } | { ok: false; issue: DiskPlaybookRegistryIssue } => {
  const absolute = resolve(root)
  if (!existsSync(absolute)) {
    return { ok: false, issue: issue("root-not-found", absolute, "registry root does not exist") }
  }
  try {
    const canonical = realpathSync(absolute)
    if (!statSync(canonical).isDirectory()) {
      return {
        ok: false,
        issue: issue("root-not-dir", absolute, "registry root is not a directory"),
      }
    }
    return { ok: true, root: canonical }
  } catch (error) {
    return {
      ok: false,
      issue: issue("io-error", absolute, error instanceof Error ? error.message : String(error)),
    }
  }
}

const loadRegistration = (
  root: string,
  path: string,
):
  | { ok: true; registration: PlaybookRegistration }
  | { ok: false; issue: DiskPlaybookRegistryIssue } => {
  let canonical: string
  try {
    canonical = realpathSync(path)
  } catch (error) {
    return {
      ok: false,
      issue: issue("read-error", path, error instanceof Error ? error.message : String(error)),
    }
  }
  if (!isConfined(root, canonical)) {
    return {
      ok: false,
      issue: issue("path-escape", path, `resolved outside registry root: ${canonical}`),
    }
  }
  try {
    if (!statSync(canonical).isFile()) {
      return {
        ok: false,
        issue: issue("not-file", path, "playbook candidate is not a regular file"),
      }
    }
  } catch (error) {
    return {
      ok: false,
      issue: issue("read-error", path, error instanceof Error ? error.message : String(error)),
    }
  }

  let text: string
  try {
    text = readFileSync(canonical, "utf8")
  } catch (error) {
    return {
      ok: false,
      issue: issue("read-error", path, error instanceof Error ? error.message : String(error)),
    }
  }

  const parsed = parsePlaybookFrontmatter(text)
  if (!parsed.ok) {
    return { ok: false, issue: issue("invalid-frontmatter", path, parsed.error.message) }
  }
  const rawName = parseFrontmatter(text).data.name
  if (rawName === undefined) {
    return { ok: false, issue: issue("missing-name", path, "frontmatter must declare name") }
  }
  if (typeof rawName !== "string" || !PLAYBOOK_NAME.test(rawName)) {
    return {
      ok: false,
      issue: issue("invalid-name", path, "frontmatter name must be a non-empty kebab-case string"),
    }
  }
  return { ok: true, registration: { name: rawName, frontmatter: parsed.value } }
}

const scan = (
  rootPath: string,
):
  | { readonly ok: true; readonly registrations: readonly PlaybookRegistration[] }
  | { readonly ok: false; readonly issues: readonly DiskPlaybookRegistryIssue[] } => {
  const rootResult = canonicalRoot(rootPath)
  if (!rootResult.ok) return { ok: false, issues: [rootResult.issue] }

  let candidates: string[]
  try {
    candidates = readdirSync(rootResult.root)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => resolve(rootResult.root, name))
  } catch (error) {
    return {
      ok: false,
      issues: [
        issue("io-error", rootResult.root, error instanceof Error ? error.message : String(error)),
      ],
    }
  }

  const registrations: PlaybookRegistration[] = []
  const issues: DiskPlaybookRegistryIssue[] = []
  const names = new Map<string, string>()
  for (const path of candidates) {
    const loaded = loadRegistration(rootResult.root, path)
    if (!loaded.ok) {
      issues.push(loaded.issue)
      continue
    }
    const prior = names.get(loaded.registration.name)
    if (prior !== undefined) {
      issues.push(
        issue(
          "duplicate-name",
          path,
          `playbook name '${loaded.registration.name}' is also declared by ${prior}`,
        ),
      )
      continue
    }
    names.set(loaded.registration.name, path)
    registrations.push(loaded.registration)
  }
  if (issues.length > 0) return { ok: false, issues: Object.freeze(issues) }
  return { ok: true, registrations: Object.freeze(registrations) }
}

export const createDiskPlaybookRegistry = (root: string): DiskPlaybookRegistry => {
  let registrations: readonly PlaybookRegistration[] = Object.freeze([])
  let last: DiskPlaybookRegistryReloadResult = { ok: true, loaded: 0 }
  const reload = (): DiskPlaybookRegistryReloadResult => {
    try {
      const result = scan(root)
      if (!result.ok) {
        last = result
        return last
      }
      registrations = result.registrations
      last = { ok: true, loaded: registrations.length }
      return last
    } catch (error) {
      last = {
        ok: false,
        issues: [
          issue("io-error", resolve(root), error instanceof Error ? error.message : String(error)),
        ],
      }
      return last
    }
  }
  const registry: DiskPlaybookRegistry = {
    list: () => registrations,
    reload,
    lastReload: () => last,
  }
  reload()
  return registry
}
