/**
 * Use case taxonomy — SINGLE SOURCE OF TRUTH.
 *
 * Mirrors `docs/analysis/may-21-coding-agent-query-usecase.md` §1 (12 대분류 /
 * ~120 소분류) one-for-one. Every change here must round-trip through
 * `doc-sync.ts` to keep the markdown view consistent. Adding/removing/renaming
 * a leaf without re-running doc-sync is a contract violation; the unit test
 * `tests/unit/eval-taxonomy.test.ts` guards id uniqueness and tree shape.
 *
 * ID scheme: `<major>.<mid>.<leaf>` in kebab-case. Stable across releases —
 * downstream stores (Tier 1 fixtures, Tier 3 trajectory labels) key by this id,
 * so a rename is a breaking change (bump a migration in `storage/`).
 *
 * Evidence keys reference `docs/analysis/may-21-...md` §0 데이터셋:
 *   - hao2026  — Self-Admitted GenAI Usage taxonomy (ChatGPT 64-task)
 *   - hao2024  — Shared ChatGPT Conversations in PR/Issue (16 SE inquiry)
 *   - liu2026  — Proactive Coding Assistants (1,246 dev IDE traces)
 *   - wang2026 — Beyond the Prompt: Cursor Rules (401 OSS repos)
 *   - zhong2025 — Developer-LLM Conversations (52K WildChat subset)
 *   - none     — Empirically observed in practice; no academic anchor yet.
 */

export type EvidenceKey = "hao2026" | "hao2024" | "liu2026" | "wang2026" | "zhong2025" | "none"

/** A leaf use case node. `examples` are short trigger phrases the LLM
 *  classifier and the synthetic generator both consume — keep concrete. */
export interface UseCaseLeaf {
  /** `<major>.<mid>.<leaf>` */
  id: string
  /** Display label (Korean primary, English allowed for canonical terms). */
  label: string
  /** 1-3 representative trigger prompts. Quotes intentional. */
  examples: readonly string[]
  /** Evidence keys backing this leaf. */
  evidence: readonly EvidenceKey[]
}

export interface UseCaseMid {
  id: string
  label: string
  leaves: readonly UseCaseLeaf[]
}

export interface UseCaseMajor {
  /** `<major>` */
  id: string
  label: string
  /** Empirical share where measured (Hao 2026 ChatGPT n=343 for cats 1-7).
   *  Omit when no robust number exists. */
  empiricalShare?: number
  mids: readonly UseCaseMid[]
}

/** Helper to build a leaf with the parent's id prefix. */
const leaf = (
  midId: string,
  slug: string,
  label: string,
  examples: readonly string[],
  evidence: readonly EvidenceKey[],
): UseCaseLeaf => ({ id: `${midId}.${slug}`, label, examples, evidence })

/** Helper to build a mid with prefixed leaves. */
const mid = (
  majorId: string,
  slug: string,
  label: string,
  build: (midId: string) => readonly UseCaseLeaf[],
): UseCaseMid => {
  const id = `${majorId}.${slug}`
  return { id, label, leaves: build(id) }
}

// ── 12 대분류 ────────────────────────────────────────────────────────────────

