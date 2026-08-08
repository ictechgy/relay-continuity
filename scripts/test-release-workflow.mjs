#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
const ciWorkflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
const codeqlWorkflow = await readFile(resolve(root, ".github/workflows/codeql.yml"), "utf8");
const codeqlConfig = await readFile(resolve(root, ".github/codeql/codeql-config.yml"), "utf8");
const relayMain = await readFile(resolve(root, "src/main.rs"), "utf8");

function jobBlock(source, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`release workflow has no ${name} job`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function verifyRemoteActionPin(value, location) {
  if (value.startsWith("./")) return;
  if (value.startsWith("docker://")) {
    if (!/^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/.test(value)) {
      throw new Error(`${location} must pin docker actions to an immutable sha256 digest`);
    }
    return;
  }
  const remote = value.match(/^([^@\s]+)@([0-9a-f]{40})$/);
  if (!remote || !remote[1].includes("/")) {
    throw new Error(`${location} must pin every remote action to a full 40-hex commit SHA`);
  }
}

function verifyNpmPublishTrigger(source) {
  const job = jobBlock(source, "npm-publish");
  if (
    !/^  npm-publish:\n    if: github\.event_name == 'push' && github\.ref_type == 'tag' && vars\.PUBLISH_NPM == 'true'$/m.test(
      job
    )
  ) {
    throw new Error("npm publish must require an enabled tag push");
  }
}

function productionGitStatusArgs(source) {
  const stringLiteral = /"(?:\\.|[^"\\])*"/g;
  const calls = [...source.matchAll(/\bgit_bytes\(\s*root\s*,\s*&\[(?<arguments>[\s\S]*?)\]\s*,?\s*\)/g)];
  const statusCalls = calls
    .map(({ groups }) => {
      const rawArguments = groups.arguments;
      if (rawArguments.replace(stringLiteral, "").replace(/[\s,]/g, "") !== "") return null;
      return [...rawArguments.matchAll(stringLiteral)].map(([literal]) => JSON.parse(literal));
    })
    .filter((args) => args?.[0] === "status" && args.includes("--porcelain=v1"));

  if (statusCalls.length !== 1) {
    throw new Error(`expected exactly one production porcelain Git status call, found ${statusCalls.length}`);
  }
  return statusCalls[0];
}

function verifyReleaseSmokeGitStatusFixture(workflowSource, rustSource) {
  const expected = productionGitStatusArgs(rustSource).join(" ");
  const archiveJob = jobBlock(workflowSource, "archive");
  if ((archiveJob.match(/^\s*'case "\$\*" in'\s*\\\s*$/gm) ?? []).length !== 1) {
    throw new Error("release smoke fake Git fixture must match the complete argument vector");
  }
  const fakeGitCommands = [
    ...archiveJob.matchAll(/^\s*'\s*"([^"]+)"\)\s+.*;;'\s*\\\s*$/gm)
  ].map((match) => match[1]);
  const statusCommands = fakeGitCommands.filter(
    (command) => command === "status" || command.startsWith("status ")
  );

  if (statusCommands.length !== 1 || statusCommands[0] !== expected) {
    throw new Error(
      `release smoke fake Git status fixture must match production exactly: expected ${JSON.stringify(expected)}, found ${JSON.stringify(statusCommands)}`
    );
  }
  return expected;
}

