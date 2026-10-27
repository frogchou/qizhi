import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { tauriCommands } from "./lib/tauri";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App commands={tauriCommands} />
  </React.StrictMode>,
);
