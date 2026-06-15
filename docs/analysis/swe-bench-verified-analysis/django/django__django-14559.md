---
instance_id: django__django-14559
repo: django/django
base_commit: d79be3ed39b76d3e34431873eec16f6dd354ab17
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-06-26T05:38:46Z
fail_to_pass: 3
pass_to_pass: 23
gold_files: [django/db/models/query.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-14559

## 문제 요약
`QuerySet.bulk_update()`는 항상 `None`을 반환하지만, 일반 `update()`는 매칭된 행 수(int)를 반환한다. 이슈는 두 API의 반환 계약 불일치를 지적하고, `bulk_update()`가 내부적으로 배치마다 `update()`를 반복 호출하므로 그 반환값들을 합산해 갱신 행 수를 돌려주기를 요구한다. 증상은 "반환값 누락(`None`)", 기대는 "갱신된 행 수(int) 반환". 이슈 본문과 코멘트 스레드에서 GitHub 퍼머링크로 정확한 라인(L568)까지 지목한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement가 파일(`django/db/models/query.py`)·함수(`bulk_update()`)·라인(L568)을 직접 지목하고, "단순히 `update()`를 반복 호출하니 반환값을 더해 돌려주면 된다"고 픽스 위치까지 적어준다. grep 한 방. cross-module 추적 불필요.
- **S (Repair Strategy) = S1 Direct-Map (+S2 Constraint-Reasoning)**: dominant는 S1. 정형 결함클래스 "drop된 반환값 누산"에 템플릿 매칭 — early-return을 `return 0`으로, 루프 앞에 누산기 `rows_updated = 0`, 루프 안에서 `+=`, 끝에 `return rows_updated`. 기계적 변형이라 S1. 보조로 S2가 붙는 이유는 **중복(duplicates) 엣지케이스의 올바른 의미론을 추론으로 결정**해야 하기 때문 — "정확한 distinct 행 수"가 아니라 "단순 합산(배치 분할 시 중복 계수)"이 의도된 계약임을 hints/티켓 논의에서 합성해야 한다. 더 시도하는 게 아니라 불변식(배치 단위 update 합)을 따져 푸는 것이라 S2.
- **K (Knowledge) = K-Domain**: 일반 파이썬 추론만으로는 빈 objs early-return 경로·`transaction.atomic` 배치 루프·`update()`가 영향 행 수(int)를 반환한다는 ORM 계약을 알기 어렵다. django QuerySet 내부 동작(배치 분할, atomic 트랜잭션, pk__in 필터 update의 반환 의미)에 대한 프레임워크 지식이 필요. 다만 hint에서 `returning` 시그니처 미래대응을 "하지 않는다"는 결정까지 주어져 K-API 부담은 낮다.
- **Primary type = T-DirectMap**: 위치가 L0로 자명하고 픽스가 "누락된 반환값 누산"이라는 기계적 S1 변형이 본질. 진짜 난점이 localize(T-DiffuseLoc)도, 스펙 재구성(T-SpecInference)도, 구조 변경(T-DesignRefactor)도 아니다. 도메인 지식은 필요하지만 병목이 아니라 보조라 T-DomainBound이 아닌 T-DirectMap.

## 난이도 티어
**Tier = T2 (쉬움)**. 공식 difficulty 라벨은 `15 min - 1 hour`(개발자 구현시간 기준, T3에 가까운 prior)인데, 에이전트 난이도 관점에서는 한 단계 낮춰 T2로 본다.
- 이 티어로 미는 구조적 피처:
  - **1파일·1함수·~6줄** 수정(`gold_files = [django/db/models/query.py]`, 단일 헌크 클러스터). ICLR 컷의 "1파일·소규모" 구간(≈48% solve)에 명확히 든다.
  - **L0 직접 포인터** + **has-repro 성격**: 이슈가 픽스 방법(반환값 합산)과 정확한 라인을 거의 적어준다 — 가장 강한 easiness 신호.
  - **S1 기계적 픽스**: 누산기 패턴은 정형 결함클래스라 후보 패치 발산이 적다.
- 공식 라벨보다 낮춘 이유: 공식 시간은 "duplicates 엣지케이스를 어떻게 처리할지 고민"하는 사람 시간을 반영하지만, 오라클 관점에서 정답은 "고민하지 말고 단순 합산"이라 실제 코드 변경량·추론량은 작다.
- T2에 머무르고 T1로 더 낮추지 않는 이유: **regression-trap**(PASS_TO_PASS 23개의 인접 bulk_update 동작을 깨지 말아야 함)과 **S2 보조 추론**(중복 계수가 버그가 아니라 계약임을 깨달아야 함)이 있어 순수 T1(이슈가 픽스를 거의 그대로 적어주고 엣지 없음)은 아니다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/query.py` : `QuerySet.bulk_update()` (단일 함수, 두 헌크).
- **근본 원인**: `bulk_update()`가 `transaction.atomic` 루프 안에서 `self.filter(pk__in=pks).update(**update_kwargs)`를 호출하면서 각 호출의 반환값(영향 행 수 int)을 **버리고**, 명시적 `return`도 없어 항상 `None`을 반환한다. 빈 objs early-return 경로(`if not objs: return`)도 `None`을 반환한다.
- **수정 요지**:
  1. 빈 objs early-return을 `return` → `return 0`으로 변경 (갱신 없음 = 0행).
  2. 배치 루프 진입 직전에 누산기 `rows_updated = 0` 도입.
  3. 루프 본문을 `self.filter(pk__in=pks).update(**update_kwargs)` → `rows_updated += self.filter(pk__in=pks).update(**update_kwargs)`로 변경 (각 배치 update의 반환 행 수 합산).
  4. 메서드 끝에서 `return rows_updated`.
  - **의도적 비대응**: objs 내 중복 처리(future-proofing, `returning` named-tuple)는 하지 않는다. 같은 배치 내 중복은 동일 pk라 1로, 다른 배치로 분리된 중복은 각 배치가 같은 행을 갱신해 중복 계수된다 — 설계상 단순 합산을 그대로 둔다. `bulk_update.alters_data = True` 마커는 불변.

## 검증 (test_patch)
- **FAIL_TO_PASS (3개)**:
  - `test_empty_objects`: `bulk_update([], ['note'])`가 `assertNumQueries(0)`(쿼리 0개)를 유지하면서 `rows_updated == 0`을 반환하는지. early-return을 `return 0`으로 바꾼 것을 고정.
  - `test_large_batch`: 2000개 Note를 `bulk_update` 후 반환값 `== 2000`. 다중 배치에 걸친 누산 정확성 증명.
  - `test_updated_rows_when_passing_duplicates`: 동일 객체 두 번 → 단일 배치에서는 `1`(같은 pk 한 번 갱신), `batch_size=1`로 쪼개면 `2`(두 배치가 같은 행을 각각 갱신). **단순 합산 계약을 명시적으로 박아둠**.
- **픽스 증명**: 재현 입력(빈/대량/중복 리스트)을 넘기고 반환 int를 직접 단언. duplicates 테스트가 "1 또는 2가 배치 분할에 따라 달라지는 것이 버그가 아니라 합의된 동작"임을 코드로 고정해 미래의 dedup 시도를 차단한다.
- **overfit 관점**: FAIL_TO_PASS가 빈/대량/중복 세 경계를 모두 커버해 special-case 패치(예: 항상 `len(objs)` 반환)로는 통과 불가 — duplicates의 `batch_size=1 → 2` 기대가 `len` 단축을 깬다. overfit 위험은 낮은 편이라 플래그에 `overfit-risk`를 달지 않았다.
- **regression 관점**: PASS_TO_PASS 23개가 기존 bulk_update 동작(batch_size/foreign_keys/functions/multiple_fields/null/inherited/json 등)을 회귀 가드한다. 반환값 추가는 부수효과(실제 update 수행)에 영향을 주면 안 되므로 `regression-trap` 플래그 부여.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `django/db/models/query.py` L568과 함수명 `bulk_update`를 직접 명시 → grep `def bulk_update` 한 방으로 함수 본문 도착. 추가 탐색 불필요(L0).
2. **픽스와 일반화 근거**: `update()`가 영향 행 수 int를 반환한다는 ORM 계약을 활용해, 배치 루프의 각 `update()` 반환값을 누산기에 더하고 `return`한다. 빈 objs 경로는 "갱신 0건"이라 `return 0`. 이게 올바른 일반화인 이유 — `update()`의 반환 의미(매칭 행 수)를 배치 합으로 자연 확장한 것이고, 배치 수·크기에 독립적으로 "이번 호출이 발행한 update들이 매칭한 총 행 수"라는 단일 불변식을 만족하기 때문. 임의 상수(`len(objs)`)나 distinct pk 카운트가 아니라 실제 DB 반환 합이라 모든 입력에 대해 성립.
3. **regression 안전**: PASS_TO_PASS 23개 — 반환값을 추가하되 `transaction.atomic`·배치 분할·`update_kwargs` 구성·`alters_data` 마커는 절대 건드리지 않아야 한다. 누산은 반드시 atomic 루프 **내부**에서 `+=`로 해야 부분 실패 시 의미가 유지되고, 루프 밖 초기화/반환 위치를 흐트러뜨리면 기존 update 부수효과 테스트가 깨진다.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 두 지점 — (a) 빈 objs early-return을 `return`(=None) 그대로 두면 `test_empty_objects`의 `== 0` 단언 실패. (b) hints의 "duplicates split between batches will be counted twice" 경고를 보고 "정확성"을 위해 dedup/distinct 카운트를 구현하면 `test_updated_rows_when_passing_duplicates`의 `batch_size=1 → 2` 기대와 충돌. 회피법: 티켓 논의 결론("단순 합산이면 충분, future-proofing/duplicate 처리 안 함")을 따라 **가장 단순한 누산**만 구현. 중복 계수는 버그가 아니라 의도된 계약이다.
