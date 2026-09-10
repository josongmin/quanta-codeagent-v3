import { NIGHTLY_INDICES } from "./conflict-parser-fuzz-cases"
import { registerRealGitConflictTests } from "./conflict-parser-fuzz-runtime"

registerRealGitConflictTests(
  "conflict-parser differential fuzz — nightly real-git remainder",
  NIGHTLY_INDICES,
  20,
)
