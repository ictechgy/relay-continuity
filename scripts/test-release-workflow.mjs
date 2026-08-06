#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
const ciWorkflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");

const releaseContractTests = spawnSync(
  process.execPath,
  [resolve(root, "scripts/test-release-contract.mjs")],
  { cwd: root, encoding: "utf8" }
);
if (releaseContractTests.status !== 0) {
  throw new Error(
    `release contract tests failed: ${releaseContractTests.stderr || releaseContractTests.stdout}`
  );
}

const githubActionPins = new Map([
  ["actions/checkout", { sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", version: "v7.0.1", count: 6 }],
  ["actions/upload-artifact", { sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", version: "v7.0.1", count: 3 }],
  ["actions/download-artifact", { sha: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", version: "v8.0.1", count: 2 }],
  ["actions/setup-node", { sha: "820762786026740c76f36085b0efc47a31fe5020", version: "v7.0.0", count: 1 }]
]);
const actionCounts = new Map([...githubActionPins.keys()].map((action) => [action, 0]));
const combinedWorkflows = `${ciWorkflow}\n${workflow}`;

for (const [sourceName, source] of [
  ["ci", ciWorkflow],
  ["release", workflow]
]) {
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const uses = line.match(/^\s*(?:-\s*)?uses\s*:\s*(?:"([^"]*)"|'([^']*)'|([^#]*?))(?:\s+#\s*(.*?)\s*)?$/);
    if (!uses) continue;

    const value = (uses[1] ?? uses[2] ?? uses[3]).trim();
    const comment = uses[4]?.trim();
    if (!value.startsWith("./") && !value.startsWith("docker://")) {
      const remote = value.match(/^([^@\s]+)@([0-9a-f]{40})$/);
      if (!remote || !remote[1].includes("/")) {
        throw new Error(
          `${sourceName} workflow line ${index + 1} must pin every remote action to a full 40-hex commit SHA`
        );
      }
    }
    const action = [...githubActionPins.keys()].find((candidate) => value.startsWith(`${candidate}@`));
    if (!action) continue;

    const approved = githubActionPins.get(action);
    if (value !== `${action}@${approved.sha}` || comment !== approved.version) {
      throw new Error(`${sourceName} workflow line ${index + 1} uses an unapproved ${action} pin`);
    }
    actionCounts.set(action, actionCounts.get(action) + 1);
  }
}
for (const [action, approved] of githubActionPins) {
  const actual = actionCounts.get(action);
  if (actual !== approved.count) {
    throw new Error(`workflows must use ${action} exactly ${approved.count} times, found ${actual}`);
  }
  const rawReferences = combinedWorkflows.match(new RegExp(`${action}@`, "g"))?.length ?? 0;
  if (rawReferences !== actual) {
    throw new Error(`workflows contain an unparsed ${action} reference`);
  }
}
if (!/actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0\n        with:\n          node-version: '24'\n          registry-url: https:\/\/registry\.npmjs\.org\n          package-manager-cache: false\n/.test(workflow)) {
  throw new Error("release workflow must disable setup-node package-manager caching explicitly");
}
if ((workflow.match(/skip-decompress: true\n          digest-mismatch: error/g) ?? []).length !== 2) {
  throw new Error("release workflow must bypass deprecated artifact decompression without weakening digest checks");
}
if ((workflow.match(/test ! -L /g) ?? []).length !== 4) {
  throw new Error("release workflow must reject symlinked artifact payloads after extraction");
}

const contracts = [
  [
    "non-cancelling per-ref release concurrency",
    /concurrency:\n  group: release-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false/
  ],
  [
    "early release identity contract",
    /  release-contract:\n    runs-on: ubuntu-22\.04\n    timeout-minutes: 5\n    permissions:\n      contents: read\n    outputs:\n      version: \$\{\{ steps\.verify\.outputs\.version \}\}[\s\S]*node scripts\/verify-release-contract\.mjs[\s\S]*--cargo Cargo\.toml[\s\S]*--event-name "\$RELEASE_EVENT_NAME"[\s\S]*--ref-type "\$RELEASE_REF_TYPE"[\s\S]*--ref-name "\$RELEASE_REF_NAME"[\s\S]*--github-output "\$GITHUB_OUTPUT"/
  ],
  [
    "archive attestation authority",
    /  archive:\n    needs: release-contract\n    timeout-minutes: 35\n    permissions:\n      attestations: write\n      contents: read\n      id-token: write\n/
  ],
  [
    "packaging attestation read authority",
    /  npm-packages:\n    needs: \[release-contract, archive\]\n    runs-on: ubuntu-22\.04\n    timeout-minutes: 20\n    permissions:\n      attestations: read\n      contents: read\n    steps:\n/
  ],
  [
    "publish dependency and timeout",
    /  npm-publish:[\s\S]*needs: \[release-contract, npm-packages\]\n    runs-on: ubuntu-22\.04\n    timeout-minutes: 15/
  ],
  [
    "portable Linux target with stable asset name",
    /- os: ubuntu-22\.04\n            asset: linux-x86_64\n            target: x86_64-unknown-linux-musl[\s\S]*cargo build --release --locked --target "\$\{\{ matrix\.target \}\}"[\s\S]*target\/\$\{\{ matrix\.target \}\}\/release\/relay"/
  ],
  [
    "dynamic and GLIBC rejection",
    /file relay-linux-x86_64 \| grep -E 'x86-64\.\*static' >\/dev\/null[\s\S]*readelf -d relay-linux-x86_64 \| grep '\(NEEDED\)' >\/dev\/null[\s\S]*strings relay-linux-x86_64 \| grep -E 'GLIBC_\[0-9\]' >\/dev\/null/
  ],
  [
    "digest-pinned Ubuntu runtime smoke",
    /ubuntu:22\.04@sha256:0199853f6d6b20b0424f3c5694a72a62764f01e6a771b1eb48a4197848986c7e/
  ],
  [
    "digest-pinned Debian runtime smoke",
    /debian:12-slim@sha256:1def178129dfb5f24db43afbf2fcac04530012e3264ba4ff81c71184e17a9ee4/
  ],
  [
    "isolated read-only amd64 runtime smoke",
    /--platform linux\/amd64[\s\S]*--network none[\s\S]*--read-only[\s\S]*--cap-drop ALL[\s\S]*--security-opt no-new-privileges[\s\S]*--user "\$\(id -u\):\$\(id -g\)"[\s\S]*--env RELAY_STATE_HOME=\/smoke\/state[\s\S]*\/opt\/relay --version; \/opt\/relay --help >\/tmp\/help; \/opt\/relay init >\/tmp\/init; \/opt\/relay status >\/tmp\/status/
  ],
  [
    "contract-authoritative package version",
    /RELEASE_VERSION: \$\{\{ needs\.release-contract\.outputs\.version \}\}/
  ],
  [
    "pinned attestation action",
    /actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/
  ],
  ["ephemeral GitHub CLI authentication", /GH_TOKEN: \$\{\{ github\.token \}\}/],
  ["repository provenance binding", /--repo "\$GITHUB_REPOSITORY"/],
  ["workflow provenance binding", /--signer-workflow "\$SIGNER_WORKFLOW"/],
  ["source ref binding", /--source-ref "\$GITHUB_REF"/],
  ["source commit binding", /--source-digest "\$GITHUB_SHA"/],
  ["hosted runner policy", /--deny-self-hosted-runners/],
  [
    "native payload verification input",
    /node scripts\/verify-npm-packages\.mjs \\\n            --output dist\/npm \\\n            --artifacts release-assets/
  ],
  [
    "verified native artifact extraction",
    /actual_archives="\$\(find release-assets -mindepth 1 -maxdepth 1 -exec basename \{\} \\; \| LC_ALL=C sort\)"\n          test "\$actual_archives" = "\$expected_archives"[\s\S]*expected="\$\(printf 'relay-%s\\nrelay-%s\.sha256\\n' "\$asset" "\$asset" \| LC_ALL=C sort\)"\n            actual="\$\(unzip -Z1 "\$archive" \| LC_ALL=C sort\)"\n            test "\$actual" = "\$expected"\n            unzip -q "\$archive" -d release-assets/
  ],
  [
    "verified npm artifact extraction",
    /archive="npm-packages\/npm-packages\.zip"\n          actual_archives="\$\(find npm-packages -mindepth 1 -maxdepth 1 -exec basename \{\} \\; \| LC_ALL=C sort\)"\n          test "\$actual_archives" = "npm-packages\.zip"[\s\S]*actual="\$\(unzip -Z1 "\$archive" \| LC_ALL=C sort\)"\n          test "\$actual" = "\$expected"\n          unzip -q "\$archive" -d npm-packages/
  ]
];

for (const [name, pattern] of contracts) {
  if (!pattern.test(workflow)) throw new Error(`release workflow violates ${name}`);
}
if (/runs-on: ubuntu-latest/.test(workflow)) {
  throw new Error("release workflow must use versioned Linux runner labels");
}
if ((workflow.match(/@sha256:[0-9a-f]{64}/g) ?? []).length !== 2) {
  throw new Error("release workflow must use exactly two reviewed runtime image digests");
}
if (/sed -n 's\/\^version/.test(workflow)) {
  throw new Error("downstream release jobs must consume the verified contract version");
}
if (/\bNPM_TOKEN\b/.test(workflow)) {
  throw new Error("release workflow must not use a long-lived npm token");
}

process.stdout.write("Verified release workflow authority and provenance contracts.\n");
