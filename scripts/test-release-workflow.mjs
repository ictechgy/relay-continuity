#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
const ciWorkflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");

const githubActionPins = new Map([
  ["actions/checkout", { sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", version: "v7.0.1", count: 5 }],
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
    "archive attestation authority",
    /  archive:\n    permissions:\n      attestations: write\n      contents: read\n      id-token: write\n/
  ],
  [
    "packaging attestation read authority",
    /  npm-packages:\n    needs: archive\n    runs-on: ubuntu-latest\n    permissions:\n      attestations: read\n      contents: read\n    steps:\n/
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
if (/\bNPM_TOKEN\b/.test(workflow)) {
  throw new Error("release workflow must not use a long-lived npm token");
}

process.stdout.write("Verified release workflow authority and provenance contracts.\n");
