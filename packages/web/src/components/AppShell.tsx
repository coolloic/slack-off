import { AlertTriangle, ArrowLeft, CheckCircle2, CircleDashed, Gauge, History, Lock, Menu, RadioTower, Settings, SquareTerminal, Ticket, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useMatch } from "react-router";
import { t } from "../i18n/en.ts";
import { needsYouCount } from "../lib/jira-filter.ts";
import { paths, type Status, type TicketRow } from "../lib/api.ts";
import { dismissSourceError, useApi, useEvents, useLive } from "../lib/hooks.ts";
import { cn } from "../lib/utils.ts";
import { StateBadge } from "./StateBadge.tsx";
import { UsageBanner } from "./UsageBanner.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

function Dot({ ok }: { ok: boolean }) {
  return <span className={cn("size-1.5 rounded-full", ok ? "bg-tertiary" : "bg-rose-500")} aria-hidden />;
}

function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-7 items-center gap-1.5 rounded border border-outline-variant/30 bg-surface-container-low px-2 font-mono text-code-sm text-on-surface-variant", className)}>
      {children}
    </div>
  );
}

function StatusChips({ status }: { status: Status }) {
  return (
    <>
      <Chip className="bg-surface-container">
        <span>{t("top.concurrency")}</span>
        <span className="font-semibold text-primary">{status.concurrency}</span>
        {status.restartRequired && <span className="text-amber-700">· {t("top.restartRequired")}</span>}
      </Chip>
      <Tooltip content={status.executor.reason ?? status.executor.label}>
        <div title={status.executor.label}>
          <Chip>
            <Dot ok={status.executor.available} />
            <span>{t("top.executorShort")}</span>
            <span className="text-outline-variant">·</span>
            <span className={status.executor.available ? "font-medium text-tertiary" : "font-medium text-rose-600"}>
              {status.executor.available ? t("top.executorReady") : t("top.executorMissing")}
            </span>
          </Chip>
        </div>
      </Tooltip>
      <Chip>
        <Dot ok={status.jira.configured} />
        <span>{status.jira.source === "api" ? t("top.jiraApi") : t("top.jira")}</span>
        <span className="text-outline-variant">·</span>
        <span className={status.jira.configured ? "font-medium text-tertiary" : "font-medium text-rose-600"}>
          {status.jira.configured ? t("top.jiraConfigured") : t("top.jiraNotConfigured")}
        </span>
      </Chip>
    </>
  );
}

/** Below lg: one status line under the header row (executor + JIRA), never wrapping. */
function StatusLine({ status }: { status: Status }) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-3 pb-1.5 font-mono text-code-sm text-on-surface-variant lg:hidden" aria-label={t("top.status")}>
      <span className="flex min-w-0 items-center gap-1.5" title={status.executor.reason ?? status.executor.label}>
        <span className="flex shrink-0">
          <Dot ok={status.executor.available} />
        </span>
        <span className="min-w-0 truncate">
          {t("top.executorShort")} · {status.executor.available ? t("top.executorReady") : t("top.executorMissing")}
        </span>
      </span>
      <span className="shrink-0 text-outline-variant">|</span>
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="flex shrink-0">
          <Dot ok={status.jira.configured} />
        </span>
        {t("top.jiraShort")} · {status.jira.configured ? t("top.jiraConfigured") : t("top.jiraNotConfigured")}
      </span>
      {status.restartRequired && <span className="shrink-0 text-amber-700">· {t("top.restartRequired")}</span>}
    </div>
  );
}

