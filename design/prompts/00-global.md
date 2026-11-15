Desktop web app (1440px wide), named "Slack Off". A locally-run developer tool where AI agents move JIRA tickets from "Ready for Dev" to "Ready for Human Review"; the developer only steps in at a few decision points.
Users: software engineers. Style: restrained developer-tool aesthetic like Linear / GitHub, high information density, keyboard friendly, light theme (dark theme later), monospace font for ticket keys, branch names, code and JSON. No marketing imagery or illustrations. All UI copy in English.
Layout: narrow left sidebar navigation + main content area.
Global status colors: blue = agent running; orange with pulsing dot = waiting for developer decision (most prominent); green = done/passed; red = blocked/failed/contradiction; gray = abandoned/not started.
Decision points always use the same component: an orange-bordered card titled "Your decision needed" with a primary button. Any button that writes externally (change JIRA, comment, push, open PR) shows a small "This will: …" line next to it.
Agent activity appears as a collapsible live terminal-like log.
