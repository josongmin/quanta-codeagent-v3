# Terminal-Bench — 문제별 분석

Terminal-Bench(`terminal-bench` 데이터셋, **89 task**, Stanford+Laude / laude-institute/terminal-bench-2)를 **task별로 까볼 수 있게** 정리한 레퍼런스. [swe-bench-pro-analysis](../swe-bench-pro-analysis/)와 같은 포맷 철학 — 정답(solve.sh) 기반 유형 분류 + "뭘 조져야 하는지" 공략 포인트. 단 **TB는 코드 diff가 아니라 터미널 작업**이라 축을 새로 정의([TAXONOMY.md](TAXONOMY.md)).

> ⚠️ 분석 md는 **solve.sh(정답) 스포일러 포함** — 사람이 task 유형을 빠르게 파악하는 레퍼런스지 에이전트 블라인드 학습셋 아님. solve.sh엔 canary GUID가 박혀 있음.

## 핵심: TB는 "코딩"이 아니라 3분할 — 코딩(1/3)+코딩&환경(1/3)+순수터미널(1/4)

기존 정설("TB는 코딩 아님")은 반만 맞다. **전수 실측**하니:

| terminal_native | n | 성격 | quanta 함의 |
|---|--:|---|---|
| **low** | 30 (34%) | 스펙→파일 하나, 터미널은 실행판 | **SWE 스킬 그대로 전이** |
| **med** | 35 (39%) | 코드 + env/도구 셋업(uv/deps/빌드) | 셋업 안정성이 관건 |
| **high** | 24 (27%) | 시스템상태/멀티스텝셸/VM/장시간 | **quanta 터미널서피스 진짜 차별화** |

→ 자세한 결론은 [SYNTHESIS.md](SYNTHESIS.md).

## 분포 (89 전수)

**Category (16):** software-engineering 26 · system-administration 9 · security 8 · scientific-computing 8 · data-science 8 · file-operations 5 · debugging 5 · model-training 4 · mathematics 4 · data-processing 4 · machine-learning 3 · video/personal-assistant/optimization/games/data-querying 각 1

**Skill-class (파생):** CODE-AUTHOR 21 · NUMERIC-SCI 15 · SYSADMIN 15 · ADVERSARIAL-SEC 11 · DATA-WRANGLE 10 · ML-TRAIN 9 · DEBUG-FIX 8

**Difficulty:** medium 55 · hard 30 · easy 4  (expert 소요추정 5분~2400분)

## 구조

```
terminal-bench-analysis/
├── README.md          ← 여기 (개요 + 분포 + 네비)
├── TAXONOMY.md        분류 루브릭 (category/difficulty/skill-class/terminal-native/interaction 축)
├── SYNTHESIS.md       횡단 종합 (TB 3분할 · SYSADMIN=high · 공략 우선순위 · 우리 2/5 교차)
├── _data/
│   ├── tasks.jsonl        89 task 원본 메타+instruction+solution 덤프
│   └── classified.json    89 task 분류결과(frontmatter 집계 SSOT)
└── tasks/<category>/<task>.md   ← per-task 89개 (frontmatter + Goal/Solution/Verifier/Difficulty/quanta공략)
```

## per-task md 읽는 법

각 md frontmatter: `category · difficulty · tags · expert/junior_min · skill_class · terminal_native · docker_image`.
본문 5섹션: **Goal**(뭘 해야) · **Solution shape**(solve.sh가 하는 것) · **Verifier**(뭘 검증) · **Difficulty drivers**(왜 이 난이도) · **quanta attack points**(필요 도구·실패리스크·스캐폴드 먹히나).

예: [tasks/data-science/reshard-c4-data.md](tasks/data-science/reshard-c4-data.md)(우리가 푼 것) · [tasks/system-administration/qemu-alpine-ssh.md](tasks/system-administration/qemu-alpine-ssh.md)(가장 터미널-native).

## quanta 실측 (첫 5-task run, gpt-5.4, 2026-07-01)

**2/5 resolved**: ✅reshard-c4-data ✅break-filter-js-from-html / ❌gpt2-codegolf·llm-inference-batching-scheduler·write-compressor. 통합 end-to-end 검증됨(harbor host + brain chatgpt-oauth). 리더보드 숫자는 더 큰 샘플+Opus 4.8(표준-스캐폴드 58.3% 베이스라인 vs delta)로. 세팅/재런: `/tmp/tb-results/SUMMARY.md`.

## 분석 함정 (per-task md에 flag됨)

- **solve.sh ≠ 진짜 풀이**인 케이스: regex-chess/extract-moves-from-video(정답키 echo)·adaptive-rejection-sampler(암호화 ref 복호)·query-optimize/tune-mjcf(산출물 1줄).
- **anti-cheat 해시게이트**(입력 SHA256/MD5) 다수 → 하드코딩/스킵 차단.
- **hidden test**(schemelike-metacircular-eval shadow_test) → 일반화 필요.
- 일부 task는 진짜 로직이 `environment/`나 `tests/`에 있음(headless-terminal/circuit-fibsqrt/extract-elf/feal-*) — 각 md에 명시.
