import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Offline Desktop-carried CLI fixture. Execution is deliberately unsupported. */
export function writeDeepSeekFixture(root: string, version = "0.2.1-rc.5"): string {
  const app = path.join(root, "DeepSeek Harness.app");
  const contents = path.join(app, "Contents");
  const cli = path.join(contents, "Resources/runtime/cli/bin/dsh");
  mkdirSync(path.dirname(cli), { recursive: true });
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0"?><plist><dict>
<key>CFBundleIdentifier</key><string>com.deepseek.dsh</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`);
  writeFileSync(path.join(contents, "Resources/app.asar"), "offline fixture, not a runtime");
  writeFileSync(path.join(contents, "MacOS/DeepSeek Harness"), "offline fixture");
  writeFileSync(cli, `#!/bin/sh
# Desktop launcher target: @deepseek-ai/dsh-desktop-host/lib/cli.js
echo invoked >> "$(dirname "$0")/invocations"
case "$*" in
  --version) echo '${version}'; exit 0 ;;
  --help) echo 'dsh: boot a DeepSeek Harness profile'; exit 0 ;;
  '--profile headless --help') echo 'Usage: headless [--json] [--session-id <id>] [task]'; exit 0 ;;
  *) echo 'Execution unsupported in FO-DEEPSEEK01 fixture' >&2; exit 64 ;;
esac
`);
  chmodSync(cli, 0o755);
  return app;
}