export const TAXONOMY: readonly UseCaseMajor[] = [
  {
    id: "software-quality",
    label: "Software Quality",
    empiricalShare: 0.29,
    mids: [
      mid("software-quality", "debugging", "Debugging", (m) => [
        leaf(
          m,
          "error-message-paste",
          "에러 메시지 paste → 수정",
          ["스택트레이스 + 고쳐줘"],
          ["hao2026", "hao2024"],
        ),
        leaf(m, "reproducer", "재현 코드 작성", ["이 버그 재현 테스트"], ["hao2026"]),
        leaf(m, "env-specific", "환경별 디버깅", ["CI에서만 실패"], ["none"]),
        leaf(m, "heisenbug", "Heisenbug/Flaky 추적", ["가끔 실패"], ["none"]),
        leaf(m, "log-analysis", "로그 분석", ["대량 로그 paste"], ["none"]),
      ]),
      mid("software-quality", "refactoring", "Refactoring", (m) => [
        leaf(m, "rename", "Rename", ["식별자/파일/모듈"], ["hao2026"]),
        leaf(m, "extract", "Extract function/component/module", ["코드 블록 분리"], ["hao2026"]),
        leaf(m, "type-tightening", "타입 리팩터링", ["any→strict, generic"], ["hao2026"]),
        leaf(m, "simplify", "로직 단순화", ["nested→flat, DRY"], ["hao2026"]),
        leaf(m, "pattern-apply", "Pattern 적용", ["Strategy/Factory"], ["hao2026"]),
      ]),
      mid("software-quality", "testing", "Testing", (m) => [
        leaf(m, "unit-gen", "Unit test generation", ["함수→테스트"], ["hao2026"]),
        leaf(m, "edge-case", "Edge case 추가", ["null/empty/huge input"], ["hao2026"]),
        leaf(m, "mock-fixture", "Mock/fixture 셋업", ["의존성 모킹"], ["none"]),
        leaf(m, "coverage", "Coverage 채우기", ["이 파일 80%"], ["none"]),
        leaf(m, "e2e", "E2E 시나리오", ["Playwright/Cypress"], ["none"]),
        leaf(m, "qualitative", "Qualitative test (LLM 출력)", ["챗봇 출력 검증"], ["hao2026"]),
      ]),
      mid("software-quality", "code-review", "Code Review", (m) => [
        leaf(m, "diff-pr", "Diff/PR 전체 리뷰", ["내 PR 봐줘"], ["hao2024", "hao2026"]),
        leaf(m, "security", "보안 리뷰", ["SQLi/XSS/auth"], ["none"]),
        leaf(m, "perf", "성능 리뷰", ["알고리즘/쿼리"], ["none"]),
        leaf(m, "style", "Style/convention", ["lint 보완"], ["hao2026"]),
      ]),
      mid("software-quality", "issue-resolution", "Issue Resolution", (m) => [
        leaf(m, "github-issue", "GitHub 이슈 → 수정", ["이슈 링크 + 고쳐"], ["hao2024"]),
        leaf(m, "user-report", "사용자 보고 버그", ["유저가 X 안된대"], ["hao2024"]),
      ]),
    ],
  },

  {
    id: "feature-implementation",
    label: "Feature Implementation/Enhancement",
    empiricalShare: 0.24,
    mids: [
      mid("feature-implementation", "new-feature", "New Feature", (m) => [
        leaf(m, "spec-to-impl", "명세→구현", ["X 기능 만들어"], ["hao2026"]),
        leaf(m, "prototyping", "Prototyping (MVP)", ["full project 빌드"], ["hao2026"]),
        leaf(m, "new-module", "새 모듈/컴포넌트", ["greenfield 생성"], ["hao2026"]),
      ]),
      mid("feature-implementation", "enhancement", "Feature Enhancement", (m) => [
        leaf(m, "extend", "기존 기능 확장", ["Y 옵션 추가"], ["hao2026"]),
        leaf(m, "ux", "UX 개선", ["더 직관적으로"], ["hao2026"]),
        leaf(m, "behavior-tweak", "Behavior tweak", ["threshold 변경"], ["none"]),
      ]),
      mid("feature-implementation", "migration", "Migration / Translation", (m) => [
        leaf(m, "language", "Language migration", ["JS→TS, Py2→3"], ["hao2026"]),
        leaf(m, "framework", "Framework migration", ["Vue2→3, Pages→App Router"], ["hao2026"]),
        leaf(m, "api", "API migration", ["deprecated→신 API"], ["none"]),
        leaf(m, "version-upgrade", "Version upgrade", ["Node 16→20"], ["none"]),
        leaf(m, "db", "DB migration", ["MySQL→Postgres"], ["none"]),
      ]),
      mid("feature-implementation", "scripting", "Scripting", (m) => [
        leaf(m, "automation", "자동화 script", ["bash/python 일회용"], ["hao2026"]),
        leaf(m, "adhoc-etl", "일회성 데이터 처리", ["ad-hoc ETL"], ["hao2026"]),
      ]),
      mid("feature-implementation", "design", "Design", (m) => [
        leaf(m, "modeling", "기능 설계 결정", ["어떻게 모델링?"], ["hao2026"]),
        leaf(m, "palette", "Color palette", ["디자인 자산"], ["hao2026"]),
        leaf(m, "api-surface", "API surface 설계", ["인터페이스 형태"], ["none"]),
      ]),
    ],
  },

  {
    id: "learning",
    label: "Learning / Comprehension",
    empiricalShare: 0.19,
    mids: [
      mid("learning", "library", "Library/Framework Learning", (m) => [
        leaf(m, "api-usage", "API 사용법", ["staleTime 의미?"], ["hao2026"]),
        leaf(m, "best-practice", "Best practice 질문", ["권장 방법?"], ["hao2026"]),
        leaf(m, "compare-libs", "A vs B 비교", ["Drizzle vs Prisma"], ["hao2024"]),
        leaf(m, "maintained", "Maintained 여부", ["이거 살아있어?"], ["none"]),
      ]),
      mid("learning", "comprehension", "Code Comprehension", (m) => [
        leaf(m, "function-explain", "함수 동작 설명", ["이 함수 뭐함?"], ["hao2026", "hao2024"]),
        leaf(m, "callsite-trace", "호출처 추적", ["어디서 호출?"], ["hao2024"]),
        leaf(m, "architecture", "아키텍처 파악", ["구조 설명"], ["hao2024"]),
        leaf(m, "onboarding", "Onboarding", ["어디부터 봐?"], ["hao2024"]),
      ]),
      mid("learning", "brainstorm", "Brainstorming", (m) => [
        leaf(m, "approach", "접근법 탐색", ["어떻게 풀까?"], ["hao2026"]),
        leaf(m, "tradeoff", "Trade-off 논의", ["장단점은?"], ["hao2026"]),
      ]),
    ],
  },

  {
    id: "documentation",
    label: "Documentation",
    empiricalShare: 0.13,
    mids: [
      mid("documentation", "code-level", "Code-level", (m) => [
        leaf(m, "jsdoc", "JSDoc / docstring", ["함수→doc"], ["hao2026"]),
        leaf(m, "inline-comment", "인라인 코멘트 (복잡 패턴)", ["정규식/알고리즘"], ["hao2026"]),
      ]),
      mid("documentation", "project", "Project-level", (m) => [
        leaf(m, "readme", "README", ["프로젝트 소개"], ["hao2026"]),
        leaf(m, "user-guide", "User guide", ["사용자 매뉴얼"], ["hao2026"]),
        leaf(m, "architecture-doc", "Architecture doc", ["시스템 설명"], ["hao2026"]),
        leaf(m, "contributing", "Contribution guideline", ["기여자용"], ["hao2026"]),
      ]),
      mid("documentation", "api", "API Doc", (m) => [
        leaf(m, "openapi", "OpenAPI / Swagger spec", ["spec 작성"], ["hao2026"]),
      ]),
      mid("documentation", "release", "Release / Process", (m) => [
        leaf(m, "release-note", "Release note", ["변경 사항"], ["hao2026"]),
        leaf(m, "changelog", "Changelog", ["버전별"], ["hao2026"]),
        leaf(m, "legal-notice", "Trademark notice", ["법적 문구"], ["hao2026"]),
      ]),
      mid("documentation", "translation", "Translation", (m) => [
        leaf(m, "doc-translate", "문서 번역", ["다국어화"], ["hao2026"]),
      ]),
    ],
  },

  {
    id: "dev-environment",
    label: "Development Environment",
    empiricalShare: 0.07,
    mids: [
      mid("dev-environment", "ci-cd", "CI/CD", (m) => [
        leaf(m, "gh-actions", "GH Actions workflow", ["yml 작성"], ["hao2026"]),
        leaf(m, "review-bot", "코드리뷰 자동화", ["bot 통합"], ["hao2026"]),
        leaf(m, "custom-action", "Custom job/action", ["재사용 action"], ["hao2026"]),
      ]),
      mid("dev-environment", "container", "Container", (m) => [
        leaf(m, "dockerfile", "Dockerfile 생성", ["멀티스테이지"], ["hao2026"]),
        leaf(m, "compose-k8s", "Compose / k8s manifest", ["오케스트레이션"], ["hao2026"]),
      ]),
      mid("dev-environment", "build", "Build / Bundler", (m) => [
        leaf(m, "bundler-config", "webpack/vite 설정", ["bundle config"], ["none"]),
        leaf(m, "tsconfig", "tsconfig", ["TS 컴파일 옵션"], ["none"]),
      ]),
      mid("dev-environment", "iac", "Infra-as-Code", (m) => [
        leaf(m, "terraform", "Terraform", ["클라우드 리소스"], ["none"]),
        leaf(m, "helm", "Helm chart", ["k8s 패키징"], ["none"]),
      ]),
      mid("dev-environment", "lint-format", "Lint / Format", (m) => [
        leaf(m, "ruleset", "eslint/biome/ruff 룰", ["룰 정의"], ["none"]),
      ]),
    ],
  },

  {
    id: "process-automation",
    label: "Process Automation",
    empiricalShare: 0.06,
    mids: [
      mid("process-automation", "pr", "PR 관리", (m) => [
        leaf(m, "pr-description", "PR description 자동 생성", ["diff→요약"], ["hao2026"]),
        leaf(m, "pr-review-comment", "PR 리뷰 코멘트", ["자동 리뷰"], ["hao2026"]),
        leaf(m, "pr-title", "PR title 작성", ["컨벤셔널 prefix"], ["hao2026"]),
      ]),
      mid("process-automation", "commit", "Commit 관리", (m) => [
        leaf(m, "commit-message", "Commit message 생성", ["staged→msg"], ["hao2026"]),
        leaf(m, "conventional", "Conventional commit", ["feat/fix/chore"], ["hao2026"]),
      ]),
      mid("process-automation", "issue", "Issue 관리", (m) => [
        leaf(m, "issue-description", "Issue description 생성", ["템플릿 채우기"], ["hao2026"]),
        leaf(m, "release-planning", "Release planning", ["마일스톤 정리"], ["hao2026"]),
        leaf(m, "triage", "Issue triage", ["라벨/우선순위"], ["none"]),
      ]),
    ],
  },

  {
    id: "data-generation",
    label: "Data Generation / Manipulation",
    empiricalShare: 0.04,
    mids: [
      mid("data-generation", "prompt", "Prompt Generation", (m) => [
        leaf(m, "meta-prompt", "LLM 프롬프트 작성", ["메타 프롬프트"], ["hao2026"]),
      ]),
      mid("data-generation", "ui-string", "UI String", (m) => [
        leaf(m, "i18n", "다국어 i18n", ["키-값 생성"], ["hao2026"]),
      ]),
      mid("data-generation", "fixture", "Test Fixture", (m) => [
        leaf(m, "mock-data", "Mock data 생성", ["seed/factory"], ["hao2026"]),
      ]),
      mid("data-generation", "doc-translation", "Doc Translation", (m) => [
        leaf(m, "readme-translate", "README 번역", ["영↔한"], ["hao2026"]),
      ]),
      mid("data-generation", "format-conv", "Format Conversion", (m) => [
        leaf(m, "json-yaml-csv", "JSON↔YAML↔CSV", ["데이터 변환"], ["none"]),
      ]),
    ],
  },

  {
    id: "read-mode",
    label: "Read-mode / Navigation",
    mids: [
      mid("read-mode", "reading", "Code Reading", (m) => [
        leaf(m, "open-file", "파일 열람 / 일부 보기", ["X 파일 보여줘"], ["liu2026"]),
        leaf(m, "goto-definition", "Symbol 정의 점프", ["go-to-definition"], ["liu2026"]),
        leaf(m, "find-references", "호출 그래프 추적", ["find references"], ["liu2026"]),
      ]),
      mid("read-mode", "search", "Code Search", (m) => [
        leaf(m, "grep", "Grep / find", ["키워드 검색"], ["liu2026"]),
        leaf(m, "semantic", "의미 기반 검색", ["auth 처리하는 곳"], ["liu2026"]),
      ]),
      mid("read-mode", "navigation", "Navigation", (m) => [
        leaf(m, "view-switch", "View switching", ["파일 전환 컨텍스트"], ["liu2026"]),
        leaf(m, "tree", "Workspace 탐색", ["tree view"], ["liu2026"]),
      ]),
    ],
  },

  {
    id: "qa-howto",
    label: "Q&A / How-to",
    mids: [
      mid("qa-howto", "conceptual", "Conceptual Question", (m) => [
        leaf(m, "concept-explain", "개념 설명 요청", ["CQRS가 뭐야?"], ["hao2024"]),
        leaf(m, "term-define", "용어 정의", ["idempotent 의미?"], ["hao2024"]),
      ]),
      mid("qa-howto", "how-to", "How-to Guidance", (m) => [
        leaf(m, "step-by-step", "단계별 가이드", ["X 설정 방법?"], ["hao2024"]),
        leaf(m, "recipe", "Recipe", ["흔한 패턴은?"], ["hao2024"]),
      ]),
      mid("qa-howto", "comparison", "Comparison", (m) => [
        leaf(m, "ab-choice", "A vs B 선택", ["어떤 게 나아?"], ["hao2024"]),
        leaf(m, "tradeoff", "Trade-off 분석", ["장단점"], ["hao2024"]),
      ]),
    ],
  },

  {
    id: "persistent-context",
    label: "Persistent Context Management",
    mids: [
      mid("persistent-context", "conventions", "Conventions", (m) => [
        leaf(m, "coding-conv", "코딩 컨벤션 정의", ["naming, file layout"], ["wang2026"]),
        leaf(m, "style-rules", "Style 규칙", ["import 순서"], ["wang2026"]),
      ]),
      mid("persistent-context", "guidelines", "Guidelines", (m) => [
        leaf(m, "work-rules", "작업 지침", ["테스트 먼저"], ["wang2026"]),
        leaf(m, "workflow", "Workflow 규칙", ["main 직접 푸시 금지"], ["wang2026"]),
      ]),
      mid("persistent-context", "project-info", "Project Information", (m) => [
        leaf(m, "domain", "프로젝트 컨텍스트", ["도메인/용어집"], ["wang2026"]),
        leaf(m, "environment", "Environment", ["런타임/버전"], ["wang2026"]),
        leaf(m, "change-history", "Change history", ["최근 변경"], ["wang2026"]),
      ]),
      mid("persistent-context", "llm-directives", "LLM Directives", (m) => [
        leaf(m, "direct-instr", "모델 직접 지시", ["한국어로 답해"], ["wang2026"]),
        leaf(m, "output-format", "Output format 강제", ["코드만, 설명 X"], ["wang2026"]),
      ]),
      mid("persistent-context", "examples", "Examples", (m) => [
        leaf(m, "few-shot", "Few-shot 예시", ["입출력 샘플"], ["wang2026"]),
      ]),
    ],
  },

  {
    id: "operational",
    label: "Operational / DevOps",
    mids: [
      mid("operational", "deploy", "Deploy", (m) => [
        leaf(m, "deploy-cmd", "배포 명령", ["prod에 올려"], ["none"]),
        leaf(m, "rollback", "Rollback", ["이전 버전으로"], ["none"]),
      ]),
      mid("operational", "incident", "Incident Response", (m) => [
        leaf(m, "5xx", "5xx 폭발 대응", ["prod 죽음"], ["none"]),
        leaf(m, "log-query", "로그 조회", ["실시간 분석"], ["none"]),
      ]),
      mid("operational", "monitoring", "Monitoring", (m) => [
        leaf(m, "alert", "Alert 설정", ["threshold"], ["none"]),
        leaf(m, "dashboard", "Dashboard", ["메트릭 시각화"], ["none"]),
      ]),
      mid("operational", "db-op", "DB Operation", (m) => [
        leaf(m, "run-migration", "Migration 실행", ["마이그 돌려"], ["none"]),
        leaf(m, "query-tune", "쿼리 튜닝", ["slow query 분석"], ["none"]),
      ]),
    ],
  },

  {
    id: "meta",
    label: "Meta / Agent Management",
    mids: [
      mid("meta", "capability", "Capability", (m) => [
        leaf(m, "ask-capability", "도구 능력 확인", ["이거 할 수 있어?"], ["none"]),
      ]),
      mid("meta", "permission", "Permission", (m) => [
        leaf(m, "check-access", "권한 확인/설정", ["이 폴더 접근?"], ["none"]),
      ]),
      mid("meta", "memory", "Memory", (m) => [
        leaf(m, "save-recall", "기억 저장/회수", ["기억해, 잊어"], ["none"]),
      ]),
      mid("meta", "session", "Session", (m) => [
        leaf(m, "resume", "세션 재개 / 분기", ["아까 거 다시"], ["none"]),
      ]),
      mid("meta", "configuration", "Configuration", (m) => [
        leaf(m, "settings", "설정 / hooks / MCP", ["settings.json 편집"], ["none"]),
      ]),
      mid("meta", "cost-usage", "Cost / Usage", (m) => [
        leaf(m, "token-cost", "토큰/비용 확인", ["얼마 썼어?"], ["none"]),
      ]),
    ],
  },
] as const
