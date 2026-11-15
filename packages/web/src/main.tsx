import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { BrowserRouter, Route, Routes, useNavigate } from "react-router";
import { api } from "./lib/api.ts";
import { registerWebMcpTools } from "./lib/webmcp.ts";
import { AppShell } from "./components/AppShell.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { CostPage } from "./pages/CostPage.tsx";
import { PairPage } from "./pages/PairPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { TicketPage } from "./pages/ticket/TicketPage.tsx";
import { TicketsPage } from "./pages/TicketsPage.tsx";

/** Experimental WebMCP tools (read, draft, open-decision only); a no-op where the browser has no modelContext. */
function WebMcp() {
  const navigate = useNavigate();
  useEffect(() => {
    const ac = new AbortController();
    // Only GET is handed over, so no write method is reachable at runtime (ruling W-1).
    registerWebMcpTools({ api: { get: api.get }, navigate: (p) => void navigate(p), signal: ac.signal });
    return () => ac.abort();
  }, [navigate]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <BrowserRouter>
        <WebMcp />
        <Routes>
          <Route path="pair" element={<PairPage />} />
          <Route element={<AppShell />}>
            <Route index element={<TicketsPage />} />
            <Route path="tickets/:key/:tab?" element={<TicketPage />} />
            <Route path="cost" element={<CostPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </StrictMode>,
);
