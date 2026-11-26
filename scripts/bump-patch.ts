#!/usr/bin/env bun
// Compatibility entrypoint. Updates the single package.json source only.
import { advanceVersion } from "./version.ts";
process.stdout.write(advanceVersion(process.cwd(), "patch").version);
