import { SERVICE_LAUNCHER_CONTEXT_ENV } from "../cloud/serviceProtocol.ts";

// The shared provider-env setup removes T3 run shims and provider credentials. Agents inside a
// managed T3 service also inherit its home and launcher context; CI has neither.
for (const name of ["T3CODE_HOME", "T3_BOOT_SERVICE_UNIT", SERVICE_LAUNCHER_CONTEXT_ENV]) {
  delete process.env[name];
}
