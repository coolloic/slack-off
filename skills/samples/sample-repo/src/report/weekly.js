// Groups orders by the Monday of their week, newest first, keeping the last `weeks` weeks.
export function weekStart(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export function weeklyRows(orders, weeks = 12) {
  const byWeek = new Map();
  for (const o of orders) {
    const w = weekStart(o.placedAt);
    const row = byWeek.get(w) ?? { week: w, orders: 0, revenueCents: 0 };
    row.orders += 1;
    row.revenueCents += o.total;
    byWeek.set(w, row);
  }
  return [...byWeek.values()].sort((a, b) => (a.week < b.week ? 1 : -1)).slice(0, weeks);
}
