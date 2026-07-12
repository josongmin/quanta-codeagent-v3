# 06 — edit 실패 계측 + 근본원인 + fresh-hash root-fix (구현 완료)

2026-07-13. `03-hashline-remap-selfcorrect.md`의 measure-first 게이트를 실제로 당겨본 결과다.
03의 E1(stale-path remap hint) keystone 가정이 **계측으로 뒤집혔고**, 더 싼 root-fix를 구현·검증했다.
03은 조사기록(SSOT는 00)이라 이 문서가 우선순위/설계를 갱신한다.

## 1. 계측 (measure-first 실행)

소스: `~/Library/quanta-codeagent-v3/bench/full-remote/trajectories` (실 SWE-bench 런).
⚠️ **함정**: 카세트라 매 request가 전체 대화 히스토리 포함 → 실패 1건이 이후 모든 턴에 재등장하며 N배 뻥튀기.
고유 이벤트로 dedupe 필수 (우리 메모리의 trajectory 이중카운트 함정). stale_precondition은 `sha256 X != expected Y` 해시쌍이 유니크.

| 인스턴스 | 고유 edit 호출 | stale_precondition (dedup) | not_found |
|---|---|---|---|
| i-01be5cf7dd3101d06 | 13 | 5 (38%) | 0 |
| i-02a064be4d8c02b34 | 4 | 2 (50%) | 0 |
| **합계** | **17** | **7 (41%)** | **0** |

raw echo 171 → dedup 7. **stale_precondition = edit의 41%, not_found = 0.**
한계: n=2, 둘 다 django-14315, 실패가 postgresql/client.py에 집중 → 절대 비율 일반화 불가.
하지만 구조적 원인은 task 무관하게 재현(아래).

## 2. 근본원인 — 03의 E1/E2는 증상 치료였다

**성공한 edit이 새 hash를 안 돌려준다** (index.ts 성공 리턴 = `{before, next, message}`, hash 없음).
트라젝토리 스모킹건: `postgresql/client.py`가 4개의 서로 다른 현재-hash로 4연속 stale —
= **자기유발 staleness.** 모델이 같은 파일에 연속 edit할 때 첫 edit이 파일을 바꾸면
다음 edit의 `expected_hash`(이전 read 시점)가 자동 stale → 매 edit마다 재read 강요.
41%의 정체가 이것. `not_found`는 0이라 03이 내가 제안했던 "E2 keystone"도 반증됨.

## 3. 구현한 fix (root-fix, gated) — LANDED

**성공한 edit이 post-edit 바이트의 sha256을 output에 첨부** → 모델이 재read 없이 다음 same-file edit의
`expected_hash`로 재사용. `planned.next`가 이미 메모리에 있어 추가 read 0.

- gate: `QUANTA_EDIT_FRESH_HASH` (strict opt-in, default-OFF, `ctx.editFreshHash`).
  `QUANTA_EDIT_AUTO_FUZZY`의 8-site 배선을 그대로 미러링(재발명 0):
  `tool/types.ts`(ToolContext field + EditToolContext Pick) · `runtime-config.ts`(gateOnStrict) ·
  `runtime-config/types-extra.ts`(type) · `runtime-config-knobs/knobs-a.ts`(catalog) ·
  `agent/dispatch/tool-context.ts`(seam) · `tool/edit/index.ts`(behavior).
- OFF ⇒ 성공 output **byte-identical** legacy.
- 토큰 비용: 실패경로 아님 — 성공 output에 한 줄(+~40 tokens) 추가지만, **재read 1회(파일 크기 비례)를 제거**하므로 연속 edit에서 net-negative.

### 회귀 테스트 — `tests/unit/edit-fresh-hash-hellgate.test.ts` (4 test, red-on-injection 실증)
1. OFF byte-identical (게이트 제거 시 RED — 주입 검증됨).
2. ON = sha256(post-edit) advertise, red-on-injection `not.toBe(sha256(before))` (before로 계산 시 RED — 주입 검증됨).
3. advertised hash == 실제 on-disk 바이트 digest.
4. **E2E root-fix**: advertised hash를 다음 same-file edit의 expected_hash로 → 성공(stale 없음).
5. **paired control**: read-time(pre-edit) hash 재사용 → stale_precondition (버그 실재 + fix가 원인임 증명).

검증: 4/4 pass, edit 스위트 47/47, typecheck src pass. red-on-injection 2종 주입→RED 확인 후 원복.
(무관 선존 RED: `with-temperature.test.ts` 타입에러 + raw-process.env ratchet 55>51 — 둘 다 동시세션 것, 내 diff는 raw read 0 추가.)

## 4. 갱신된 우선순위 (03 대체)

1. **fresh-hash root-fix = 진짜 keystone** (구현 완료). 자기유발 staleness 제거.
2. **03의 E1(localized remap hint) = secondary.** fresh-hash가 자기유발분을 없앤 뒤 남는
   잔여(bash/외부가 바꾼 진짜 stale)만 커버 → 그때 효능 재측정. 지금 짓지 말 것.
3. **03의 E2(not_found enrich) = 보류.** 이 데이터선 0. 빈도 데이터 나오면 재검토.

## 5. 남은 것

- **효능 A/B**: fresh-hash ON/OFF로 re-read-count / tokens-per-successful-edit 측정 (bench 박스).
  n=2 로컬로는 41%를 확정 못 함 — 박스 트라젝토리로 표본 키워 비율 확정 + fix 효능 측정.
- flat이면 03의 measure-first 원칙대로 gate 삭제. 단 root-fix 성격상 재read 제거는 자명한 net-positive라 flat 가능성 낮음.
