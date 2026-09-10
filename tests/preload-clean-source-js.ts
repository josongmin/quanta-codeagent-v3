/**
 * Bun resolves an extensionless import to a colocated `.js` before its `.ts`
 * sibling. Historical TypeScript emits under `src/` would therefore let tests
 * execute stale code even though source and typecheck target `.ts`. This preload
 * runs before `tests/setup.ts` and every test module, removing only ignored
 * generated JavaScript while preserving the explicit auth-ui exception.
 */
import { readdirSync, unlinkSync } from "node:fs"
import { join, relative } from "node:path"

export const SOURCE_JS_CLEANED_ROOT_ENV = "QUANTA_TEST_SOURCE_JS_CLEANED_ROOT"
export const SOURCE_ROOT = join(import.meta.dir, "..", "src")
const PRESERVED_SOURCE_JS = new Set(["ui/auth-ui.js"])

const removeStaleSourceJs = (directory: string): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      removeStaleSourceJs(path)
      continue
    }
    // Match the old lstat behavior: never follow directory symlinks, but remove
    // a stale `.js` symlink that would still win Bun's extension resolution.
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (!path.endsWith(".js")) continue
    if (PRESERVED_SOURCE_JS.has(relative(SOURCE_ROOT, path))) continue
    unlinkSync(path)
  }
}

/**
 * Managed-campaign contract: the parent runner may import this module once,
 * call this function, then pass the returned root through
 * `SOURCE_JS_CLEANED_ROOT_ENV` to every child. Direct `bun test` invocations do
 * not carry that marker and therefore retain the fail-safe preload cleanup.
 */
export const cleanStaleSourceJs = (): string => {
  removeStaleSourceJs(SOURCE_ROOT)
  return SOURCE_ROOT
}

if (process.env[SOURCE_JS_CLEANED_ROOT_ENV] !== SOURCE_ROOT) cleanStaleSourceJs()
