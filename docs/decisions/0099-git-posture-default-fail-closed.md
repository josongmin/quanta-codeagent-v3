# ADR-0099: Git posture — default fail-closed (Codex §18.2/§18.4/§18.5 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**: ADR-0100(destructive git HARD_DENY 6룰, 런타임 backstop), ADR-0101(push mass-delete 3룰), ADR-0098(repo-rules tree scoping, 같은 batch)
- **참조**: `src/agent/prompt.ts`(신규 섹션), `tests/unit/git-posture-prompt-hellgate.test.ts`(11 anchor 적대)

## 맥락

기존 system prompt에 git 관련 정책 명시가 없었다. always-confirm HITL 티어가 push/commit/branch_switch를 게이팅했지만 — 모델이 PROMPT 단에서 "이건 위험" 신호를 받지 못해, 정상적인 task에서 자유롭게 commit/push를 시도하다 confirm 페이로드를 매번 보게 됐다.

Codex §18.2: "Do not git commit unless explicitly requested" + "NEVER use git" — git이 1급 도구지만 default 비활성.
Codex §18.4: 강한 가드레일 verbatim — `reset --hard`, `checkout -- `, `commit --amend`, `rebase -i`, `push --force`, `clean -fd`.
Codex §18.5: naming convention(branch `<prefix>/<desc>`, PR title prefix).

## 결정

system prompt 새 섹션 `Git posture (default fail-closed — Codex §18.2/§18.4/§18.5 absorption)`:

1. **Default-NO mutation**: commit/push/branch/merge/rebase/cherry-pick/reset/restore/checkout(mutating)/stash/tag = explicit request 없으면 금지. read-only 검사(status/log/diff/blame/show/grep/ls-files)는 자유.
2. **destructive verbatim ban**: `reset --hard`, `checkout -- <path>`, `checkout .`, `commit --amend`, `push --force(-with-lease)`, `rebase -i`, `rebase --abort`, `clean -fd` — verbatim 사용자 요청 없으면 금지. `--no-verify` 금지(hook fail 시 원인 fix). interactive `-i` 금지(hang).
3. **unrelated revert 금지**: `git status`에 사용자 in-flight 변경 보이면 건드리지 않음.
4. **naming convention**: branch `quanta/<short-desc>`, commit terse imperative, PR title `[quanta] <short-desc>`. AGENTS.md/CLAUDE.md 재정의 우선.

## 결과

- 11 hellgate anchor — 5 destructive verbatim + Default-NO 문구 + `--no-verify` + naming convention 전부 매치.
- 런타임 backstop(ADR-0100/0101) 없이도 모델이 prompt 단에서 가드.

## 한계

- prompt 텍스트만으로는 모델 일탈 시 차단 불가 — ADR-0100/0101 HARD_DENY가 런타임 backstop.
- 한국어/영어 키워드만 매치 — 다른 언어 "save your work" 동의어는 미커버.
