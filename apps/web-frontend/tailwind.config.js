/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // Codex-aligned token scale — LIGHT base (clean ChatGPT/Codex-desktop feel).
      // Components use these semantic names; flipping these values reskins the app.
      colors: {
        // surfaces — app(white) → raised cards/sidebar(light gray) → overlay/input(white)
        surface: {
          DEFAULT: "#ffffff", // app background
          raised: "#f7f7f8", // panels / cards / sidebar / user bubble
          overlay: "#ffffff", // dropdowns / menus / modals (with shadow)
          input: "#ffffff", // composer / inputs (border defines them)
        },
        // hairlines (light gray)
        line: {
          DEFAULT: "#e7e7ea",
          subtle: "#efeff1",
          strong: "#d7d7dc",
        },
        // text ramp (dark on light)
        ink: {
          DEFAULT: "#1c1c1f", // primary
          secondary: "#666670", // labels / secondary
          tertiary: "#8a8a94", // muted / captions
          faint: "#b2b2ba", // placeholder / disabled
        },
        // brand accent (deeper blue for contrast on white)
        accent: {
          DEFAULT: "#4c6ef5",
          muted: "#3b5bd9",
          fg: "#ffffff", // text/icon ON a solid accent button
        },
        // semantic (deeper for light-bg contrast)
        ok: "#16a34a",
        warn: "#d97706",
        err: "#dc2626",
        info: "#2563eb",
        // fenced code blocks stay DARK on the light page (Codex-accurate snippets).
        code: {
          DEFAULT: "#0d1117",
          line: "#21262d",
        },
      },
      fontFamily: {
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
        chat: ["0.9375rem", { lineHeight: "1.6" }], // 15px / relaxed
      },
      boxShadow: {
        // soft elevation for overlays/menus on a light surface
        overlay: "0 8px 28px -6px rgba(20,20,30,0.16), 0 2px 8px -2px rgba(20,20,30,0.08)",
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
