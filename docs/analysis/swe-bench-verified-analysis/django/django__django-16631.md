---
instance_id: django__django-16631
repo: django/django
base_commit: 9b224579875e30203d079cc2fee83b116d98eb78
version: 5.0
difficulty: 1-4 hours
created_at: 2023-03-06T15:19:52Z
fail_to_pass: 1
pass_to_pass: 12
gold_files: [django/contrib/auth/__init__.py, django/contrib/auth/base_user.py]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain
flags: [cross-file-dep, regression-trap, overfit-risk, has-repro]
---

# django__django-16631

## 문제 요약
사용자가 `SECRET_KEY`를 회전(rotate)하면서 이전 키를 `SECRET_KEY_FALLBACKS`에 넣었는데, 사이트의 모든 사용자가 로그아웃되어 버렸다. 문서는 fallback 키가 회전 기간 동안 세션을 유지시켜 준다고 설명하지만, 실제로는 세션 인증 해시 검증에 fallback 키가 전혀 쓰이지 않는다. `AbstractBaseUser.get_session_auth_hash`가 `salted_hmac`을 호출할 때 `secret` 인자를 넘기지 않아 항상 현재 `SECRET_KEY`로만 해시를 계산하기 때문이다. 게다가 단순히 fallback로 검증만 허용하면(hints에서 콜레가가 지적), 회전이 끝나고 fallback이 제거되는 순간 같은 세션들이 다시 무효화된다 — 즉 fallback로 통과한 세션을 현재 키로 **업그레이드**하는 것까지가 올바른 픽스다.

## 유형 (정형화)

- **L (Localization) = L3 (Multi-site).** problem_statement가 `salted_hmac`, `AbstractBaseUser.get_session_auth_hash`를 직접 지목하지만(이 한 지점만 보면 L0/L1처럼 보임), 올바른 픽스는 **해시 생성**(`base_user.py`)과 **세션 검증·플러시·업그레이드 진입점**(`__init__.py:get_user`) 두 파일이 **조율되어** 바뀌어야 한다. fallback 해시를 만드는 것만으로는 부족하고, "검증 실패 → flush"하던 `get_user`의 제어흐름을 "fallback 매칭 시 cycle_key + 해시 재기록"으로 재배선해야 한다. 두 사이트가 함께 바뀌므로 L3.
- **S (Strategy) = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드 추가가 아니라 작은 구조 변경이다: `get_session_auth_hash`의 본문을 `_get_session_auth_hash(secret=None)`로 추출(parameter 도입)하고, `get_session_auth_fallback_hash` 제너레이터를 신설하며, `get_user`의 검증 분기를 "현재 키 실패 → fallback 시도 → 매칭 시 세션 업그레이드 / 미매칭 시 flush"로 재배치한다. 이것은 collect-then-process류의 lifecycle 재배치(S6)다. 동시에 S5가 보조로 들어간다 — "fallback이 통과하면 어떻게 동작해야 하는가"는 코드만으론 결정되지 않고, 이슈 본문("회전 기간 세션 유지")+hints("rotation 종료 후 재무효화를 막으려면 업그레이드 필요")+`update_session_auth_hash` 관례에서 **의도된 스펙을 재구성**해야 픽스의 형태가 정해진다. APR 관점: GenProg식 mutate&test로는 `cycle_key()`+`session[HASH_SESSION_KEY] = session_auth_hash`라는 정확한 lifecycle 동작을 합성하지 못한다. 의도를 먼저 세우고(S5) 구조를 다시 짜는(S6) 문제다.
- **K (Knowledge) = K-Domain.** `salted_hmac`의 `secret` 파라미터, `SECRET_KEY_FALLBACKS` 설정, 세션 lifecycle API(`cycle_key`, `flush`, `HASH_SESSION_KEY`), `constant_time_compare`의 타이밍안전 의미 — 전부 django.contrib.auth 내부 지식이다. 일반 파이썬 추론으로는 "cycle_key로 키를 재발급해야 세션 고정 방어를 깨지 않는다"를 도출할 수 없다.
- **Primary = T-DesignRefactor.** localize 자체는 키워드로 절반이 주어지지만(L0스럽지 않음), 본질적 난점은 두 파일에 걸친 **조율된 구조 변경 + lifecycle 재배치**(S6)다. K-Domain도 강하지만 dominant한 병목은 "fallback 통과 시 세션을 어떻게 업그레이드하는가"라는 설계 결정이라 T-DesignRefactor로 라벨링한다(T-DomainBound이 차순위).

