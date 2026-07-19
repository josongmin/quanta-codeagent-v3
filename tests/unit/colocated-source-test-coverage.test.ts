/**
 * CI entrypoint for deterministic behavioral tests intentionally colocated
 * with their owning slices. `bun test tests/unit` discovers this file, then
 * executes each owner-local module exactly once through these imports.
 *
 * Keep this list limited to the seven gaps audited in Jul-15. Adding a source
 * test here requires it to remain deterministic and unit-tier appropriate;
 * integration/contract tests belong in their existing tier directories.
 */
import "../../src/permission/__tests__/profile-list-select-harder.hellgate.test"
import "../../src/permission/__tests__/profile-list-select.hellgate.test"
import "../../src/llm/empty-stream-breaker.test"
import "../../src/memory/adapters/__tests__/sqlite-delete-async.hellgate.test"
import "../../src/llm/system-prompt-cache/__tests__/drift-detector.hellgate.test"
import "../../src/agent/loop/__tests__/bg-compaction-live-suffix-install.test"
import "../../src/tool/mcp_resources/__tests__/read-resource-dir-blob-to-disk.hellgate.test"
import "../../src/tool/stale-read-guard/gate-contract.test"
