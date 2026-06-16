---
instance_id: psf__requests-2931
repo: psf/requests
base_commit: 5f7a3a74aab1625c2bb65f643197ee885e3da576
version: "2.9"
difficulty: "15 min - 1 hour"
created_at: 2015-12-16T14:57:00Z
fail_to_pass: 1
pass_to_pass: 84
gold_files: [requests/models.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`requests.put(url, data=u"ööö".encode("utf-8"))`처럼 UTF-8로 인코딩된 binary 페이로드를 보내면 requests 2.9에서 실패한다(2.8.1에서는 동작). 원인은 이슈 #2844 픽스에서 도입된 `to_native_string` 호출이 body로 들어온 bytes를 native string으로 강제 변환하면서 바이트 페이로드를 깨뜨리는 것이다. 이슈 본문에 재현 코드와 회귀 도입 PR 링크가 모두 포함되어 있다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 함수명을 직접 지목하진 않지만 `to_native_string`이라는 심볼과 회귀 도입 PR(#2844)을 명시한다. `grep to_native_string requests/models.py` 한두 방이면 `_encode_params`의 `isinstance(data, (str, bytes))` 분기로 수렴한다. L0에 가까운 L1.
- **S2 (Constraint-Reasoning) +S6**: 단순히 `to_native_string`을 지우면 끝이 아니다. 같은 `_encode_params`가 **body 인코딩**(`prepare_body`)과 **URL 파라미터 인코딩**(`prepare_url`) 두 경로에서 공유되기 때문이다. body는 native string 강제가 해롭고(바이트 깨짐), params는 native string이 필요(requote/urlunparse가 py2에서 native string 기대)하다. 두 호출자의 불변식이 충돌하므로, 변환을 함수 안에서 빼고 params 경로에만 재배치하는 작은 구조 조정(S6)이 필요하다. "어느 호출자가 어떤 타입 계약을 요구하나"를 추론으로 분리해야 하므로 S2가 dominant.
- **K-Domain**: py2/py3 string 이원성, native string 계약, requests의 prepare 파이프라인 내부 지식이 병목.
- **primary = T-ConstraintReason**: 위치는 쉽게 찾지만 "두 호출자의 상충하는 타입 불변식을 분리"하는 의미 추론이 본질.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일 1개(`requests/models.py`), 변경 2헌크 ~5줄로 소규모.
- `has-repro`: 네이티브 재현 코드 + 회귀 도입 PR 링크 → 강한 easiness 신호.
- 그러나 단순 1줄 삭제로 끝나지 않는다. `_encode_params`를 공유하는 두 호출 경로의 충돌을 인지하고 변환을 옮겨야 하므로 `regression-trap`이 실재한다. naive하게 `to_native_string`만 제거하면 params 인코딩 회귀(예: `test_params_bytes_are_encoded`)를 일으킬 수 있다.
공식 라벨("15 min - 1 hour")과 정합. L0급 픽스(T2)로 보일 수 있으나, "그냥 삭제"가 회귀를 부르는 함정 때문에 T3로 올린다.

## 골드패치 분석
- **파일/함수**: `requests/models.py` — `PreparedRequest._encode_params`(staticmethod)와 `PreparedRequest.prepare_url`.
- **근본원인**: 이슈 #2844 픽스가 `_encode_params`의 `isinstance(data, (str, bytes))` 분기에 `return to_native_string(data)`를 넣었다. 이 함수는 body 인코딩 경로에서도 호출되는데, py3에서 bytes body가 들어오면 `to_native_string`이 bytes를 str로 디코딩/변환해 페이로드를 손상시킨다.
- **수정요지**:
  1. `_encode_params`의 분기를 `return to_native_string(data)` → `return data`로 되돌려, 들어온 str/bytes를 그대로 통과시킨다(body 안전).
  2. `to_native_string` 변환이 정말 필요한 곳은 URL 파라미터 경로뿐이므로, `prepare_url`에서 `_encode_params(params)` 호출 직전에 `if isinstance(params, (str, bytes)): params = to_native_string(params)`를 추가한다.
  결과적으로 native-string 강제는 params에만 국소화되고 body는 원본 바이트를 보존한다.

## 검증 (test_patch)
- **FAIL_TO_PASS** (1개): `test_binary_put` — `requests.Request('PUT', url, data=u"ööö".encode("utf-8")).prepare()` 후 `assert isinstance(request.body, bytes)`. 픽스 전에는 `_encode_params`가 `to_native_string`으로 body를 str화해 단언 실패. 픽스 후 `return data`로 bytes가 보존되어 통과.
- **픽스 증명**: body 경로가 변환을 거치지 않으므로 bytes → bytes 항등. params 경로는 `prepare_url`에서 별도 변환을 받으므로 기존 동작 유지.
- **overfit/regression 관점**: FAIL_TO_PASS는 1개로 얇지만, 핵심 회귀 가드는 PASS_TO_PASS `test_params_bytes_are_encoded`(`params=b'test=foo'` → `'?test=foo'`)가 담당한다. 이 테스트가 "params 경로 native-string 보존"을 강제하므로, 변환을 prepare_url로 옮기지 않고 단순 삭제했다면 깨진다 — special-case overfit을 구조적으로 차단. 90개 P2P가 넓은 prepare 파이프라인을 커버해 regression-trap을 완화.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "calling to_native_string" + #2844 링크 → `grep -n to_native_string requests/models.py`로 `_encode_params`의 `isinstance(data, (str, bytes))` 분기를 즉시 지목. "binary payload" = body 경로임을 인지.
2. **픽스**: 그 분기를 `return data`로 환원. 단, `to_native_string`이 도입된 이유(params를 native string으로 만들어 py2 `urlunparse`/`requote_uri`와 정합)를 보존하기 위해, 변환을 호출자인 `prepare_url`의 params 처리부로 이동. 이는 "body엔 해롭고 params엔 필요"라는 상충 불변식을 호출자별로 분리하는 올바른 일반화 — 어떤 특정 입력에만 맞춘 게 아니다.
3. **regression 안전**: `test_params_bytes_are_encoded`(bytes params 인코딩)와 `test_params_*` 계열을 안 깨야 한다. prepare_url에 변환을 재배치했기에 params 경로 native-string 계약이 유지된다. py2 인코딩 분기(`is_py2` 블록)는 건드리지 않아 부수효과 없음.
4. **함정 회피**: 오라클 없는 에이전트의 전형 실패는 (a) `_encode_params`에서 `to_native_string`만 삭제하고 끝내 params 회귀를 일으키거나, (b) body 분기에 `isinstance(data, bytes)` 같은 특수분기를 끼워 넣어 overfit하는 것. 올바른 회피법은 _encode_params가 **두 호출자(prepare_body/prepare_url)에 공유**됨을 먼저 확인하고, 변환 책임을 타입 계약이 필요한 호출자(prepare_url)로 끌어올리는 것이다.
