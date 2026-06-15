---
instance_id: django__django-15930
repo: django/django
base_commit: 63884829acd207404f2a5c3cc1d6b4cd0a822b70
version: 4.2
difficulty: <15 min fix
created_at: 2022-08-07T15:26:41Z
fail_to_pass: 1
pass_to_pass: 88
gold_files: [django/db/models/expressions.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-15930

## 문제 요약
`Case(When(~Q(pk__in=[]), then=...))`처럼 "항상 참인" 조건을 쓰면 `ProgrammingError: syntax error at or near "THEN"`가 발생한다. `~Q(pk__in=[])`는 "모든 행에 매칭"되는 sentinel 조건인데, 생성된 SQL이 `... ORDER BY CASE WHEN THEN True ELSE False END ...`처럼 `WHEN`과 `THEN` 사이의 조건절이 통째로 비어버려 DB가 거부한다. 이슈 본문은 재현 코드와 실제 생성 SQL·네이티브 에러를 모두 포함하며, "모든 행이 매칭되므로 전부 `True`로 annotate되기를 기대"한다고 의도를 명시한다.

## 유형 (정형화)
- **L (Localization) = L1 (Traceable)**: 이슈가 클래스 심볼(`Case`/`When`)과 증상 SQL(`CASE WHEN THEN`)을 주므로 `django/db/models/expressions.py`의 conditional expression 영역으로 좁게 수렴한다. 다만 정확한 수정 지점(`When.as_sql` vs `Q`/`WhereNode`의 빈-문자열 발생원)을 가르려면 약간의 데이터플로우 추적이 필요해 L0이 아니라 L1.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S5 Spec-Inference)**: 위치는 좁혀지지만 "올바른 보정 식"을 추론으로 합성해야 한다. `condition_sql == ""`라는 불변식(WHERE에서는 empty가 always-true의 합법 인코딩)을 인지하고, CASE-WHEN 문맥에서는 그 empty를 항상 참인 명시적 술어로 치환해야 한다는 조건식을 도출하는 것이 핵심. G&V로 후보를 던져 맞히는 류가 아니라 의미 추론으로 한 방에 합성되는 형태라 S2가 dominant. 또 "기대 동작이 전부 True"라는 스펙은 코드만으론 안 나오고 이슈 본문에서 재구성해야 해 S5를 보조로 둔다.
- **K (Knowledge) = K-Domain**: "always-true 필터는 WHERE에서 빈 문자열로 컴파일된다"는 것은 순수 파이썬 추론이 아니라 Django ORM SQL 컴파일러의 내부 관례다. 이 관례를 모르면 빈 문자열의 출처를 오해한다.
- **Primary type = T-ConstraintReason**: 위치는 명확(L1)하나 픽스가 기계적 가드 추가(S1)가 아니라 "empty-condition → always-true predicate" 의미 보정의 추론 합성이 본질이라 T-DirectMap이 아닌 T-ConstraintReason. L이 L2/L3이 아니므로 T-DiffuseLoc도, dominant가 지식 그 자체가 아니라 추론이므로 T-DomainBound도 아니다.