/** Publishes the header's rendered height as --header-h so sticky elements below it stay in sync. */
function useHeaderHeight(): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const apply = () => document.documentElement.style.setProperty("--header-h", `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return setEl;
}

/** Phone (<md) left side of the header, by route: tickets = menu + brand; ticket = back + key + state; settings = menu + title. */
function MobileHeaderLeft({ onMenu, tickets }: { onMenu: () => void; tickets: TicketRow[] | undefined }) {
  const ticketMatch = useMatch("/tickets/:key/*");
  const settings = useMatch("/settings");
  const cost = useMatch("/cost");
  const menu = (
    <button data-menu-button aria-label={t("nav.openMenu")} onClick={onMenu} className="flex size-11 shrink-0 items-center justify-center rounded text-on-surface hover:bg-slate-100">
      <Menu className="size-5" />
    </button>
  );
  if (ticketMatch) {
    const key = ticketMatch.params.key ?? "";
    const row = tickets?.find((r) => r.key === key);
    return (
      <div className="flex min-w-0 items-center gap-1.5 md:hidden">
        <Link to="/" aria-label={t("ticket.back")} className="flex size-11 shrink-0 items-center justify-center rounded text-on-surface hover:bg-slate-100">
          <ArrowLeft className="size-5" />
        </Link>
        <span className="min-w-0 shrink truncate rounded bg-surface-container px-1.5 font-mono text-code-md font-semibold text-primary">{key}</span>
        {row && <StateBadge state={row.state} className="min-w-0 max-w-[55%] shrink" />}
      </div>
    );
  }
  if (settings || cost) {
    return (
      <div className="flex min-w-0 items-center gap-1 md:hidden">
        {menu}
        <span className="truncate text-headline-md">{settings ? t("settings.title") : t("cost.title")}</span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-1 md:hidden">
      {menu}
      <Link to="/" className="flex min-w-0 items-center gap-1.5">
        <SquareTerminal className="size-5 shrink-0 text-primary" />
        <span className="truncate text-headline-md text-on-surface">{t("app.name")}</span>
      </Link>
    </div>
  );
}

/** Phone bottom navigation: only Tickets / Settings. Hidden while a decision bar owns the bottom edge. */
function BottomNav() {
  const { pathname } = useLocation();
  const ticketsActive = pathname === "/" || pathname.startsWith("/tickets");
  const item = (active: boolean) => cn("flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-label-sm", active ? "font-semibold text-primary" : "text-on-surface-variant");
  return (
    <nav aria-label={t("nav.menu")} className="bottom-nav fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200 bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
      <Link to="/" className={item(ticketsActive)} aria-current={ticketsActive ? "page" : undefined}>
        <Ticket className="size-5" />
        {t("nav.tickets")}
      </Link>
      <Link to="/cost" className={item(pathname === "/cost")} aria-current={pathname === "/cost" ? "page" : undefined}>
        <Gauge className="size-5" />
        {t("nav.cost")}
      </Link>
      <Link to="/settings" className={item(pathname === "/settings")} aria-current={pathname === "/settings" ? "page" : undefined}>
        <Settings className="size-5" />
        {t("nav.settings")}
      </Link>
    </nav>
  );
}

function TopBar({ status, tickets, onMenu }: { status: Status | undefined; tickets: TicketRow[] | undefined; onMenu: () => void }) {
  // F2-I2: decisions plus JIRA writes waiting for "Send to JIRA"
  const needs = needsYouCount(status);
  const ticketRoute = useMatch("/tickets/:key/*");
  // both hooks always run (a conditional second hook crashed the bar when a link led into /settings, phase 4d)
  const settingsMatch = useMatch("/settings");
  const costMatch = useMatch("/cost");
  const settingsRoute = settingsMatch ?? costMatch;
  const headerRef = useHeaderHeight();
  // Height is content-driven (no fixed h-*); --header-h keeps sticky offsets in sync.
  return (
    <header ref={headerRef} className="sticky top-0 z-40 flex flex-col border-b border-outline-variant/30 bg-white pt-[env(safe-area-inset-top)]">
    <div className="flex min-h-14 items-center justify-between gap-2 px-2 lg:min-h-12 lg:justify-end lg:px-4">
      <MobileHeaderLeft onMenu={onMenu} tickets={tickets} />
      <div className="hidden min-w-0 items-center gap-1 md:flex lg:hidden">
        <button data-menu-button aria-label={t("nav.openMenu")} onClick={onMenu} className="flex size-11 items-center justify-center rounded text-on-surface hover:bg-slate-100">
          <Menu className="size-5" />
        </button>
        <Link to="/" className="flex min-w-0 items-center gap-1.5">
          <SquareTerminal className="size-4 shrink-0 text-primary" />
          <span className="truncate text-headline-sm text-on-surface">{t("app.name")}</span>
        </Link>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {settingsRoute && <span className="rounded-full bg-surface-container-high px-2.5 py-1 font-mono text-code-sm text-primary md:hidden">{t("settings.daemonChip")}</span>}
        <Link
          to={needs > 0 ? "/?needs=1" : "/"}
          title={needs > 0 ? undefined : t("top.needsYouNone")}
          className={cn(
            "flex h-9 items-center gap-1.5 rounded-full border px-3 font-mono text-code-sm md:h-11 md:rounded md:px-2.5 lg:h-7 lg:px-2",
            (ticketRoute || settingsRoute) && "max-md:hidden",
            needs > 0 ? "border-secondary-container/40 bg-secondary-fixed text-on-secondary-fixed" : "border-outline-variant/30 bg-surface-container-low text-on-surface-variant",
          )}
        >
          {needs > 0 && <span className="size-1.5 animate-pulse-subtle rounded-full bg-secondary-container" />}
          <span className="font-semibold">{t("top.needsYou")}</span>
          <span className="rounded bg-white/80 px-1 text-[11px] font-bold text-secondary">{needs}</span>
        </Link>
        {status && (
          <>
            <div className="hidden items-center gap-2 lg:flex">
              <StatusChips status={status} />
            </div>
          </>
        )}
      </div>
    </div>
    {status && !ticketRoute && !settingsRoute && <StatusLine status={status} />}
    </header>
  );
}

const LG = "(min-width: 1024px)";
const subscribeLg = (cb: () => void) => {
  const mq = window.matchMedia(LG);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
/** true at lg+ (the sidebar is a static column there, not a drawer). */
const useIsDesktop = () => useSyncExternalStore(subscribeLg, () => window.matchMedia(LG).matches);

function SideBar({ ticketCount, connected, status, open, onClose }: { ticketCount: number | undefined; connected: boolean; status: Status | undefined; open: boolean; onClose: () => void }) {
  const { pathname } = useLocation();
  const desktop = useIsDesktop();
  const closeRef = useRef<HTMLButtonElement>(null);
  // Below lg the sidebar is a modal drawer: closed = inert (not focusable, hidden from AT); open = focus moves in,
  // Escape closes, and focus goes back to the element that opened it (the menu button).
  const drawerOpen = open && !desktop;
  useEffect(() => {
    if (!drawerOpen) return;
    // Safari does not focus a tapped button, so fall back to the visible menu button
    const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const opener = active ?? [...document.querySelectorAll<HTMLElement>("[data-menu-button]")].find((b) => b.getClientRects().length > 0) ?? null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [drawerOpen, onClose]);
  const ticketsActive = pathname === "/" || pathname.startsWith("/tickets");
  const item = "flex h-11 items-center justify-between rounded px-2 text-body-md transition-colors lg:h-8";
  const disabled = (icon: ReactNode, label: string) => (
    <Tooltip content={t("nav.phaseLater")} side="right">
      <span className={cn(item, "cursor-not-allowed text-slate-400 max-lg:hidden")} aria-disabled="true">
        <span className="flex items-center gap-2">
          {icon}
          {label}
        </span>
      </span>
    </Tooltip>
  );
  return (
    <>
    {open && <button aria-label={t("nav.closeMenu")} className="fixed inset-0 z-50 bg-slate-900/40 lg:hidden" onClick={onClose} />}
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex w-[85%] max-w-sm flex-col justify-between border-r border-outline-variant/30 bg-white transition-transform lg:w-56 lg:max-w-none lg:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full",
      )}
      aria-label={t("nav.menu")}
      inert={!desktop && !open}
      aria-modal={drawerOpen || undefined}
      role={drawerOpen ? "dialog" : undefined}
    >
      <div>
        <div className="flex h-14 items-center justify-between border-b border-outline-variant/30 px-4 lg:h-12">
          <Link to="/" className="flex items-center gap-1.5">
            <SquareTerminal className="size-4 text-primary" />
            <span className="text-headline-sm text-on-surface">{t("app.name")}</span>
          </Link>
          <span className="flex items-center gap-1">
            <span className="rounded border border-outline-variant/40 bg-surface-container px-1.5 py-0.5 font-mono text-code-sm text-on-surface-variant">{t("app.port")}</span>
            <button ref={closeRef} aria-label={t("nav.closeMenu")} onClick={onClose} className="flex size-11 items-center justify-center rounded hover:bg-slate-100 lg:hidden">
              <X className="size-5" />
            </button>
          </span>
        </div>
        <nav className="flex flex-col gap-0.5 p-1.5">
          <NavLink
            to="/"
            className={cn(item, ticketsActive ? "bg-surface-container-high font-semibold text-on-surface" : "text-on-surface-variant hover:bg-surface-container")}
          >
            <span className="flex items-center gap-2">
              <CheckCircle2 className="size-4" />
              {t("nav.tickets")}
            </span>
            {ticketCount !== undefined && <span className="rounded bg-surface-container-highest px-1.5 font-mono text-code-sm font-semibold max-lg:rounded-full max-lg:bg-secondary-container max-lg:px-2.5 max-lg:text-on-secondary-fixed">{ticketCount}</span>}
          </NavLink>
          {disabled(<History className="size-4" />, t("nav.auditLog"))}
          <NavLink
            to="/cost"
            className={({ isActive }) => cn(item, isActive ? "bg-surface-container-high font-semibold text-on-surface" : "text-on-surface-variant hover:bg-surface-container")}
          >
            <span className="flex items-center gap-2">
              <CircleDashed className="size-4" />
              {t("nav.costQuota")}
            </span>
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) => cn(item, isActive ? "bg-surface-container-high font-semibold text-on-surface" : "text-on-surface-variant hover:bg-surface-container")}
          >
            <span className="flex items-center gap-2">
              <Settings className="size-4" />
              {t("nav.settings")}
            </span>
          </NavLink>
        </nav>
        {status && (
          <div className="mx-3 flex flex-col gap-1.5 border-t border-outline-variant/30 pt-3 lg:hidden">
            <span className="text-label-sm uppercase tracking-[0.05em] text-on-surface-variant">{t("nav.statusTitle")}</span>
            <span className="flex items-center gap-2 font-mono text-code-sm" title={status.executor.label}>
              <Dot ok={status.executor.available} />
              {t("top.executorShort")} · {status.executor.available ? t("top.executorReady") : t("top.executorMissing")}
            </span>
            <span className="flex items-center gap-2 font-mono text-code-sm">
              <Dot ok={status.jira.configured} />
              {t("top.jiraShort")} · {status.jira.configured ? t("top.jiraConfigured") : t("top.jiraNotConfigured")}
            </span>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2 bg-surface-container-low p-3 lg:hidden">
        <div className="flex items-center gap-2 rounded bg-white p-3 text-body-sm">
          {status?.remoteAccess.active ? <RadioTower className="size-4 shrink-0 text-tertiary" /> : <Lock className="size-4 shrink-0 text-on-surface-variant" />}
          <span className="flex min-w-0 flex-1 flex-col">
            {status?.remoteAccess.active ? t("nav.remoteAccessOn") : t("nav.remoteAccessOff")}
            {status?.remoteAccess.url && <span className="break-all font-mono text-code-sm text-on-surface-variant">{status.remoteAccess.url}</span>}
          </span>
        </div>
        <div className="flex items-center justify-between font-mono text-code-sm text-on-surface-variant">
          <span>{t("nav.localAddress")}</span>
          <span className="flex items-center gap-1.5">
            <Dot ok={connected} />
            {connected ? t("nav.sseConnected") : t("nav.sseDisconnected")}
          </span>
        </div>
      </div>
      <div className="hidden items-center gap-1.5 border-t border-outline-variant/30 bg-surface-container-low p-2 font-mono text-code-sm text-on-surface-variant lg:flex">
        <Dot ok={connected} />
        {connected ? t("nav.sseConnected") : t("nav.sseDisconnected")}
      </div>
    </aside>
    </>
  );
}

function Banners({ status }: { status: Status | undefined }) {
  const { sourceError } = useLive();
  return (
    <>
      <UsageBanner usage={status?.usage} />
      {status && !status.jira.configured && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-body-md text-amber-900">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {t("banner.firstRun")}
          </span>
          <Link to="/settings" className="font-semibold text-primary underline-offset-2 hover:underline">
            {t("banner.firstRunAction")} →
          </Link>
        </div>
      )}
      {sourceError && (
        <div role="alert" className="flex items-start justify-between gap-3 border-b border-rose-200 bg-rose-50 px-4 py-2 text-body-md text-rose-800">
          <span className="flex min-w-0 items-start gap-2 break-words">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span className="font-semibold">{t("banner.sourceError")}:</span> {sourceError}
          </span>
          <button aria-label={t("banner.dismiss")} onClick={dismissSourceError} className="flex size-9 shrink-0 items-center justify-center text-rose-700 hover:text-rose-900">
            <X className="size-4" />
          </button>
        </div>
      )}
    </>
  );
}

export function AppShell() {
  useEvents();
  const live = useLive();
  const status = useApi<Status>(paths.status);
  const tickets = useApi<TicketRow[]>(paths.tickets);
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setMenuOpen(false), [pathname]);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  return (
    <div className="min-h-screen bg-white">
      <SideBar ticketCount={tickets.data?.length} connected={live.connected} status={status.data} open={menuOpen} onClose={closeMenu} />
      <div className="lg:pl-56">
        <TopBar status={status.data} tickets={tickets.data} onMenu={() => setMenuOpen(true)} />
        <Banners status={status.data} />
        <main>
          <Outlet />
        </main>
      </div>
      <BottomNav />
    </div>
  );
}
