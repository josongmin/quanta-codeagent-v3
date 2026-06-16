---
instance_id: pylint-dev__pylint-4661
repo: pylint-dev/pylint
base_commit: 1d1619ef913b99b06647d2030bddff4800abdf63
version: "2.10"
difficulty: "15 min - 1 hour"
created_at: 2021-07-03T00:57:06Z
fail_to_pass: 1
pass_to_pass: 0
gold_files: [pylint/config/__init__.py, setup.cfg]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S1)
knowledge: K-Domain
flags: [overfit-risk, underspecified]
---

## 문제 요약
pylint이 데이터(stats 파일)를 홈 디렉터리의 `.pylint.d`에 저장해 홈을 더럽힌다. XDG Base Directory Specification을 따라 적절한 표준 위치로 옮겨달라는 요청이다. 이슈 본문은 `$HOME/.local/share/<PROGRAM>`을 언급하지만, hints에서 메인테이너들이 `appdirs` 패키지 통합과 `~/.cache` 사용을 논의하며 최종 의도(캐시 디렉터리 사용 + appdirs 위임)를 확정한다.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈에 심볼 직접 지목은 없으나 `PYLINTHOME`/`.pylint.d` 키워드로 `pylint/config/__init__.py`의 `PYLINT_HOME` 상수 정의로 바로 수렴한다. grep 한두 방. 단일 로직 파일 + 보조 설정파일(`setup.cfg`).
- **S (Strategy) = S5 (+S1)**: 핵심은 "어디로 옮기나"가 코드만으로 결정되지 않는다는 점. 이슈는 `~/.local/share`를 제시했지만 실제 정답은 `appdirs.user_cache_dir("pylint")`(즉 `~/.cache`)다. 의도된 동작을 hints 토론(데이터 비-crucial → cache가 적절, appdirs로 OS별 위임)에서 **스펙으로 재구성**해야만 픽스가 결정된다(S5). 일단 스펙이 정해지면 상수 한 줄 치환은 기계적(S1 보조).
- **K = K-Domain**: XDG 규격 + `appdirs` API(`user_cache_dir` vs `user_data_dir`) + pylint 설정시스템 관례를 알아야 올바른 함수를 고른다.
- **primary = T-SpecInference**: 진짜 난점이 "어떤 식을 쓰나"가 아니라 "의도된 타깃 디렉터리 스펙을 이슈/토론에서 재구성"하는 데 있다. 위치는 쉽고 변경량도 작지만 정답이 본문과 어긋난다.

## 난이도 티어
**T3 (중간)**. 구조 피처: 로직 파일 1개 + 설정 1개, 실제 동작변경은 `PYLINT_HOME` 상수 1줄 치환 + import 1줄(<10줄). localize 직접성은 높음(L1). has-repro는 없고 P2P trap도 없다(PASS_TO_PASS=0). T1/T2로 내려가지 않는 이유는 **underspecified**: 이슈가 제시한 `~/.local/share`를 그대로 따르면 골드(`user_cache_dir`=`~/.cache`)와 불일치해 FAIL_TO_PASS를 통과 못 한다. 정답 디렉터리 선택이 도메인 추론(K-Domain)이라 단순 템플릿 픽스가 아니다. 공식 라벨 "15분-1시간"과 일치 — 구현은 짧지만 올바른 타깃 결정에 판단이 든다.

## 골드패치 분석
- **건드린 파일·함수**:
  - `pylint/config/__init__.py` — 모듈 레벨 `PYLINT_HOME` 상수 정의(USER_HOME 분기의 else 절)와 `import appdirs` 추가.
  - `setup.cfg` — `install_requires`에 `appdirs>=1.4.0`, isort `known_third_party`/mypy `ignore_missing_imports` 정비.
- **근본원인**: `PYLINT_HOME`의 기본값이 `os.path.join(USER_HOME, ".pylint.d")`로 하드코딩되어 XDG/OS 표준 위치를 무시.
- **수정요지**: else 분기를 `PYLINT_HOME = appdirs.user_cache_dir("pylint")`로 교체해 캐시 디렉터리 위임. 추가로 구 위치(`os.path.join(USER_HOME, ".pylint.d")`)가 존재하면 stderr로 "obsolescent ... you can safely remove" 마이그레이션 안내를 출력(데이터 손실 없이 하위호환). `USER_HOME == ""`/`"~"` 두 특수분기는 보존.

## 검증 (test_patch)
- **FAIL_TO_PASS**: `tests/lint/unittest_lint.py::test_pylint_home` 단 1개. 테스트의 기대값을 `os.path.join(uhome, ".pylint.d")` → `appdirs.user_cache_dir("pylint")`로 바꾸고 `config.PYLINT_HOME == expected`를 단언.
- **픽스 증명**: 테스트가 골드와 동일한 `appdirs.user_cache_dir("pylint")` 식을 그대로 oracle로 박아두어, 골드가 같은 함수를 호출해야만 통과. uhome=="~" 분기 보존도 함께 확인.
- **overfit·regression 관점**: `overfit-risk` 플래그 — FAIL_TO_PASS가 1개뿐이고 테스트가 정답 식을 그대로 미러링한다. 즉 테스트는 "appdirs를 호출했는가"만 검증하고 마이그레이션 print, setup.cfg 의존성, Windows/macOS 경로 차이는 검증하지 않는다(테스트가 oracle 식을 동어반복). regression은 PASS_TO_PASS=0이라 인접동작 깨짐 위험은 낮으나, 그만큼 테스트 신호가 얇아 다른 디렉터리(`user_data_dir`)로 풀면 적발되지만 그 외 품질 결함은 안 잡힌다.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 `.pylint.d`/`PYLINTHOME` 키워드 → `grep PYLINT_HOME pylint/` → `pylint/config/__init__.py`의 USER_HOME 3분기(빈문자/"~"/else) 발견. 변경점은 else 절 하나로 확정.
2. **픽스와 일반화**: 본문의 `~/.local/share`를 곧이곧대로 따르지 말 것. hints 토론(데이터=stats 파일로 비-crucial → 백업 대상인 data보다 `~/.cache`가 적절, OS별 경로는 `appdirs`로 위임)에서 의도를 재구성해 `appdirs.user_cache_dir("pylint")`를 선택하는 것이 올바른 일반화다. `appdirs` 위임은 Windows/macOS까지 한 번에 맞추므로 OS 분기 하드코딩보다 견고. 의존성을 `setup.cfg`에 선언해야 실제로 import 가능.
3. **regression 안전**: P2P가 비어 있지만 USER_HOME의 빈문자/`"~"` 두 특수분기(CWD-relative, home 없음)는 반드시 보존해야 한다 — else만 바꾸고 위 분기를 건드리면 안 됨. 기존 사용자의 데이터 유실을 막기 위해 구 디렉터리 존재 시 stderr 안내만 출력하고 자동 삭제/이동은 하지 않는 것이 하위호환 측면에서 안전.
4. **함정 회피**: (a) 이슈 본문의 `user_data_dir`(`~/.local/share`)로 풀면 테스트가 RED — oracle은 `user_cache_dir`다. 본문 ≠ 정답인 underspecified 함정을 hints로 해소해야 한다. (b) `import appdirs`만 추가하고 `setup.cfg` 의존성 선언을 빠뜨리면 환경에서 ImportError. (c) `appdirs` 없이 직접 `~/.cache` 경로를 조립하면 Windows에서 깨지고 oracle 식과도 불일치해 통과 못 함.
