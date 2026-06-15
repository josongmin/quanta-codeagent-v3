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
---

# django__django-13279

## 문제 요약
Django 3.1로 전환하면서 세션 데이터 직렬화 포맷이 바뀌었다(#31274, signing.dumps 기반의 새 포맷). 그래서 같은 프로젝트의 여러 인스턴스를 구버전/신버전 섞어서 굴리는 전환 기간에 `DEFAULT_HASHING_ALGORITHM='sha1'`을 설정해도, 새 인스턴스가 만든 세션을 구 포맷만 이해하는 인스턴스가 디코드하지 못한다. 사용자는 `DEFAULT_HASHING_ALGORITHM='sha1'`을 켜면 전환 기간 호환이 보장되길 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (호환성 분기 빠짐) / regression (#31274 포맷 변경의 후속 결함)
- 서브시스템: django.contrib.sessions 백엔드 (세션 직렬화/인코딩)
- 증상 타입: silent-wrong / 디코드 실패 (전환 중 세션 손실)
- 로컬라이제이션 신호: problem_statement가 "format for session data" 변경과 "use the legacy encode()"를 직접 언급 → `sessions/backends/base.py`의 `encode()`/`_legacy_*` 메서드로 직결

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/sessions/backends/base.py` : `SessionBase.encode()` + 신규 `SessionBase._legacy_encode()`
- 근본 원인: #31274에서 `decode()`는 신포맷 실패 시 `_legacy_decode()`로 폴백하는 역호환 경로를 두었지만, `encode()`는 항상 새 `signing.dumps()` 포맷으로만 출력했다. 즉 "구 포맷으로 **쓰는**" 경로가 없어서, `DEFAULT_HASHING_ALGORITHM='sha1'`을 켜도 새 인스턴스가 구 인스턴스가 읽을 수 있는 데이터를 만들 수 없었다.
- 수정 요지: `encode()` 진입부에 `if settings.DEFAULT_HASHING_ALGORITHM == 'sha1': return self._legacy_encode(session_dict)` 분기를 추가. 신규 `_legacy_encode()`는 구 포맷을 재현한다 — serializer로 dumps → `self._hash(serialized)` → `base64.b64encode(hash + b':' + serialized)`. 즉 기존 `_legacy_decode()`가 풀 수 있는 `hash:payload` base64 포맷을 그대로 생성. 두 메서드 모두 `RemovedInDjango40Warning` 주석으로 한시적 호환임을 표시.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작: 신규 `test_default_hashing_algorith_legacy_decode`가 모든 세션 백엔드(Cookie/Cache/File/CacheDB/Database/Custom 등 9개 클래스)에서 검증된다. SessionTestsMixin을 공유하므로 한 메서드가 전 백엔드로 퍼진다.
- 테스트가 픽스를 증명하는 방식: `DEFAULT_HASHING_ALGORITHM='sha1'`로 settings를 오버라이드한 뒤 `data = {'a test key': 'a test value'}`를 `self.session.encode(data)`로 인코딩하고, 그 결과를 `self.session._legacy_decode(encoded)`로 다시 디코드해 원본 `data`와 같은지 단언한다. 픽스 전에는 `encode()`가 신포맷을 내므로 `_legacy_decode()`가 풀지 못해 실패. 픽스 후에는 `encode()`가 `_legacy_encode` 경로를 타 구 포맷을 내므로 라운드트립이 성립. `@ignore_warnings(RemovedInDjango40Warning)`로 deprecation 경고를 억제한다.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 짚어준 #31274 커밋과 "legacy encode" 키워드 → `sessions/backends/base.py`에서 `encode`/`decode`/`_legacy_decode`를 읽는다. `decode`엔 폴백이 있는데 `encode`엔 대칭 경로가 없다는 비대칭을 발견하는 게 핵심.
- 함정/난이도 메모: 단일 파일·소량 변경이지만 (1) 신규 `_legacy_encode`가 기존 `_legacy_decode`와 **정확히** 포맷 호환(`hash:payload` base64, `self._hash` 사용)이어야 하고, (2) 게이트 조건이 `settings.DEFAULT_HASHING_ALGORITHM == 'sha1'`이라는 정확한 설정 키여야 한다. 임의의 새 인코딩을 만들면 라운드트립이 깨진다. test_patch가 unittest.TestCase→SimpleTestCase로 바꾸는 부분은 `self.settings()` 오버라이드를 쓰기 위함이지 본 픽스와 무관.
- 우리 에이전트 관점: 막힐 지점은 "encode를 새로 만들지 말고 decode의 역호환 짝을 복원한다"는 의도 파악. 기존 `_legacy_decode`를 안 읽고 자체 직렬화를 구현하면 테스트의 `_legacy_decode` 라운드트립에서 실패한다. 9개 FAIL_TO_PASS는 백엔드별 중복일 뿐 단일 mixin 메서드이므로 수정 범위는 좁다.
