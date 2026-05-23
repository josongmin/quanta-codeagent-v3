/**
 * Aggregate every persisted `EvalRecord` across every tier into a single
 * (UseCase × Tier) coverage matrix. Each cell is the best observed verdict
 * for that pair (`pass > partial > fail > skipped`); audit cells map
 * coverage levels into the same lattice (`ok→pass`, `partial→partial`,
 * `no→fail`, `tbd→skipped`).
 */
import { assertNever } from "@/shared";
import { allLeaves, leafById, parseId, TAXONOMY } from "../taxonomy";
const TIER_ORDER = ["audit", "synthetic", "public", "trajectory", "compare"];
const VERDICT_RANK = {
    pass: 4,
    partial: 3,
    fail: 2,
    error: 1,
    skipped: 0,
};
const COVERAGE_TO_VERDICT = {
    ok: "pass",
    partial: "partial",
    no: "fail",
    tbd: "skipped",
};
const verdictFromRecord = (rec) => {
    const p = rec.payload;
    switch (p.kind) {
        case "audit":
            return COVERAGE_TO_VERDICT[p.coverage];
        case "synthetic":
            return p.verdict;
        case "public":
            return p.verdict;
        case "trajectory":
            // Presence of a trajectory record == we saw real usage of this UseCase.
            // `pass` semantics: "real evidence exists", not "agent succeeded".
            return "pass";
        case "compare":
            if (p.winner === 0)
                return "pass";
            if (p.winner === -1)
                return "partial";
            return "fail";
        default:
            return assertNever(p);
    }
};
const emptyCell = () => ({ verdict: "skipped", count: 0 });
export const buildCoverageMatrix = (records) => {
    const byUsecase = new Map();
    let seen = 0;
    // ADR-0087 — running token/cost rollup. `roll.records` stays 0 until a
    // synthetic/public payload carries `tokens`, at which point the rollup is
    // attached; an all-usage-free corpus leaves `tokenCost` undefined.
    const roll = {
        prompt: 0,
        completion: 0,
        cacheRead: 0,
        costUsd: 0,
        records: 0,
    };
    for (const rec of records) {
        seen += 1;
        const p = rec.payload;
        if ((p.kind === "synthetic" || p.kind === "public") && p.tokens !== undefined) {
            roll.prompt += p.tokens.prompt;
            roll.completion += p.tokens.completion;
            roll.cacheRead += p.tokens.cacheRead ?? 0;
            if (typeof p.costUsd === "number")
                roll.costUsd += p.costUsd;
            roll.records += 1;
        }
        const id = rec.usecase;
        let row = byUsecase.get(id);
        if (row === undefined) {
            row = {
                audit: emptyCell(),
                synthetic: emptyCell(),
                public: emptyCell(),
                trajectory: emptyCell(),
                compare: emptyCell(),
            };
            byUsecase.set(id, row);
        }
        const v = verdictFromRecord(rec);
        const cell = row[rec.tier];
        cell.count += 1;
        if (VERDICT_RANK[v] > VERDICT_RANK[cell.verdict])
            cell.verdict = v;
    }
    const blocks = [];
    for (const maj of TAXONOMY) {
        const rows = [];
        for (const m of maj.mids) {
            for (const l of m.leaves) {
                const cells = byUsecase.get(l.id) ?? {
                    audit: emptyCell(),
                    synthetic: emptyCell(),
                    public: emptyCell(),
                    trajectory: emptyCell(),
                    compare: emptyCell(),
                };
                rows.push({ id: l.id, midLabel: m.label, cells });
            }
        }
        blocks.push({
            majorId: maj.id,
            label: maj.label,
            ...(maj.empiricalShare !== undefined ? { share: maj.empiricalShare } : {}),
            rows,
        });
    }
    // Mark unknown / unclassified (trajectory uses "unclassified" sentinel id).
    // We intentionally drop them from the matrix here — `report/trend` surfaces
    // a top-line count instead.
    void leafById;
    void parseId;
    void allLeaves;
    return {
        blocks,
        tiers: TIER_ORDER,
        recordsSeen: seen,
        ...(roll.records > 0 ? { tokenCost: roll } : {}),
    };
};
