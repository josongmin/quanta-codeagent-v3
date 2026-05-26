import React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "./styles/index.css"

const rootEl = document.getElementById("root")
if (rootEl === null) {
  throw new Error("quanta-web-frontend: #root element missing from index.html")
}

createRoot(rootEl).render(
  (
    import.meta.env.VITE_QUANTA_STRICT_MODE === "1" ? (
      <React.StrictMode>
        <App />
      </React.StrictMode>
    ) : (
      <App />
    )
  ),
)
