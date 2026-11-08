export type Hlc = string;
export const MAX_CLOCK_AHEAD_MS = 300_000;
export function hlcPhysical(h: Hlc): number {
  return parse(h).ms;
}
export function isFutureHlc(h: Hlc, now: number): boolean {
  return parse(h).ms > Math.floor(now) + MAX_CLOCK_AHEAD_MS;
}

function parse(h: Hlc) {
  const match = /^(\d{13})\.(\d{5})\.(.+)$/.exec(h);
  if (!match) throw new Error(`Invalid HLC: ${h}`);
  return { ms: Number(match[1]), counter: Number(match[2]), envId: match[3]! };
}
function format(ms: number, counter: number, envId: string): Hlc {
  ms += Math.floor(counter / 100000);
  counter %= 100000;
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 9999999999999 || !envId) {
    throw new Error("HLC out of range");
  }
  return `${String(ms).padStart(13, "0")}.${String(counter).padStart(5, "0")}.${envId}`;
}
export function compare(a: Hlc, b: Hlc): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function bounded(ms: number, counter: number, envId: string, now: number): Hlc {
  if (ms + Math.floor(counter / 100000) > Math.floor(now) + MAX_CLOCK_AHEAD_MS) {
    throw new Error("Mesh clock is ahead of this device; correct the device clock before editing");
  }
  return format(ms, counter, envId);
}
export function tick(now: number, last: Hlc | null, envId: string): Hlc {
  const previous = last === null ? null : parse(last);
  const ms = Math.max(Math.floor(now), previous?.ms ?? 0);
  const counter = previous?.ms === ms ? previous.counter + 1 : 0;
  return bounded(ms, counter, envId, now);
}
export function receive(local: Hlc, remote: Hlc, now: number): Hlc {
  const a = parse(local),
    b = parse(remote);
  const ms = Math.max(Math.floor(now), a.ms, b.ms);
  const counter = Math.max(a.ms === ms ? a.counter : -1, b.ms === ms ? b.counter : -1) + 1;
  return bounded(ms, counter, a.envId, now);
}
