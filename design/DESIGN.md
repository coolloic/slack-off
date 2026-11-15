---
name: Autonomous Engineering Orchestrator
colors:
  surface: '#faf8ff'
  surface-dim: '#d2d9f4'
  surface-bright: '#faf8ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f3ff'
  surface-container: '#eaedff'
  surface-container-high: '#e2e7ff'
  surface-container-highest: '#dae2fd'
  on-surface: '#131b2e'
  on-surface-variant: '#434655'
  inverse-surface: '#283044'
  inverse-on-surface: '#eef0ff'
  outline: '#737686'
  outline-variant: '#c3c6d7'
  surface-tint: '#0053db'
  primary: '#004ac6'
  on-primary: '#ffffff'
  primary-container: '#2563eb'
  on-primary-container: '#eeefff'
  inverse-primary: '#b4c5ff'
  secondary: '#904d00'
  on-secondary: '#ffffff'
  secondary-container: '#fe932c'
  on-secondary-container: '#663500'
  tertiary: '#006243'
  on-tertiary: '#ffffff'
  tertiary-container: '#007d57'
  on-tertiary-container: '#bdffdc'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dbe1ff'
  primary-fixed-dim: '#b4c5ff'
  on-primary-fixed: '#00174b'
  on-primary-fixed-variant: '#003ea8'
  secondary-fixed: '#ffdcc3'
  secondary-fixed-dim: '#ffb77d'
  on-secondary-fixed: '#2f1500'
  on-secondary-fixed-variant: '#6e3900'
  tertiary-fixed: '#85f8c4'
  tertiary-fixed-dim: '#68dba9'
  on-tertiary-fixed: '#002114'
  on-tertiary-fixed-variant: '#005137'
  background: '#faf8ff'
  on-background: '#131b2e'
  surface-variant: '#dae2fd'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.015em
  headline-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: -0.005em
  body-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  code-lg:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 18px
  code-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '400'
    lineHeight: 14px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.02em
  kbd:
    fontFamily: JetBrains Mono
    fontSize: 10px
    fontWeight: '500'
    lineHeight: 12px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 0.75rem
  margin: 1rem
  space-xs: 0.25rem
  space-sm: 0.375rem
  space-md: 0.5rem
  space-lg: 0.75rem
  space-xl: 1rem
---

## Brand & Style

This design system targets senior software engineers, tech leads, and autonomous agent operators running heavy local workflows. The visual tone is technical, disciplined, precise, and uncompromisingly dense—taking cues from top-tier local engineering environments like Linear, GitHub, and terminal dashboards. 

The aesthetic is built around:
- **High-Density Minimalism**: Every pixel serves telemetry, orchestration state, or actionable command execution. Negative space is minimal and structured rather than airy or marketing-oriented.
- **Instrument Precision**: 1px structural dividing lines, strict tabular layouts, and clear visual state transitions replace expressive decorations, shadows, or rounded softness.
- **Zero Fluff**: No decorative iconography, empty-state illustrations, marketing gradients, or oversized hero elements. The UI functions as a high-throughput cockpit where agent activity and human-in-the-loop decisions take precedence.

## Colors

The palette establishes an ultra-clean, clinical light canvas engineered for continuous, glare-free monitoring under intense developer focus:

- **Canvas & Neutral Foundation**:
  - Base canvas: `#ffffff`
  - Subtle layer/sidebar tint: `#f8fafc` (slate-50)
  - Surface active/hover: `#f1f5f9` (slate-100)
  - Hairline borders/dividers: `#e2e8f0` (slate-200)
  - Muted text & metadata: `#64748b` (slate-500)
  - Secondary text: `#334155` (slate-700)
  - Primary text & headlines: `#0f172a` (slate-900)

- **Semantic Status Signals**:
  - **Running / Executing**: `#2563eb` (blue-600) with a faint `#eff6ff` (blue-50) background for live agent tasks, patch generations, and test runs.
  - **Decision Required / Awaiting Human**: `#d97706` (amber-600) / `#f59e0b` (amber-500) with an amber-50 background for merge approvals, lint interventions, and branch collision prompts. Accompanied by a 2-second rhythm CSS pulse indicator.
  - **Done / PR Ready**: `#059669` (emerald-600) for completed automations, passing checks, and created PRs.
  - **Blocked / Execution Error**: `#e11d48` (rose-600) for failed unit tests, agent loop bailouts, and rejected diffs.
  - **Discovered / Queued**: `#94a3b8` (slate-400) for unassigned backlog tickets and pending syncs.

## Typography

The type system separates general UI hierarchy from technical engineering artifacts:

- **Interface UI (`Inter`)**: Sized deliberately between 11px and 16px to optimize visual information parsing without compromising accessibility. All UI labels, table headers, breadcrumbs, and modal notifications render in clean, neutral sans-serif with slight negative tracking on titles.
- **Developer Telemetry (`JetBrains Mono`)**: JIRA ticket keys (e.g., `ENG-4092`), git branch fragments (`feat/agent-ast-parser`), SHA commit hashes, diff lines, terminal outputs, and keyboard shortcuts render strictly in monospaced glyphs to ensure clean tabular alignment across multi-column data views.

