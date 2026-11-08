import * as NodeChildProcess from "node:child_process";
export const COMMAND_TIMEOUT_MS = 120_000;
export const COMMAND_MAX_BUFFER = 32 * 1024 * 1024;
const POLL_INTERVAL_MS = 250;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
export const runSync = (command, args, options = {}) =>
  NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
    ...options,
  });
export const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let out = "",
      err = "";
    let bytes = 0;
    const capture = (chunk) => {
      bytes += chunk.length;
      if (bytes > (options.maxBuffer ?? COMMAND_MAX_BUFFER)) {
        child.kill();
        reject(Error(`${command}: output exceeds maxBuffer`));
        return false;
      }
      return true;
    };
    child.stdout?.on("data", (chunk) => {
      if (capture(chunk)) out += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      if (capture(chunk)) err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(
            Object.assign(Error(`${command}: ${code}: ${err.slice(-2000)} ${out.slice(-1000)}`), {
              code,
              stdout: out,
              stderr: err,
            }),
          ),
    );
  });

export const until = async (description, read, accepts, timeout = COMMAND_TIMEOUT_MS) => {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    try {
      value = await read();
      if (accepts(value)) return value;
    } catch (error) {
      value = error.message;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw Error(`${description}: ${JSON.stringify(value).slice(-3000)}`);
};
