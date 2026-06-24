# leaderboard-dashboard rawdata (SSOT)

대시보드(`../server.ts`)가 읽는 raw 소스 데이터를 벤치툴 아래로 모은 폴더.

| 파일 | 용도 | server.ts 소비 |
|---|---|---|
| `scaffold-solving-summary.md` | 경쟁사 프론티어 ✅/· 매트릭스 (500×17, #=134중 해결수) | `MATRIX_MD` (`--matrix`) |
| `verified-full.jsonl` | SWE-bench Verified 500행 (problem/gold patch/F2P/난이도). HF `princeton-nlp/SWE-bench_Verified` | `DATASET_JSONL` (`--dataset`) |
| `experiments-verified/results/<folder>.json` | upstream raw — 공개 제출 134개의 results.json (resolved/unresolved) | (매트릭스 .md의 원본; 직접 소비X) |

## upstream raw provenance

`experiments-verified/`는 `scaffold-solving-summary.md`를 떨군 **원본**.
출처: `https://raw.githubusercontent.com/swe-bench/experiments/main/evaluation/verified/<folder>/results/results.json`
folders.txt = 134개 제출 폴더 목록 (git tree `main` 기준).

### union 재계산 / 검증
```
python3 recompute-union.py
```
2026-06-24 재검증: **union 468 / 500 solved, 32 never-resolved**. (대시보드 #=0 = 32와 일치.)
