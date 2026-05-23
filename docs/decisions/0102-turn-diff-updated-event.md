# ADR-0102: `turn_diff_updated` stream event + emitter (Codex `turn/diff/updated` 흡수 + CTK 8 skills 같은 batch)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**: ADR-0098(repo-rules tree), ADR-0099/0100/0101(git posture cluster), ADR-0048(in_progress event 비교 paradigm)
- **참조**: `src/stream/types.ts`(AgentEvent 확장), `src/agent/turn-diff/index.ts`(emitter 모듈), `src/stream/adapters/jsonl-recorder.ts`/`stdout.ts`(소비자), `src/skill/system-skills/{babysit,fix-merge-conflicts,...}/SKILL.md`(8 CTK skills), `tests/unit/turn-diff-emitter-hellgate.test.ts`(14 적대), `tests/unit/ctk-git-skills-hellgate.test.ts`(7)

## 맥락

Codex Desktop은 turn 종료 시 `turn/diff/updated` 이벤트로 turn 전체 누적 unified diff을 emit한다 — UI / replay / session jsonl recorder가 assistant 텍스트를 파싱할 필요 없이 "이번 턴이 만진 모양"을 본다.

quanta는 turn-end에 closeout-guard reminder만 — 구조화된 turn-diff 채널 부재.

또한 본 batch에서 Cursor CTK 8 git skills(babysit/fix-merge-conflicts/get-pr-comments/loop-on-ci/make-pr-easy-to-review/new-branch-and-pr/pr-review-canvas/review-and-ship) 흡수.

## 결정

### Part A — `turn_diff_updated` AgentEvent 확장

`AgentEvent` 닫힌 union에 신규 variant:
```
{ type: "turn_diff_updated"; turn: number; fromSha: string; toSha: string;
  filesChanged: number; insertions: number; deletions: number;
  unifiedDiff: string }
```

### Part B — emitter 모듈 `src/agent/turn-diff/`

closed-port + default-OFF 디자인 — `GitRunner` 주입, 미주입 시 no-op.

- `captureTurnStart(runner, cwd)` → 턴 시작 시 HEAD SHA 스냅샷. not-a-repo / empty-repo / spawn-error 모두 null collapse.
- `computeTurnDiff({runner, cwd, fromSha, maxUnifiedBytes?})` → 턴 종료 시 diff 페이로드. `git diff <fromSha>` (working tree까지 포함) + `--shortstat`. 64KiB default cap, 4MiB hard ceiling, 빈 변경 시 null.
- `buildTurnDiffEvent(turn, payload)` → pure event composer.

### Part C — 소비자

`stream/types.ts` 닫힌 union 확장 시 `jsonl-recorder.ts` KIND_MAP + dataOf, `stdout.ts` switch 모두 exhaustive switch라 컴파일러가 강제(closed-union contract). 두 adapter에 핸들러 추가.

### Part D — CTK 8 git skills

`src/skill/system-skills/<name>/SKILL.md` 8개 신규(`discoverSystemSkills()` 자동 픽업, slash-router wiring은 follow-up). 각 SKILL은 P0 룰 + 절차 + outcome enum(success/partial/blocked/...) — `complete` 금지어.

특히 **pr-review-canvas** = moved-code detection의 청사진(`color-moved=zebra` + 분류 4 카테고리: logic/moved/mechanical/risks).

## 결과

- 14 turn-diff hellgate 통과(spawn-error / 빈 diff / 100KB 트렁케이션 / 무효 budget / signal 전달).
- 7 CTK skills hellgate 통과(discoverable / anchor phrases / outcome enum / `--no-verify` 금지 / moved-code 키워드).
- stream/types.ts AgentEvent union exhaustive switch 봉합 → recorder + stdout 자동 컴파일 강제.

## 한계

- loop 통합은 **opt-in seam** 노출 단계까지(`buildTurnDiffEvent` + `captureTurnStart` API). 실제 loop emit wiring은 follow-up(`agent/loop.ts` M state라 본 batch에서 회피).
- CTK skills는 prompt-only — 실제 `gh` 호출이 동작하려면 ADR-0103/0104 도구 + 사용자 인증 필요.
- moved-code detection 알고리즘 자체는 skill 안내문 — 구체 detector 구현은 follow-up.
