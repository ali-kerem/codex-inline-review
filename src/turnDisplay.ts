export function formatTurnTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())} ${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

export function turnDisplayLabel(turnId: string, timestamp: string): string {
  return `Turn ${turnId.slice(0, 8)} ${formatTurnTimestamp(timestamp)}`;
}
