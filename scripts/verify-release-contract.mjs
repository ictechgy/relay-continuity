#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { appendFile, lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage =
  "usage: verify-release-contract.mjs --cargo <Cargo.toml> --event-name <push|workflow_dispatch> --ref-type <tag|branch> --ref-name <ref> [--github-output <path>]";
const maximumCargoBytes = 1024 * 1024;

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

export function cargoPackageVersion(contents) {
  if (Buffer.byteLength(contents, "utf8") > maximumCargoBytes) {
    throw new Error("Cargo.toml exceeds the release contract size limit");
  }
  const packageSection = contents.match(
    /(?:^|\n)\[package\][ \t]*(?:#[^\r\n]*)?\r?\n([\s\S]*?)(?=\r?\n\[[^\]\r\n]+\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)|$)/
  );
  if (!packageSection) throw new Error("Cargo.toml has no [package] section");
  const versions = [
    ...packageSection[1].matchAll(
      /^[ \t]*version[ \t]*=[ \t]*(?:"([0-9A-Za-z.+-]+)"|'([0-9A-Za-z.+-]+)')[ \t]*(?:#[^\r\n]*)?\r?$/gm
    )
  ];
  if (versions.length !== 1) {
    throw new Error("Cargo.toml [package] must contain exactly one literal version");
  }
  return versions[0][1] ?? versions[0][2];
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

export async function readCargoPackageVersion(path) {
  const cargoPath = resolve(path);
  const before = await lstat(cargoPath);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maximumCargoBytes) {
    throw new Error("Cargo.toml must be a regular non-symlink file within the size limit");
  }
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("release contract requires no-follow file support");
  }

  const handle = await open(cargoPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maximumCargoBytes || !sameFile(before, opened)) {
      throw new Error("Cargo.toml changed or became unsafe before it was opened");
    }
    const bytes = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== opened.size || !sameFile(opened, after)) {
      throw new Error("Cargo.toml changed while it was being read");
    }
    return cargoPackageVersion(bytes.subarray(0, offset).toString("utf8"));
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
