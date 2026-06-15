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
---

# django__django-11451

## 문제 요약
`ModelBackend.authenticate()`는 username이 None일 때(다른 인증 백엔드용 credentials가 넘어온 경우 등) 불필요한 DB 쿼리를 실행한다. 구체적으로 `WHERE "auth_user"."username" IS NULL` 같은 무의미한 쿼리가 나가고, 게다가 timing 마스킹을 위해 비싼 패스워드 해셔(`UserModel().set_password(password)`)까지 돌린다. 사용자는 자기 백엔드용 credentials만 줬을 때 ModelBackend가 아무 일도 안 하고 즉시 빠져나가길(쿼리 0, 해셔 호출 0) 기대한다.

## 유형 분류
- 버그 카테고리: 누락처리 (early-return guard 부재) / 성능
- 서브시스템: django.contrib.auth 인증 백엔드
- 증상 타입: 불필요한 DB 쿼리 + 불필요한 패스워드 해셔 실행 (silent 성능 낭비)
- 로컬라이제이션 신호: problem_statement가 `ModelBackend.authenticate()`를 메서드 시그니처째로 인용하고 `username is None or password is None: return` 패치까지 제안 — 파일/함수가 사실상 명시됨.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/auth/backends.py:ModelBackend.authenticate`
- 근본 원인: `username = kwargs.get(UserModel.USERNAME_FIELD)`로 fallback한 뒤에도 username/password가 None일 수 있는데, 가드 없이 곧장 `UserModel._default_manager.get_by_natural_key(username)`를 호출. None일 때 쿼리가 나가고, 미존재 분기에서 timing 보정용 `set_password`까지 실행됨.
- 수정 요지: username fallback 직후 2줄 early-return 추가 — `if username is None or password is None: return`. credentials가 불완전하면 DB 조회/해셔 실행 이전에 빠져나간다. timing 마스킹 논리는 같은 백엔드 내 존재/미존재 차이만 가리면 되고, 백엔드 간 timing 차이는 어차피 별도 코드라 마스킹 대상이 아니라는 게 근거.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_authentication_without_credentials` (ModelBackendTest, CustomPermissionsUserModelBackendTest, ExtensionUserModelBackendTest 3개 모델 변형) + `test_custom_perms`.
- 테스트가 어떻게 픽스를 증명하는지: `CountingMD5PasswordHasher`로 PASSWORD_HASHERS를 override한 뒤, `{}`, `{'username': ...}`, `{'password': 'test'}` 3가지 불완전 credentials에 대해 `authenticate(**credentials)` 호출. 각 케이스를 `with self.assertNumQueries(0)`로 감싸 DB 쿼리 0건을, `CountingMD5PasswordHasher.calls == 0`으로 해셔 미실행을 확인. 픽스 전에는 쿼리 1건 + 해셔 1회가 발생해 두 단언 모두 실패.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 `django/contrib/auth/backends.py`의 `ModelBackend.authenticate`를 직접 지목 — localization은 trivial. 핵심은 fallback 라인과 `get_by_natural_key` 호출 사이에 가드를 넣는 위치 선정.
- 함정/난이도 메모: (1) `if username is None: username = kwargs.get(...)` 직후에 넣어야 함 — 그 위에 넣으면 USERNAME_FIELD fallback이 무력화됨. (2) `password is None`까지 가드해야 한다는 점을 놓치기 쉬움 (username만 막으면 password 누락 케이스에서 여전히 해셔 실행). (3) 단일 파일·2줄 수정이라 over-engineering 위험; timing(#20760) 로직을 건드리면 PASS_TO_PASS의 "Hasher is run once..." 테스트가 깨질 수 있어 그 분기는 그대로 둬야 함.
- 우리 에이전트 관점: 명세가 패치를 거의 그대로 주므로 막힐 지점은 적음. 다만 `return` vs `return None`, 그리고 가드 삽입 위치(fallback 전/후)를 잘못 잡으면 회귀. PASS_TO_PASS가 45건으로 인접 timing/perms 동작을 폭넓게 가드하니 최소 변경 원칙을 지켜야 안전.
