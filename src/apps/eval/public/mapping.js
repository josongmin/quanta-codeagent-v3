export const MAPPINGS = [
    {
        bench: "swebench-verified",
        primary: "software-quality.debugging.error-message-paste",
        secondary: [
            "software-quality.issue-resolution.github-issue",
            "software-quality.debugging.reproducer",
            "software-quality.testing.unit-gen",
        ],
        note: "Real GitHub issue → patch. Multi-leaf evidence; primary is Debugging.",
    },
    {
        bench: "livecodebench",
        primary: "feature-implementation.new-feature.spec-to-impl",
        note: "Algorithmic spec → solution; uncontaminated by training cutoff.",
    },
    {
        bench: "terminalbench",
        primary: "operational.deploy.deploy-cmd",
        secondary: ["feature-implementation.scripting.automation"],
        note: "Long-horizon shell tasks; touches Deploy + Scripting.",
    },
    {
        bench: "multi-swebench",
        primary: "feature-implementation.migration.language",
        secondary: ["software-quality.debugging.error-message-paste"],
        note: "Multi-language SWE-bench variants; emphasises Migration.",
    },
];
export const findMapping = (bench) => MAPPINGS.find((m) => m.bench === bench);
