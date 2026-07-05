/** Resolution -> bucket size in seconds (raw = no bucketing). */
export const RESOLUTION_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '1h': 3600,
  raw: 0,
};
