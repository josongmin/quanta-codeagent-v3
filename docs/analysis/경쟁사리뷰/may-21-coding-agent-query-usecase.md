# 2026-05-21 코딩에이전트 Query Use Case 분류표

> **목적**: quanta-codeagent-v3가 실제 사용자 쿼리 use case를 충분히 커버하는지 *나중에* 검증할 때 쓰는 체크리스트. 실증 연구 기반으로 모든 use case를 대/중/소 3단으로 분류했고, 각 항목에 커버리지 verification 칼럼을 비워둠.
>
> **검증 방법(권장)**: 항목별로 (a) 어떤 컴포넌트/모듈이 처리하는지, (b) 통합/단위 테스트가 있는지, (c) runbook/example로 시연 가능한지 채울 것.

---

## 0. 근거 데이터셋

| # | 연구 | 데이터 | 인용 위치 |
|---|---|---|---|
| 1 | **WildChat** (Zhao et al., ICLR 2024) | 1M ChatGPT 대화, 카테고리 분포 | 전체 트래픽 분포 |
| 2 | **Developer-LLM Conversations** (Zhong/Zou/Adams 2025) | 52,086 개발자 대화 (WildChat 부분집합) | turn 구조, 코드 결함률 |
| 3 | **Self-Admitted GenAI Usage** (Hao et al., 2026) | ChatGPT 64-task / Copilot 39-task taxonomy, n=343/281 | 메인 분류 베이스 |
| 4 | **Shared ChatGPT in GitHub PRs/Issues** (Hao et al., 2024) | 580 대화, 16 SE inquiry | PR/Issue 분포 |
| 5 | **Proactive Coding Assistants** (Liu et al., 2026) | 1,246 개발자 / 3일 / 4.63M IDE 이벤트 | Read-mode 비중 |
| 6 | **Cursor Rules** (Wang et al., 2026) | 401 OSS repo, 1,876 .mdc 파일 | persistent context 카테고리 |
| 7 | **Stack Overflow Obsolete?** (Kabir et al., CHI 2024) | ChatGPT 답 품질 분석 | 정성적 시사점 |

전체 분포 상위 카테고리 (Hao 2026 ChatGPT n=343):

| Rank | Root 카테고리 | 비중 |
|---|---|---|
| 1 | Software Quality | **29%** |
| 2 | Feature Implementation | 24% |
| 3 | Learning / Comprehension | 19% |
| 4 | Documentation | 13% |
| 5 | Development Environment | 7% |
| 6 | Process Automation | 6% |
| 7 | Data Generation | 4% |

추가 실측치:
- **Multi-turn 68%** / Single-turn 32% (Zhong 2025)
- **IDE 동작 중 cursor selection 40%, view switching 13%** — read-mode 압도 (Liu 2026)
- LLM 생성 Python 코드의 **83.4%가 undefined variable** 포함 (Zhong 2025)

---

## 1. Use Case 대/중/소 분류표

검증 칼럼: `커버` (OK/PARTIAL/NO/TBD), `담당 컴포넌트`, `검증 수단`.

### 대1. Software Quality (29%)