## 난이도 티어
**T5 (어려움).** 구조적 피처:
- **멀티파일·멀티헌크 (L3):** 2파일·4헌크. `base_user.py`에서 메서드 추출+신규 제너레이터+`secret` 전달, `__init__.py`에서 검증 분기 전면 재작성. ICLR 2024 컷에서 ≥2파일 조율은 solve-rate를 크게 떨어뜨린다.
- **overfit-risk + 숨은 2차 요구사항:** FAIL_TO_PASS가 1개뿐이고, "fallback로 검증만 통과"시키는 naive 패치는 1차 단언(여전히 로그인됨)을 통과시킬 수 있다. 그러나 테스트가 `assertNotEqual(session_key, prev_session_key)`(cycle_key 발생)와 **fallback 제거 후 재호출 통과**(현재 키로 업그레이드 완료)까지 검사하므로, 업그레이드 lifecycle을 빠뜨리면 FAIL. hints에서 사람이 직접 경고한 함정이 그대로 테스트에 박혀 있다 — 즉 underspecified한 1차 신호 너머의 일반화가 필요(CEGIS적 함정).
- **regression-trap:** PASS_TO_PASS 12개가 `get_user`/유저모델 생성·스왑·superuser 경로를 커버. `get_user`의 검증 분기를 재배선하면서 정상 검증·flush 경로(fallback 없을 때, 해시 불일치 시 진짜 flush)를 안 깨야 한다.
- **K-Domain 깊이:** 세션 고정 방어를 위한 `cycle_key`, 타이밍안전 `constant_time_compare`, HMAC `secret` 회전 — 보안 도메인지식이 필수.

공식 라벨 "1-4 hours"(T4 prior)보다 **한 단계 올린다**: 시간라벨은 개발자 구현시간 기준이라 "fallback 통과 시 업그레이드"라는 숨은 2차 스펙(hints에서야 드러나는, naive 패치로 1차 단언을 속이기 쉬운 overfit 함정)과 멀티파일 조율 비용을 과소평가한다. localize는 쉬운 편이나 strategy(S6+S5)와 overfit-risk가 티어를 T5로 민다.

## 골드패치 분석
- **건드린 파일/함수:**
  - `django/contrib/auth/base_user.py`:
    - `get_session_auth_hash` — 본문을 위임 호출(`return self._get_session_auth_hash()`)로 축소.
    - 신규 `get_session_auth_fallback_hash` — `settings.SECRET_KEY_FALLBACKS`를 순회하며 각 키로 `_get_session_auth_hash(secret=fallback_secret)`를 `yield`하는 제너레이터.
    - 신규 `_get_session_auth_hash(secret=None)` — 기존 해시 계산을 추출하고 `salted_hmac(..., secret=secret, ...)`로 `secret`을 전달.
    - 모듈 상단에 `from django.conf import settings` 추가.
  - `django/contrib/auth/__init__.py`: `get_user(request)`의 세션 검증 분기 재작성.
- **근본 원인:** `get_session_auth_hash`가 `salted_hmac`에 `secret`을 넘기지 않아 항상 현재 `SECRET_KEY`로만 HMAC을 만든다. 따라서 키 회전 후 fallback에 있는 구 키로 만들어진 기존 세션 해시는 현재 키 검증에서 무조건 불일치 → `get_user`가 `session.flush()` 후 `user = None` → 전원 로그아웃.
- **수정 요지:**
  1. 해시 계산을 `_get_session_auth_hash(secret=None)`로 분리하고 `secret` 전달 경로를 열어, 임의의 키(현재 또는 fallback)로 세션 해시를 생성 가능하게 함.
  2. `get_session_auth_fallback_hash` 제너레이터로 모든 fallback 키 해시를 lazy 제공.
  3. `get_user`에서 (a) `session_hash` 빈 값 가드를 명시적 `if not session_hash: session_hash_verified = False`로 정리하고, (b) 현재 키 검증 실패 시 곧장 flush하지 않고 fallback 해시 중 하나라도 `constant_time_compare`로 일치하면 `request.session.cycle_key()` 후 `request.session[HASH_SESSION_KEY] = session_auth_hash`로 **현재 키 해시로 업그레이드**(로그인 유지 + 향후 fallback 제거에도 생존), 아무 fallback도 안 맞으면 기존대로 flush + `user = None`.

## 검증 (test_patch)
- **FAIL_TO_PASS (1):** `test_get_user_fallback_secret (auth_tests.test_basic.TestGetUser.test_get_user_fallback_secret)`
- **동작/픽스 증명:**
  1. 사용자를 로그인시켜 세션 생성, `prev_session_key` 기록.
  2. `override_settings(SECRET_KEY="newsecret", SECRET_KEY_FALLBACKS=[기존 settings.SECRET_KEY])`로 회전 상황 흉내 → `get_user(request)`가 여전히 올바른 User 반환(로그아웃 안 됨)을 단언, 그리고 `assertNotEqual(request.session.session_key, prev_session_key)`로 `cycle_key()` 발생(= 단순 통과가 아니라 세션 업그레이드 경로를 탔음)을 단언.
  3. fallback 제거: `override_settings(SECRET_KEY="newsecret")`만으로 다시 `get_user`가 정상 User 반환 → 직전 호출에서 세션 해시가 **현재 키 기준으로 재기록**되었음을 증명(업그레이드가 실제로 일어났다는 결정적 증거).
