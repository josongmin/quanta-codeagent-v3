/**
 * Epic-2 — toolchain detector. Maps a project's marker files to {language,
 * test command, parser}. Pure: takes an injected existence probe (no real IO),
 * so it is trivially testable and slice-clean.
 *
 * Precedence is ordered (first match wins): a compiled-language marker
 * (Cargo.toml / go.mod) outranks package.json, since a Rust/Go project often
 * carries a JS sidecar but is tested via cargo/go.
 */
import type { Toolchain } from "./types"

export interface ExistsPort {
  /** True iff `name` exists directly under the project root. */
  fileExists(name: string): Promise<boolean>
}

interface Marker {
  readonly file: string
  readonly toolchain: Toolchain
}

const MARKERS: readonly Marker[] = [
  // Default capture (NOT --nocapture): cargo replays a failed test's panic into
  // the `---- NAME stdout ----` block, which is where parseCargo reads file:line.
  { file: "Cargo.toml", toolchain: { kind: "rust", command: ["cargo", "test"], parser: "cargo" } },
  // -json gives a structured event stream; ./... runs the whole module tree.
  { file: "go.mod", toolchain: { kind: "go", command: ["go", "test", "-json", "./..."], parser: "go" } },
  { file: "pyproject.toml", toolchain: { kind: "python", command: ["python3", "-m", "unittest", "discover", "-v"], parser: "python-unittest" } },
  { file: "setup.py", toolchain: { kind: "python", command: ["python3", "-m", "unittest", "discover", "-v"], parser: "python-unittest" } },
  { file: "setup.cfg", toolchain: { kind: "python", command: ["python3", "-m", "unittest", "discover", "-v"], parser: "python-unittest" } },
  { file: "package.json", toolchain: { kind: "node", command: ["npm", "test", "--silent"], parser: "generic" } },
]

/** Detect the project's toolchain, or `null` if no marker is present. */
export const detectToolchain = async (_cwd: string, fs: ExistsPort): Promise<Toolchain | null> => {
  for (const m of MARKERS) {
    if (await fs.fileExists(m.file)) return m.toolchain
  }
  return null
}