| 중분류 | 소분류 | 트리거 예시 | 커버 | 담당 컴포넌트 | 검증 수단 |
|---|---|---|---|---|---|
| Debugging | 에러 메시지 paste → 수정 | 스택트레이스 + "고쳐줘" | TBD |  |  |
| Debugging | 재현 코드 작성 | "이 버그 재현 테스트" | TBD |  |  |
| Debugging | 환경별 디버깅 | "CI에서만 실패" | TBD |  |  |
| Debugging | Heisenbug/Flaky 추적 | "가끔 실패" | TBD |  |  |
| Debugging | 로그 분석 | 대량 로그 paste | TBD |  |  |
| Refactoring | Rename | 식별자/파일/모듈 | TBD |  |  |
| Refactoring | Extract function/component | 코드 블록 분리 | TBD |  |  |
| Refactoring | 타입 리팩터링 | any→strict, generic | TBD |  |  |
| Refactoring | 로직 단순화 | nested→flat, DRY | TBD |  |  |
| Refactoring | Pattern 적용 | Strategy/Factory | TBD |  |  |
| Testing | Unit test generation | 함수→테스트 | TBD |  |  |
| Testing | Edge case 추가 | null/empty/huge | TBD |  |  |
| Testing | Mock/fixture 셋업 | 의존성 모킹 | TBD |  |  |
| Testing | Coverage 채우기 | "이 파일 80%" | TBD |  |  |
| Testing | E2E 시나리오 | Playwright/Cypress | TBD |  |  |
| Testing | Qualitative test | LLM 출력 검증 | TBD |  |  |
| Code Review | Diff/PR 전체 리뷰 | "PR 봐줘" | TBD |  |  |
| Code Review | 보안 리뷰 | SQLi/XSS/auth | TBD |  |  |
| Code Review | 성능 리뷰 | 알고리즘/쿼리 | TBD |  |  |
| Code Review | Style/convention | lint 보완 | TBD |  |  |
| Issue Resolution | GitHub 이슈→수정 | 이슈 링크 + "고쳐" | TBD |  |  |
| Issue Resolution | 사용자 보고 버그 | "유저가 X 안된대" | TBD |  |  |

### 대2. Feature Implementation / Enhancement (24%)

| 중분류 | 소분류 | 트리거 예시 | 커버 | 담당 컴포넌트 | 검증 수단 |
|---|---|---|---|---|---|
| New Feature | 명세→구현 | "X 기능 만들어" | TBD |  |  |
| New Feature | Prototyping (MVP) | full project 빌드 | TBD |  |  |
| New Feature | 새 모듈/컴포넌트 | greenfield 생성 | TBD |  |  |
| Feature Enhancement | 기존 기능 확장 | "Y 옵션 추가" | TBD |  |  |
| Feature Enhancement | UX 개선 | "더 직관적으로" | TBD |  |  |
| Feature Enhancement | Behavior tweak | threshold 변경 | TBD |  |  |
| Migration | Language migration | JS→TS, Py2→3 | TBD |  |  |
| Migration | Framework migration | Vue2→3, Pages→App Router | TBD |  |  |
| Migration | API migration | deprecated→신 API | TBD |  |  |
| Migration | Version upgrade | Node 16→20 | TBD |  |  |
| Migration | DB migration | MySQL→Postgres | TBD |  |  |
| Scripting | 자동화 script (NEW) | bash/python 일회용 | TBD |  |  |
| Scripting | 일회성 데이터 처리 | ad-hoc ETL | TBD |  |  |
| Design | 기능 설계 결정 | "어떻게 모델링?" | TBD |  |  |
| Design | Color palette | 디자인 자산 | TBD |  |  |
| Design | API surface 설계 | 인터페이스 형태 | TBD |  |  |

### 대3. Learning / Comprehension (19%)

| 중분류 | 소분류 | 트리거 예시 | 커버 | 담당 컴포넌트 | 검증 수단 |
|---|---|---|---|---|---|
| Library Learning | API 사용법 | "staleTime 의미?" | TBD |  |  |
| Library Learning | Best practice 질문 | "권장 방법?" | TBD |  |  |
| Library Learning | A vs B 비교 | "Drizzle vs Prisma" | TBD |  |  |
| Library Learning | Maintained 여부 | "이거 살아있어?" | TBD |  |  |
| Code Comprehension | 함수 동작 설명 | "이 함수 뭐함?" | TBD |  |  |
| Code Comprehension | 호출처 추적 | "어디서 호출?" | TBD |  |  |
| Code Comprehension | 아키텍처 파악 | "구조 설명" | TBD |  |  |
| Code Comprehension | Onboarding | "어디부터 봐?" | TBD |  |  |
| Brainstorming | 접근법 탐색 | "어떻게 풀까?" | TBD |  |  |
| Brainstorming | Trade-off 논의 | "장단점은?" | TBD |  |  |

### 대4. Documentation (13%)

