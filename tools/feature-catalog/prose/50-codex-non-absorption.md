## Codex 특정 의도적 미흡수 (ADR-0015~0023 근거)

- **Heartbeat/cron 자동화** (`codex_app.automation_update`) — CLI/bench는 single-session, 적용 부재
- **Plugin bundle** (skills + MCP + app capability 묶음 패키징) — skill 단독으로 커버, plugin 형식은 ROI 낮음
- **Cassette validator 엄격 per-entry 검증** — Codex 자체가 placeholder로 표기, 본 환경도 동일 보류
- **숨겨진 global memory DB** — Codex가 NON-CLAIM으로 표기. 본 환경은 명시적 `QUANTA_MEMORY_PATH` 영속만 사용
- **Git directive 5종** (`::git-stage`/`::git-commit` 등 UI 레일 명령) — CLI에 UI 레일 없음, `bash`/`git_*` 도구로 충분
