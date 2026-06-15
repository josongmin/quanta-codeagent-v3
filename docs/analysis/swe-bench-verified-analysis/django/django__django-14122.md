---
instance_id: django__django-14122
repo: django/django
base_commit: bc04941bf811d1ea2c79fb7fc20457ed2c7e3410
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-03-13T19:57:16Z
fail_to_pass: 1
pass_to_pass: 26
gold_files: [django/db/models/sql/compiler.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-14122

## 문제 요약
모델 `Meta.ordering`이 설정된 상태에서 `.values('author').annotate(count=Count('author'))` 같은 집계 쿼리를 돌리면, `Meta.ordering`에 쓰인 필드들이 GROUP BY 절에 끼어들어가 잘못된 집계 결과가 나온다. 직전 커밋 `0ddb4ebf`가 이 경우 ORDER BY는 제거했지만 GROUP BY는 여전히 ordering 필드로 채워 그룹이 과도하게 쪼개졌다(ticket #14357의 불완전한 fix를 잇는 후속 버그). 사용자는 명시적으로 묶은 컬럼(`author`)만으로 그룹핑되어 올바른 카운트가 나오길 기대한다. 증상은 silent-wrong(예외 없이 잘못된 집계 출력).

## 유형 (정형화)
- **L (Localization) = L1 (Traceable).** 이슈가 직접 심볼을 지목하진 않지만 "GROUP BY", "Meta.ordering", "wrong aggregation" 키워드 + 직전 커밋 `0ddb4ebf` 참조 + 첨부 PR이 SQL compiler의 GROUP BY 생성 경로(`SQLCompiler.get_group_by`)로 좁게 수렴시킨다. grep 한 방은 아니고, ORDER BY는 정상인데 GROUP BY만 틀린 비대칭을 짚어야 해서 약간의 탐색이 든다. L0가 아닌 이유: 이슈가 함수명을 적어주지 않는다.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S1).** 고칠 지점(get_group_by의 order_by 확장 루프)은 비교적 명확하지만, **올바른 조건을 추론으로 합성**해야 한다 — "ordering 컬럼을 GROUP BY에서 빼라"는 너무 강하고(명시적 `order_by()` 깨짐), 정확히 "`Meta.ordering` 출처일 때만 빼라"는 불변식을 따져야 한다. 결과 코드는 `if not self._meta_ordering:` 가드 한 줄이라 기계적(S1)으로 보이지만, **그 조건이 맞다고 판단하는 과정 자체가 semantic 추론**이라 dominant는 S2다. 이미 존재하는 `_meta_ordering` 플래그를 발견·재사용하는 부분이 보조적 S1.
- **K (Knowledge) = K-Domain.** django ORM query compiler 내부지식이 병목이다. GROUP BY/ORDER BY가 `get_group_by` 안에서 어떻게 생성되는지, `is_ref`(SELECT 절 참조 스킵)가 무엇인지, `_meta_ordering`이 Meta.ordering 출처를 표시하는 기존 플래그라는 것을 알아야 한다. 일반 파이썬 추론(K-Gen)으로는 풀 수 없다.
- **Primary = T-ConstraintReason.** 위치는 명확(L1)하나 픽스의 본질이 "ordering을 빼되 어떤 ordering만 빼야 하는가"라는 조건식의 정확한 합성에 있다. 진짜 어려움이 localize가 아니라(→T-DiffuseLoc 아님), 구조 변경도 아니라(→T-DesignRefactor 아님) constraint reasoning이다.

## 난이도 티어
- **Tier = T4 (약간 어려움).** 공식 라벨 "15 min - 1 hour"(T3 prior 부근)보다 한 칸 올린다.
- **T4로 미는 구조적 피처:**
  - **K-Domain 병목** — query compiler 내부와 `_meta_ordering`/`is_ref` 시맨틱을 모르면 못 푼다. 루브릭상 K-Domain 단일이면 T4 진입.
  - **regression-trap (넓은 P2P)** — PASS_TO_PASS 26개 중 다수가 ordering 동작(`test_order_by_f_expression`, `test_extra_ordering_with_table_name`, reverse ordering, nulls first/last, ptr-field default ordering 등). 명시적 `order_by()` / extra clause / F-expression ordering의 GROUP BY 동작을 하나라도 깨면 즉시 회귀. constraint를 너무 넓게 잡으면(ordering 전체 차단) 이들이 무너진다.
  - **S2 constraint 합성** — 단일 1줄 가드지만 조건의 정확성이 까다롭다.
- **T5가 아닌 이유:** 단일 파일·단일 헌크·5줄 미만, cross-file 조율 없음(L3 아님), overfit 고위험(S4) 아님 — 픽스 자체는 작다. **T3가 아닌 이유:** 단순 단일파일 추론을 넘어 도메인지식 + 넓은 regression-trap이 동시에 걸려 있어 T4가 맞다.

## 골드패치 분석
- **건드린 파일/함수:** `django/db/models/sql/compiler.py` : `SQLCompiler.get_group_by`
- **근본 원인:** `get_group_by`는 `order_by` 항목을 순회하며 SELECT 참조가 아닌(`is_ref`가 False인) 표현식의 컬럼(`expr.get_group_by_cols()`)을 무조건 GROUP BY에 추가한다. 그런데 ordering이 사용자가 명시한 게 아니라 `Meta.ordering`에서 암묵적으로 주입된 경우에도 이 컬럼들이 GROUP BY로 들어가, 집계의 의도와 무관한 컬럼으로 그룹이 추가 분할됐다. 직전 커밋 `0ddb4ebf`는 같은 케이스에서 ORDER BY만 제거하고 이 GROUP BY 경로는 손대지 않아 fix가 비대칭적으로 불완전했다.
- **수정 요지:** `order_by` → GROUP BY 확장 루프 **전체**를 `if not self._meta_ordering:` 가드로 감쌌다. 즉 ordering이 `Meta.ordering`에서 파생된 것이면 그 컬럼들을 GROUP BY에 넣지 않는다. 사용자가 명시적으로 `.order_by(...)`를 건 경우엔 `_meta_ordering`이 비어 기존 동작(루프 실행, `is_ref` 스킵 포함)이 그대로 유지된다. 주석도 SELECT→대문자 통일로 갱신.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_default_ordering_does_not_affect_group_by (ordering.tests.OrderingTests)`. `tests/ordering/tests.py`에 추가됐고 `Count` import도 함께 추가.
- **픽스 증명:** author_1을 'Article 4'를 제외한 3개 기사에, author_2를 'Article 4' 1개에 할당한 뒤 `Article.objects.values('author').annotate(count=Count('author'))`를 실행. `Article`은 Meta.ordering(pub_date 등)이 걸려 있다. 버그 상태에서는 ordering 필드가 GROUP BY에 끼어 author당 행이 과분할되어 카운트가 쪼개진다. 픽스 후에는 `assertCountEqual`로 정확히 `[{'author': pk1, 'count': 3}, {'author': pk2, 'count': 1}]`가 나와 **author만으로 그룹핑**됨을 증명한다.
- **overfit 관점:** FAIL_TO_PASS가 1개로 얇지만, 픽스 핵심이 "Meta.ordering 출처일 때만 분기"라는 명확한 조건이라 special-case 솔루션이 끼어들 여지가 작다. overfit-risk 플래그를 달 정도는 아니다(테스트가 GROUP BY 결과를 직접 관찰).
- **regression 관점:** 26개 PASS_TO_PASS가 ordering 정상동작(명시적 order_by, F-expression, extra clause, reverse, nulls 정렬, ptr-field default ordering)을 광범위하게 커버한다 — `_meta_ordering`이 아닌 명시적 ordering 경로가 살아있음을 보장하는 안전망. 가드를 `_meta_ordering`이 아니라 ordering 전체로 잘못 걸면 이들이 무너지므로 regression-trap이 실효적이다.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 "GROUP BY populated with Meta.ordering fields" + 직전 커밋 `0ddb4ebf`(ORDER BY는 고쳤음) 신호 → ORDER BY와 GROUP BY를 둘 다 만드는 단일 지점인 `django/db/models/sql/compiler.py`의 `SQLCompiler.get_group_by`로 직행. 그 안에서 `order_by`를 순회하며 `expr.get_group_by_cols()`를 GROUP BY에 넣는 루프가 범인.
2. **픽스와 올바른 일반화:** 이미 존재하는 `self._meta_ordering`(ORDER BY 제거 로직이 쓰던 "ordering이 Meta 출처임" 플래그)을 재사용해 그 루프를 `if not self._meta_ordering:`로 가드. **이게 올바른 일반화인 이유:** 버그의 본질은 "ordering이 GROUP BY에 들어간 것"이 아니라 "**사용자가 의도하지 않은** ordering이 들어간 것"이다. 명시적 `order_by()`는 사용자 의도이므로 SQL 표준상 GROUP BY 동반이 필요할 수 있어 유지해야 하고, `Meta.ordering`은 묵시적이라 집계 의미를 오염시키면 안 된다. 따라서 출처 기반 분기가 정확히 일반화된 조건이다.
3. **regression 안전:** 가드를 출처(`_meta_ordering`)로 한정함으로써 명시적 order_by / extra clause / F-expression / reverse / nulls 정렬을 다루는 26개 P2P가 모두 보존된다(이들은 `_meta_ordering`이 False라 루프가 그대로 돈다). `is_ref` 스킵(SELECT 절 참조 컬럼은 이미 GROUP BY에 있으니 제외)도 루프 안에 그대로 둬서 유지.
4. **함정 회피:** 오라클 없는 에이전트의 주요 오답 — (a) ordering 컬럼을 **무조건** GROUP BY에서 제거 → 명시적 order_by의 GROUP BY 동작을 깨 P2P 회귀(가장 흔한 overshoot). (b) `_meta_ordering` 플래그의 존재를 모르고 새 플래그/상태를 추가하는 over-engineering. (c) ORDER BY 생성부(`get_order_by`)만 보고 GROUP BY 경로의 비대칭을 못 짚음. 회피법: silent-wrong이므로 먼저 실패 쿼리를 재현해 실제 GROUP BY SQL을 관찰하고, 직전 커밋이 ORDER BY만 고쳤다는 단서로 "같은 출처 조건을 GROUP BY에도 미러링"한다는 최소·대칭 수정으로 수렴한다.
