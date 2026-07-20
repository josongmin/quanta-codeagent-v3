/**
 * Bun resolves an extensionless import to a colocated `.js` before its `.ts`
 * sibling. Historical TypeScript emits under `src/` would therefore let tests
 * execute stale code even though source and typecheck target `.ts`. This preload
 * runs before `tests/setup.ts` and every test module, removing only ignored
 * generated JavaScript while preserving the explicit auth-ui exception.
 */
import { lstatSync, readdirSync, unlinkSync } from "node:fs"
import { join, relative } from "node:path"

const SOURCE_ROOT = join(import.meta.dir, "..", "src")
const PRESERVED_SOURCE_JS = new Set(["ui/auth-ui.js"])

const removeStaleSourceJs = (directory: string): void => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (lstatSync(path).isDirectory()) {
      removeStaleSourceJs(path)
      continue
    }
    if (!path.endsWith(".js")) continue
    if (PRESERVED_SOURCE_JS.has(relative(SOURCE_ROOT, path))) continue
    unlinkSync(path)
  }
}

removeStaleSourceJs(SOURCE_ROOT)
