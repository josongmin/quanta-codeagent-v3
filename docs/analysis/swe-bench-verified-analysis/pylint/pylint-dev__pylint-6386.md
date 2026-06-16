---
instance_id: pylint-dev__pylint-6386
repo: pylint-dev/pylint
base_commit: 754b487f4d892e3d4872b6fc7468a71db4e31c13
version: "2.14"
difficulty: "15 min - 1 hour"
created_at: 2022-04-19T06:34:57Z
fail_to_pass: 1
pass_to_pass: 7
gold_files: [pylint/config/argument.py, pylint/config/arguments_manager.py, pylint/config/utils.py, pylint/lint/base_options.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [has-repro, regression-trap, cross-file-dep]
---

## 문제 요약

`verbose` 옵션의 짧은 플래그 `-v`가 argparse에서 인자를 요구해 `pylint mytest.py -v`가 `error: argument --verbose/-v: expected one argument`로 죽는다. 긴 형태 `--verbose`는 인자 없이 정상 동작한다. 또한 help 메시지가 `VERBOSE`라는 값을 받는 것처럼 표시되는 부수 결함도 함께 보고됐다.

## 유형 (정형화)

- **L = L3 (Multi-site)**: 단일 한 줄이 아니라 4개 파일을 **조율해서** 함께 바꿔야 한다. preprocess 진입 게이트(`utils.py`), metavar 전달 경로(`argument.py` → `arguments_manager.py`), 옵션 정의(`base_options.py`)가 서로 맞물려야 픽스가 성립한다.
- **S = S2 (+S6)**: 고칠 지점들을 알면 식이 자명하진 않다. `-v`가 왜 인자를 요구하는지 — verbose 옵션의 action은 `store_true`가 아니라 `_DoNothingAction`(`_CallbackAction(argparse.Action)`)이고, `_CallbackAction`이 `nargs=0`을 설정하지 않아 argparse 기본값대로 '정확히 1개 인자'를 요구한다. `--verbose`는 preprocess가 PREPROCESSABLE로 잡아 processed_args에서 소비/제거해 argparse가 아예 보지 못하므로 에러가 안 나지만, `-v`는 게이트(`startswith("--")`)에 걸려 preprocess를 통과 못 하고 본파싱에 도달해 'expected one argument'를 낸다 — 이 인과를 추론으로 합성해야 한다. metavar=`""`로 빈 문자열을 흘려보내는 신규 필드 도입은 작은 구조 변경(S6)이다.
- **K = K-Domain**: argparse의 nargs/store_true/metavar 의미론과 pylint 자체의 `_Argument`/preprocess 2단 파싱 아키텍처를 알아야 한다.
- **primary = T-ConstraintReason**: 위치는 키워드로 좁혀지나, 진짜 난점은 "왜 짧은 플래그만 인자를 먹는가"의 인과를 따져 올바른 조건/전달경로를 합성하는 데 있다.

APR 관점: 이슈가 픽스를 명세하지 않고(템플릿 매칭 불가) 동작 불변식("`-v`는 `--verbose`와 동일")을 코드 경로 추론으로 충족해야 하므로 SemFix/Angelix 계열 constraint-reasoning이다.

## 난이도 티어

**T4 (약간 어려움)**. 구조적 피처: 4파일·5헌크지만 각 헌크는 작다(파일당 1~2줄 추가). repro는 네이티브 에러 메시지로 존재(easiness 신호)하나, **localize 직접성이 낮다** — `-v` 키워드만으로 `_preprocess_options`의 `startswith("--")` 게이트와 PREPROCESSABLE 딕셔너리 양쪽을 동시에 찾아야 한다. P2P에 `test_unknown_short_option_name` 등 단축옵션 파싱 인접 테스트가 있어 **regression-trap**이 실재한다(`"--"` → `"-"` 완화가 다른 단축옵션 처리를 깨면 안 됨). cross-file-dep(metavar가 argument→manager→base_options 3홉). 공식 difficulty "15분-1시간"과 정합 — 변경량은 작으나 멀티사이트 조율이 시간을 먹는다.

## 골드패치 분석

- `pylint/config/utils.py`: (1) PREPROCESSABLE_OPTIONS에 `"-v": (False, _set_verbose_mode)` 추가 — 짧은 플래그도 preprocess에서 verbose로 인식. (2) `_preprocess_options`의 `if not argument.startswith("--")`를 `startswith("-")`로 완화해 단축 플래그가 게이트를 통과하게 함. (3) `_convert_option_to_argument`에 `metavar=optdict.get("metavar", None)` 전달.
- `pylint/config/argument.py`: `_CallableArgument`(line 443~)의 `__init__`에 `metavar: str` 파라미터와 `self.metavar` 필드 추가. (`_StoreTrueArgument`는 line 248의 별개 클래스로 이 패치에서 건드려지지 않는다 — 패치 컨텍스트의 `flags/action/arg_help/kwargs/hide_help/section` + `self.action`/`self.kwargs`가 `_CallableArgument`에만 일치한다.)
- `pylint/config/arguments_manager.py`: `_add_parser_option`에서 argparse `add_argument(... metavar=argument.metavar)` 전달.
- `pylint/lint/base_options.py`: `_make_run_options`의 verbose / enable-all-extensions 옵션 dict에 `"metavar": ""` 추가.

근본원인: 짧은 verbose가 preprocess의 `--` 전용 게이트에 걸려 verbose-mode 사전처리에서 누락 → argparse 본파싱까지 흘러가며 인자를 요구. 부가로 metavar가 없어 help가 `VERBOSE`를 표시. 수정요지: preprocess 게이트를 단축까지 넓히고 `-v`를 등록, metavar를 빈 문자열로 명시해 help 표시 정리.

## 검증 (test_patch)

FAIL_TO_PASS `test_short_verbose`: `Run([EMPTY_MODULE, "-v"], exit=False)` 후 stderr에 `"Using config file"`이 있는지 확인. `-v`가 더 이상 인자 에러로 죽지 않고 verbose 모드로 진입해야 통과한다. 픽스 증명: PREPROCESSABLE에 `-v` 등록 + 게이트 완화로 `_set_verbose_mode`가 호출돼 verbose 출력이 발생.

overfit 관점: 테스트가 `"Using config file"` 문자열 1건만 보므로 **overfit-risk는 존재하나 낮다** — 단순 try/except로 `-v`만 삼키는 special-case로도 통과 가능하지만, 골드는 일반 경로(PREPROCESSABLE+게이트)로 풀어 다른 단축 플래그에도 일관. regression 관점: `"--"`→`"-"` 완화가 P2P의 `test_unknown_short_option_name`/`test_unknown_option_name` 등 미지 옵션 에러 경로를 안 깨야 한다(PREPROCESSABLE 미매칭 시 passthrough 유지되므로 안전).

## 모범답안 (오라클 기반)

1. **localize 경로**: 에러 `argument --verbose/-v: expected one argument`와 "긴 옵션은 OK"라는 비대칭 단서 → verbose 정의(`base_options.py` `_make_run_options`)와 단축/장축이 갈리는 사전처리(`config/utils.py` `_preprocess_options` + `PREPROCESSABLE_OPTIONS`)로 수렴. `--verbose`만 딕셔너리에 있고 게이트가 `startswith("--")`인 두 사실이 인과의 핵심.
2. **픽스와 일반화**: `-v`를 PREPROCESSABLE에 등록하고 게이트를 `startswith("-")`로 넓힌다. 이는 `-v`만 하드코딩하는 special-case가 아니라 "단축 플래그도 사전처리 대상"이라는 일반 규칙이라 올바른 일반화다. metavar=`""`는 help 표시 결함(부수보고)까지 정조준.
3. **regression 안전**: P2P 단축/미지 옵션 테스트군이 깨지면 안 된다. 게이트 완화 후에도 PREPROCESSABLE 미매칭 인자는 그대로 passthrough되어 argparse가 동일하게 미지옵션 에러를 내므로 인접 동작 보존.
4. **함정 회피**: (a) `-v`만 `utils.py`에 넣고 게이트를 안 넓히면 `startswith("--")`에서 걸러져 여전히 실패 — 두 변경이 함께여야 함(멀티사이트 누락). (b) metavar 경로를 base_options에만 넣고 argument/manager 전달을 빠뜨리면 `add_argument`까지 안 닿아 무효(3홉 cross-file 누락). (c) argparse action을 `store_true`로 바꾸는 식의 과잉수정은 다른 verbose 소비처를 흔들 수 있어 회피.
