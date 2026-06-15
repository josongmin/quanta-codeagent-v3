---
instance_id: django__django-13568
repo: django/django
base_commit: ede9fac75807fe5810df66280a60e7068cc97e4a
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-10-19T15:20:08Z
fail_to_pass: 1
pass_to_pass: 13
gold_files: [django/contrib/auth/checks.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-13568

## 문제 요약
`USERNAME_FIELD`로 지정한 필드의 유일성을 `unique=True` 대신 `Meta.constraints`의 `UniqueConstraint(fields=["username"])`로 보장해도, 시스템 체크가 무조건 `auth.E003`("must be unique...") 에러를 띄운다. PostgreSQL에서 CharField/TextField에 `unique=True`를 쓰면 불필요한 암묵적 `*_like` 인덱스가 생기므로 `UniqueConstraint`를 선호하는 경우가 있는데, 체크가 이 합법적 패턴을 인식하지 못하는 게 문제다. 이슈 본문이 재현 모델 코드와 정확한 에러 ID를 그대로 적어주고, "Model._meta.constraints에 USERNAME_FIELD 존재 여부를 추가로 검사하라"는 수정 방향까지 제시한다.

## 유형 (정형화)
- **L0 (Pinpointed)** — 이슈 본문에 에러 ID `auth.E003`와 정확한 메시지 문구("must be unique because it is named as the 'USERNAME_FIELD'")가 박혀 있다. 이 문자열로 grep하면 `django/contrib/auth/checks.py`의 `check_user_model` 단일 함수, 단일 분기(`if not cls._meta.get_field(...).unique`)로 한 방에 수렴한다. 탐색 노력 사실상 0.
- **S2 (Constraint-Reasoning) +S5 (Spec-Inference)** — 고칠 지점은 명백하나, **"username이 unique constraint로 보장되는가"의 올바른 술어를 합성**하는 것이 핵심이다. 단순히 "constraint가 있으면 통과"가 아니라, ① constraint의 `fields`가 정확히 `(USERNAME_FIELD,)` 단일 필드여야 하고(복합 constraint는 단독 유일성 미보장), ② **partial(조건부) constraint는 유일성을 보장하지 않으므로 제외**해야 한다는 불변식을 따져야 한다. 이 partial 제외 의미론은 코드만 봐선 결정 안 되고, "유일성을 실제로 보장하는가"라는 도메인 스펙에서 재구성해야 하므로 S5 보조. 후보를 마구 시도해 테스트로 거르는 G&V(S3/S4)가 아니라, 올바른 조건식을 "생각으로" 합성하는 SemFix/Angelix 계열.
- **K-Domain** — 정답의 병목은 일반 파이썬 추론이 아니라 django ORM 메타 API 지식이다. `cls._meta.total_unique_constraints`라는 프로퍼티의 **존재와 의미**(condition 없는 "total" unique constraint만 반환, partial은 `unique_constraints`로 분리)를 알아야 한다. 이걸 모르면 `cls._meta.constraints`를 직접 순회해 partial 케이스를 잘못 통과시킨다.
- **primary = T-DomainBound** — L0라 localize는 trivial이고 수정도 4줄이지만, 정답·오답을 가르는 결정적 요인이 `total_unique_constraints` vs `constraints`/`unique_constraints` 구분이라는 **프레임워크 내부 지식**이다. 따라서 "constraint 추론"(T-ConstraintReason)보다 K-Domain dominant인 T-DomainBound가 더 방어가능하다 — 추론 자체는 partial 제외 한 가지뿐이고, 그 추론을 코드로 옮기는 정확한 API를 아느냐가 진짜 관문.

## 난이도 티어
**T4 (약간 어려움).** 공식 라벨은 "15분-1시간"(T2~T3 prior)이고 patch scope는 1파일·4줄(+net 3줄)로 T2 구조다. 그럼에도 T4로 올리는 구조적 피처:
- **K-Domain 병목** — 루브릭상 K-Domain이 dominant면 T4 하한. `total_unique_constraints` 프로퍼티를 모르면 정답 도달 불가이고, 이 API는 django 3.1+에서 도입된 비교적 신상이라 memorization 의존도가 높다.
- **regression-trap (P2P trap)** — test_patch가 같이 추가하는 `test_username_partially_unique`가 PASS_TO_PASS에 들어있다. partial constraint(`condition=Q(...)`)는 여전히 E003/W004를 내야 하는 음성 케이스인데, 순진하게 `constraints` 또는 `unique_constraints`를 순회하면 이 테스트가 깨진다. FAIL_TO_PASS만 보고 "constraint 있으면 통과"로 짜면 회귀를 유발하는 전형적 함정.
- localize는 L0(has-repro로 에러 ID·재현코드 제공)라 쉬운 쪽으로 당기지만, 위 두 피처가 "한 줄 픽스로 보이는데 정답은 미묘"한 영역으로 밀어 T4가 맞다. T5는 아님 — 멀티파일/멀티헌크/overfit 고위험이 아니고, regression-trap도 단일 음성 케이스라 좁다.

## 골드패치 분석
- **건드린 파일·함수:** `django/contrib/auth/checks.py` → `check_user_model` (`@@ -52,7 +52,10 @@`)
- **근본 원인:** username 유일성 판정이 `cls._meta.get_field(cls.USERNAME_FIELD).unique` 단일 항에만 의존. 필드 수준 `unique=True`만 인지하고, 모델 메타에 선언된 `UniqueConstraint`(테이블 수준 유일성)는 전혀 고려하지 않아 합법적 패턴에 false-positive E003을 낸다.
- **수정 요지:** unique 가드 조건에 보조 항을 **AND**로 추가 —
  ```python
  if not cls._meta.get_field(cls.USERNAME_FIELD).unique and not any(
      constraint.fields == (cls.USERNAME_FIELD,)
      for constraint in cls._meta.total_unique_constraints
  ):
  ```
  필드가 unique가 아니어도, `total_unique_constraints` 중 `fields`가 정확히 `(USERNAME_FIELD,)`인 단일-필드 constraint가 하나라도 있으면 에러/경고 분기 전체를 건너뛴다. **`total_unique_constraints` 선택이 핵심** — 이 프로퍼티는 `condition`/`include`가 붙은 partial·covering constraint를 제외하고 무조건 유일성을 보장하는 것만 반환하므로, partial unique는 여전히 E003이 유지된다. `(cls.USERNAME_FIELD,)` 단일-원소 튜플 비교는 복합 constraint(`fields=['username','tenant']` 등)가 username 단독 유일성을 보장하지 않음을 정확히 배제한다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_username_unique_with_model_constraint` — `UniqueConstraint(fields=['username'], name='username_unique')`(condition 없는 total) 만 가진 `CustomUserUniqueConstraint`에서 기본 백엔드와 커스텀 백엔드(`my.custom.backend`) 양쪽 모두 `run_checks` 결과가 `[]`여야 한다. 픽스 전: `unique=True`가 없어 무조건 E003. 픽스 후: `total_unique_constraints`에 `(username,)`이 잡혀 분기 skip → 빈 리스트.
- **regression 증명 (PASS_TO_PASS, 13개 중):** `test_username_partially_unique` — `condition=Q(password__isnull=False)`인 partial constraint를 가진 모델은 `total_unique_constraints`에서 제외되므로 여전히 기본 백엔드에서 E003, 커스텀 백엔드에서 W004가 나와야 한다. 이게 `total_` 프로퍼티 선택의 정당성을 강제하는 **음성 케이스**다. 나머지 P2P(`ModelsPermissionsChecksTests` 8개, `test_username_non_unique`, REQUIRED_FIELDS 류 등)는 인접 체크 동작이 안 깨졌음을 보장.
- **overfit·regression 관점:** FAIL_TO_PASS는 1개로 얇지만, partial 음성 케이스가 같은 패치에서 PASS_TO_PASS로 함께 들어와 overfit(단순 "constraint 있으면 통과")을 직접 차단한다. 즉 weak-suite로 인한 CEGIS 고위험은 아니고, 테스트 쌍(양성 total + 음성 partial)이 올바른 일반화를 핀으로 박는다. 다만 복합-필드 constraint를 username 유일성으로 오인하는 변형은 명시적 테스트가 없어, `(USERNAME_FIELD,)` 튜플 비교를 느슨하게(`USERNAME_FIELD in constraint.fields`) 짜도 이 스위트는 통과 — 미세한 잔여 overfit 표면.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 `auth.E003` 에러 ID + "must be unique because it is named as the 'USERNAME_FIELD'" 문구로 코드베이스 grep → `django/contrib/auth/checks.py`의 `check_user_model`, 정확히 `if not cls._meta.get_field(cls.USERNAME_FIELD).unique:` 분기. has-repro(재현 모델 코드 제공)라 후보 모호성 없음.
2. **픽스와 왜 올바른 일반화인가:** 그 분기 조건을 "필드 unique가 아니다 **AND** 모델 레벨 single-field unique constraint도 없다"로 강화한다. `total_unique_constraints`를 순회해 `constraint.fields == (cls.USERNAME_FIELD,)`를 찾는 것이 올바른 일반화인 이유 — (a) DB가 실제로 강제하는 유일성의 **두 가지 합법적 표현**(필드 `unique` + 테이블 `UniqueConstraint`)을 모두 인정하므로 false-positive를 정확히 제거하고, (b) `total_` 프로퍼티가 partial을 걸러주어 "유일성을 실제로 보장하는 constraint"만 인정하며, (c) 단일-원소 튜플 비교로 복합 constraint를 배제해 과도한 허용을 막는다. 특정 테스트 값에 맞춘 게 아니라 도메인 불변식(유일성 보장 ⇔ unconditional single-field uniqueness)을 코드화한 것.
3. **regression 안전:** `test_username_partially_unique`(P2P)를 깨지 않아야 한다 — partial constraint는 유일성 미보장이므로 E003/W004가 유지돼야 하고, 이는 `total_unique_constraints`가 partial을 빼주는 덕에 자동 충족된다. `test_username_non_unique`(아무 constraint 없는 모델), `ModelsPermissionsChecksTests` 권한 체크들도 분기를 AND로만 좁혔지 다른 경로를 안 건드려 그대로 통과.
4. **함정 회피:** 오라클 없는 에이전트의 주요 실패 모드 — (1) `cls._meta.constraints` 또는 `cls._meta.unique_constraints`를 직접 순회 → partial constraint가 잘못 통과되어 `test_username_partially_unique` 회귀. **피하는 법: `total_unique_constraints` 프로퍼티의 존재·의미를 알고 골라 쓴다.** (2) `USERNAME_FIELD in constraint.fields`처럼 멤버십으로 비교 → 복합-필드 constraint를 username 유일성으로 오인. **피하는 법: `== (USERNAME_FIELD,)` 단일-튜플 동등 비교.** (3) 조건을 OR/별도 분기로 잘못 붙여 unique=True 케이스의 경고 경로를 망가뜨림. **피하는 법: 기존 `not ...unique`에 `and not any(...)`로 AND 결합해 분기 진입 조건만 좁힌다.**
