---
instance_id: psf__requests-2317
repo: psf/requests
base_commit: 091991be0da19de9108dbe5e3752917fea3d7fdc
version: "2.4"
difficulty: "<15 min fix"
created_at: 2014-11-01T02:20:16Z
fail_to_pass: 8
pass_to_pass: 133
gold_files: [requests/sessions.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`requests/sessions.py`의 `Session.request()`는 `method = builtin_str(method)`로 HTTP 메서드를 정규화한다. Python 3.4에서 `method`가 `b'GET'` 같은 bytes로 들어오면 `builtin_str(b'GET')`은 `str(b'GET')` → 리터럴 문자열 `"b'GET'"`를 만들어버린다(Python 2에서는 동일 코드가 정상). 그 결과 서버에 `"b'GET'"`라는 깨진 메서드가 전송되어 404가 난다. neutronclient가 `safe_encode_list`로 인자를 bytes로 강제하는 사용 패턴에서 재현된다.

## 유형 (정형화)

- **L0 (Pinpointed)**: 이슈 본문이 파일·라인·심볼을 정확히 지목한다 — "In requests/sessions.py is a command: `method = builtin_str(method)`". grep 한 방으로 끝. localize 노력 0.
- **S1 (Direct-Map)**: hints_text가 픽스를 사실상 명세한다 — "should have been replaced with `to_native_str`". bytes→native str 변환이라는 정형 결함(타입강제)에 대한 기계적 치환. 후보 탐색·테스트 반복 불필요.
- **K-Domain**: 일반 파이썬 지식만으로 `builtin_str`의 함정(2/3 분기 동작 차이)을 알기 어렵다. requests의 compat 레이어(`builtin_str` vs `to_native_string`)와 Py2/Py3 bytes-str 모델 차이를 알아야 "왜 깨지는지/무엇으로 바꿔야 하는지"가 보인다. 다만 좁은 도메인이라 K-Domain 약함.
- **primary = T-DirectMap**: 위치는 이슈가 못박았고(L0), 픽스는 가드/치환 수준의 기계적 변환(S1)이다. 추론으로 식을 합성(S2)할 필요 없이 올바른 변환 함수로 1:1 대체한다.

APR 관점: 결함클래스가 "잘못된 변환 API 호출"로 깔끔히 분류되고, 정답 심볼 `to_native_string`이 같은 파일에 이미 import·사용 중이라(line 21, 136) PAR/TBar식 template-replace로 도출 가능하다 → S1.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처:
- 파일 1개(`requests/sessions.py`), 변경 2줄(import 정리 1 + 치환 1). <5줄 컷 안쪽.
- localize 직접성 최상(L0, 이슈가 라인 지목) + `has-repro`(neutronclient 재현 경로 + 명확한 증상 404).
- 도메인 지식은 얕음 — compat 레이어 한 함수만 알면 됨.
- `regression-trap` 존재: PASS_TO_PASS 124개로 넓고, `request()`는 모든 호출의 공통 진입점이라 메서드 정규화를 잘못 바꾸면 광범위하게 깨질 수 있다. 그래서 T1(존나쉬움)이 아니라 T2. 단 정답 함수가 이미 검증·사용 중이라 trap의 실질 위험은 낮다.

공식 라벨 `<15 min fix`와 일치. tier를 T1으로 더 낮추지 않은 이유는 K-Gen이 아닌 약한 K-Domain(`builtin_str`의 Py3 함정 인지 필요)과 넓은 P2P 때문.

## 골드패치 분석

- **건드린 파일·함수**: `requests/sessions.py` → `Session.request()` (line 428 부근), 그리고 상단 import 라인 13.
- **근본원인**: `builtin_str`는 Py3에서 `str`이므로 `builtin_str(b'GET')`가 bytes를 디코딩하지 않고 repr성 문자열 `"b'GET'"`를 만든다. 즉 "native string으로 정규화"라는 의도와 달리, 입력이 bytes일 때 의미를 보존하지 못한다.
- **수정요지**:
  1. `method = builtin_str(method)` → `method = to_native_string(method)`로 치환. `to_native_string`은 bytes를 ascii 디코딩하여 native `str`을 만들어 `b'GET'` → `'GET'`로 올바르게 변환한다.
  2. line 13의 `from .compat import ... builtin_str` import에서 더 이상 안 쓰는 `builtin_str`를 제거(dead import 정리). `to_native_string`은 line 21에서 이미 import되어 있어 추가 import 불필요.

## 검증 (test_patch)

- **FAIL_TO_PASS 핵심**: `test_encoded_methods` — `requests.request(b'GET', httpbin('get'))` 후 `assert r.ok`. base_commit에서는 `"b'GET'"` 메서드로 404 → `r.ok` False, 픽스 후 `'GET'`으로 정상 200 → 통과. 이 테스트가 bytes 메서드 경로를 정확히 겨냥한다.
- 나머지 FAIL_TO_PASS(`test_HTTP_302_ALLOW_REDIRECT_GET`, `test_POSTBIN_GET_POST_FILES`, `test_requests_history_is_saved` 등)는 신규 추가가 아니라 동일 테스트 모듈에서 실제 네트워크/리다이렉트 경로를 도는 케이스로, 환경에서 함께 측정되는 회귀 묶음이다.
- **픽스 증명**: 입력 `b'GET'`에 대해 `to_native_string`이 `'GET'`을 반환함을 `test_encoded_methods`가 end-to-end로 관찰한다. str 입력(`'GET'`)은 `to_native_string`이 그대로 통과시키므로 기존 동작 보존.
- **overfit 관점**: S1 치환이라 special-case로 통과하기 어렵다. 단, `test_encoded_methods` 단일로는 `if isinstance(method, bytes): method = method.decode('ascii')` 같은 좁은 패치도 통과 가능 → 약한 overfit 여지. 하지만 골드의 `to_native_string`은 str/bytes 양쪽을 일반적으로 다루므로 더 올바른 일반화다.
- **regression 관점**: `test_unicode_method_name` 등 str 메서드 경로가 PASS_TO_PASS에 있어, 정상 str 입력이 깨지지 않음을 보증한다.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈가 `requests/sessions.py`의 `method = builtin_str(method)`를 라인째 지목 → 해당 파일의 `Session.request()`로 직행. grep `builtin_str` 한 번. L0이라 탐색 비용 사실상 0.
2. **픽스와 일반화 근거**: `builtin_str`는 Py3에서 bytes를 디코딩하지 않아 의도(native string 정규화)를 못 지킨다. 같은 파일 line 21에 이미 import된 `to_native_string`(utils.py 정의, ascii 디코딩으로 bytes→str)으로 치환. 이는 한 입력값에 대한 분기가 아니라 "bytes/str 무엇이 와도 native str로 정규화"라는 계약을 복원하므로 올바른 일반화다(hints_text가 정확히 이 함수를 지목).
3. **regression 안전**: `request()`는 전 호출 공통 진입점 → str 메서드(`'GET'`, `test_unicode_method_name`)가 그대로 보존돼야 한다. `to_native_string`은 이미 str이면 변환 없이 통과시키므로 124개 PASS_TO_PASS의 정상 경로를 깨지 않는다. import 정리는 `builtin_str`이 이 파일에서 다른 곳에 안 쓰이는지 확인 후 제거(검증 필요).
4. **함정 회피**: (a) 자작 `str(method, 'ascii')`/`method.decode()`로 직접 디코딩하면 str 입력에서 `AttributeError`/이중디코딩 가능 — 프로젝트 표준 `to_native_string` 재사용이 정답. (b) `builtin_str` import를 남겨두면 dead import(린트 회귀)이고, 반대로 다른 사용처가 있는데 지우면 NameError — 제거 전 파일 전역 grep 필수. (c) overfit 유혹(bytes만 isinstance 가드)에 빠지지 말고 양방향 정규화 함수를 쓸 것.
