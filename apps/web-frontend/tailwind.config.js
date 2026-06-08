/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // Codex-aligned token scale (dark-first). Components should prefer these
      // semantic names over raw `neutral-*` so the surface reads as one system.
      // (raw Tailwind `neutral-*` still works for legacy spots mid-migration.)
      colors: {
        // surfaces — app → raised cards → overlay/dropdown → input field
        surface: {
          DEFAULT: "#0f0f12", // app background
          raised: "#17171b", // panels / cards / sidebar
          overlay: "#1e1e23", // dropdowns / menus / popovers
          input: "#202026", // composer / input fields
        },
        // hairlines
        line: {
          DEFAULT: "#2a2a30",
          subtle: "#1f1f24",
          strong: "#3a3a43",
        },
        // text ramp
        ink: {
          DEFAULT: "#ededee", // primary
          secondary: "#9b9ba4", // labels / secondary
          tertiary: "#6a6a73", // muted / captions
          faint: "#50505a", // placeholder / disabled
        },
        // brand accent (kept from quanta)
        accent: {
          DEFAULT: "#7aa2f7",
          muted: "#5d7fbf",
          fg: "#0f0f12", // foreground ON accent (for solid buttons)
        },
        // semantic (clean github-ish)
        ok: "#3fb950",
        warn: "#d29922",
        err: "#f85149",
        info: "#58a6ff",
      },
      fontFamily: {
        // prose body — system sans first (Codex/ChatGPT desktop feel)
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "Liberation Mono",
          "Courier New",
          "monospace",
        ],
      },
      borderRadius: {
        "2xs": "0.1875rem",
      },
      fontSize: {
        // chat body — slightly larger than text-sm for readable prose
        chat: ["0.9375rem", { lineHeight: "1.6" }], // 15px / relaxed
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(2px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.12s ease-out",
      },
    },
  },
  plugins: [],
}
