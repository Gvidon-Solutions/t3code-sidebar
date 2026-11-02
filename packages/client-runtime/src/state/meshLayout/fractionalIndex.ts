const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function validate(key: string | null) {
  if (key !== null && (!key || key.endsWith("0") || [...key].some((c) => !DIGITS.includes(c)))) {
    throw new Error("Invalid fractional index");
  }
}
export function between(a: string | null, b: string | null): string {
  validate(a);
  validate(b);
  if (a !== null && b !== null && a >= b) throw new Error("Unordered bounds");
  let prefix = "";
  for (let i = 0; ; i++) {
    const lo = a && i < a.length ? DIGITS.indexOf(a[i]!) : 0;
    const hi = b !== null && i < b.length ? DIGITS.indexOf(b[i]!) : 62;
    if (hi - lo > 1) return prefix + DIGITS[Math.floor((lo + hi) / 2)]!;
    prefix += DIGITS[lo]!;
    if (lo < hi) b = null;
  }
}
export function generateN(a: string | null, b: string | null, count: number): string[] {
  if (!Number.isInteger(count) || count < 0) throw new Error("Invalid count");
  if (!count) return [];
  const left = Math.floor(count / 2);
  const middle = between(a, b);
  return [...generateN(a, middle, left), middle, ...generateN(middle, b, count - left - 1)];
}
