import { loadTheme } from "./theme";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
document.documentElement.dataset.theme = loadTheme();
createRoot(document.getElementById("root")!).render(<App />);
