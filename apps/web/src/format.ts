export function shortRef(requestId: string, needType: string): string {
  const prefix = needType === 'WATER' ? 'W' : 'C';
  const tail = requestId.replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase() || '0000';
  return `${prefix}-${tail}`;
}

export function waitLabel(receivedAt: string, serverTime: string): string {
  const delta = Date.parse(serverTime) - Date.parse(receivedAt);
  if (!Number.isFinite(delta)) return 'Wait time unavailable';
  if (delta < 0) return 'Station clock is not used for ordering';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'Under a minute since the server received it';
  if (minutes < 60) return `${minutes} min since the server received it`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min since the server received it`;
}

export function clock(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
    timeZoneName: 'short',
  }).format(date);
}

export function freshness(receivedAtMs: number | null): string {
  if (!receivedAtMs) return 'Not loaded';
  const seconds = Math.max(0, Math.round((Date.now() - receivedAtMs) / 1000));
  if (seconds < 3) return 'Just updated';
  return `Updated ${seconds}s ago`;
}
