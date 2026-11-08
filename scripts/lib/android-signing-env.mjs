import * as NodeFS from "node:fs";

export function applyAndroidSigningEnvironment(env, development = false) {
  if (development || env.T3_ANDROID_KEYSTORE || !env.T3_ANDROID_SIGNING_ENV) return;
  const text = NodeFS.readFileSync(env.T3_ANDROID_SIGNING_ENV, "utf8");
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?(T3_ANDROID_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    env[match[1]] = value;
  }
}
