export const RUN_WORKER_POLICY_SOURCE = String.raw`
function runSetting(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback;
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') throw Error('Invalid ' + name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw Error('Invalid ' + name);
  return parsed;
}
function killGraceMs(value) { return runSetting(value, 10000, 0, 2147483647, 'run termination grace'); }
function jobRetentionMs(value) { return runSetting(value, 604800000, 0, Number.MAX_SAFE_INTEGER, 'run retention'); }
function jobLogBytes(value) { return runSetting(value, 10485760, 131072, 1073741824, 'run journal byte limit'); }
`;
