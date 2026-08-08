#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { appendFile, lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const usage =
  "usage: verify-release-contract.mjs --cargo <Cargo.toml> --event-name <push|workflow_dispatch> --ref-type <tag|branch> --ref-name <ref> [--github-output <path>]";
const maximumCargoBytes = 1024 * 1024;
const maximumMetadataBytes = 1024 * 1024;
const cargoMetadataTimeoutMilliseconds = 15_000;

function readArguments(argv) {
  const result = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(usage);
    const name = key.slice(2);
    if (Object.hasOwn(result, name)) throw new Error(`duplicate argument: --${name}`);
    result[name] = value;
  }
  for (const required of ["cargo", "event-name", "ref-type", "ref-name"]) {
    if (!result[required]) throw new Error(usage);
  }
  const known = new Set(["cargo", "event-name", "ref-type", "ref-name", "github-output"]);
  const unknown = Object.keys(result).find((name) => !known.has(name));
  if (unknown) throw new Error(`unknown argument: --${unknown}`);
  return result;
}

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function cargoMetadata(cargoPath) {
  const result = spawnSync(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--no-deps",
      "--frozen",
      "--manifest-path",
      cargoPath
    ],
    {
      cwd: dirname(cargoPath),
      encoding: null,
      env: { ...process.env, CARGO_TERM_COLOR: "never" },
      killSignal: "SIGKILL",
      maxBuffer: maximumMetadataBytes + 1,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: cargoMetadataTimeoutMilliseconds,
      windowsHide: true
    }
  );

  if (result.error?.code === "ETIMEDOUT") {
    throw new Error("Cargo metadata exceeded the release contract time limit");
  }
  if (
    result.error?.code === "ENOBUFS" ||
    result.stdout?.length > maximumMetadataBytes ||
    result.stderr?.length > maximumMetadataBytes
  ) {
    throw new Error("Cargo metadata exceeded the release contract output limit");
  }
  if (result.error || result.status !== 0) {
    throw new Error("Cargo metadata could not resolve the validated manifest");
  }

  try {
    return JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new Error("Cargo metadata returned an invalid release contract response");
  }
}

function packageVersionFromMetadata(metadata, cargoPath) {
  if (!metadata || metadata.version !== 1 || !Array.isArray(metadata.packages)) {
    throw new Error("Cargo metadata returned an invalid release contract response");
  }
  const packages = metadata.packages.filter(
    (entry) => entry && entry.manifest_path === cargoPath
  );
  if (packages.length !== 1) {
    throw new Error(
      "Cargo metadata did not return exactly one package for the validated manifest"
    );
  }
  if (typeof packages[0].version !== "string") {
    throw new Error("Cargo metadata returned an invalid release contract response");
  }
  return packages[0].version;
}

export async function readCargoPackageVersion(path) {
  const requestedCargoPath = resolve(path);
  let before;
  try {
    before = await lstat(requestedCargoPath);
  } catch {
    throw new Error("Cargo.toml could not be inspected safely");
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size > maximumCargoBytes) {
    throw new Error("Cargo.toml must be a regular non-symlink file within the size limit");
  }
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("release contract requires no-follow file support");
  }

  let handle;
  try {
    handle = await open(requestedCargoPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error("Cargo.toml could not be opened safely");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maximumCargoBytes || !sameFile(before, opened)) {
      throw new Error("Cargo.toml changed or became unsafe before it was opened");
    }

    let cargoPath;
    let canonical;
    try {
      cargoPath = await realpath(requestedCargoPath);
      canonical = await lstat(cargoPath);
    } catch {
      throw new Error("Cargo.toml changed or became unsafe before metadata was read");
    }
    if (!canonical.isFile() || canonical.isSymbolicLink() || !sameFile(opened, canonical)) {
      throw new Error("Cargo.toml changed or became unsafe before metadata was read");
    }

    const metadata = cargoMetadata(cargoPath);

    let after;
    let requestedAfter;
    let cargoPathAfter;
    try {
      after = await handle.stat();
      requestedAfter = await lstat(requestedCargoPath);
      cargoPathAfter = await realpath(requestedCargoPath);
    } catch {
      throw new Error("Cargo.toml changed or became unsafe while metadata was read");
    }
    if (
      !after.isFile() ||
      !requestedAfter.isFile() ||
      requestedAfter.isSymbolicLink() ||
      cargoPathAfter !== cargoPath ||
      !sameFile(opened, after) ||
      !sameFile(opened, requestedAfter)
    ) {
      throw new Error("Cargo.toml changed or became unsafe while metadata was read");
    }

    return packageVersionFromMetadata(metadata, cargoPath);
  } finally {
    await handle.close();
  }
}

export function isSemVer(version) {
  if (version.length > 256) return false;
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    version
  );
}

export function verifyReleaseIdentity({ version, eventName, refType, refName }) {
  if (!isSemVer(version)) throw new Error("Cargo package version is not valid SemVer");
  if (eventName === "push") {
    if (refType !== "tag") throw new Error("release push must be a tag ref");
  } else if (eventName === "workflow_dispatch") {
    if (refType !== "tag" && refType !== "branch") {
      throw new Error("manual release ref must be a branch or tag");
    }
  } else {
    throw new Error("unsupported release event");
  }

  if (refType === "tag" && refName !== `v${version}`) {
    throw new Error("release tag does not exactly match the Cargo package version");
  }
  return version;
}

async function main() {
  const arguments_ = readArguments(process.argv);
  const version = verifyReleaseIdentity({
    version: await readCargoPackageVersion(arguments_.cargo),
    eventName: arguments_["event-name"],
    refType: arguments_["ref-type"],
    refName: arguments_["ref-name"]
  });
  if (arguments_["github-output"]) {
    await appendFile(resolve(arguments_["github-output"]), `version=${version}\n`, {
      encoding: "utf8",
      flag: "a"
    });
  }
  process.stdout.write(`Verified release contract for ${version}.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`release contract rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
