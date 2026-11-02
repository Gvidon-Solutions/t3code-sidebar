export type Hlc = string;

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
export function tick(now: number, last: Hlc | null, envId: string): Hlc {
  const previous = last === null ? null : parse(last);
  const ms = Math.max(Math.floor(now), previous?.ms ?? 0);
  return format(ms, previous?.ms === ms ? previous.counter + 1 : 0, envId);
}
export function receive(local: Hlc, remote: Hlc, now: number): Hlc {
  const a = parse(local),
    b = parse(remote);
  const ms = Math.max(Math.floor(now), a.ms, b.ms);
  const counter = Math.max(a.ms === ms ? a.counter : -1, b.ms === ms ? b.counter : -1) + 1;
  return format(ms, counter, a.envId);
}