const githubActionPins = new Map([
  ["actions/checkout", { sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", version: "v7.0.1" }],
  ["actions/upload-artifact", { sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", version: "v7.0.1" }],
  ["actions/download-artifact", { sha: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", version: "v8.0.1" }],
  ["actions/setup-node", { sha: "820762786026740c76f36085b0efc47a31fe5020", version: "v7.0.0" }],
  ["github/codeql-action/init", { sha: "5595ccaf912efad79be6eef63a5619ff05969be3", version: "v4.37.6" }],
  ["github/codeql-action/analyze", { sha: "5595ccaf912efad79be6eef63a5619ff05969be3", version: "v4.37.6" }]
]);
const actionCounts = new Map([...githubActionPins.keys()].map((action) => [action, 0]));
const combinedWorkflows = `${ciWorkflow}\n${workflow}\n${codeqlWorkflow}`;

for (const [sourceName, source] of [
  ["ci", ciWorkflow],
  ["release", workflow],
  ["codeql", codeqlWorkflow]
]) {
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const uses = line.match(/^\s*(?:-\s*)?uses\s*:\s*(?:"([^"]*)"|'([^']*)'|([^#]*?))(?:\s+#\s*(.*?)\s*)?$/);
    if (!uses) continue;

    const value = (uses[1] ?? uses[2] ?? uses[3]).trim();
    const comment = uses[4]?.trim();
    verifyRemoteActionPin(value, `${sourceName} workflow line ${index + 1}`);
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
  if (actual === 0) {
    throw new Error(`workflows must use approved ${action} at least once`);
  }
  const rawReferences = combinedWorkflows.match(new RegExp(`${action}@`, "g"))?.length ?? 0;
  if (rawReferences !== actual) {
    throw new Error(`workflows contain an unparsed ${action} reference`);
  }
}
verifyRemoteActionPin(`docker://example.invalid/image@sha256:${"a".repeat(64)}`, "fixture");
for (const value of ["docker://example.invalid/image:latest", "docker://example.invalid/image@main"]) {
  try {
    verifyRemoteActionPin(value, "fixture");
    throw new Error(`mutable docker action unexpectedly passed: ${value}`);
  } catch (error) {
    if (error.message.startsWith("mutable docker action unexpectedly passed")) throw error;
  }
}

verifyNpmPublishTrigger(workflow);
for (const fragment of [
  "github.event_name == 'push' && ",
  "github.ref_type == 'tag' && ",
  " && vars.PUBLISH_NPM == 'true'"
]) {
  const mutated = workflow.replace(fragment, "");
  if (mutated === workflow) throw new Error(`publish trigger mutation fixture not found: ${fragment}`);
  try {
    verifyNpmPublishTrigger(mutated);
    throw new Error(`weakened npm publish trigger unexpectedly passed: ${fragment}`);
  } catch (error) {
    if (error.message.startsWith("weakened npm publish trigger unexpectedly passed")) throw error;
  }
}
const productionStatusInvocation = verifyReleaseSmokeGitStatusFixture(workflow, relayMain);
const driftedWorkflow = workflow.replace(
  productionStatusInvocation,
  `${productionStatusInvocation} --fixture-drift`
);
if (driftedWorkflow === workflow) {
  throw new Error("release smoke Git status mutation fixture not found");
}
try {
  verifyReleaseSmokeGitStatusFixture(driftedWorkflow, relayMain);
  throw new Error("drifted release smoke Git status fixture unexpectedly passed");
} catch (error) {
  if (error.message === "drifted release smoke Git status fixture unexpectedly passed") throw error;
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

if (
  !/concurrency:\n  group: release-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false/.test(
    workflow
  )
) {
  throw new Error("release workflow violates non-cancelling per-ref release concurrency");
}
const jobContracts = [
  [
    "release-contract",
    "early release identity contract",
    /  release-contract:\n    runs-on: ubuntu-22\.04\n    timeout-minutes: 5\n    permissions:\n      contents: read\n    outputs:\n      version: \$\{\{ steps\.verify\.outputs\.version \}\}[\s\S]*node scripts\/verify-release-contract\.mjs[\s\S]*--cargo Cargo\.toml[\s\S]*--event-name "\$RELEASE_EVENT_NAME"[\s\S]*--ref-type "\$RELEASE_REF_TYPE"[\s\S]*--ref-name "\$RELEASE_REF_NAME"[\s\S]*--github-output "\$GITHUB_OUTPUT"/
  ],
  [
    "archive",
    "archive attestation authority",
    /  archive:\n    needs: release-contract\n    timeout-minutes: 35\n    permissions:\n      attestations: write\n      contents: read\n      id-token: write\n/
  ],
  [
    "npm-packages",
    "packaging attestation read authority",
    /  npm-packages:\n    needs: \[release-contract, archive\]\n    runs-on: ubuntu-22\.04\n    timeout-minutes: 20\n    permissions:\n      attestations: read\n      contents: read\n    steps:\n/
  ],
  [
    "npm-publish",
    "publish dependency and timeout",
    /  npm-publish:[\s\S]*needs: \[release-contract, npm-packages\]\n    runs-on: ubuntu-22\.04\n    timeout-minutes: 15[\s\S]*archive="npm-packages\/npm-packages\.zip"/
  ],
  [
    "archive",
    "portable Linux target with stable asset name",
    /- os: ubuntu-22\.04\n            asset: linux-x86_64\n            target: x86_64-unknown-linux-musl[\s\S]*cargo build --release --locked --target "\$\{\{ matrix\.target \}\}"[\s\S]*target\/\$\{\{ matrix\.target \}\}\/release\/relay"[\s\S]*file relay-linux-x86_64[\s\S]*--platform linux\/amd64[\s\S]*--network none[\s\S]*--read-only[\s\S]*--cap-drop ALL/
  ],
  [
    "archive",
    "dynamic and GLIBC rejection",
    /file relay-linux-x86_64 \| grep -E 'x86-64\.\*static' >\/dev\/null[\s\S]*readelf -d relay-linux-x86_64 \| grep '\(NEEDED\)' >\/dev\/null[\s\S]*strings relay-linux-x86_64 \| grep -E 'GLIBC_\[0-9\]' >\/dev\/null/
  ],
  [
    "archive",
    "digest-pinned Ubuntu runtime smoke",
    /ubuntu:22\.04@sha256:0199853f6d6b20b0424f3c5694a72a62764f01e6a771b1eb48a4197848986c7e/
  ],
  [
    "archive",
    "digest-pinned Debian runtime smoke",
    /debian:12-slim@sha256:1def178129dfb5f24db43afbf2fcac04530012e3264ba4ff81c71184e17a9ee4/
  ],
  [
    "archive",
    "isolated read-only amd64 runtime smoke",
    /--platform linux\/amd64[\s\S]*--network none[\s\S]*--read-only[\s\S]*--cap-drop ALL[\s\S]*--security-opt no-new-privileges[\s\S]*--user "\$\(id -u\):\$\(id -g\)"[\s\S]*--env RELAY_STATE_HOME=\/smoke\/state[\s\S]*\/opt\/relay --version; \/opt\/relay --help >\/tmp\/help; \/opt\/relay init >\/tmp\/init; \/opt\/relay status >\/tmp\/status/
  ],
  [
    "npm-packages",
    "contract-authoritative package version",
    /RELEASE_VERSION: \$\{\{ needs\.release-contract\.outputs\.version \}\}[\s\S]*node scripts\/verify-npm-packages\.mjs/
  ],
  [
    "archive",
    "pinned attestation action",
    /actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/
  ],
  ["npm-packages", "ephemeral GitHub CLI authentication", /GH_TOKEN: \$\{\{ github\.token \}\}/],
  ["npm-packages", "repository provenance binding", /--repo "\$GITHUB_REPOSITORY"/],
  ["npm-packages", "workflow provenance binding", /--signer-workflow "\$SIGNER_WORKFLOW"/],
  ["npm-packages", "source ref binding", /--source-ref "\$GITHUB_REF"/],
  ["npm-packages", "source commit binding", /--source-digest "\$GITHUB_SHA"/],
  ["npm-packages", "hosted runner policy", /--deny-self-hosted-runners/],
  [
    "npm-packages",
    "native payload verification input",
    /node scripts\/verify-npm-packages\.mjs \\\n            --output dist\/npm \\\n            --artifacts release-assets/
  ],
  [
    "npm-packages",
    "verified native artifact extraction",
    /actual_archives="\$\(find release-assets -mindepth 1 -maxdepth 1 -exec basename \{\} \\; \| LC_ALL=C sort\)"\n          test "\$actual_archives" = "\$expected_archives"[\s\S]*expected="\$\(printf 'relay-%s\\nrelay-%s\.sha256\\n' "\$asset" "\$asset" \| LC_ALL=C sort\)"\n            actual="\$\(unzip -Z1 "\$archive" \| LC_ALL=C sort\)"\n            test "\$actual" = "\$expected"\n            unzip -q "\$archive" -d release-assets/
  ],
  [
    "npm-publish",
    "verified npm artifact extraction",
    /archive="npm-packages\/npm-packages\.zip"\n          actual_archives="\$\(find npm-packages -mindepth 1 -maxdepth 1 -exec basename \{\} \\; \| LC_ALL=C sort\)"\n          test "\$actual_archives" = "npm-packages\.zip"[\s\S]*actual="\$\(unzip -Z1 "\$archive" \| LC_ALL=C sort\)"\n          test "\$actual" = "\$expected"\n          unzip -q "\$archive" -d npm-packages/
  ]
];

const jobBlocks = new Map();
for (const [jobName, name, pattern] of jobContracts) {
  if (!jobBlocks.has(jobName)) jobBlocks.set(jobName, jobBlock(workflow, jobName));
  if (!pattern.test(jobBlocks.get(jobName))) throw new Error(`release workflow violates ${name}`);
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

if (
  !/permissions:\n  contents: read[\s\S]*analyze:\n    name: Analyze \(\$\{\{ matrix\.language \}\}\)[\s\S]*permissions:\n      contents: read\n      security-events: write/.test(
    codeqlWorkflow
  )
) {
  throw new Error("CodeQL workflow must use explicit least-privilege permissions");
}
for (const language of ["actions", "javascript-typescript", "rust"]) {
  if (!new RegExp(`- language: ${language}\\n            build-mode: none`).test(codeqlWorkflow)) {
    throw new Error(`CodeQL workflow must analyze ${language} without a build`);
  }
}
if (
  !/config-file: \.\/\.github\/codeql\/codeql-config\.yml/.test(codeqlWorkflow) ||
  !/category: \/language:\$\{\{ matrix\.language \}\}/.test(codeqlWorkflow)
) {
  throw new Error("CodeQL workflow must bind the reviewed configuration and stable categories");
}
const codeqlConfigContract = codeqlConfig
  .split(/\r?\n/)
  .filter((line) => line.trim() && !line.trimStart().startsWith("#"));
if (
  JSON.stringify(codeqlConfigContract) !==
  JSON.stringify([
    'name: "Relay CodeQL configuration"',
    "paths-ignore:",
    '  - "tests/**"'
  ])
) {
  throw new Error("CodeQL configuration may exclude only the black-box tests directory");
}

process.stdout.write("Verified release and CodeQL workflow authority and provenance contracts.\n");
