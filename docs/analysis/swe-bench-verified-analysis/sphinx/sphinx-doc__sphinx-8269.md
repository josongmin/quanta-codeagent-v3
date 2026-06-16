---
instance_id: sphinx-doc__sphinx-8269
repo: sphinx-doc/sphinx
base_commit: 1e2ccd8f0eca0870cf6f8fce6934e2da8eba9b72
version: "3.3"
difficulty: "<15 min fix"
created_at: 2020-10-03T11:08:37Z
fail_to_pass: 1
pass_to_pass: 5
gold_files: [sphinx/builders/linkcheck.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`linkcheck` 빌더는 `linkcheck_anchors=True`일 때, 서버가 404/500 같은 에러 상태코드를 돌려줘도 항상 "Anchor not found"라고만 보고한다. 실제 근본 원인(HTTP 에러)을 가린다. 기대 동작은 `linkcheck_anchors=False`일 때와 동일하게 HTTP 상태 에러(`404 Client Error ...`, `500 Server Error ...`)를 그대로 broken 사유로 보고하는 것이다. 이슈에 재현 절차와 actual/expected 출력이 명확히 적혀 있다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `linkcheck`/`linkcheck_anchors` 키워드로 단일 파일 `sphinx/builders/linkcheck.py`의 `check_uri()`로 바로 수렴. 파일은 자명하나 anchor 분기(`if anchor and self.app.config.linkcheck_anchors`)를 짚는 데 약간의 코드 독해가 든다 → L0가 아닌 L1.
- **S2 (Constraint-Reasoning)**: 고칠 지점은 좁지만, "anchor 검사 *전에* HTTP 상태를 먼저 검증해야 한다"는 순서 불변식을 추론해야 한다. else 분기는 이미 `raise_for_status()`를 부르는데 anchor 분기는 누락 — 두 경로의 에러처리 불변식을 일치시키는 의미적 추론. 무작정 후보를 던지는 G&V가 아님.
- **K-Domain**: `requests`/`raise_for_status()`가 `HTTPError`를 던지고, 그게 상위 `except HTTPError`로 잡혀 `'broken', str(err)`로 분류된다는 sphinx linkcheck 내부 제어흐름을 알아야 픽스가 옳음을 확신할 수 있다. 순수 일반추론(K-Gen)보단 도메인 결.
- **primary = T-ConstraintReason**: 위치는 명확(L1)하나 픽스의 핵심이 "상태검증→anchor검사" 순서라는 조건 합성에 있다. 한 줄짜리지만 기계적 가드(T-DirectMap)가 아니라, 두 분기의 에러 불변식을 맞추는 추론이 본질.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 1파일·실질 +1줄(헌크 단일), `has-repro`(재현절차+expected 출력 명시)로 가장 강한 easiness 신호. localize는 거의 직접적이고 도메인 깊이는 얕다. 공식 라벨 `<15 min fix`와 일치 — prior와 어긋나지 않는다. T1로 내리지 않은 이유: 픽스가 "어디에 한 줄을 넣느냐(GET 직후, anchor 검사 직전)"의 위치 추론과 `raise_for_status()` 호출이라는 도메인 호출을 요구해서, 이슈가 픽스를 그대로 적어주는 T1 프로파일은 아니다. P2P 5개(`test_defaults`, `test_anchors_ignored`, `test_auth` 등)가 인접 linkcheck 동작이라 약한 `regression-trap`이 있으나 신규 호출이 정상(200) 경로엔 무해해 위험은 낮다.

## 골드패치 분석
- **파일·함수**: `sphinx/builders/linkcheck.py` 내 `check_uri()`의 anchor 분기.
- **근본 원인**: `linkcheck_anchors=True`일 때 실행되는 분기는
  ```python
  response = requests.get(req_url, stream=True, ...)
  found = check_anchor(response, unquote(anchor))
  if not found:
      raise Exception(__("Anchor '%s' not found") % anchor)
  ```
  로, GET 응답의 HTTP 상태를 전혀 검사하지 않는다. 404/500이면 에러 페이지 본문에 anchor가 없으니 `check_anchor`가 False → "Anchor not found" 예외로 잘못 보고된다. 반면 else(비-anchor) 분기는 HEAD/GET 후 `response.raise_for_status()`를 호출해 HTTP 에러를 `HTTPError`로 정상 보고한다.
- **수정 요지**: anchor 분기에서 GET 직후 `check_anchor` 호출 *전에* `response.raise_for_status()` 한 줄 추가. 이로써 에러 상태는 `HTTPError`로 던져져 상위 `except HTTPError`가 `'broken', str(err)`(또는 401→working, 503→ignored)로 분류하고, anchor 검사는 2xx 응답에서만 의미를 갖게 된다. 두 분기의 에러처리 불변식이 동일해진다.

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_raises_for_invalid_status`: 항상 500을 반환하는 로컬 `HTTPServer`(`InternalServerErrorHandler`)를 스레드로 띄우고, `linkcheck_anchors=True` 환경(`test-linkcheck-localserver`)에서 `http://localhost:7777/#anchor`를 빌드. `output.txt`가 정확히 `index.rst:1: [broken] ...: 500 Server Error: Internal Server Error for url: http://localhost:7777/`를 담아야 통과. 픽스 없으면 "Anchor 'anchor' not found"가 나와 실패 → 픽스 후 `raise_for_status()`가 `HTTPError`를 던져 정확한 문구가 나온다.
- **overfit 관점**: 단일 F2P지만 검증이 실제 HTTP 서버를 띄워 상태코드 경로를 관통하므로 special-case 통과가 어렵다. 픽스 자체가 표준 `raise_for_status()`라 500에 국한되지 않고 4xx/5xx 일반에 적용 → 올바른 일반화.
- **regression 관점**: P2P 5개는 정상(200) 응답과 anchor-ignore/auth/header 경로를 검증. `raise_for_status()`는 2xx에서 no-op이라 이들 통과 경로를 깨지 않는다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "linkcheck", "linkcheck_anchors", "Anchor not found" 문구 → `sphinx/builders/linkcheck.py` `check_uri()`로 grep. anchor 분기(`if anchor and self.app.config.linkcheck_anchors`)와 else 분기를 나란히 읽어 **else는 `raise_for_status()`를 부르고 anchor 분기는 안 부른다**는 비대칭을 발견.
2. **픽스와 일반화 근거**: anchor 분기의 `requests.get(...)` 직후, `check_anchor` 호출 *앞*에 `response.raise_for_status()` 추가. expected 출력이 "linkcheck_anchors=False와 동일"이라 했으므로 else 분기와 동일한 메커니즘(`HTTPError`→상위 except 분류)을 재사용하는 게 정확히 의도와 일치. 모든 에러 상태에 일반적이라 overfit 아님.
3. **regression 안전**: 정상 링크(2xx)에서 `raise_for_status()`는 아무것도 안 하므로 `test_defaults`/`test_anchors_ignored`/`test_auth`/`test_linkcheck_request_headers`를 보존. 401/503의 특수 처리(`working`/`ignored`)는 상위 except에서 이미 분기되므로 그대로 유지된다.
4. **함정 회피**: (a) "Anchor not found 메시지를 고쳐라"로 오독해 메시지 포맷만 바꾸면 근본 원인(HTTP 에러 은폐)을 못 잡는다 — 상태 검증이 anchor 검사보다 *앞서야* 함을 놓치는 게 핵심 함정. (b) `raise_for_status()`를 `check_anchor` *뒤*에 넣으면 순서 불변식이 깨져 여전히 anchor 우선 보고가 될 수 있다. (c) else 분기를 손대 중복 호출을 만드는 과교정 회피. 최소 변경은 anchor 분기 단 한 줄.
