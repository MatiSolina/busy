export const ROUTINE_DAYS = [
  { label: "Mon", value: 1 },
  { label: "Tue", value: 2 },
  { label: "Wed", value: 3 },
  { label: "Thu", value: 4 },
  { label: "Fri", value: 5 },
  { label: "Sat", value: 6 },
  { label: "Sun", value: 0 },
] as const;

export function routineScheduleLabel(days: readonly number[], time: string) {
  let label = ROUTINE_DAYS.filter((day) => days.includes(day.value))
    .map((day) => day.label)
    .join(", ");
  if (days.length === 7) {
    label = "Every day";
  } else if (days.length === 5 && days.every((day) => day >= 1 && day <= 5)) {
    label = "Weekdays";
  } else if (days.length === 2 && days.includes(0) && days.includes(6)) {
    label = "Weekends";
  }
  return `${label} at ${time}`;
}
