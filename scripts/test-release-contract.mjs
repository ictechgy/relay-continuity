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

function expectRejected(result, label, reason) {
  expectStatus(result, 1, label);
  const expected = `release contract rejected: ${reason}`;
  if (result.stderr.trim() !== expected) {
    throw new Error(
      `${label}: expected stderr ${JSON.stringify(expected)}, received ${JSON.stringify(result.stderr.trim())}`
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
    [
      "push",
      "tag",
      "v0.2.0-rc.8",
      "mismatched tag",
      "release tag does not exactly match the Cargo package version"
    ],
    ["push", "branch", "main", "branch push", "release push must be a tag ref"],
    [
      "workflow_dispatch",
      "tag",
      "v0.2.0",
      "manual mismatched tag",
      "release tag does not exactly match the Cargo package version"
    ],
    [
      "workflow_dispatch",
      "commit",
      "deadbeef",
      "manual unsupported ref",
      "manual release ref must be a branch or tag"
    ],
    ["pull_request", "branch", "main", "unsupported event", "unsupported release event"]
  ];
  for (const [eventName, refType, refName, label, reason] of rejected) {
    expectRejected(run(cargoPath, eventName, refType, refName), label, reason);
  }

  for (const invalid of ["01.2.3", "1.02.3", "1.2", "1.2.3-01", "1.2.3-"]) {
    await writeFile(cargoPath, cargo(invalid));
    expectRejected(
      run(cargoPath, "push", "tag", `v${invalid}`),
      `invalid SemVer ${invalid}`,
      "Cargo package version is not valid SemVer"
    );
  }

  await writeFile(cargoPath, cargo("1.2.3", 'version = "9.9.9"'));
  expectRejected(
    run(cargoPath, "push", "tag", "v1.2.3"),
    "duplicate package version",
    "Cargo.toml [package] must contain exactly one literal version"
  );

  await writeFile(cargoPath, cargo("1.2.3", "version = '9.9.9'"));
  expectRejected(
    run(cargoPath, "push", "tag", "v1.2.3"),
    "mixed-quote duplicate package version",
    "Cargo.toml [package] must contain exactly one literal version"
  );

  const oversizedVersion = `1.2.3-${"a".repeat(257)}`;
  await writeFile(cargoPath, cargo(oversizedVersion));
  expectRejected(
    run(cargoPath, "push", "tag", `v${oversizedVersion}`),
    "oversized version",
    "Cargo package version is not valid SemVer"
  );

  await writeFile(cargoPath, `${cargo("1.2.3")}#${"x".repeat(1024 * 1024)}`);
  expectRejected(
    run(cargoPath, "push", "tag", "v1.2.3"),
    "oversized Cargo.toml",
    "Cargo.toml must be a regular non-symlink file within the size limit"
  );

  const symlinkTarget = join(fixture, "Cargo.target.toml");
  const symlinkPath = join(fixture, "Cargo.symlink.toml");
  await writeFile(symlinkTarget, cargo("1.2.3"));
  await symlink(symlinkTarget, symlinkPath);
  expectRejected(
    run(symlinkPath, "push", "tag", "v1.2.3"),
    "symlinked Cargo.toml",
    "Cargo.toml must be a regular non-symlink file within the size limit"
  );

  const directoryPath = join(fixture, "Cargo.directory.toml");
  await mkdir(directoryPath);
  expectRejected(
    run(directoryPath, "push", "tag", "v1.2.3"),
    "directory Cargo.toml",
    "Cargo.toml must be a regular non-symlink file within the size limit"
  );

  await writeFile(cargoPath, `[workspace]\nmembers = []\n`);
  expectRejected(
    run(cargoPath, "push", "tag", "v1.2.3"),
    "missing package section",
    "Cargo.toml has no [package] section"
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}

process.stdout.write("Verified release tag and Cargo version contracts.\n");
