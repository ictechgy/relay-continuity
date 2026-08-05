#!/usr/bin/env node

import { cp, chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const platformPackages = [
  ["relay-darwin-arm64", "relay-macos-arm64"],
  ["relay-darwin-x64", "relay-macos-x86_64"],
  ["relay-linux-x64", "relay-linux-x86_64"]
];

function readArguments(argv) {
  const result = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("usage: package-npm.mjs --artifacts <dir> --output <dir> --version <version>");
    }
    result[key.slice(2)] = value;
  }
  if (!result.artifacts || !result.output || !result.version) {
    throw new Error("usage: package-npm.mjs --artifacts <dir> --output <dir> --version <version>");
  }
  return result;
}

async function findFile(directory, expectedName) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);
    if (entry.isFile() && entry.name === expectedName) return candidate;
    if (entry.isDirectory()) {
      const found = await findFile(candidate, expectedName);
      if (found) return found;
    }
  }
  return undefined;
}

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function copyPackage(template, destination, version) {
  await cp(template, destination, { recursive: true });
  const manifestPath = join(destination, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = version;
  if (manifest.optionalDependencies) {
    for (const dependency of Object.keys(manifest.optionalDependencies)) {
      manifest.optionalDependencies[dependency] = version;
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function npmPack(directory, output) {
  const result = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", output], {
    cwd: directory,
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim().split(/\r?\n/).at(-1);
}

const arguments_ = readArguments(process.argv);
const artifacts = resolve(arguments_.artifacts);
const output = resolve(arguments_.output);
const packages = join(output, "packages");
const tarballs = join(output, "tarballs");
const binaryDigests = new Map();

await rm(output, { recursive: true, force: true });
await mkdir(packages, { recursive: true });
await mkdir(tarballs, { recursive: true });

for (const [packageDirectory, artifactName] of platformPackages) {
  const source = await findFile(artifacts, artifactName);
  if (!source) throw new Error(`missing release artifact: ${artifactName}`);
  const checksumFile = await findFile(artifacts, `${artifactName}.sha256`);
  if (!checksumFile) throw new Error(`missing release checksum: ${artifactName}.sha256`);
  const expected = (await readFile(checksumFile, "utf8")).trim().split(/\s+/)[0];
  const sourceDigest = await sha256(source);
  if (!/^[a-f0-9]{64}$/.test(expected) || sourceDigest !== expected) {
    throw new Error(`release checksum mismatch: ${artifactName}`);
  }
  binaryDigests.set(packageDirectory, sourceDigest);
  const destination = join(packages, packageDirectory);
  await copyPackage(join(root, "packages", packageDirectory), destination, arguments_.version);
  await mkdir(join(destination, "bin"), { recursive: true });
  await cp(source, join(destination, "bin", "relay"));
  await chmod(join(destination, "bin", "relay"), 0o755);
}

const wrapperDirectory = join(packages, "relay");
await copyPackage(join(root, "packages", "relay"), wrapperDirectory, arguments_.version);

const packed = [];
const publishManifest = [];
for (const directory of [...platformPackages.map(([name]) => name), "relay"]) {
  const filename = npmPack(join(packages, directory), tarballs);
  packed.push(basename(filename));
  const manifest = JSON.parse(await readFile(join(packages, directory, "package.json"), "utf8"));
  const tarball = basename(filename);
  const entry = {
    name: manifest.name,
    tarball,
    version: manifest.version,
    sha256: await sha256(join(tarballs, tarball))
  };
  const binarySha256 = binaryDigests.get(directory);
  if (binarySha256) entry.binarySha256 = binarySha256;
  publishManifest.push(entry);
}
await writeFile(join(output, "publish-order.txt"), `${packed.join("\n")}\n`);
await writeFile(join(output, "publish-manifest.json"), `${JSON.stringify({ version: arguments_.version, packages: publishManifest }, null, 2)}\n`);