## 난이도 티어
**Tier = T4 (약간 어려움)**. 공식 라벨은 `<15 min fix`(개발자 구현시간 기준 T1~T2급)지만, 에이전트 관점 구조 피처로 재조정해 T4로 올린다.
- **상향 요인**: (1) S2 constraint-reasoning — 빈 문자열이 "버그가 아니라 always-true의 합법 인코딩"임을 알아야 보정 방향이 잡힌다(K-Domain 결합). (2) regression-trap: P2P가 88개로 매우 광범위하며, 특히 대칭쌍 `test_annotate_with_empty_when`(always-**false** `Q(pk__in=[])` → default 값)을 깨면 안 된다. always-false 경로는 empty 컨디션이 아니므로 건드리면 회귀가 난다. (3) over-localize 함정: 빈 문자열의 발생원을 `Q`/`WhereNode`로 깊이 추적하면 잘못된 상위 레벨을 고치게 된다.
- **하향 요인(왜 T5가 아닌가)**: 단일 파일·단일 헌크·5줄, has-repro(재현코드+네이티브 스택+생성 SQL 전부 제공 → 가장 강한 easiness 신호), 멀티사이트 조율 불필요. overfit 위험도 낮다(아래).
- 공식 라벨과의 차이: 구현 자체는 5줄이라 사람에겐 15분이지만, 에이전트에겐 "어디가 아니라 어떤 식으로"라는 의미 추론 + 넓은 P2P 보존 + 미끼 localization 때문에 체감 난이도가 한 단계 높다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/expressions.py` → `When.as_sql`.
- 근본 원인: `~Q(pk__in=[])` 같은 everything-matches 필터는 WHERE 절에서는 빈 문자열(`""`)로 컴파일되어 정상 동작한다(WHERE 전체가 생략 = 모든 행 통과). 그러나 `CASE WHEN <cond> THEN ...` 구문에서는 `<cond>` 자리에 빈 문자열이 들어가 `WHEN THEN`이 되어 SQL 문법 오류가 난다. 즉 동일한 "always-true" 표현이 두 문맥에서 다른 인코딩을 요구하는데 `When.as_sql`이 그 차이를 보정하지 않았다.
- 수정 요지: `condition_sql, condition_params = compiler.compile(self.condition)` 직후에 가드를 삽입 — `if condition_sql == "": condition_sql, condition_params = compiler.compile(Value(True))`. 빈 조건일 때 항상 참인 술어 `Value(True)`로 재컴파일해 `condition_sql`/`condition_params`를 채운다. `Value(True)`에 위임하는 것이 백엔드별 always-true 리터럴(예: 일부 백엔드의 `1`/`True`) 처리를 자동으로 해결하는 핵심.

## 검증 (test_patch)
- FAIL_TO_PASS (1개): `test_annotate_with_full_when` — `Case(When(~Q(pk__in=[]), then=Value("selected")), default=Value("not selected"))`로 annotate.
- 픽스 증명: 항상 참인 입력 `~Q(pk__in=[])`에 대해 (1) 쿼리가 SQL 오류 없이 실행되어 `len(objects) == CaseTestModel.objects.count()`(전 행 반환), (2) 모든 객체가 `selected == "selected"`(조건이 항상 참 → default가 아닌 then 값). 가드 전이라면 `WHEN THEN`으로 ProgrammingError가 나 테스트가 RED.
- overfit 관점: 픽스가 특정 테스트 형태가 아니라 "빈 condition_sql"이라는 일반 불변식에 거는 가드라 overfit-risk 낮음. FAIL_TO_PASS는 1개로 얇지만, 픽스가 입력별 special-case가 아니라 컴파일 단계의 보편 보정이라 CEGIS류 일반화 부담이 없다.
- regression 관점: 대칭쌍 `test_annotate_with_empty_when`(always-false)을 비롯해 88개 P2P가 보존돼야 한다. always-false `Q(pk__in=[])`는 빈 condition_sql을 만들지 않으므로(반대 경로) 이 가드에 걸리지 않아 안전하며, 일반 `When`들도 비-빈 condition_sql이라 영향 없음 — `== ""` 가드가 최소 침습이라 회귀가 닫힌다.

## 모범답안 (오라클 기반)
1. **localize 경로**: 에러 메시지의 `CASE WHEN THEN`과 생성 SQL이 결정적 단서. `Case`/`When`은 conditional expression이므로 `django/db/models/expressions.py`로 직행. `When`의 SQL 생성 지점 `When.as_sql`에서 `compiler.compile(self.condition)`이 빈 문자열을 돌려주는 경로를 확인 → 여기가 수정점. (빈 문자열의 *발생원*을 `Q`/`WhereNode`까지 따라가는 건 미끼; 보정은 소비 지점인 `When`에서 하는 게 옳다.)
2. **픽스와 왜 올바른 일반화인가**: `condition_sql == ""`일 때 `compiler.compile(Value(True))`로 치환. 이는 "WHERE에서 empty = always-true 합법 인코딩"이라는 도메인 불변식을, CASE-WHEN 문맥에서 요구되는 "명시적 always-true 술어"로 번역하는 의미적으로 정확한 보정이다. 입력 패턴이 아니라 컴파일 산출물(빈 문자열)에 거는 가드라 `~Q(pk__in=[])` 한 형태가 아닌 모든 always-true sentinel을 커버한다. `Value(True)`에 위임함으로써 백엔드별 리터럴 차이를 하드코딩 없이 흡수 = 올바른 일반화.
3. **regression 안전**: always-false 대칭쌍(`test_annotate_with_empty_when`)은 빈 condition_sql을 만들지 않으므로 가드 밖 → 깨지지 않는다. 비-빈 condition을 가진 일반 `When`/`Case` 88개 P2P도 `== ""` 분기에 걸리지 않아 byte-동일 경로. 가드를 `compile` 직후 최소 위치에 두는 것이 인접 동작 보존의 핵심.
4. **함정 회피**: (a) 빈 문자열 출처를 `Q.__invert__`/`WhereNode`로 깊이 추적해 상위 레벨을 고치려는 over-engineering — WHERE의 empty는 *정상*이므로 거기를 바꾸면 다른 동작이 깨진다. (b) DB별 always-true 리터럴(`TRUE`/`1=1`/`1`)을 직접 하드코딩하려는 유혹 — 백엔드 호환을 깨고 overfit. 정답은 `Value(True)` 위임. (c) always-false(empty_when)까지 함께 건드리는 과교정 — 그쪽은 이미 통과 중이라 손대면 회귀.
