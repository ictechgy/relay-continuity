#!/usr/bin/env node

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { constants } from "node:os";

const platforms = {
  "darwin-arm64": "@ictechgy/relay-darwin-arm64",
  "darwin-x64": "@ictechgy/relay-darwin-x64",
  "linux-x64": "@ictechgy/relay-linux-x64"
};

const target = `${process.platform}-${process.arch}`;
const packageName = platforms[target];

if (!packageName) {
  console.error(
    `Relay does not publish a native binary for ${target}. Supported targets: ${Object.keys(platforms).join(", ")}.`
  );
  process.exit(1);
}

const require = createRequire(import.meta.url);
let binary;
try {
  binary = require.resolve(`${packageName}/bin/relay`);
} catch {
  console.error(
    `Relay's ${target} package is missing. Reinstall @ictechgy/relay for this platform.`
  );
  process.exit(1);
}

const child = spawnSync(binary, process.argv.slice(2), {
  stdio: "inherit",
  windowsHide: true
});

if (child.error) {
  console.error(`Unable to start Relay: ${child.error.message}`);
  process.exit(1);
}

if (child.signal) {
  const signalNumber = constants.signals[child.signal];
  if (!Number.isInteger(signalNumber)) {
    console.error(`Relay terminated from an unknown signal: ${child.signal}`);
    process.exit(1);
  }
  process.exit(128 + signalNumber);
}

process.exit(child.status ?? 1);
