New MOBILE screen (390×844 phone, mobile web) "Acceptance report – mobile", same design system. Opaque top bar: back arrow, "PROJ-128" in monospace, and an orange "Awaiting confirmation" badge with a pulsing dot. Scrollable pill tabs with "Acceptance" selected.

At the top, a VERDICT BANNER (show the green variant "Passed · attempt 2 of 3 · today 14:05"). Below it, two small greyed example rows labelled "Variant":
- red "Failed · attempt 3 of 3"
- amber "E2E not executed — no acceptance section in .slackoff/config.json"

Then a grey ISOLATION NOTE with a lock icon: "The acceptance agent saw only the requirements and ACs, ran on a history-free snapshot with its own Claude config and its own browser".

Then "Acceptance criteria" as a list of CARDS. Each card has:
- the AC id in monospace ("AC-1") and the AC text;
- a Pass (green) or Fail (red) tag on the right;
- flow chips "normal", "error", "boundary".

The first card is EXPANDED. It shows each flow's Steps / Expected / Actual as compact labelled rows, then a horizontally scrolling row of 3 screenshot THUMBNAILS (16:10, rounded, each with a short caption). The third card shows a red warning row "Platform re-run disagreed: test 'rejects empty cart' failed".

Then a collapsible "Previous attempts" timeline, collapsed. It shows the last line: "Attempt 1 · Failed · AC-2 · fixed in iteration 3".

STICKY BOTTOM BAR:
- left: two secondary buttons, "Reject" and "Re-run acceptance";
- right: an orange primary button "Confirm & deliver";
- under it, a caption: "This will: show you the exact list of actions before anything is sent".

Also draw, as a second frame next to it, a FULL-SCREEN LIGHTBOX for a screenshot:
- black background;
- the image fitted to the screen width;
- a caption at the bottom: "AC-1 · normal flow · step 3 — order confirmation";
- left/right chevron buttons and a close (X) button top-right, all ≥44px;
- a "2 / 3" counter.

Opaque bars, nothing wider than the screen, touch targets ≥44px, English copy, no model names, no person names.
