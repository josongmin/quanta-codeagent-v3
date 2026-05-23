# ADR-0101: Push mass-delete guard 3룰 (Claude Desktop `push_refused_mass_delete` 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**: ADR-0100(destructive git 6룰), ADR-0099(prompt 단 ban)
- **참조**: `src/permission/policy-rules.ts`(3 신규 룰), `tests/unit/permission-rules.fixtures.ts`(3 신규 fixture)

## 맥락

Claude Desktop 1.7196의 cowork memory sync 22 이벤트 중 `push_refused_mass_delete` — 대량 ref 삭제를 푸시하려 할 때 거부하는 가드. 우리는 cowork memory가 없지만, dispatch-seam pre-tool 정적 검사로 동등.

기존 ADR-0100 `git-push-force`가 `--force` 자체는 차단하지만, **mass-delete의 다른 변종**들이 비커버:
- `git push --mirror` — local 상태를 그대로 remote에 mirror(local에서 지운 모든 ref가 remote에서도 사라짐)
- `git push --force --delete <remote> <branch>` — force + delete combo (force-delete remote ref)
- `git push origin :a :b :c …` — 다중 colon-refspec delete (≥3개)

## 결정

`HARD_DENY_RULES`에 3개 추가:

1. **git-push-mirror**: `\bpush\b...--mirror\b`
2. **git-push-force-with-delete**: lookahead 2개로 `--force`(또는 `-f`/`--force-with-lease`) AND `--delete`(또는 `-d`) 둘 다 존재 시 매치. 순서 무관.
3. **git-push-multi-branch-delete**: `\bpush\b(...\s:<refname>){3,}` — 3개 이상의 colon-prefixed refspec(branch delete syntax)

단일 `git push --delete <remote> <branch>`는 HITL `always-confirm` 티어에서 그대로(routine cleanup 가능). `:branch` 2개까지도 HITL.

## 결과

- 룰 검증: 245 permission-rules.test.ts 통과(ADR-0100 23 + 본 ADR 11 신규 = 34 신규).
- mass-delete 시나리오 한정 — 단일 delete는 HITL가 처리(과도 차단 회피).

## 한계

- refspec 파싱은 정규식 — 3개 미만 colon-refspec은 catastrophic 아니라 가정. 실 운영에서 1-2개도 사고면 임계 조정.
- `git push --prune` (Codex 등에서 가끔 등장) — 미매치. mirror의 sub-feature지만 다른 모양. 발견되면 4번째 룰로 확장.
