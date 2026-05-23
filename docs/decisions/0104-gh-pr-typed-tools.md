# ADR-0104: `gh_pr_review_diff` / `gh_pr_auto_merge` / `gh_pr_create.draft` (Claude Desktop PR IPC 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**: ADR-0103(`gh_pr_blame`, 같은 batch), Claude Desktop `createLocalPr`/`reviewDiff`/`autoMerge` IPC 패턴
- **참조**: `src/tool/gh/index.ts`(3 신규 도구 + draft 옵션), `tests/unit/gh-pr-tools-hellgate.test.ts`(HELL-11~18 = 8 적대)

## 맥락

Claude Desktop은 PR ops를 IPC에서 typed로 노출(`createLocalPr` / `reviewDiff` / `autoMerge`). 우리 기존 `ghTools`는 `gh_pr_view` / `gh_pr_create` / `gh_pr_comment` / `gh_pr_list` / `gh_pr_checks` / `gh_issue_view` 6개 — typed PR diff 페치와 auto-merge 부재, `--draft` 옵션 누락.

## 결정

`src/tool/gh/index.ts`에 3 도구 + 1 옵션 추가:

### 1. `gh_pr_review_diff` (read-only)
- 입력: `pr`, optional `maxBytes`(default 64KiB, schema cap 1MiB)
- 호출: `gh pr diff <ref>`
- 출력: unified diff 본문, maxBytes 초과 시 truncation marker(`[truncated: N bytes total, showing first M bytes]`)

### 2. `gh_pr_auto_merge` (mutating)
- 입력: `pr`, optional `method`(merge | squash | rebase, default merge)
- 호출: `gh pr merge <ref> --auto --merge|--squash|--rebase`
- 결과: "auto-merge enabled" 또는 gh stdout

### 3. `gh_pr_create.draft` 옵션
- 기존 schema에 `draft?: boolean` 추가
- `draft: true` ⇒ argv에 `--draft` 추가, 없으면 byte-identical pre-ADR

모든 새 도구는 기존 패턴 답습: `GhRunner` injection, `normalizeRef` leading-`-` 거부, stderr truncation(500자), `defaultGhRunner`의 scrubbed env(`GH_TOKEN`/`GITHUB_*` 허용, `OPENAI_API_KEY` 등 거부).

## 결과

- 8 hellgate 통과: argv 정확성 / 트렁케이션 marker / schema cap 거부 / 작은 diff passthrough / default method `--merge` / squash·rebase mapping / draft 플래그 add·omit.
- `ghTools()` factory 9개로 확장 — 순서: 6 read(view/issue/checks/list/blame/review_diff) → 3 mutating(comment/create/auto_merge).

## 한계

- `gh_pr_review_diff`는 GraphQL 미사용 — `gh pr diff`가 단일 unified diff 반환. file-level review thread는 ADR-0103(`gh_pr_blame`)이 담당.
- `auto_merge` method "rebase-and-merge" 등 일부 GitHub 정책 모드는 미커버 — 표준 3개만.
- `draft: true`는 PR open 시점 그것 — 이후 ready-for-review 전환은 별도 도구 필요(미구현).
- `inputSchema.max(1MiB)`는 dispatcher의 validation 책임. tool execute는 trust input(기존 패턴 답습).
