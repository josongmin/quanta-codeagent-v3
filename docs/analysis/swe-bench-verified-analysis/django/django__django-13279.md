---
instance_id: django__django-13279
repo: django/django
base_commit: 6e9c5ee88fc948e05b4a7d9f82a8861ed2b0343d
version: "3.2"
difficulty: 15 min - 1 hour
created_at: 2020-08-07T05:15:16Z
fail_to_pass: 9
pass_to_pass: 346
gold_files: [django/contrib/sessions/backends/base.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep]
---

# django__django-13279

## 문제 요약
Django 3.1로 전환하면서 세션 데이터 직렬화 포맷이 바뀌었다(#31274 / 커밋 `d4fff711`, `signing.dumps` 기반 새 포맷). 그래서 같은 프로젝트를 구버전/신버전 인스턴스 혼재로 굴리는 전환 기간에 `DEFAULT_HASHING_ALGORITHM='sha1'`을 설정해도, 새 인스턴스가 만든 세션을 구 포맷만 이해하는 인스턴스가 디코드하지 못한다. 사용자는 `DEFAULT_HASHING_ALGORITHM='sha1'`이 전환 기간 호환을 보장하리라 기대했고, problem_statement 자체가 "legacy `encode()`를 쓰자(it's a bit hacky)"라며 픽스 방향까지 제안한다.

## 유형 (정형화)

**L (Localization) = L1 — Traceable.** problem_statement가 직접 심볼을 찍어주진 않지만 "format for session data" 변경(#31274 커밋 해시)과 "use the legacy `encode()`"라는 키워드로 `django/contrib/sessions/backends/base.py`의 `encode()`/`decode()`/`_legacy_*` 메서드군으로 곧장 수렴한다. grep 한 방(L0)은 아니고, 해당 파일 안에서 `decode`엔 폴백이 있는데 `encode`엔 대칭 경로가 없다는 **비대칭**을 직접 읽어 발견해야 하므로 L1이 정확하다.

**S (Repair Strategy) = S2 Constraint-Reasoning (+S6 Design-Refactor).** 고칠 위치(`encode()`)는 사실상 명세돼 있으나, 올바른 픽스는 "임의의 구 포맷"이 아니라 **기존 `_legacy_decode()`가 정확히 역으로 풀 수 있는 직렬화 식**을 추론·합성해야 성립한다. `hash:payload` 레이아웃, `self._hash(serialized)` 해시 함수, `base64.b64encode(... + b':' + ...)` 인코딩이 디코더의 역연산과 비트 단위로 맞아야 한다 — 이게 S2(불변식/계약을 따져 올바른 식을 합성)의 핵심이다. 동시에 단순 한 줄 가드가 아니라 신규 헬퍼 메서드 `_legacy_encode()`를 **도입**하고 `encode()`에 게이트 분기를 얹는 작은 구조 변경이라 S6를 보조로 둔다. 후보 패치를 마구 뽑아 테스트로 거르는 S3/S4가 아니다 — 라운드트립 계약이 정답을 유일하게 못박는다.

**K (Knowledge) = K-Domain.** Django 세션 백엔드 내부(`signing.dumps` 신포맷 vs pre-3.1 `hash:serialized` 포맷, `DEFAULT_HASHING_ALGORITHM` 설정의 의미, `RemovedInDjango40Warning` deprecation 관례)를 알아야 한다. 일반 파이썬 추론(K-Gen)만으로는 "구 포맷이 정확히 무엇인지"를 못 짚는다.

**Primary = T-ConstraintReason.** 위치는 명확(L1)하나 진짜 난점이 "encode의 출력이 기존 decoder 계약과 정확히 맞도록 식을 합성"하는 데 있어, T-ConstraintReason이 dominant. T-DirectMap(S1 기계적 가드)으로 보기엔 신규 직렬화 식 합성이 비자명하고, T-DiffuseLoc은 위치가 좁아 해당 없음.

## 난이도 티어

**Tier = T4 (약간 어려움).** 공식 라벨은 "15 min - 1 hour"(개발자 구현시간 기준 T2~T3 prior).

이 티어로 미는 구조적 피처:
- **단일 파일·소규모(+8줄)** — scope만 보면 쉬운 쪽. 하지만 줄 수가 곧 난이도가 아니다.
- **K-Domain + S2 합성** — 픽스의 정당성이 "decoder와의 역연산 계약"에 걸려 있어, 도메인 지식 없이 자체 직렬화를 발명하면 라운드트립이 깨진다. 루브릭상 K-Domain 또는 S2 단독으로도 T4로 밀린다.
- **cross-file-dep** — `_legacy_encode`의 정합성이 같은 클래스의 `_legacy_decode`(이미 존재)와 `signing`/`_hash`/`serializer` 계약에 묶여 있다(암묵적 의미 의존).
- **넓은 P2P trap(346개, regression-trap)** — 세션 인코딩/디코딩은 9개 백엔드가 공유하는 hot path라, `encode()`를 잘못 건드리면 `test_decode`/`test_save`/`test_cycle` 등 수백 개 인접 동작이 깨진다.

**공식 라벨과의 차이:** 공식 "15분~1시간"은 의도(legacy encode 복원)를 이미 아는 개발자의 구현시간이다. 오라클 없는 에이전트 관점에선 (1) decode의 비대칭을 읽어 내고 (2) `_legacy_decode`의 정확한 역연산을 합성해야 하는 추론 비용 + 넓은 regression 표면이 더해져 T2가 아닌 T4로 본다. localize는 쉬우나 "올바른 일반화"의 제약이 빡빡한 케이스다.

## 골드패치 분석
- **건드린 파일/함수:** `django/contrib/sessions/backends/base.py` — `SessionBase.encode()` 수정 + 신규 `SessionBase._legacy_encode()` 추가.
- **근본 원인:** #31274에서 `decode()`는 신포맷 파싱 실패 시 `_legacy_decode()`로 폴백하는 **읽기** 역호환 경로를 뒀지만, `encode()`는 항상 새 `signing.dumps()` 포맷으로만 출력했다. 즉 "구 포맷으로 **쓰는**" 경로가 없어서, `DEFAULT_HASHING_ALGORITHM='sha1'`을 켜도 새 인스턴스가 구 인스턴스가 읽을 수 있는 세션 데이터를 만들지 못한다. encode/decode 역호환의 **비대칭**이 본질.
- **수정 요지:** `encode()` 진입부에 게이트
  ```python
  if settings.DEFAULT_HASHING_ALGORITHM == 'sha1':
      return self._legacy_encode(session_dict)
  ```
  를 추가하고, 신규 `_legacy_encode()`가 구 포맷을 재현한다: `self.serializer().dumps(session_dict)` → `self._hash(serialized)` → `base64.b64encode(hash.encode() + b':' + serialized).decode('ascii')`. 이는 기존 `_legacy_decode()`가 풀 수 있는 `hash:payload` base64 포맷과 정확히 짝이다. 두 메서드 모두 `RemovedInDjango40Warning` 주석으로 한시적(Django 4.0에서 제거) 호환임을 명시.

## 검증 (test_patch)
- **FAIL_TO_PASS 동작:** 신규 `test_default_hashing_algorith_legacy_decode`가 `SessionTestsMixin`을 공유하는 9개 백엔드 클래스(Cookie/Cache/File/FilePathLib/CacheDB/CacheDBTimeZone/Database/DatabaseTimeZone/CustomDatabase)에서 동일 메서드로 검증된다 — FAIL_TO_PASS 9개는 백엔드별 중복일 뿐 실제 픽스 표면은 단일 mixin 메서드.
- **픽스 증명 방식:** `with self.settings(DEFAULT_HASHING_ALGORITHM='sha1')` 오버라이드 하에서 `data = {'a test key': 'a test value'}`를 `self.session.encode(data)`로 인코딩한 뒤, 그 결과를 `self.session._legacy_decode(encoded)`로 다시 풀어 원본 `data`와 같은지 단언한다. 픽스 전: `encode()`가 신포맷을 내므로 `_legacy_decode()`가 풀지 못해 실패. 픽스 후: `encode()`가 `_legacy_encode` 경로를 타 구 포맷을 내므로 `encode→_legacy_decode` 라운드트립이 성립. `@ignore_warnings(category=RemovedInDjango40Warning)`로 deprecation 경고를 억제한다.
- **overfit 관점:** FAIL_TO_PASS는 단 하나의 라운드트립 단언이라 표면상 얇지만, 단언 대상이 **encode 출력이 기존 decoder로 풀려야 한다**는 강한 계약이라 special-case로 통과하기 어렵다(임의 포맷을 내면 `_legacy_decode`가 실패). 다만 게이트 키를 잘못 잡거나(예: `== 'sha256'` 반대로) decode 쪽까지 손대는 over-edit는 테스트로 직접 안 걸릴 수 있어 overfit-risk 자체는 낮지만 0은 아님 — flags엔 더 강한 regression-trap/cross-file-dep만 표기.
- **regression 관점:** P2P 346개가 9개 백엔드의 거의 모든 세션 동작(save/cycle/decode/expiry/flush…)을 덮는다. `encode()`는 디폴트(비-sha1) 경로에서 **반드시 기존 `signing.dumps` 출력을 byte-identical로 유지**해야 하므로, 게이트를 진입부 `if`로만 두고 기본 경로를 손대지 않은 골드패치가 정답이다. test_patch가 일부 클래스를 `unittest.TestCase` → `SimpleTestCase`로 바꾸는 부분은 `self.settings()` 오버라이드를 쓰기 위한 테스트 인프라 변경이지 본 픽스와 무관.

## 모범답안 (오라클 기반)

1. **localize 경로:** problem_statement의 두 신호 — (a) #31274 커밋 해시("changed format for session data"), (b) "use the legacy `encode()` when `DEFAULT_HASHING_ALGORITHM == 'sha1'`" — 를 따라 `django/contrib/sessions/backends/base.py`를 연다. `encode()`/`decode()`/`_legacy_decode()`를 나란히 읽어 **decode엔 `_legacy_decode` 폴백이 있는데 encode엔 대칭이 없다**는 비대칭을 포착한다(이게 핵심 localize 통찰).

2. **픽스와 올바른 일반화인 이유:** `encode()` 진입부에 `settings.DEFAULT_HASHING_ALGORITHM == 'sha1'` 게이트를 추가하고, 신규 `_legacy_encode()`가 **기존 `_legacy_decode()`의 정확한 역연산**(`hash:serialized` → base64, `self._hash`/`self.serializer` 재사용)을 수행하게 한다. 이게 overfit이 아닌 이유: 테스트가 요구하는 건 "특정 바이트열"이 아니라 "encode 출력이 decoder 계약을 만족"하는 **불변식**이고, 골드는 이미 존재하는 decoder의 역함수를 복원함으로써 그 불변식을 일반적으로 충족한다(임의 백엔드·임의 payload에 성립).

3. **regression 안전:** 비-sha1 기본 경로의 `signing.dumps(...)` 출력을 절대 건드리지 않아야 한다 — P2P 346개(특히 `test_decode`, `test_save`, `test_cycle`, `test_save_doesnt_clear_data`)가 신포맷 라운드트립을 검증한다. 게이트를 진입부 early-return으로 두어 기본 경로를 byte-identical로 보존하는 게 안전한 구조다. `decode()`/`_legacy_decode()`는 손대지 않는다(읽기 호환은 이미 동작).

4. **함정 회피:** 오라클 없는 에이전트가 틀리기 쉬운 지점 — (a) `_legacy_decode`를 안 읽고 **자체 직렬화를 발명**하면 `encode→_legacy_decode` 라운드트립에서 실패한다(반드시 기존 decoder의 역을 복원). (b) 게이트 키를 `DEFAULT_HASHING_ALGORITHM` 정확히가 아니라 다른 설정으로 잡으면 트리거가 안 된다. (c) encode를 sha1 분기로 전면 교체해 기본 경로의 신포맷을 깨면 346 P2P가 무너진다 — 분기 추가지 교체가 아니다. (d) `RemovedInDjango40Warning` 주석/`@ignore_warnings`는 deprecation 관례라 누락해도 기능은 되지만, 골드의 의도(한시적 호환)를 살리려면 표기하는 게 맞다.
