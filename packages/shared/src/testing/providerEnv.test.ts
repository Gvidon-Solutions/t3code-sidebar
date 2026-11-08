import { expect, it } from "vite-plus/test";
import { stripProvisionedEnvironment } from "./providerEnv.ts";

it("strips provider credentials and the T3 run shim directories from PATH", () => {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/opt/t3/run/shims:/opt/t3/run/bin:/bin:/opt/t3/run/shims",
    T3CODE_RUN_SHIMS: "/opt/t3/run/shims",
    T3CODE_RUN_BIN: "/opt/t3/run/bin",
    T3CODE_RUN_SOCKET: "/tmp/agent.sock",
    ANTHROPIC_AUTH_TOKEN: "secret",
    T3CODE_TRANSFER_BUDGET_REPORT_PATH: "/tmp/report",
    HOME: "/home/user",
  };
  stripProvisionedEnvironment(env, ":");
  expect(env).toEqual({
    PATH: "/usr/bin:/bin",
    T3CODE_TRANSFER_BUDGET_REPORT_PATH: "/tmp/report",
    HOME: "/home/user",
  });
});

it("keeps the ambient environment when a live run opts in", () => {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/opt/t3/run/shims",
    T3CODE_RUN_SHIMS: "/opt/t3/run/shims",
    ANTHROPIC_AUTH_TOKEN: "secret",
    T3CODE_TEST_KEEP_PROVIDER_ENV: "1",
  };
  stripProvisionedEnvironment(env, ":");
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("secret");
  expect(env.PATH).toBe("/usr/bin:/opt/t3/run/shims");
});
