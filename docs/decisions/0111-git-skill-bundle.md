# ADR-0111: CTK git-skill bundle (8 system skills, Cursor cursor-team-kit absorption)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **소스 분석**: `docs/analysis/code-agent-loop/cursor-git.md` §⑧ (CTK git 스킬 verbatim catalog)
- **CTK 원본**: `~/.cursor/plugins/cache/cursor-public/cursor-team-kit/*/skills/{babysit,fix-merge-conflicts,get-pr-comments,loop-on-ci,make-pr-easy-to-review,new-branch-and-pr,pr-review-canvas,review-and-ship}/SKILL.md`
- **관련 ADR**: ADR-0099(git-posture-default-fail-closed), ADR-0100(destructive-git-hard-deny), ADR-0101(push-mass-delete-guard), ADR-0104(gh-pr-typed-tools), ADR-0109(moved-code-detector)
- **참조**: `src/skill/system-skills/<name>/{SKILL.md,index.ts}`(8개), `tests/unit/skill-git-bundle.test.ts`(스모크), `tests/unit/ctk-git-skills-hellgate.test.ts`(SKILL.md 본문 hellgate), `tests/unit/ctk-git-skills-router-hellgate.test.ts`(라우터 seam hellgate)

## 맥락

Cursor cursor-team-kit (CTK)는 8개의 **git workflow** 스킬을 SKILL.md prompt-only 형태로 동봉한다. 코드 의존성이 없고(=순수 프롬프트+gh/git 셸 명령) 즉시 흡수 가능 (cursor-git.md §⑧ "★ Tier0 (prompt-only, 즉시)" 평가).

8개 스킬:
| 스킬 | 한 줄 책무 |
|---|---|
| `babysit` | PR을 merge-ready로 유지하는 장기 루프 (CI/리뷰/conflict 반응) |
| `fix-merge-conflicts` | 비대화형 conflict 해결 + build+test 검증 후에야 resolved 선언 |
| `get-pr-comments` | PR 리뷰 코멘트를 file:line 앵커로 ranked action list 생성 |
| `loop-on-ci` | `gh pr checks` SoT로 CI 실패 반복 복구 (최소 패치/반복) |
| `make-pr-easy-to-review` | PR 4-detector 정리 (noisy commits / stale desc / unrelated / mixed mech+logic) |
| `new-branch-and-pr` | 새 변경 → 브랜치 + 커밋 + 푸시 + PR 오픈 end-to-end |
| `pr-review-canvas` | **moved-code 감지** 분류 리뷰 (logic/moved/mechanical/risks 4-section) |
| `review-and-ship` | review + verify + commit + push + PR (combined ship orchestration) |

가장 기깔난 것은 **pr-review-canvas의 moved-code detection**: 일반 `git diff`가 함수 이동을 `delete from A + add to B`로 표시해서 reviewer가 "두 변경"으로 오독하는 문제를 별도 카테고리로 surface하는 패턴 (cursor-git.md "가장 충격적인 단일 발견").

## 결정

CTK 8개 git 스킬을 quanta 시스템 스킬(`src/skill/system-skills/<name>/SKILL.md`)로 흡수한다. 각 스킬은:

1. **본문은 quanta-adapt**, Cursor verbatim copy가 아님. CTK의 워크플로 + 가드레일을 가져오되:
   - quanta 도구 이름 사용 (`git_commit` mode:"regular", `git_branch_switch` 등)
   - quanta verify-workflow 사용 (`bun run typecheck`, `bun test`)
   - quanta HITL/posture 룰 인용 (always-confirm tier, Git posture system prompt)
   - quanta 컨벤션 (브랜치 `quanta/<short>`, PR title `[quanta] <subject>`)
2. **Cursor verbatim은 워딩이 최선일 때만** 보존:
   - babysit의 "intent conflict → abort + ask"
   - loop-on-ci의 "`gh pr checks` is the source of truth"
   - `--no-verify` 금지 verbatim
   - `pr-review-canvas`의 "moved-code is INVISIBLE by default" 분류 원칙
3. **Cursor 출처 cite**: 본문에 `Adapted from Cursor CTK <name> ...` 1줄.
4. **frontmatter 표준화**:
   - `name` (디렉토리와 일치 — 라우터 드리프트 방지)
   - `description` (트리거 발화 포함)
   - `userInvocable: true` + `allowedTools: [Bash, Read, Grep, Edit]` (셸/PR-ops 필수)
   - `category: skill` / `stability: stable`
