// Display formatting shared by the report page.
export function formatMoney(cents) {
  return (cents / 100).toFixed(2);
}

export function formatWeek(week) {
  return `Week of ${week}`;
}