| 중분류 | 소분류 | 트리거 예시 | 커버 | 담당 컴포넌트 | 검증 수단 |
|---|---|---|---|---|---|
| Code-level | JSDoc / docstring | 함수→doc | TBD |  |  |
| Code-level | 인라인 코멘트 (복잡 패턴) | 정규식/알고리즘 | TBD |  |  |
| Project-level | README | 프로젝트 소개 | TBD |  |  |
| Project-level | User guide | 사용자 매뉴얼 | TBD |  |  |
| Project-level | Architecture doc | 시스템 설명 | TBD |  |  |
| Project-level | Contribution guideline | 기여자용 | TBD |  |  |
| API Doc | OpenAPI / Swagger | spec 작성 | TBD |  |  |
| Release/Process | Release note | 변경 사항 | TBD |  |  |
| Release/Process | Changelog | 버전별 | TBD |  |  |
| Release/Process | Trademark notice | 법적 문구 | TBD |  |  |
| Translation | 문서 번역 | 다국어화 | TBD |  |  |

### 대5. Development Environment (7%)

| 중분류 | 소분류 | 트리거 예시 | 커버 | 담당 컴포넌트 | 검증 수단 |
|---|---|---|---|---|---|
| CI/CD | GH Actions workflow | yml 작성 | TBD |  |  |
| CI/CD | 코드리뷰 자동화 | bot 통합 | TBD |  |  |
| CI/CD | Custom job/action | 재사용 action | TBD |  |  |
| Container | Dockerfile 생성 | 멀티스테이지 | TBD |  |  |
| Container | Compose / k8s manifest | 오케스트레이션 | TBD |  |  |
| Build/Bundler | webpack/vite 설정 | bundle config | TBD |  |  |
| Build/Bundler | tsconfig | TS 컴파일 옵션 | TBD |  |  |
| Infra-as-Code | Terraform | 클라우드 리소스 | TBD |  |  |
| Infra-as-Code | Helm chart | k8s 패키징 | TBD |  |  |
| Lint/Format | eslint/biome/ruff | 룰 정의 | TBD |  |  |

### 대6. Process Automation (Copilot 압도적: 28K PR desc, 1.2K commit msg)

| 중분류 | 소분류 | 트리거 예시 | 커버 | 담당 컴포넌트 | 검증 수단 |
|---|---|---|---|---|---|
| PR 관리 | PR description 자동 생성 | diff→요약 | TBD |  |  |
| PR 관리 | PR 리뷰 코멘트 | 자동 리뷰 | TBD |  |  |
| PR 관리 | PR title 작성 | 컨벤셔널 prefix | TBD |  |  |
| Commit 관리 | Commit message 생성 | staged→msg | TBD |  |  |
| Commit 관리 | Conventional commit | feat/fix/chore | TBD |  |  |
| Issue 관리 | Issue description 생성 | 템플릿 채우기 | TBD |  |  |
| Issue 관리 | Release planning | 마일스톤 정리 | TBD |  |  |
| Issue 관리 | Issue triage | 라벨/우선순위 | TBD |  |  |

### 대7. Data Generation / Manipulation (4%)

| 중분류 | 소분류 | 트리거 예시 | 커버 | 담당 컴포넌트 | 검증 수단 |
|---|---|---|---|---|---|
| Prompt Generation | LLM 프롬프트 작성 | 메타 프롬프트 | TBD |  |  |
| UI String | 다국어 i18n | 키-값 생성 | TBD |  |  |
| Test Fixture | Mock data | seed/factory | TBD |  |  |
| Doc Translation | README 번역 | 영↔한 | TBD |  |  |
| Format Conversion | JSON↔YAML↔CSV | 데이터 변환 | TBD |  |  |

### 대8. Read-mode / Navigation (IDE 실측 40%+ — 학술 분류 누락)

| 중분류 | 소분류 | 트리거 예시 | 커버 | 담당 컴포넌트 | 검증 수단 |
|---|---|---|---|---|---|
| Code Reading | 파일 열람 / 일부 보기 | "X 파일 보여줘" | TBD |  |  |
| Code Reading | Symbol 정의 점프 | go-to-definition | TBD |  |  |
| Code Reading | 호출 그래프 추적 | find references | TBD |  |  |
| Code Search | Grep / find | 키워드 검색 | TBD |  |  |
| Code Search | 의미 기반 검색 | "auth 처리하는 곳" | TBD |  |  |
| Navigation | View switching | 파일 전환 컨텍스트 | TBD |  |  |
| Navigation | Workspace 탐색 | tree view | TBD |  |  |