5. **default-OFF**: 호스트가 명시적으로 invoke하거나 description match 시에만 활성 (skill 슬라이스의 일반 정책).

### 라우터 seam — `<name>/index.ts`

각 스킬 디렉토리에 동반되는 `index.ts`는:
- canonical `<NAME>_SKILL_NAME` 상수 export (SKILL.md frontmatter `name`과 동일, 드리프트 시 router hellgate 실패).
- `trigger<Name>()` — `{ name: "<skill-id>" }` 반환 (slash command 등 외부 라우터 와이어업용 타입 안전한 진입점).
- `find<Name>Skill()` — `discoverSystemSkills()` 결과에서 해당 skill 객체 lookup.

라우터 자체(`slash-commands.ts` 와이어업)는 본 ADR 범위 밖 — index.ts는 옵트인 seam.

## 가드레일 (8 스킬 공통)

| 가드 | 적용 스킬 | 근거 |
|---|---|---|
| `--no-verify` 금지 | babysit, loop-on-ci, new-branch-and-pr, review-and-ship | pre-commit hook 우회 = 정책 무시 |
| `.github/workflows/*` 수정 금지 | babysit, loop-on-ci | "CI 실패를 통과시키려고 CI를 바꾸는 것" 차단 |
| intent conflict → abort + ask | babysit, fix-merge-conflicts, make-pr-easy-to-review, new-branch-and-pr, review-and-ship | 사용자 의도 일탈 자동 진행 금지 |
| build+test 검증 필수 | fix-merge-conflicts, review-and-ship | 컴파일만으로는 resolved/ship-ready 부족 |
| 명시적 사용자 동의 | new-branch-and-pr, review-and-ship | 기본 Git posture가 차단하는 mutation을 수행 |
| `complete` 단어 금지 | 8개 전부 | 각 스킬은 outcome enum (`merged`/`resolved`/`green`/...) 선언, implicit "done" 차단 |

## 트레이드오프

**가져간 것**:
- 8개 즉시 가용한 PR/CI 워크플로 (직접 작성 시 8 × 수일 분량의 SOTA prompt design).
- moved-code 감지처럼 한 번 보면 당연하지만 발견하기 어려운 reviewer 부담 패턴.
- "intent conflict → abort" 같은 명료한 P0 룰 워딩.

**의도적으로 안 가져간 것**:
- CTK의 `disable-model-invocation:true` (Cursor만의 manual-only flag) — quanta는 description 매칭에 노출 (적절한 활성).
- CTK `pr-review-canvas`의 인터랙티브 HTML 렌더러 — quanta는 마크다운 리포트로 단순화 (HTML 렌더링은 surface 의존, 스킬 본문이 할 일 아님).
- CTK의 Slack/Linear 통합 — `gh` CLI만 기본, 다른 PR 시스템은 향후 옵트인.

## 향후 통합

`pr-review-canvas`의 moved-code 감지는 현재 본문이 `git diff --color-moved=zebra` 휴리스틱에 의존한다. ADR-0109(`moved-code-detector`)가 `src/git/moved-code-detector.ts`로 정밀 detector를 ship하는 즉시 `pr-review-canvas`가 그 모듈을 호출하도록 본문을 갱신할 것 (별도 follow-up; 이 ADR 범위는 prompt 흡수까지).

## 테스트

| 테스트 | 책무 |
|---|---|
| `tests/unit/skill-git-bundle.test.ts` (본 ADR) | 스모크 — 8 SKILL.md 존재 + frontmatter 파싱 + name 유일 + dir==name |
| `tests/unit/ctk-git-skills-hellgate.test.ts` | 각 SKILL.md 본문 anchor 구문 + outcome enum + 핵심 가드레일(`--no-verify` / moved-code / "intent conflict") |
| `tests/unit/ctk-git-skills-router-hellgate.test.ts` | 라우터 seam — 8 `index.ts`의 `<NAME>_SKILL_NAME` 상수가 SKILL.md frontmatter와 일치 |

## 결과

- 8 SKILL.md (`src/skill/system-skills/<name>/SKILL.md`).
- 8 router seam (`src/skill/system-skills/<name>/index.ts`).
- 스모크 1개 + hellgate 2개 = 11개 테스트 패스.
- quanta `discoverSystemSkills()`가 자동 등록 (호스트가 활성).
- `disable-model-invocation` 의도적 omit으로 description 매칭 활성화.
