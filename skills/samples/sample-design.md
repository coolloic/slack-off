# Design: CSV export of the weekly report (SAMPLE-1)

## Approach

Add `toCsv(rows)` in `src/report/csv.js`. It writes the header `Week,Orders,Revenue`, then one line per row from
`weeklyRows(orders, weeks)` (`src/report/weekly.js`). Text fields are quoted with `"` and inner quotes doubled.
Revenue uses `formatMoney` from `src/report/format.js`, so the file matches the page (two decimals).

`downloadName(today)` returns `weekly-report-YYYY-MM-DD.csv`. The download handler in `src/report/index.js` calls both
and returns `{ filename, body, contentType: "text/csv" }`.

## Weeks

The number of weeks is a parameter with a default of 12 (the description). The 26-week request in a comment is an open
question for the product owner; changing the default is a one-line change.

## Tests

`test/csv.test.js`: header row, quoting of a week label containing a comma, two-decimal revenue, empty input (header
only), and the file name for a fixed date.

## Risks

- Large exports: 12 to 26 rows, no streaming needed.
- Rounding: `formatMoney` is the single place that formats money.