## Layout & Spacing

The interface uses a strict multi-pane desktop-first layout designed for widescreen monitors (standard developer setups):

- **Layout Structure**: 
  - Left collapsible navigation/orchestration tree: fixed width (220px–260px).
  - Central operational board/feed: multi-column workflow stage container (Backlog, Synthesizing, Testing, Review Needed, PR Dispatched).
  - Right inspect panel: fixed width (380px–460px) displaying real-time agent execution logs, context diffs, and LLM token usage.
- **Rhythm & Density**:
  - Vertical cadence is anchored on strict 4px increments.
  - Standard padding inside list items, table rows, and badges is compressed (`space-xs` = 4px, `space-sm` = 6px, `space-md` = 8px).
  - Row heights: tables and list entries must not exceed 32px in standard mode and 28px in ultra-dense mode.
- **Adaptability**:
  - Tablet/Narrow viewports (below 1024px): Right inspector switches to an overlay drawer; columns collapse into a single master-detail stack.
  - Phone viewports (below 640px): Telemetry inspector is hidden behind an explicit toggle, and ticket tables switch to condensed single-column cards.

## Elevation & Depth

This system avoids blurred drop shadows and skeuomorphic layers. Visual separation and spatial depth rely strictly on:

- **Structural Borders**: 1px solid `#e2e8f0` dividers between all panes, table rows, and splitters.
- **Tonal Stepping**: 
  - Base app background: `#ffffff`
  - Pane headers & toolbars: `#f8fafc`
  - Active focused item: `#f1f5f9`
  - Popover menus and command palette: `#ffffff` backed by a 1px `#cbd5e1` outline and a micro shadow (`0 2px 4px rgba(15, 23, 42, 0.04)`).
- **Zero Distraction**: Eliminates stacked drop shadows. Modal overlays employ a clean `#0f172a` backdrop at 20% opacity without backdrop blur to keep machine performance unhindered during agent runs.

## Shapes

The interface embraces a low-radius, architectural geometry:
- Standard controls, inputs, badges, and cards use `roundedness: 1` (`0.25rem` / `4px`).
- Internal tags, keyboard shortcut badges (`<kbd>`), and status chips use `2px` or `3px` radius.
- Nested elements follow the concentric radius formula: nested child borders never exceed parent border curves. Circular avatars and binary toggle pips remain the only fully rounded elements.

## Components

### Buttons
- **Primary Action (Run Agent / Approve PR)**: Solid `#0f172a` background, `#ffffff` text, 1px solid transparent, 28px height, 8px horizontal padding, Inter 12px 500. Hover: `#1e293b`.
- **Secondary / Ghost**: White background, 1px solid `#e2e8f0`, `#334155` text. Hover: `#f8fafc`, border color `#cbd5e1`.
- **Destructive (Abort / Kill Process)**: White background, 1px solid `#fecdd3`, `#e11d48` text. Hover: `#fff1f2`.

### Status Badges & Chips
- Compact, height 20px, horizontal padding 6px, JetBrains Mono 11px font.
- **Running**: Blue-50 background, `#2563eb` text, 1px solid `#bfdbfe`.
- **Needs Decision**: Amber-50 background, `#d97706` text, 1px solid `#fde68a`. Includes a 6px inline dot with a subtle CSS ping/pulse animation (`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`).
- **Done**: Emerald-50 background, `#059669` text, 1px solid `#a7f3d0`.
- **Blocked**: Rose-50 background, `#e11d48` text, 1px solid `#fecdd3`.

### Lists & Data Grids
- Rows have a fixed height of 32px, 1px bottom border `#e2e8f0`.
- Monospace keys (`JIRA-1234`) pinned left, followed by the ticket title in Inter 13px, active step badge, and assigned agent status.
- Row hover produces `#f8fafc`. Keyboard selection produces `#f1f5f9` with a 2px vertical blue accent bar on the left edge.

### Keyboard Shortcut Badges (`kbd`)
- Rendered in JetBrains Mono 10px.
- Background `#f1f5f9`, border 1px solid `#cbd5e1`, text `#475569`, padding `1px 4px`, radius `3px`.

### Input Fields & Filter Bars
- 28px height, 1px solid `#e2e8f0`, background `#ffffff`, text Inter 12px.
- Focus state: border color `#2563eb`, outline `1px solid #2563eb` with no blurred glow rings. Placeholder color `#94a3b8`.

### Real-Time Telemetry Cards
- Card containers have zero drop shadow, 1px solid `#e2e8f0`, background `#ffffff`.
- Headers are 28px height, border-bottom 1px solid `#e2e8f0`, background `#f8fafc`, uppercase label in Inter 11px with `letter-spacing: 0.05em`.
- Terminal and output preview sections use JetBrains Mono 12px with a `#f8fafc` background and strict tabular numeric alignment.