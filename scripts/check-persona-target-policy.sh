#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EXPECT_MODE="${1:-}"

usage() {
  cat <<'EOF'
Usage:
  scripts/check-persona-target-policy.sh --expect-agent

Validates that the current workspace is the quanta-codeagent-v3 repo and that
the mandatory agent bootstrap artifacts exist.
EOF
}

if [[ "${EXPECT_MODE}" != "--expect-agent" ]]; then
  usage >&2
  exit 2
fi

required_files=(
  "AGENTS.md"
  "AGENT_CORE.md"
  "AGENT_PLAYBOOK.md"
  "AGENT_REFERENCE.md"
  "AGENT_RULE_CATALOG.md"
  "README.md"
  "docs/ARCHITECTURE.md"
  "docs/decisions/README.md"
  ".codex/CODEX-RULES.md"
  ".codex/CODEX-START-PROMPT.md"
  ".ai/guide-development.md"
)

for required_file in "${required_files[@]}"; do
  if [[ ! -f "${REPO_ROOT}/${required_file}" ]]; then
    echo "error: missing ${REPO_ROOT}/${required_file}" >&2
    exit 1
  fi
done

if [[ "$(git -C "${REPO_ROOT}" rev-parse --is-inside-work-tree 2>/dev/null || true)" != "true" ]]; then
  echo "error: ${REPO_ROOT} is not a git worktree" >&2
  exit 1
fi

if ! grep -q "Quanta CodeAgent v3" "${REPO_ROOT}/README.md"; then
  echo "error: README.md does not match the expected repo identity" >&2
  exit 1
fi

echo "repo_root=${REPO_ROOT}"
echo "repo_name=quanta-codeagent-v3"
echo "persona=agent"
echo "target=quanta-codeagent-v3"
echo "verdict=pass"
