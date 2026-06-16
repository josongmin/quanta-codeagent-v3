---
instance_id: psf__requests-6028
repo: psf/requests
base_commit: 0192aac24123735b3eaf9b08df46429bb770c283
version: "2.27"
difficulty: "15 min - 1 hour"
created_at: 2022-01-04T15:32:52Z
fail_to_pass: 2
pass_to_pass: 185
gold_files: [requests/utils.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

requests 2.27.0에서 인증정보(`user:pass@`)가 포함된 프록시를 쓰면 `407 Proxy Authentication Required`가 발생한다. 2.26.0까지는 정상(200). 이슈 리포터가 직접 bisect해 PR #5924("Move from urlparse to parse_url for prepending schemes")가 원인임을 특정했고, `prepend_scheme_if_needed`에서 `urlunparse`로 넘어가는 `netloc`이 `user:pwd@host:port` → `host:port`로 바뀌어 auth가 유실됨을 확인했다. 즉 새 파서(`urllib3.parse_url`)는 auth를 `netloc`에 포함하지 않고 별도 필드로 분리하는데, 함수가 이를 다시 합치지 않은 것.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈 본문이 직접 함수를 지목하진 않지만, 리포터의 bisect가 커밋과 파일(`requests/utils.py`)을, 추가 코멘트가 함수명(`prepend_scheme_if_needed`)과 정확한 변수(`auth`/`netloc`)까지 짚어준다. grep 한 방까진 아니나 후보는 단일 함수로 즉시 수렴. 사실상 L0에 가까운 L1.
- **S2 (Constraint-Reasoning)**: 고칠 지점은 명확하나, `parse_url`이 auth를 분리한다는 불변식을 이해하고 `urlunparse`가 기대하는 `netloc=user:pass@host:port` 형식을 정확히 재합성해야 한다. 픽스가 "체크 추가"의 기계적 템플릿이 아니라 파서 계약 차이를 메우는 의미 추론.
- **K-Domain (Domain-bound)**: urllib3 `parse_url` vs stdlib `urlparse`의 `netloc` 정의 차이, `urlunparse`의 6-튜플 의미 등 라이브러리 내부 계약 지식이 병목. 일반 파이썬 추론만으론 "왜 auth가 사라졌는지" 설명 불가.
- **primary = T-ConstraintReason**: 위치는 잡혀 있고(L1) overfit 위험도 낮으나, 올바른 식(`'@'.join([auth, netloc])`)을 파서 계약 추론으로 합성하는 것이 본질. 그래서 S3(다후보 G&V)나 S1(템플릿)이 아니라 S2.

## 난이도 티어

**T3 (중간)**. 구조적 피처: 단일 파일·단일 함수·4줄 추가로 patch scope는 T1~T2급이지만, 핵심 난점이 "파서 계약 차이를 추론"하는 데 있어 단순 가드 추가가 아니다. 공식 라벨도 "15분-1시간"으로 T2~T3 경계. **has-repro**(명확한 bisect + 변수 수준 진단)가 강한 easiness 신호라 아래로 당기지만, K-Domain(파서 계약)과 `regression-trap`(145개 P2P, 특히 인접 `prepend_scheme_if_needed`/`urldefragauth`/`select_proxies`/`get_auth_from_url` 케이스를 안 깨야 함)이 위로 밀어 **T3**로 수렴. 공식 difficulty와 일치하나, "이슈가 사실상 답을 적어줬다"는 점에서 실측 난이도는 T3 하단.

## 골드패치 분석

- **파일·함수**: `requests/utils.py` 의 `prepend_scheme_if_needed(url, new_scheme)`.
- **근본원인**: PR #5924가 `urlparse` → `urllib3.parse_url`로 전환하면서 파서의 `netloc` 정의가 달라졌다. `urlparse`의 `netloc`은 auth를 포함(`user:pass@host:port`)하지만, `parse_url`은 `scheme, auth, host, port, path, query, fragment`로 **auth를 별도 필드로 분리**한다. 함수는 `auth`를 언패킹만 하고 사용하지 않은 채 `netloc`(auth 없는 `host:port`)만 `urlunparse`에 넘겨, 결과 URL에서 인증정보가 통째로 소실. 프록시 단계에서 자격증명이 빠져 407.
- **수정요지**: `netloc`을 `urlunparse`에 넘기기 전, `auth`가 있으면 다시 결합:
  ```python
  if auth:
      # parse_url doesn't provide the netloc with auth
      # so we'll add it ourselves.
      netloc = '@'.join([auth, netloc])
  ```
  `if not netloc:` swap 직후·`if scheme is None:` 직전에 삽입해, netloc 복원이 끝난 상태에서 auth를 붙인다.

## 검증 (test_patch)

- **FAIL_TO_PASS (2개)**: `test_prepend_scheme_if_needed` 파라미터에 `http://user:pass@example.com/path?query`(user+pass)와 `http://user@example.com/path?query`(user만) 두 케이스가 추가되어, 입력=출력(scheme 이미 있음) 동일성을 검사. 픽스 전엔 auth가 누락된 `http://example.com/path?query`가 반환돼 실패, 픽스 후엔 auth가 보존돼 통과.
- **픽스 증명**: 두 케이스가 user:pass와 user-only를 모두 커버하므로 `'@'.join([auth, netloc])`가 양쪽 auth 형태에서 정확히 복원됨을 보장.
- **overfit 관점**: 픽스가 입력값 하드코딩이 아니라 `auth` 필드 일반 결합이라 overfit-risk 낮음. 다만 빈 password·특수문자 인코딩(`%`) 케이스는 직접 검증되지 않으나, 기존 `get_auth_from_url` P2P가 인코딩 경로를 별도로 지켜줌.
- **regression 관점**: 145개 P2P 중 auth 없는 기존 3케이스(`example.com/path`, `//example.com/path`, `example.com:80`)는 `if auth:`가 거짓이라 무변경 — guard가 정확히 새 경로만 활성화해 회귀 0.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈는 "프록시 407"이지만 본문보다 코멘트 신호가 결정적이다 — 리포터 bisect가 커밋 `ef59aa0`("Move from urlparse to parse_url")과 `requests/utils.py`를, 후속 진단이 `prepend_scheme_if_needed`의 `urlunparse` 인자 `netloc`이 auth를 잃는다고 명시. 따라서 `requests/utils.py`의 해당 함수로 직행, `parsed = parse_url(url)` 언패킹에서 `auth`가 뽑히지만 이후 미사용임을 확인.
2. **픽스와 일반화 근거**: `urlunparse`에 넘기는 `netloc`에 `auth`를 재결합. `parse_url`이 auth를 분리하는 건 모든 auth 포함 URL에 대한 구조적 사실이므로, `if auth: netloc = '@'.join([auth, netloc])`는 특정 입력이 아닌 파서 계약 자체를 보정 → 올바른 일반화. `if auth` 가드는 auth 없는 URL의 `@` 오염을 막는 필수 조건.
3. **regression 안전**: auth 없는 기존 P2P(`example.com/path` 등)는 가드가 거짓이라 byte-identical. 인접 함수 계약(`select_proxies`, `urldefragauth`, `get_auth_from_url`)은 손대지 않으므로 그 P2P군도 무영향. 삽입 위치를 `if not netloc:` netloc/path swap **이후**로 둬, 복원된 netloc에 auth를 붙이는 순서를 지키는 게 핵심.
4. **함정 회피**: (a) auth를 host/port 분리 필드(`'%s:%s' % (host, port)`)로 재조립하려다 포트 None·IPv6 케이스에서 형식이 깨질 수 있음 — `parse_url`이 이미 만든 `netloc`을 재사용하고 auth만 prepend하는 게 안전. (b) 픽스를 redirect/proxy 처리 상위 호출부(`adapters`, `sessions`)에서 시도하면 diffuse해지고 회귀 위험↑ — 진짜 결함은 단일 함수의 누락된 결합이다. (c) `if auth:` 가드를 빠뜨리면 auth 없는 URL이 `@host:port`로 오염돼 기존 3 P2P가 깨진다.
