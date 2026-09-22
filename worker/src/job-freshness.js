// Same monthly grace period as the existing health email, expressed for the UI.
export function maxJobAgeSeconds(id) {
  return (id === 'fetch-13f-history' ? 35 * 24 : 48) * 3600;
}
export function jobState(job, nowSeconds) {
  if (job.cronDisabled) return 'manual';
  const last = job.lastRun;
  if (!last?.ts) return 'pending';
  if (last.status === 'failed') return 'failed';
  if (nowSeconds - last.ts > maxJobAgeSeconds(job.id)) return 'stale';
  return last.status === 'ok' ? 'ok' : 'pending';
}