### 대9. Q&A / How-to (PR 13% / Issue 22%)

| 중분류 | 소분류 | 트리거 예시 | 커버 | 담당 컴포넌트 | 검증 수단 |
|---|---|---|---|---|---|
| Conceptual Question | 개념 설명 요청 | "CQRS가 뭐야?" | TBD |  |  |
| Conceptual Question | 용어 정의 | "idempotent 의미?" | TBD |  |  |
| How-to Guidance | 단계별 가이드 | "X 설정 방법?" | TBD |  |  |
| How-to Guidance | Recipe | "흔한 패턴은?" | TBD |  |  |
| Comparison | A vs B 선택 | "어떤 게 나아?" | TBD |  |  |
| Comparison | Trade-off 분석 | 장단점 | TBD |  |  |

### 대10. Persistent Context Management (Cursor Rules 연구)

| 중분류 | 소분류 | 트리거 예시 | 커버 | 담당 컴포넌트 | 검증 수단 |
|---|---|---|---|---|---|
| Conventions | 코딩 컨벤션 정의 | naming, file layout | TBD |  |  |
| Conventions | Style 규칙 | import 순서 | TBD |  |  |
| Guidelines | 작업 지침 | "테스트 먼저" | TBD |  |  |
| Guidelines | Workflow 규칙 | "main 직접 푸시 금지" | TBD |  |  |
| Project Information | 프로젝트 컨텍스트 | 도메인/용어집 | TBD |  |  |
| Project Information | Environment | 런타임/버전 | TBD |  |  |
| Project Information | Change history | 최근 변경 | TBD |  |  |
| LLM Directives | 모델 직접 지시 | "한국어로 답해" | TBD |  |  |
| LLM Directives | Output format 강제 | "코드만, 설명 X" | TBD |  |  |
| Conversation State | 멀티턴 thread grounding | ""이제 다 됐냐?"", ""그거 다시 돌려봐"", ""여기서 말하는 그거 뭐였지?"" | TBD |  |  |
| Examples | Few-shot 예시 | 입출력 샘플 | TBD |  |  |

### 대11. Operational / DevOps (학술 분류 약함, 실무 큼)

| 중분류 | 소분류 | 트리거 예시 | 커버 | 담당 컴포넌트 | 검증 수단 |
|---|---|---|---|---|---|
| Deploy | 배포 명령 | "prod에 올려" | TBD |  |  |
| Deploy | Rollback | "이전 버전으로" | TBD |  |  |
| Incident Response | 5xx 폭발 대응 | "prod 죽음" | TBD |  |  |
| Incident Response | 로그 조회 | 실시간 분석 | TBD |  |  |
| Monitoring | Alert 설정 | threshold | TBD |  |  |
| Monitoring | Dashboard | 메트릭 시각화 | TBD |  |  |
| DB Operation | Migration 실행 | "마이그 돌려" | TBD |  |  |
| DB Operation | 쿼리 튜닝 | slow query 분석 | TBD |  |  |

### 대12. Meta / Agent Management (도구 자체 관리)

| 중분류 | 소분류 | 트리거 예시 | 커버 | 담당 컴포넌트 | 검증 수단 |
|---|---|---|---|---|---|
| Capability | 도구 능력 확인 | "이거 할 수 있어?" | TBD |  |  |
| Permission | 권한 확인/설정 | "이 폴더 접근?" | TBD |  |  |
| Memory | 기억 저장/회수 | "기억해", "잊어" | TBD |  |  |
| Session | 세션 재개 / 분기 | "아까 거 다시" | TBD |  |  |
| Configuration | 설정/hooks/MCP | settings.json 편집 | TBD |  |  |
| Cost/Usage | 토큰/비용 확인 | "얼마 썼어?" | TBD |  |  |

---

## 2. 직교 축 (대분류와 독립적으로 적용)

각 축의 모든 값을 시스템이 처리할 수 있어야 함.

