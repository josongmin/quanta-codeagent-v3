---
instance_id: django__django-11451
repo: django/django
base_commit: e065b293878b1e3ea56655aa9d33e87576cd77ff
version: 3.0
difficulty: <15 min fix
created_at: 2019-06-08T19:11:42Z
fail_to_pass: 6
pass_to_pass: 45
gold_files: [django/contrib/auth/backends.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

# django__django-11451

## 문제 요약
`ModelBackend.authenticate()`는 username이 None일 때(다른 인증 백엔드용 credentials가 넘어온 경우 등) 불필요한 DB 쿼리를 실행한다. 구체적으로 `WHERE "auth_user"."username" IS NULL` 같은 무의미한 쿼리가 나가고, 게다가 timing 마스킹을 위해 비싼 패스워드 해셔(`UserModel().set_password(password)`)까지 돌린다. 사용자(django-sesame 저자)는 자기 백엔드용 credentials만 줬을 때 ModelBackend가 아무 일도 안 하고 즉시 빠져나가길(쿼리 0, 해셔 호출 0) 기대한다. problem_statement는 정확한 메서드 본문을 인용하고 `if username is None or password is None: return` 픽스까지 명시적으로 제안한다.

## 유형 (정형화)

- **L0 (Localization = Pinpointed)** — problem_statement가 `ModelBackend.authenticate()`를 메서드 시그니처·본문째로 인용하고, 무의미한 SQL과 비싼 해셔 호출 지점까지 짚는다. grep 한 방으로 `django/contrib/auth/backends.py`의 단일 함수에 정확히 도달. 탐색 비용 사실상 0.
- **S1 (Repair = Direct-Map / template)** — 이슈가 픽스를 거의 그대로 적어준다("My suggestion is to shortcut with: `if username is None or password is None: return`"). 결함 클래스는 정형적인 **None-가드 / early-return 누락**. 합성할 식이 없고 추론으로 조건을 도출할 필요도 없으므로 S2(constraint-reasoning) 아님 — 템플릿 매칭으로 끝나는 기계적 가드 삽입이다.
- **K-Gen (Knowledge = General)** — `None or None → return` 자체는 일반 파이썬 추론. django auth 내부지식이 *왜 안전한가*를 설명해주긴 하지만(아래 regression 참조), 픽스 도출에 ORM/query-compiler 도메인지식이 병목으로 작용하지 않는다. 이슈 본문이 도메인 근거(백엔드 간 timing은 마스킹 대상 아님)를 이미 제공.

**primary type = T-DirectMap**: 위치가 명확(L0)하고 픽스가 기계적 가드(S1)다. T-LocTrivial이 아닌 이유는 "찾으면 끝"보다 한 단계 더 — 가드를 *어디에* 넣고 *어떤 조건*(username만이 아니라 password까지)으로 넣는지가 정답을 가르기 때문에 DirectMap이 더 정확하다.

왜 S1인가 (APR 관점): PAR/TBar류 template-based repair가 곧장 매칭하는 전형이다. fault pattern("nullable로 진행하면 안 되는 인자에 대한 unguarded use") → fix template("early-return null-check"). SemFix/Angelix 같은 의미적 합성도, GenProg/Astor 같은 generate-&-validate 탐색도 불필요 — 후보 패치 공간이 1개로 수렴하고 이슈가 그 1개를 명시한다.

## 난이도 티어
**tier = T2 (쉬움)**. 공식 라벨도 `<15 min fix`로 일치하지만, 둘은 우연히 같은 게 아니라 구조 피처가 일관되게 가리킨다:

- 미는 피처: 1파일·**2줄** 헌크(구조적 컷의 "1파일·<5줄 ≈ 48% solve" 구간), L0 localize(이슈가 파일·함수·픽스를 다 줌), `has-repro`(네이티브 SQL과 재현 시나리오 명시 — 가장 강한 easiness 신호).
- T1로 더 내리지 않는 이유: T1은 "이슈가 픽스를 거의 적어줌 + 함정 없음"인데, 여기엔 **두 개의 미세 함정**(가드 삽입 위치 = USERNAME_FIELD fallback 직후여야 함, 가드 조건 = `username`만이 아니라 `password is None`까지)이 있어 무뇌 복붙이 회귀를 부른다. 그래서 T2.
- T3 이상으로 올리지 않는 이유: 추론 합성(S2) 없음, underspecified 아님(이슈가 명확), 멀티사이트 아님. P2P가 45건으로 넓어 `regression-trap` 플래그는 켜지만, 이건 "최소 변경을 지키면 자동으로 안전"한 종류라 난이도를 한 티어 이상 올릴 만큼은 아니다.

## 골드패치 분석
- **건드린 파일/함수**: `django/contrib/auth/backends.py` → `ModelBackend.authenticate`.
- **근본 원인**: `if username is None: username = kwargs.get(UserModel.USERNAME_FIELD)` fallback 이후에도 username(그리고 애초에 password)이 None일 수 있는데, 가드 없이 곧장 `UserModel._default_manager.get_by_natural_key(username)`를 호출한다. None일 때 `WHERE username IS NULL` 쿼리가 나가고, `DoesNotExist` 분기에서 timing 보정용 `UserModel().set_password(password)` 해셔까지 실행된다.
- **수정 요지**: fallback 라인 직후에 2줄 early-return 삽입:
  ```python
  if username is None or password is None:
      return
  ```
  credentials가 불완전하면 DB 조회·해셔 실행 *이전에* 빠져나간다. timing 마스킹(#20760) 논리는 *같은 ModelBackend 내* 존재/미존재 user 간 차이만 가리면 되고, *다른 백엔드와의* timing 차이는 어차피 별도 코드 경로라 마스킹 대상이 아니라는 게 정당화 근거다.

## 검증 (test_patch)
- **FAIL_TO_PASS (6개)**: 신규 `test_authentication_without_credentials` × 3개 user-model 변형(`ModelBackendTest` / `CustomPermissionsUserModelBackendTest` / `ExtensionUserModelBackendTest`) + 동반 회귀로 묶인 `test_custom_perms` × 3.
- **픽스 증명**: `test_authentication_without_credentials`는 `PASSWORD_HASHERS=[CountingMD5PasswordHasher]`로 override한 뒤 `{}`, `{'username': ...}`, `{'password': 'test'}` 3가지 불완전 credentials 각각에 대해 `with self.assertNumQueries(0)` + `CountingMD5PasswordHasher.calls == 0`을 단언한다. 픽스 전에는 쿼리 1건 + 해셔 1회가 발생해 두 단언 모두 실패 → 픽스 후 early-return으로 0/0 달성. `subTest`로 3 케이스를 분리해 username-only / password-only / 둘 다 없음을 모두 커버한다.
- **overfit 관점**: FAIL_TO_PASS가 쿼리수(`assertNumQueries(0)`)와 해셔 호출수(`calls == 0`)라는 **관찰 가능한 부작용 부재**를 직접 검사하므로, special-case 하드코딩으로 통과할 여지가 거의 없다. overfit 위험 낮음 → `overfit-risk` 플래그 미부여.
- **regression 관점**: P2P 45건이 인접 동작(정상 인증 성공/실패, `test_authenticate_inactive`, "Hasher is run once regardless of whether the user exists. Refs #20760.", `test_skips_backends_without_arguments`, custom/extension user model perms 전반)을 폭넓게 가드한다. 특히 #20760 timing 테스트는 *username/password가 모두 주어진* 경로를 보므로, early-return 가드를 `None or None` 조건으로 정확히 한정하면 그 경로엔 영향이 없다 → `regression-trap` 플래그 부여하되 최소 변경으로 안전.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 `ModelBackend.authenticate()`를 직접 인용 + 문제의 SQL(`WHERE username IS NULL`)을 보여줌 → `django/contrib/auth/backends.py`의 `ModelBackend.authenticate`로 즉시 수렴(L0). 탐색 불요.

2. **픽스와 올바른 일반화 이유**: username fallback(`username = kwargs.get(UserModel.USERNAME_FIELD)`) **직후**에 `if username is None or password is None: return` 삽입. 이게 overfit이 아니라 올바른 일반화인 이유 — 테스트가 검사하는 건 특정 입력값이 아니라 "credential 불완전 ⇒ 부작용 0"이라는 *불변식*이고, 가드는 그 불변식을 입력공간 전체(username 누락 / password 누락 / 둘 다)에 대해 성립시킨다. `password is None`까지 포함해야 password-only-missing 케이스에서도 해셔가 안 돌아간다.

3. **regression 안전**: `username`과 `password`가 **둘 다 주어진** 정상 경로는 가드 조건이 거짓이라 그대로 통과 → 정상 인증(P2P의 `test_authenticate`, `test_authenticate_inactive`)과 #20760 timing 마스킹("Hasher is run once...")이 무손상. fallback *직후*에 넣어야 USERNAME_FIELD를 kwargs에서 끌어오는 동작을 죽이지 않는다(라인 위에 넣으면 fallback 무력화 → 회귀).

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) `if username is None: return`만 넣어 **password 누락 케이스를 놓침** → password-only subTest에서 해셔가 돌아 `calls == 0` 실패. (b) 가드를 fallback **위**에 넣어 USERNAME_FIELD fallback을 깸. (c) over-engineering으로 timing(#20760) 분기를 건드려 "Hasher is run once" P2P를 깸. 회피법: 이슈가 제안한 정확한 2줄을 fallback 직후에 그대로, 그 외 로직은 무손상으로 두는 **최소 변경** 원칙 — 픽스 공간이 1개로 수렴하므로 창의성을 더할 필요가 없다.
