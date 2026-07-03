# Terminal-Bench 스모크 셋 (SSOT) — RFC 07 반복 루프

목표(RFC 07): **우리 실패 ∩ 남들 성공**(승산 타겟)을 태스크별 플랜 바꿔가며 다 메꾼다. 회귀 풀런은 비싸니 **대표 3건만 회귀 가드**로 같이 돈다.

풀런 금지. `run-tb-smoke.sh <profile>`로 이 셋만 (~8 태스크, -n8, ~15-20분).

## GUARD (안정 가드 — 경쟁사 100% + 우리 baseline·레버 둘 다 통과여야)
green→red 로 뒤집히면 **SMOKE FAIL**(플랜 변경이 뭔가 깨뜨림). ⚠️ 스크립트(run-tb-smoke.sh)가 SSOT — 이 표는 그 미러.
| task | category | 이유 |
|---|---|---|
| fix-git | software-engineering (easy) | git 조작, 빠름 |
| regex-log | data-processing | regex/텍스트, 빠름 |

## LEVER_REGRESSION (레버-회귀 witness — 경쟁사 100%인데 레버 켜니 우리가 깨진 것, M0 jul-3 확정)
green 되면 회귀가 복구된 것. 이 3건 green 전에 레버 디폴트 flip 금지.
| task | category | 비고 |
|---|---|---|
| extract-elf | file-operations | 바이너리 파싱 (GUARD에서 승격 이동) |
| path-tracing | software-engineering | M0 레버런서 red |
| headless-terminal | system-administration | M0 레버런서 red |

## TARGETS (승산 타겟 — 우리 실패 ∩ 경쟁사 성공, 타입 대표)
red→green 되면 그 타입 플랜이 먹힌 것.
| task | 경쟁사평균 | RFC07 타입 | 실패 근거 |
|---|---|---|---|
| polyglot-c-py | 100% | Type1 출력계약 | 여분 `cmain` 미삭제 |
| rstan-to-pystan | 100% | Type1 출력계약 | 필수 `alpha_est.csv` 누락 |
| sam-cell-seg | 50% | Type1 출력계약 | 제출 스크립트 exit 2 크래시 |
| pytorch-model-recovery | 100% | Type2 synthesis | forward 시그니처 3-arg 틀림 |
| model-extraction-relu-logits | 80% | Type2 synthesis | 근접-오답 |

## 전체 승산셋 (타겟 대표 외 나머지 — 순차 공략 백로그)
caffe-cifar-10 · chess-best-move · db-wal-recovery · dna-assembly · dna-insert · extract-moves-from-video · gpt2-codegolf · make-mips-interpreter · mteb-leaderboard · mteb-retrieve · polyglot-rust-c · query-optimize · regex-chess · torch-pipeline-parallelism · torch-tensor-parallelism
(제외=하드천장 install-windows-3.11, 진짜어려움 filter-js/make-doom/train-fasttext/raman은 후순위)

## 프로파일 (knob 조합)
- `baseline` — knob 없음 (대조)
- `levers` — env-owned + maxTurns=60 + verify-gate
- `oc1` — levers + output-contract (현재 최선, Type1 공략)
