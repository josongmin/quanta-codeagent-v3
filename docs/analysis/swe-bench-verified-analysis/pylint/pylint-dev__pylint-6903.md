---
instance_id: pylint-dev__pylint-6903
repo: pylint-dev/pylint
base_commit: ca80f03a43bc39e4cc2c67dc99817b3c9f13b8a6
version: "2.15"
difficulty: "<15 min fix"
created_at: 2022-06-09T19:43:36Z
fail_to_pass: 1
pass_to_pass: 8
gold_files: [pylint/lint/run.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

## 문제 요약
K8s Pod에서 `pylint --jobs=0`을 실행하면 크래시한다. `pylint.lint.run._query_cpu()`가 cgroup 파일
(`/sys/fs/cgroup/cpu/cpu.shares` = 2)을 읽고 `int(cpu_shares / 1024)` = `int(2/1024)` = `0`을 반환한다.
이 0이 그대로 `multiprocessing.Pool(processes=0)`까지 흘러가 `ValueError("Number of processes must be at least 1")`을
일으킨다. 기대 동작: CPU 가용치가 1코어 미만으로 오산정되더라도 최소 1을 보장해 크래시하지 않는 것.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 파일·함수·정확한 라인까지 직접 지목한다 — `pylint/lint/run.py#L60`, `_query_cpu()`,
  그리고 `2/1024 → int → 0`이라는 계산식까지 본문에 적혀 있다. grep 한 방, 탐색 0.
- **S1 (Direct-Map)**: 정형 결함클래스(경계값/0-가드)에 템플릿 매칭. 이슈가 "`avail_cpu`가 0이면 안 된다"는 후조건을
  명세하고 픽스 형태(`or 1`)까지 제안. 식 추론(S2)이 아니라 기계적 하한 클램프.
- **K-Gen**: cgroup/CPU 도메인 배경은 이슈 본문이 다 풀어줬다. 픽스 자체는 "0이면 1로" 일반 파이썬 추론으로 충분, 프레임워크 내부지식 불요.
- **primary = T-DirectMap**: 위치가 자명(L0)하고 픽스가 기계적 가드 추가(S1). T-LocTrivial이 아닌 이유는 _찾으면 끝_ 수준의
  자명함보다 "0 → 최소 1 클램프"라는 경계 결함 패턴이 명확해 DirectMap이 더 정확.
- APR 관점: 이슈가 결함 후조건(`결과 != 0`)을 직접 제공하므로 PAR/TBar식 "null/경계 가드 삽입" 픽스 템플릿이 그대로 적용된다.

## 난이도 티어 — **T2 (쉬움)**
- 파일수 1 / 골드 헌크 1 / 추가 7줄 (주석 3 + 가드 4). 1파일·<5 실질줄 → ICLR 2024 구조컷상 가장 쉬운 구간(≈48% solve).
- localize 직접성 최상(L0): 함수·라인·계산식이 본문에 박혀 있음.
- `has-repro`: 네이티브 스택트레이스 전체(run.py:197 → pylinter.py:650 → parallel.py:140 → multiprocessing pool ValueError)와
  cgroup 파일 실측값까지 제공 — 가장 강한 easiness 신호(해결률 ~87%).
- 공식 라벨 `<15 min fix`와 일치. T1로 더 낮추지 않은 이유: `regression-trap`(아래 P2P 8개)이 약하게 존재하고,
  픽스 위치 선택(여러 `or 1` 후보 중 어디)에 미세한 판단이 끼어 완전 무뇌 T1보다 한 단계 위.

## 골드패치 분석
- **파일·함수**: `pylint/lint/run.py` 의 `_query_cpu()`.
- **근본원인**: `_query_cpu()`의 `cpu.shares` 분기에서 `avail_cpu = int(cpu_shares / 1024)`가 정수 내림으로 0을 산출.
  K8s가 코어의 _일부 분율_(shares=2)만 할당할 때 발생하며, `multiprocessing.Pool`은 `processes >= 1`을 요구하므로 하류에서 폭발.
- **수정요지**: `return avail_cpu` 직전에 하한 클램프 삽입.
  ```python
  if avail_cpu == 0:
      avail_cpu = 1
  ```
  주석으로 "K8s Pod에선 단일 코어의 분율만 가용할 수 있고, multiprocessing은 프로세스 분율을 못 돌리니 1 CPU로 가정"이라 근거를 남김.
  이슈가 제안한 `int(...) / 1024 or 1`보다 함수 말미 단일 클램프를 택해 `cfs_quota/period` 분기까지 함께 보호.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_pylint_run_jobs_equal_zero_dont_crash_with_cpu_fraction`. cgroup 파일 I/O를 모킹 —
  `cpu.cfs_quota_us`=`-1`(분기 무력화), `cpu.shares`=`2`, 그리고 `pylint.lint.run.Path`를 패치해 `cpu.shares`만 `is_file()=True`로.
  `Run([file, "--jobs=0"], reporter=Reporter())`가 `SystemExit(code=0)`로 정상 종료하면 통과.
- **픽스 증명**: 픽스 전 `_query_cpu()`가 0 반환 → Pool ValueError → 비정상 종료. 픽스 후 클램프로 1 반환 →
  `--jobs=0`(=auto)이 1코어로 정상 린트 → exit 0. 모킹이 정확히 `shares=2/1024=0` 분기를 타격해 픽스 라인을 직접 관통.
- **overfit**: 클램프는 `avail_cpu == 0` 모든 경우를 일반 커버하므로 special-case 과적합 아님. 단 테스트가 shares-분기만
  검증하고 cfs_quota-분기(이슈가 "잘 모르겠다"고 한 L55)는 안 건드림 → 약한 `overfit-risk` 잠재이나, 골드 클램프가
  공통 말미에 있어 두 분기 모두 보호하므로 실질 안전.
- **regression**: PASS_TO_PASS 8개(`test_runner[*]`, `test_runner_with_arguments[*]`)는 정상 런처 경로. 클램프는
  `avail_cpu == 0`일 때만 발화하므로 정상 CPU 산정값(>=1)에 영향 0 → P2P 안전.

## 모범답안 (오라클 기반)
1. **localize**: 이슈 본문이 `_query_cpu()` + `run.py#L60` + `int(2/1024)=0`을 명시 → `pylint/lint/run.py`의 해당 함수로 직행.
   스택트레이스로 0이 `multiprocessing.Pool`까지 전파됨을 확인.
2. **픽스**: 근본원인이 "코어 분율 → 정수 내림 0"이므로, 가용 CPU의 **하한을 1로 클램프**하는 게 올바른 일반화.
   `int()` 한 줄에 `or 1`을 박는 국소 수정보다 함수 말미에 `if avail_cpu == 0: avail_cpu = 1`을 두면 `cfs_quota/period`
   분기 결과 0까지 함께 막아 더 robust — 골드가 이 선택을 함.
3. **regression 안전**: 가드를 `== 0` 조건부로 한정해 정상 산정값 경로를 절대 건드리지 않음 → 런처 P2P 8개 무영향.
   `avail_cpu`가 `None`인 경로(어떤 cgroup 파일도 없음)는 `== 0`이 False라 그대로 통과, 하류 `_cpu_count()` fallback 보존.
4. **함정 회피**: (a) `or 1`을 잘못된 분기(예: `cpu_shares or 1`)에 붙여 원시값을 바꾸면 산술이 틀어짐 — 최종
   `avail_cpu`만 클램프해야 함. (b) `None`까지 1로 강제하면 `_cpu_count()`의 affinity fallback을 의도치 않게 차단 →
   `== 0`(not falsy `or`)로 None 보존이 정답. (c) 테스트가 shares-분기만 모킹한다고 cfs_quota 분기를 무시하면
   동일 결함이 잔존 — 두 분기 공통 말미 클램프로 한 번에 닫는 게 안전.
