import { nativeQaRuntimeEnv } from "./native-qa-environment.ts";
import { enableNativeQa } from "./native-qa-state.ts";

declare const __FORGEORBIT_NATIVE_QA_ROOT__: string;
try {
  const env = nativeQaRuntimeEnv(__FORGEORBIT_NATIVE_QA_ROOT__, process.env);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  process.umask(0o077);
  enableNativeQa(__FORGEORBIT_NATIVE_QA_ROOT__);
} catch {
  // No environment values, DB imports or cleanup that can open an app.
  console.error("[forgeorbit] QA artifact refused launch without its isolated environment");
  process.exit(1);
}
await import("./native-bootstrap.ts");
