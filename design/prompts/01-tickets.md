Screen: "Tickets" (main screen) of Slack Off.
Global shell:
- Left sidebar: Tickets (active), Audit log, Cost & quota, Settings.
- Top bar: an orange "Needs you · 3" badge (dropdown lists ticket key + decision type + waiting time); executor status chip "Claude Code · subscription · ready" (green dot); JIRA status chip "JIRA via Chrome · connected"; concurrency "Agents 1/1".
Main content:
- Header row: title "Tickets", "Fetch new tickets" button with "last fetched 5 min ago", view toggle List / Board, filters (Status, Repository, "Only needs me"), search box.
- List view table columns: Key (monospace, e.g. PROJ-128), Title, Platform status badge (status colors: Discovered gray, Refining blue, Awaiting choice orange, Designing blue, Developing blue, Reviewing blue, Awaiting confirmation orange, PR opened green, Blocked red), JIRA status, Repository, Running agent (spinner + role, e.g. "refine-ticket"), "Review AC first" toggle, AC drift warning icon (red when ACs are missing or contradict the original), Updated.
- Show ~8 realistic rows covering all statuses; one Blocked row shows reason "JIRA login expired" with "Retry" and "Abandon" actions; two Discovered rows are checkbox-selected with a bulk action bar "Start refining (2)".
