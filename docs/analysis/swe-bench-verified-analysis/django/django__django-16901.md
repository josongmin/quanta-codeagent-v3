---
instance_id: django__django-16901
repo: django/django
base_commit: ee36e101e8f8c0acde4bb148b738ab7034e902a0
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-05-30T05:08:34Z
fail_to_pass: 1
pass_to_pass: 6
gold_files: [django/db/models/sql/where.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-16901

## 문제 요약
XOR을 네이티브 지원하지 않는 DB(PostgreSQL 등)에서 `Q(...) ^ Q(...) ^ Q(...)`처럼 인자가 3개 이상일 때 Django가 생성하는 폴백 SQL이 틀렸다. 올바른 n-ary XOR 의미(그리고 MySQL 같은 네이티브 지원 DB의 의미)는 "참인 피연산자 개수가 홀수일 때 참"(parity)인데, Django의 폴백은 "정확히 하나만 참일 때 참"(exactly-one)으로 해석한다. 그래서 `Q(id=37)`을 홀수 개 XOR하면 1이 나와야 하는데 0이 나온다 (기대 시퀀스: 1, 0, 1, 0, 1). 이슈 본문에 #29865에서 도입되었음과 재현 REPL 세션이 함께 적혀 있다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed)** — 이슈가 "databases lacking XOR", "fallback SQL", "introduced in #29865"를 직접 명시한다. XOR을 SQL로 변환하는 폴백은 `django/db/models/sql/where.py`의 `WhereNode.as_sql` 내 `connection.features.supports_logical_xor` 미지원 분기 단 한 곳뿐이라 grep 한 방으로 지목된다. cross-module 추적 불필요, 후보 단일.
- **S (Repair Strategy) = S2 (Constraint-Reasoning) (+S5)** — 고칠 위치(`rhs_sum = reduce(operator.add, ...)` → `Exact(1, rhs_sum)` 블록)는 자명하지만, **올바른 조건식을 추론으로 합성**해야 한다. "n-ary XOR = 참 피연산자 개수의 홀짝(parity)"이라는 불변식을 도출하고, 이를 합계의 `MOD(sum, 2) == 1`로 환원해야 한다. 후보 패치를 마구 돌려 테스트로 거르는 G&V(S3/S4)가 아니라, 의미론을 "생각으로" 정확히 맞추는 SemFix/Angelix류다. 보조로 **S5(Spec-Inference)**: 의도된 의미(parity)는 코드만 봐선 결정 안 되고 이슈 본문의 "odd number of operands are true" + MySQL 네이티브 동작이라는 외부 스펙에서 재구성해야 한다.
- **K (Knowledge) = K-Domain** — 일반 파이썬 추론을 넘어 Django ORM query-compiler 도메인 지식이 병목이다. raw SQL `% 2`가 아니라 ORM 표현식 `Mod`를 `Case(When(...))` 합계 위에 합성해야 데이터베이스 추상화/cross-backend 정합성이 유지된다. `django.db.models.functions.Mod`의 존재와 표현식 합성 관례를 알아야 한다.
- **primary type = T-ConstraintReason** — 위치는 명확(L0)하나 진짜 난점이 "올바른 식·조건을 추론으로 합성"(S2)에 있으므로 T-ConstraintReason. T-DirectMap이 아닌 이유: 픽스가 가드/기본값/상수 같은 기계적 템플릿이 아니라, parity라는 비자명한 불변식을 SQL 표현식으로 번역하는 의미론적 합성이기 때문.

## 난이도 티어
**T4 (약간 어려움).** 이 티어로 미는 구조적 피처:
- **L0 + 1파일 ~6줄**만 보면 T2급으로 보이지만(작은 patch scope), 난점이 **줄 수가 아니라 S2 의미론 추론 + K-Domain**에 있다. TAXONOMY T4 정의("constraint추론·소규모 refactor·도메인지식 중 하나")에 정확히 해당.
- **K-Domain**: ORM 표현식 `Mod`를 골라 합계 위에 합성하는 도메인 지식이 필수. raw `% 2`나 `>= 1`로 빠지면 틀린다.
- **regression-trap**: `if len(self.children) > 2:` 가드가 핵심이다. 2개 이하에서 `sum == 1`은 이미 parity와 동치이므로 `Mod`를 적용하면 안 된다(불필요한 SQL 변경/회귀). 이 경계 디테일을 놓치면 PASS_TO_PASS의 2-ary 경로(`test_filter`)를 깰 수 있다.
- **공식 라벨("15 min - 1 hour")과 일치 방향**이지만 근거가 다르다. 공식 라벨은 "개발자 구현시간"인데, 개발자에겐 짧아도 에이전트에겐 parity 의미론 도출 + ORM `Mod` 선택 + `>2` 가드라는 세 추론 지점이 함정이다. has-repro(재현 시퀀스 명시)가 easiness를 끌어올리지만, 정답식 합성 난점이 이를 상쇄해 T3로 내려가지 않고 T4에 머문다.

## 골드패치 분석
- **건드린 파일·함수**: `django/db/models/sql/where.py` : `WhereNode.as_sql` (XOR 폴백 분기).
- **근본 원인**: XOR 미지원 DB용 폴백이 `a XOR b XOR ...`를 `(a OR b OR ...) AND (a + b + c + ...) == 1`로 변환했다. `Case(When(c, then=1), default=0)`들을 `reduce(operator.add, ...)`로 합한 뒤 `Exact(1, rhs_sum)`로 "정확히 1"을 요구하므로, 이는 "참인 인자가 **정확히 1개**"(exactly-one)를 의미한다. n-ary XOR의 올바른 정의는 "참인 인자 개수가 **홀수**"(parity)이므로 인자 3개 이상부터 어긋난다.
- **수정 요지**:
  - `from django.db.models.functions import Mod` import 추가(기존 import는 `Case`, `When`, `Exact`로 다른 모듈).
  - 합계 `rhs_sum` 산출 후 `if len(self.children) > 2:` 이면 `rhs_sum = Mod(rhs_sum, 2)`로 감싼다.
  - 결과 조건이 `MOD(a + b + c + ..., 2) == 1` → 참 인자 개수가 홀수일 때 참(parity).
  - 인자 2개 이하에서는 `sum == 1`이 곧 parity와 동치라 `Mod` 미적용으로 기존 동작/SQL 보존.
  - 주석도 `(a OR b OR c OR ...) AND MOD(a + b + c + ..., 2) == 1`로 갱신하고 parity 설명을 명시.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `xor_lookups.tests.XorLookupsTests.test_filter_multiple`.
- **픽스 증명**: `Q(num__gte=1) ^ Q(num__gte=3) ^ Q(num__gte=5) ^ Q(num__gte=7) ^ Q(num__gte=9)` (XOR 5개)로 필터링한 결과를, ORM 결과(`qs` 및 `qs.values_list("num", flat=True)`)와 순수 파이썬 parity 식 `(i>=1)^(i>=3)^(i>=5)^(i>=7)^(i>=9)`로 계산한 기대 집합을 `assertCountEqual`로 비교한다. exactly-one 폴백에서는 결과가 비거나 틀리고, parity 폴백(`Mod`)에서는 일치한다. 5개라는 홀수 개수가 정확히 exactly-one≠parity를 분리하는 입력이다.
- **overfit 관점**: 테스트가 단일 케이스지만 5-ary로 2개 초과 경로를 실제로 밟고, ORM 결과 vs 독립 파이썬 오라클이라는 **paired-control** 비교라 special-case 통과가 어렵다. `>2` 가드를 빼고 항상 `Mod`만 씌워도 이 테스트는 통과하지만(2-ary에서도 parity≡exactly-one), 그건 불필요한 SQL 변경이라 골드와 동작은 같다 — overfit-risk는 낮음.
- **regression 관점**: PASS_TO_PASS 6개(`test_filter` 2-ary, `test_filter_negated`, `test_exclude`, `test_empty_in`, `test_pk_q`, `test_stages`)가 2-ary 및 negated/empty 경로가 깨지지 않음을 보장. `>2` 가드 덕에 이들 SQL이 byte-동일하게 유지됨.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈의 "databases lacking XOR" + "fallback SQL" + "introduced in #29865" 신호 → `supports_logical_xor` feature를 grep → `django/db/models/sql/where.py`의 `WhereNode.as_sql`에서 `connection.features.supports_logical_xor`가 False인 분기로 직행. 거기서 `lhs = self.__class__(self.children, OR)`, `rhs_sum = reduce(operator.add, (Case(When(c, then=1), default=0) ...))`, `rhs = Exact(1, rhs_sum)` 블록이 정확히 그 폴백 구현임을 확인.
2. **픽스와 왜 올바른 일반화인지**: `Exact(1, rhs_sum)`이 "합계 == 1"을 강제해 exactly-one을 구현함을 인식 → n-ary XOR의 정의가 "참 인자 개수의 홀짝"임을 도출 → 합계를 `Mod(rhs_sum, 2)`로 감싸 `MOD(sum, 2) == 1`로 만든다. 이는 특정 테스트(5-ary)가 아니라 **임의 arity에 대해 parity를 구현**하므로 올바른 일반화다. raw SQL `% 2`가 아닌 ORM `Mod`를 써야 모든 백엔드에서 정합.
3. **regression 안전**: `if len(self.children) > 2:` 가드로 2-ary 이하에서는 `Mod` 미적용. 2개일 때 `sum ∈ {0,1,2}`에서 `sum==1`이 이미 parity와 동치라 변경 불필요하고, PASS_TO_PASS의 `test_filter`(2-ary)·negated·empty 경로 SQL을 그대로 보존해야 한다.
4. **함정 회피**: (a) exactly-one을 그대로 두고 OR 조합/`lhs`를 손대는 잘못된 방향으로 빠지기 쉬움 — 근본은 `rhs_sum`의 집계 의미. (b) `% 2 == 1`을 raw SQL 문자열로 박으면 cross-backend 깨짐 — `django.db.models.functions.Mod` 표현식을 써야 함. (c) `Mod` import 누락(기존 import와 다른 모듈) — 추가 필수. (d) `>2` 가드를 빼고 항상 `Mod`를 적용하면 테스트는 통과하나 2-ary SQL을 불필요하게 바꿔 골드와 어긋남 — 최소 변경 원칙 준수.
