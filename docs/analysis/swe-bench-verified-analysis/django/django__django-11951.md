---
instance_id: django__django-11951
repo: django/django
base_commit: 312049091288dbba2299de8d07ea3e3311ed7238
version: 3.1
difficulty: <15 min fix
created_at: 2019-10-21T09:35:46Z
fail_to_pass: 1
pass_to_pass: 21
gold_files: [django/db/models/query.py]
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [regression-trap, overfit-risk]
---

# django__django-11951

## 문제 요약
`bulk_create(objs, batch_size=...)`에서 사용자가 명시한 `batch_size`가 DB 백엔드가 허용하는 최대 배치 크기(`ops.bulk_batch_size(fields, objs)`) 계산을 무조건 덮어쓴다. 기존 식 `batch_size = (batch_size or max(ops.bulk_batch_size(fields, objs), 1))`는 `batch_size`가 truthy이면 백엔드 한도를 아예 무시하고 사용자 값을 그대로 쓴다. 그 결과 사용자가 백엔드 한도보다 큰 `batch_size`를 주면 한 INSERT에 너무 많은 파라미터/행이 묶여 백엔드 제약(예: SQLite 변수 한도)을 위반할 수 있다. 기대 동작은 `bulk_update`(같은 파일 L504)처럼 사용자 값과 백엔드 최대값 중 **작은 쪽**을 쓰는 것이다. 이슈 본문이 정답 스니펫(`min(batch_size, max_batch_size) if batch_size else max_batch_size`)을 그대로 제시한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)**: problem_statement가 파일·라인(`django/db/models/query.py` L1197)과 올바른 참조 구현(`bulk_update` L504)을 직접 지목. `_batched_insert`에서 `batch_size`와 `bulk_batch_size`가 함께 쓰이는 단 한 줄이 타깃. grep 한 방.
- **S (Repair Strategy) = S1 (Direct-Map / template)**: 정형 결함클래스 = 경계값 미클램프(unbounded user input). 픽스는 기계적 clamp(`min(...)`) 삽입이며, 이슈가 정확한 식까지 적어줬다. 추론 합성(S2)이 필요 없고 후보 다수(S3)도 아니다 — 템플릿 매칭.
- **K (Knowledge) = K-Gen**: `bulk_batch_size`가 "백엔드 한도"라는 얕은 의미만 알면 되고, 픽스 자체는 순수 파이썬 `min` clamp + `if batch_size`(0/None 폴백) 추론. ORM 내부(query compiler/SQL 생성) 지식 불요. 도메인 의존은 표면적.
- **primary type = T-DirectMap**: 위치 명확(L0) + S1 기계적 가드(경계 클램프). 이슈가 위치·패턴·정답식을 모두 명세하므로 "찾고 정형 픽스 적용"이 본질. T-LocTrivial보다 정확한 라벨은 T-DirectMap(픽스가 가드/클램프라는 정형 결함클래스에 매핑).
- **왜 이 strategy인가 (APR 관점)**: PAR/TBar류 fix-template("missing bound check" → "insert min/clamp")에 1:1 대응. 결함 위치가 단일 표현식이고 올바른 식이 인접 메서드(`bulk_update`)에 이미 존재해 donor로 복제 가능 — SemFix식 제약합성이나 G&V 반복탐색이 필요 없는 전형적 S1.

## 난이도 티어
**T1 (존나쉬움).** 이 티어로 미는 구조적 피처:
- 파일 1개(`django/db/models/query.py`), 단일 함수(`_batched_insert`), 실질 변경 ~2줄(L0 + S1).
- 이슈가 결함 라인·참조 패턴·정답 스니펫을 전부 제공 → localize 노력 0, 합성 추론 0. (has-repro 스택트레이스는 없지만, 정답식 명시가 그보다 강한 easiness 신호.)
- knowledge K-Gen, cross-file 조율 없음(`bulk_update`는 참조용일 뿐 수정 대상 아님).
- 공식 라벨 `<15 min fix`와 **일치** — 본 분석도 T1로 동의. 공식 시간라벨이 못 잡는 localize 난이도/overfit 위험이 여기선 거의 0이라 재조정 불필요.
- 주의: P2P 21개(`*_efficiency`/`*_batch*` 다수가 `assertNumQueries`로 쿼리 수를 단언) 때문에 regression-trap을 표기했으나, 이는 잘못 고쳤을 때만 깨지는 안전망이지 난이도를 T2 이상으로 올리진 않는다.

