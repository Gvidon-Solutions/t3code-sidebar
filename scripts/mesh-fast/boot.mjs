const waiting = [];
let available = 2;
export async function containerBoot(work) {
  if (available === 0) await new Promise((resolve) => waiting.push(resolve));
  else available--;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else available++;
  }
}
