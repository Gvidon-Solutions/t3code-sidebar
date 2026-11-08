/** Any environment key that can make a build honour test-only behaviour. */
const testBuildFlag = /^T3CODE_[A-Z0-9_]*TEST_BUILD[A-Z0-9_]*$/;

const isEnabled = (value: string | undefined) =>
  value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

/** Names of enabled test-build flags in `env`, so a release build can refuse to run. */
export function releaseBuildTestFlags(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([key, value]) => testBuildFlag.test(key) && isEnabled(value))
    .map(([key]) => key)
    .sort();
}

/** Throws when a release build would inherit a test-only flag from the ambient environment. */
export function assertReleaseBuildEnv(env: NodeJS.ProcessEnv = process.env): void {
  const flags = releaseBuildTestFlags(env);
  if (flags.length > 0)
    throw new Error(
      `Refusing a release build with test-only flags set: ${flags.join(", ")}. Unset them and build again.`,
    );
}
