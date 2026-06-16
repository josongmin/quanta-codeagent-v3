---
instance_id: psf__requests-1142
repo: psf/requests
base_commit: 22623bd8c265b78b161542663ee980738441c307
version: "1.1"
difficulty: "<15 min fix"
created_at: 2013-01-25T05:19:16Z
fail_to_pass: 1
pass_to_pass: 5
gold_files: [requests/models.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`requests.get()`이 GET 요청에 항상 `Content-Length` 헤더를 붙인다(이전 issue #957 "모든 요청에 Content-Length 부착"의 부작용). body가 없는 GET/HEAD에도 `Content-Length: 0`이 들어가서, amazon.com 같은 일부 서버가 503으로 거부한다. 관습적으로 대부분의 UA는 body 없는 GET에 Content-Length를 보내지 않으므로, GET/HEAD의 빈 body 케이스에서는 헤더를 생략해야 한다.

## 유형 (정형화)

- **L0 (Pinpointed)**: 헤더명 `Content-Length`로 grep → `prepare_content_length`가 유일 후보. 이슈가 issue #957까지 직접 지목해 원인 코드를 사실상 가리킴. 탐색 비용 거의 0.
- **S2 (Constraint-Reasoning)**: 고칠 지점은 자명하나, "언제 헤더를 빼야 하나"라는 **조건식을 추론으로 합성**해야 한다. 단순 라인 삭제가 아니라, body가 실재할 때는 보존하고 빈 body+GET/HEAD일 때만 생략하는 분기 재배치가 핵심. 무조건 삭제는 POST 등을 깨므로 S1(기계적) 아님.
- **K-Domain**: HTTP 메서드 시맨틱(GET/HEAD는 body 없음이 관례) 지식이 분기 조건을 결정. 일반 파이썬 추론만으로는 어느 메서드를 예외로 둘지 못 정함.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 올바른 `elif self.method not in ('GET','HEAD')` 조건을 의미적으로 합성하는 것이 본질.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처: 1파일(`requests/models.py`)·단일 함수·실질 2줄 변경, `has-repro`(amazon 503 재현 + 버전 명시). localize 직접성 최상(L0). 다만 단순 가드 추가가 아니라 분기 순서·조건을 따져야 해 T1(존나쉬움)은 아니다. 공식 라벨 `<15 min fix`와 정합. `regression-trap`은 가벼움(P2P 5개로 좁음)이라 T3로 올리지 않음 — body 있는 케이스 보존만 지키면 됨.

## 골드패치 분석

- **파일·함수**: `requests/models.py`의 `PreparedRequest.prepare_content_length(self, body)`.
- **근본원인**: 함수 첫 줄이 무조건 `self.headers['Content-Length'] = '0'`을 세팅했다. seekable body나 `body is not None`이면 뒤에서 실제 길이로 덮어쓰지만, body가 없는 GET/HEAD에서는 `'0'`이 그대로 남아 항상 헤더가 붙었다.
- **수정요지**: 무조건 `'0'` 세팅 줄을 제거하고, 기존 `if hasattr(seek/tell)` / `elif body is not None` 체인 끝에 `elif self.method not in ('GET', 'HEAD'): self.headers['Content-Length'] = '0'`를 추가. 즉 빈 body의 `'0'` 디폴트를 **GET/HEAD가 아닐 때만** 적용하도록 게이트.

## 검증 (test_patch)

- **FAIL_TO_PASS** `test_no_content_length`: `requests.Request('GET'...).prepare()`와 `'HEAD'` 각각에 대해 `'Content-Length' not in headers`를 assert. 패치 전엔 첫 줄이 `'0'`을 박아 실패, 패치 후엔 두 메서드가 `not in (...)` 분기에서 제외되어 헤더 미세팅 → 통과.
- **픽스 증명**: 빈 body + GET/HEAD → 어느 분기에도 안 걸려 헤더 부재. 이것이 정확히 테스트가 요구하는 동작.
- **overfit/regression 관점**: FAIL_TO_PASS는 1개로 얇지만, body가 실재하는 경로(seekable / `len(body)`)는 패치가 건드리지 않아 보존된다. `test_basic_building`(`pr.body == 'life=42'`) 등 P2P가 body 있는 케이스를 커버. overfit 위험은 낮음 — 일반 솔루션(메서드 시맨틱 기반)이라 GET/HEAD 전반에 일반화됨. 단 PUT/POST 빈 body의 `'0'` 보존이 깨지면 안 되는데 패치가 이를 정확히 유지.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 `Content-Length`와 "issue #957에서 추가됨" 신호 → 헤더 부착 코드 grep → `prepare_content_length` 단일 함수. L0이므로 탐색 1회.
2. **픽스**: 무조건 `Content-Length='0'` 첫 줄을 제거하고, body가 없는 케이스의 `'0'` 디폴트를 `elif self.method not in ('GET','HEAD')` 분기로 한정. 올바른 일반화인 이유 — "빈 body GET/HEAD엔 Content-Length 미전송"이라는 HTTP UA 관습을 메서드 차원에서 구현하므로 amazon 특정 케이스가 아니라 전 GET/HEAD에 적용된다.
3. **regression 안전**: seekable body와 `body is not None`(len 기반) 분기를 그대로 둬야 한다. POST/PUT 등 body 있는 요청과 명시적 빈 body(non-GET/HEAD) 요청의 Content-Length는 유지되어야 하며, `test_basic_building`이 이를 지킴.
4. **함정 회피**: 오라클 없는 에이전트는 "첫 줄만 삭제"하기 쉬운데, 그러면 빈 body의 모든 메서드에서 `'0'`이 사라져 POST 등의 계약을 깬다. 또는 분기 끝이 아니라 함수 진입부에 메서드 가드를 두면 body 있는 GET(드물지만 합법)에서 실제 길이 세팅을 막을 수 있다. 정답은 **체인의 마지막 elif**로 두어 "body 있으면 길이, 없고 GET/HEAD 아니면 0, 그 외엔 무헤더" 순서를 보장하는 것.