| 축 | 값 | 커버 검증 포인트 |
|---|---|---|
| **Scope** | inline / function / file / module / project-wide / cross-repo | 큰 scope에서 컨텍스트 손실/타임아웃 안 나는지 |
| **Turn 구조** | single-turn 32% / multi-turn 68% | 멀티턴 컨텍스트 유지 + 사용자 정정 반영 |
| **Specificity** | hyper-specific / specific / underspecified / exploratory | underspecified 시 역질문 or 합리적 추정 |
| **Context input** | none / paste / @file / selection / error / log / image / URL | 각 입력 형태별 파싱/렌더링 |
| **Trust level** | read-only / local edit / shell / network / destructive / external side-effect | 위험 동작 confirmation 동작 |
| **Time scale** | instant(<10s) / short(<2m) / medium(<30m) / long(<수시간) / autonomous(시간-일) | 장기 실행 cancellation/resume |

---

## 3. Tool별 가중치 차이 (실증)

| 카테고리 | ChatGPT | Copilot | quanta-v3 목표 위치 |
|---|---|---|---|
| Software Quality | 29% | 2위 | TBD |
| Feature Implementation | 24% | 1위 (inline) | TBD |
| **Learning** | **19%** | **2%** | TBD (대화형 강점?) |
| Documentation | 13% | 중간 | TBD |
| **Process Automation** | 6% | **압도적** | TBD (PR/commit msg?) |
| Language Migration | 8건 | **0건** | TBD |

---

## 4. 시간에 따른 카테고리 변화 (Hao 2024 → 2026)

| 카테고리 | 변화 | 시사점 |
|---|---|---|
| Debugging | **+3.5×** | 디버그 UX는 차별점 |
| Learning | +53% | 학습형 사용 증가 |
| Scripting | NEW | 일회성 자동화 needs |
| Brainstorming | NEW | 설계 단계 지원 |
| Refactoring | **−70%** | 킬러 기능에서 후퇴 |
| Code review | 감소 |  |
| Code comment | 감소 |  |

---

## 5. 추가 정성적 시사점

1. **LLM 코드 결함률 80%+** (Python undef var 83.4%) — 검증/실행 루프 필수
2. **"AI 코드 디버깅이 더 오래 걸린다" 45%** — debug UX가 도구 신뢰의 핵심
3. **IDE 실측: cursor selection 40%** — read/navigation이 dominant. 코딩에이전트는 generation만 보면 안 됨
4. **Multi-turn 68%** — 사용자 정정 + 후속 fix가 가장 흔함 → "Prompts that point out mistakes... and explicitly request a fix are most effective" (Zhong et al.)

---

## 6. 검증 시 사용법

이 문서를 *체크리스트*로 쓸 때:

1. 각 소분류 행의 `커버` 칼럼을 채운다 (OK 완전 / PARTIAL 부분 / NO 없음 / TBD 미검증)
2. `담당 컴포넌트`에 코드 경로 (e.g. `src/agent/loop.ts:42`) 적는다
3. `검증 수단`에 다음 중 하나 이상:
   - `tests/...` 경로 (단위/통합 테스트)
   - `docs/runbooks/...` 경로 (시연 시나리오)
   - `examples/...` (사용 예제)
   - `manual` (수동 검증만 됨)
4. 모든 행이 OK 또는 의식적으로 "scope out (NO)" 결정될 때까지 반복

검증 라운드 결과는 같은 `docs/analysis/` 디렉토리에 `MM-DD-coverage-check.md`로 별도 저장 권장.

---

## 7. 출처 링크

- WildChat: https://arxiv.org/html/2405.01470v1
- Developer-LLM Conversations: https://arxiv.org/abs/2509.10402
- Self-Admitted GenAI Usage: https://arxiv.org/html/2603.26277v1
- Shared ChatGPT in GitHub: https://arxiv.org/html/2403.10468
- Proactive Coding Assistants: https://arxiv.org/html/2605.05700
- Cursor Rules: https://arxiv.org/abs/2512.18925
- Is Stack Overflow Obsolete? (CHI 2024): https://arxiv.org/html/2308.02312v4
