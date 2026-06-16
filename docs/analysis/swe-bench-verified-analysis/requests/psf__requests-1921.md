---
instance_id: psf__requests-1921
repo: psf/requests
base_commit: 3c88e520da24ae6f736929a750876e7654accc3d
version: "2.3"
difficulty: "<15 min fix"
created_at: 2014-02-14T22:15:56Z
fail_to_pass: 6
pass_to_pass: 107
gold_files: [requests/sessions.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

문서상 `session.get(url, headers={'X': None})`처럼 요청 단위로 헤더를 None으로 두면 그 헤더가 전송에서 제외된다. 그러나 세션의 기본 헤더에 같은 방식으로 `session.headers['Accept-Encoding'] = None`을 설정하면 헤더가 빠지는 게 아니라 문자열 `"None"`이 값으로 그대로 전송된다. 즉 "None으로 헤더 unset" 규약이 request-level에는 적용되나 session-level 기본 헤더에는 적용되지 않는 비대칭 버그다.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈가 헤더 머지 동작을 직접 지목하지만 함수명까지 적어주진 않음. 힌트("a bug in how we merge the headers")로 `merge_setting`/`prepare_request` 경로를 좁히면 됨. grep 한 방은 아니고 짧은 추적 필요.
- **S2 (Constraint-Reasoning)**: 고칠 지점(merge 로직)은 명확하나, 기존 None-제거 루프가 `request_setting.items()`만 순회하는 불변식 누락을 추론해 "merge 결과 전체에서 None을 제거한다"는 올바른 일반화를 합성해야 함. 후보를 난사해 테스트로 맞추는 G&V가 아니라 의미적 결함을 짚는 수리.
- **K-Domain**: requests의 "None=헤더 unset" 규약과 session/request 설정 머지 시맨틱이라는 라이브러리 내부 계약 지식이 필요. 순수 파이썬 추론만으론 의도를 못 정함.

primary는 **T-ConstraintReason**: 위치는 좁게 잡히지만 픽스의 본질이 "None은 어느 출처(session vs request)든 최종 머지에서 제거되어야 한다"는 불변식 보정에 있기 때문.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처: 단일 파일(`requests/sessions.py`) 1함수, 추가 1줄(+빈줄)로 골드패치가 극소. 이슈에 명확한 재현 스니펫이 있어 **has-repro**(강한 easiness 신호). localize는 L1로 약간의 추적만 필요. 다만 S1 순수 기계적 가드가 아니라 "기존 루프가 왜 불충분한지"를 추론해야 해서 T1은 아니다. PASS_TO_PASS가 108개로 넓어 **regression-trap**이 존재 — 머지 동작을 건드리면 인접한 cookie/auth/redirect 머지 테스트를 깰 수 있어 한 단계 무게가 실린다. 공식 라벨 `<15 min fix`와 일치(개발자 구현시간 관점), tier는 그보다 한 칸 여유를 둔 T2.

## 골드패치 분석

- **파일·함수**: `requests/sessions.py`의 `merge_setting(request_setting, session_setting, dict_class=OrderedDict)`.
- **근본원인**: 기존 None 제거 로직이
  ```python
  for (k, v) in request_setting.items():
      if v is None:
          del merged_setting[k]
  ```
  처럼 **`request_setting`의 항목만** 순회한다. 따라서 None이 `session_setting`(=세션 기본 헤더)에서 온 경우 `merged_setting`에 None인 채 남아, 이후 prepare 단계에서 `str(None)` → `"None"`으로 직렬화된다.
- **수정요지**: 출처와 무관하게 머지 결과 전체에서 None을 거르는 한 줄을 추가.
  ```python
  merged_setting = dict((k, v) for (k, v) in merged_setting.items() if v is not None)
  ```
  이로써 session 기본값으로 들어온 None도 최종 헤더 dict에서 제외되어 전송되지 않는다.

## 검증 (test_patch)

- **FAIL_TO_PASS 핵심 동작**: 신규 `test_headers_on_session_with_None_are_not_sent` — `ses.headers['Accept-Encoding'] = None` 후 `ses.prepare_request(req)`를 호출해 `assert 'Accept-Encoding' not in prep.headers`를 확인. 픽스 전엔 키가 `"None"` 값으로 남아 실패, 픽스 후엔 머지 필터가 키를 제거해 통과. 나머지 5개(DIGESTAUTH/POSTBIN/netrc/cookie/uppercase-redirect)는 동일 환경/세션 픽스처를 공유하는 네트워크성 테스트로, 신규 테스트와 함께 그린이 되는 동반 항목.
- **overfit 관점**: 픽스가 특정 헤더명을 하드코딩하지 않고 `v is not None` 일반조건으로 처리 → 테스트는 `Accept-Encoding` 하나만 보지만 구현은 임의 헤더에 일반화. special-case 통과가 아니라 올바른 일반화라 overfit-risk 낮음.
- **regression 관점**: 108개 PASS_TO_PASS가 머지(cookie/auth/hooks/redirect) 동작 전반을 커버. 추가 필터는 None 값만 제거하고 비-None은 보존하므로 `test_request_cookie_overrides_session_cookie`, `test_header_remove_is_case_insensitive`, `test_session_hooks_*` 등 기존 머지 의미를 안 깬다.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 "`Accept-Encoding: None`이 전송된다" + 메인테이너 힌트("bug in how we merge the headers")를 신호로 잡아 `sessions.py`의 헤더 머지 경로를 추적. `prepare_request` → `merge_setting`로 좁히고, None 제거 루프가 `request_setting.items()`만 도는 것을 발견.
2. **픽스**: 루프를 고치기보다 머지 완료 직후 `merged_setting`을 `v is not None`으로 한 번 더 필터링. 이는 "None=unset" 규약이 session/request 어느 출처든 동일하게 적용되어야 한다는 불변식을 반영하므로, 헤더명에 독립적인 올바른 일반화다(특정 키 하드코딩=overfit을 회피).
3. **regression 안전**: 비-None 값은 그대로 두므로 기존 머지(쿠키/훅/auth 오버라이드, case-insensitive 헤더 제거)는 불변. 광범위한 P2P(108개)가 이를 보증.
4. **함정 회피**: 오라클 없는 에이전트가 빠지기 쉬운 함정 — (a) 기존 `request_setting` 루프를 `session_setting`도 도는 두 루프로 만드는 과잉/중복 수정(머지 후 단일 필터가 더 간결·정확), (b) `prepare_headers`나 모델 직렬화 측에서 `Accept-Encoding`만 특수처리하는 국소 패치(다른 헤더에 일반화 실패=overfit), (c) None을 빈 문자열로 치환해 키를 남기는 오답(테스트는 키 부재를 요구). 정답은 머지 단계에서 출처 무관 None 제거라는 단일 지점 보정.
