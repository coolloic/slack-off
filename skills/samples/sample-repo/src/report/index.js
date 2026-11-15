import { orders } from "../data/orders.js";
import { formatMoney, formatWeek } from "./format.js";
import { weeklyRows } from "./weekly.js";

export const COLUMNS = ["Week", "Orders", "Revenue"];

// The report page's data: the table's columns and its rows, formatted for display.
export function reportTable(weeks = 12) {
  return {
    columns: COLUMNS,
    rows: weeklyRows(orders, weeks).map((r) => [formatWeek(r.week), String(r.orders), formatMoney(r.revenueCents)]),
  };
}
