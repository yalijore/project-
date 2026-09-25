// Vitest global setup. Tests run with a fixed zone so date logic is deterministic
// unless a test sets its own zone explicitly.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ =
  'America/New_York';