## 골드패치 분석
- **건드린 파일/함수**: `django/db/models/query.py` → `QuerySet._batched_insert`.
- **근본 원인**: `batch_size = (batch_size or max(ops.bulk_batch_size(fields, objs), 1))`의 `or` 단락. `batch_size`가 truthy면 `max(...)`(백엔드 한도)를 평가조차 안 하고 사용자 값을 채택 → 사용자 값 > 백엔드 한도에 대한 캡(clamp)이 부재.
- **수정 요지**: 백엔드 최대값을 `max_batch_size`로 먼저 산출한 뒤, 사용자 값이 있으면 둘의 `min`, 없으면 `max_batch_size`를 쓰도록 클램프. `bulk_update`와 동일 패턴으로 통일.
  ```python
  max_batch_size = max(ops.bulk_batch_size(fields, objs), 1)
  batch_size = min(batch_size, max_batch_size) if batch_size else max_batch_size
  ```
  `if batch_size` 분기로 `batch_size=0`/`None`(미지정 = 백엔드 자동)의 기존 의미를 보존한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_explicit_batch_size_respects_max_batch_size (bulk_create.tests.BulkCreateTests)`.
- **동작/픽스 증명**: `Country` 1000개 생성, `max_batch_size = max(connection.ops.bulk_batch_size(fields, objs), 1)` 산출, `bulk_create(objs, batch_size=max_batch_size + 1)` 호출 후 `assertNumQueries(ceil(1000 / max_batch_size))`로 쿼리 수 단언. 캡이 적용되면 실제 분할이 `max_batch_size` 기준(`+1` 무시)이라 쿼리 수가 백엔드 최대값으로 떨어져 단언 충족. 버그(캡 없음)면 사용자 값 `max_batch_size+1` 기준으로 더 큰 청크 → 쿼리 수 부족으로 단언 실패. `@skipUnlessDBFeature('has_bulk_insert')` 게이팅.
- **overfit 관점 (overfit-risk)**: FAIL_TO_PASS가 1개이고 "캡이 걸린다"만 본다. 이론적으론 `batch_size`를 무조건 `max_batch_size`로 강제(즉 사용자가 더 작은 값을 줘도 무시)해도 이 테스트 하나는 통과할 수 있다 → S1을 잘못 일반화하면 special-case overfit 가능. 단, `min`을 쓰는 골드는 P2P `test_explicit_batch_size`(사용자가 더 작은 값 지정 시 존중)로 그 over-fix를 잡아 균형이 맞는다.
- **regression 관점 (regression-trap)**: P2P 21개 중 `test_efficiency`, `test_explicit_batch_size_efficiency`, `test_large_batch_efficiency`, `test_non_auto_increment_pk_efficiency`, `test_batch_same_vals` 등이 `assertNumQueries`로 쿼리 수를 고정한다. `min`/`max` 자리를 바꾸거나 `if batch_size` 폴백을 깨면 이 효율 테스트들이 즉시 깨진다 — 잘못 고치면 광역으로 빨개지는 안전망.

## 모범답안 (오라클 기반)
1. **Localize 경로**: 이슈 제목 "batch_size param overrides compatible batch size calculation" + 본문 라인(`query.py` L1197)과 참조(`bulk_update` L504의 `min(...)`)가 직접 지목 → `QuerySet._batched_insert`에서 `batch_size or max(ops.bulk_batch_size(...), 1)` 한 줄로 곧장 수렴. 별도 탐색 불필요(L0).
2. **픽스 & 올바른 일반화**: `or` 단락(=상한 무시)을 명시적 클램프 `min(batch_size, max_batch_size) if batch_size else max_batch_size`로 교체. 이게 올바른 일반화인 이유 — (a) 사용자 값 > 한도면 한도로 캡(버그 수정), (b) 사용자 값 ≤ 한도면 사용자 값 존중(기존 기능 보존), (c) 미지정(0/None)이면 백엔드 자동값 폴백 유지. 세 케이스를 모두 만족해야 진짜 일반화이며, 이는 `min`이라야 성립한다(무조건 `max_batch_size` 강제는 (b) 위반).
3. **Regression 안전**: `*_efficiency` 계열 P2P(`assertNumQueries`)와 `test_explicit_batch_size`(작은 값 존중)를 깨면 안 됨. 클램프가 한도 이하 입력엔 영향을 안 주므로 기존 쿼리 수가 보존되고, `if batch_size` 폴백으로 미지정 경로도 불변 → 21개 P2P 그린 유지.
4. **함정 회피 (오라클 없는 에이전트)**: (i) `min`/`max`를 헷갈려 의미 반전(사용자 값을 항상 강제)하면 F2P는 통과해도 `test_explicit_batch_size` P2P가 잡는다 — `min` 방향을 두 케이스로 검증할 것. (ii) `assertNumQueries`를 "쿼리 적을수록 좋음"으로 오해해 over-fix하지 말 것(캡 적용 = 쿼리 수 *증가*가 정상). (iii) `batch_size or ...`를 그대로 두고 엉뚱한 곳을 손대지 말 것 — 결함은 그 `or` 단락 자체. (iv) `bulk_update`(L504)는 이미 올바르니 건드리지 말고 패턴 donor로만 참조.