- **overfit 관점:** FAIL_TO_PASS가 1개로 얇아 `overfit-risk`. 하지만 이 단일 테스트가 (a) 로그인 유지 (b) cycle_key 발생 (c) fallback 제거 후 생존 세 가지를 한 시나리오에 묶어, "fallback 통과만 시키고 업그레이드를 빠뜨린" special-case 패치를 3번째 단언에서 정확히 떨군다 — naive 패치를 막는 변별 입력이 테스트에 내장됨.
- **regression 관점:** PASS_TO_PASS 12개(`test_get_user`, `test_get_user_anonymous`, superuser/유저모델 생성·스왑 등)가 fallback 없는 정상 검증·flush 경로와 유저모델 기본동작을 보호. `get_user` 분기 재작성 시 이들을 깨면 즉시 적발된다.

## 모범답안 (오라클 기반)

1. **localize 경로.** problem_statement가 `salted_hmac`과 `AbstractBaseUser.get_session_auth_hash`를 직접 지목 → `django/contrib/auth/base_user.py`가 1차 타깃. 여기서 멈추면 안 된다: "sessions가 로그아웃된다"는 증상의 주어는 검증 주체다. `get_session_auth_hash`의 호출자를 역추적하면 `django/contrib/auth/__init__.py:get_user(request)`의 `constant_time_compare(... user.get_session_auth_hash())` → `session.flush()` 분기에 도달. 이 두 사이트가 함께 고쳐질 진짜 타깃임을 확정.

2. **픽스와 올바른 일반화.** (a) `base_user.py`: 해시 계산을 `_get_session_auth_hash(secret=None)`로 추출해 `salted_hmac(..., secret=secret)`로 임의 키 해시를 가능케 하고, `get_session_auth_fallback_hash`로 모든 `SECRET_KEY_FALLBACKS` 해시를 yield. (b) `__init__.py`: 현재 키 실패 시 fallback 매칭을 시도하고, 매칭되면 `cycle_key()` + `session[HASH_SESSION_KEY] = session_auth_hash`로 **현재 키 해시로 업그레이드**. 이게 overfit 아닌 올바른 일반화인 이유: 단순히 fallback 검증만 통과시키면 이슈 본문의 "회전 기간 유지"는 만족하지만 hints가 경고한 "fallback 제거 시 재무효화"가 그대로 남는다. 업그레이드까지 해야 N개 fallback·임의 회전 타이밍에 대해 모두 올바르며, 테스트의 3번째 단언이 정확히 이 일반화를 강제한다.

3. **regression 안전.** PASS_TO_PASS의 `test_get_user`(정상 키, 통과), `test_get_user_anonymous`(세션/유저 없음)와 fallback이 비었을 때의 경로를 안 깨야 한다 — 그래서 `if not session_hash: session_hash_verified = False` 빈 값 가드를 유지하고(빈 해시가 fallback 비교로 새어들지 않게), fallback이 하나도 안 맞으면 **기존 그대로** `flush()` + `user = None`을 보존한다. 정상 검증 성공 경로(현재 키 일치)는 손대지 않는다.

4. **함정 회피.** 오라클 없는 에이전트가 틀리는 지점:
   - **base_user.py만 고치고 끝낸다.** fallback 해시 생성기만 추가하면 `get_user`가 여전히 `get_session_auth_hash()`(현재 키)만 비교하므로 아무 효과 없음 → 두 파일 조율 필수.
   - **fallback 통과만 시키고 업그레이드를 누락.** 1차 단언은 속이지만 `cycle_key`/재기록 누락으로 2·3차 단언 FAIL. hints를 읽고 "rotation 종료 후 재무효화"를 스펙으로 끌어와야 함(S5).
   - **`constant_time_compare`를 `==`로 바꾼다.** 타이밍 공격 방어가 깨짐 — fallback 루프에서도 반드시 `constant_time_compare` 사용.
   - **업그레이드 시 `cycle_key()` 생략하고 해시만 덮어쓴다.** 세션 고정 방어 관례를 어김. django auth 도메인지식으로 "비밀이 바뀌는 시점엔 키를 재발급"을 알아야 함.
   - **fallback을 list 인덱싱/즉시평가로 처리.** 골드는 제너레이터+`any(...)` short-circuit으로 불필요한 HMAC 계산을 피한다(올바른 fallback에서 멈춤).
