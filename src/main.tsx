import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { installContextMenuGuard } from "./contextMenu";
import "./styles.css";
import { initTheme } from "./theme";

initTheme();
installContextMenuGuard();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>,
);
