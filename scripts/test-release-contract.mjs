#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const verifier = join(root, "scripts", "verify-release-contract.mjs");

function cargo(version, extraPackageLines = "") {
  return `[package]\nname = "relay-continuity"\nversion = "${version}"\n${extraPackageLines}\n[dependencies]\nexample = "1"\n`;
}

function run(cargoPath, eventName, refType, refName, githubOutput) {
  const arguments_ = [
    verifier,
    "--cargo",
    cargoPath,
    "--event-name",
    eventName,
    "--ref-type",
    refType,
    "--ref-name",
    refName
  ];
  if (githubOutput) arguments_.push("--github-output", githubOutput);
  return spawnSync(process.execPath, arguments_, { cwd: root, encoding: "utf8" });
}

function expectStatus(result, status, label) {
  if (result.status !== status) {
    throw new Error(
      `${label}: expected exit ${status}, received ${result.status}: ${result.stderr || result.stdout}`
    );
  }
}

const fixture = await mkdtemp(join(tmpdir(), "relay-release-contract-test-"));
try {
  const cargoPath = join(fixture, "Cargo.toml");
  const outputPath = join(fixture, "github-output");
  await writeFile(cargoPath, cargo("0.2.0-rc.9"));
  await writeFile(outputPath, "existing=value\n");

  const tagPush = run(cargoPath, "push", "tag", "v0.2.0-rc.9", outputPath);
  expectStatus(tagPush, 0, "matching tag push");
  if ((await readFile(outputPath, "utf8")) !== "existing=value\nversion=0.2.0-rc.9\n") {
    throw new Error("matching tag push did not append the exact release version output");
  }

  expectStatus(run(cargoPath, "workflow_dispatch", "branch", "main"), 0, "manual branch");
  expectStatus(
    run(cargoPath, "workflow_dispatch", "tag", "v0.2.0-rc.9"),
    0,
    "manual matching tag"
  );
  await writeFile(cargoPath, cargo("0.2.0-rc.9").replaceAll("\n", "\r\n"));
  expectStatus(run(cargoPath, "push", "tag", "v0.2.0-rc.9"), 0, "CRLF Cargo.toml");
  await writeFile(cargoPath, cargo("0.2.0-rc.9").replace('"0.2.0-rc.9"', "'0.2.0-rc.9'"));
  expectStatus(
    run(cargoPath, "push", "tag", "v0.2.0-rc.9"),
    0,
    "single-quoted literal package version"
  );
  await writeFile(cargoPath, cargo("0.2.0-rc.9"));

  const rejected = [
    ["push", "tag", "v0.2.0-rc.8", "mismatched tag"],
    ["push", "branch", "main", "branch push"],
    ["workflow_dispatch", "tag", "v0.2.0", "manual mismatched tag"],
    ["workflow_dispatch", "commit", "deadbeef", "manual unsupported ref"],
    ["pull_request", "branch", "main", "unsupported event"]
  ];
  for (const [eventName, refType, refName, label] of rejected) {
    expectStatus(run(cargoPath, eventName, refType, refName), 1, label);
  }

  for (const invalid of ["01.2.3", "1.02.3", "1.2", "1.2.3-01", "1.2.3-"]) {
    await writeFile(cargoPath, cargo(invalid));
    expectStatus(run(cargoPath, "push", "tag", `v${invalid}`), 1, `invalid SemVer ${invalid}`);
  }

  await writeFile(cargoPath, cargo("1.2.3", 'version = "9.9.9"'));
  expectStatus(run(cargoPath, "push", "tag", "v1.2.3"), 1, "duplicate package version");

  await writeFile(cargoPath, cargo("1.2.3", "version = '9.9.9'"));
  expectStatus(
    run(cargoPath, "push", "tag", "v1.2.3"),
    1,
    "mixed-quote duplicate package version"
  );

  const oversizedVersion = `1.2.3-${"a".repeat(257)}`;
  await writeFile(cargoPath, cargo(oversizedVersion));
  expectStatus(
    run(cargoPath, "push", "tag", `v${oversizedVersion}`),
    1,
    "oversized version"
  );

  await writeFile(cargoPath, `${cargo("1.2.3")}#${"x".repeat(1024 * 1024)}`);
  expectStatus(run(cargoPath, "push", "tag", "v1.2.3"), 1, "oversized Cargo.toml");

  const symlinkTarget = join(fixture, "Cargo.target.toml");
  const symlinkPath = join(fixture, "Cargo.symlink.toml");
  await writeFile(symlinkTarget, cargo("1.2.3"));
  await symlink(symlinkTarget, symlinkPath);
  expectStatus(run(symlinkPath, "push", "tag", "v1.2.3"), 1, "symlinked Cargo.toml");

  const directoryPath = join(fixture, "Cargo.directory.toml");
  await mkdir(directoryPath);
  expectStatus(run(directoryPath, "push", "tag", "v1.2.3"), 1, "directory Cargo.toml");

  await writeFile(cargoPath, `[workspace]\nmembers = []\n`);
  expectStatus(run(cargoPath, "push", "tag", "v1.2.3"), 1, "missing package section");
} finally {
  await rm(fixture, { recursive: true, force: true });
}

process.stdout.write("Verified release tag and Cargo version contracts.\n");
