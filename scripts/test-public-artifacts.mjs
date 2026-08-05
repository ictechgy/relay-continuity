#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const verifier = join(root, "scripts", "verify-public-artifacts.mjs");

function run(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function verify(fixture, expectedStatus, expectedLabel, sensitiveValue) {
  const result = spawnSync(process.execPath, [verifier, "--root", fixture], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== expectedStatus) {
    const context = expectedLabel ? ` for ${expectedLabel}` : "";
    throw new Error(
      `verifier exited ${result.status}; expected ${expectedStatus}${context}: ${result.stderr || result.stdout}`
    );
  }
  const output = `${result.stdout}${result.stderr}`;
  if (expectedLabel && !output.includes(expectedLabel)) {
    throw new Error(`verifier did not report ${expectedLabel}: ${output}`);
  }
  if (sensitiveValue && output.includes(sensitiveValue)) {
    throw new Error("verifier repeated sensitive content in its diagnostic");
  }
  return output;
}

const fixture = await mkdtemp(join(tmpdir(), "relay-public-artifacts-test-"));
try {
  const artifacts = join(fixture, ".omx", "artifacts");
  await mkdir(artifacts, { recursive: true });
  run("git", ["init", "--quiet"], fixture);

  await writeFile(
    join(artifacts, "safe.md"),
    "cwd: repository root (`.`)\nprovider: claude\nevidence: .omx/artifacts/review.md\nsha256: " + "a".repeat(64) + "\n"
  );
  await writeFile(join(artifacts, "untracked.md"), "executable: /Users/untracked/.local/bin/tool\n");
  run("git", ["add", ".omx/artifacts/safe.md"], fixture);
  verify(fixture, 0);

  const tracked = join(artifacts, "tracked.md");
  const cases = [
    ["/Users/alice/.local/bin/claude", "macOS or Linux user-home absolute path"],
    ["/home/alice/.local/bin/agy", "macOS or Linux user-home absolute path"],
    ["/root/.ssh/config", "privileged Unix user-home absolute path"],
    ["/var/root/Library/Application Support/relay", "privileged Unix user-home absolute path"],
    ["/private/tmp/relay-worktree/review.md", "temporary workspace absolute path"],
    ["/tmp/relay-worktree/review.md", "temporary workspace absolute path"],
    ["/var/tmp/relay-worktree/review.md", "temporary workspace absolute path"],
    ["/var/folders/ab/cdef012345/T/relay-worktree/review.md", "temporary workspace absolute path"],
    [String.raw`C:\\Users\\Alice\\bin\\grok.exe`, "Windows user-home absolute path"],
    [String.raw`d:\\uSeRs\\Alice\\bin\\grok.exe`, "Windows user-home absolute path"],
    [String.raw`\\\\build-host\\Users\\Alice\\bin\\grok.exe`, "UNC user-home absolute path"],
    [String.raw`//build-host/share/HOME/Alice/bin/grok.exe`, "UNC user-home absolute path"],
    ["/opt/homebrew/bin/claude", "workstation-local tool path"],
    ["/opt/homebrew/Cellar/openssl@3/3.5.2/bin/openssl", "Homebrew Cellar or opt absolute path"],
    ["/opt/homebrew/opt/openssl@3/bin/openssl", "Homebrew Cellar or opt absolute path"],
    ["/usr/local/Cellar/node/24.4.1/bin/node", "Homebrew Cellar or opt absolute path"],
    ["/usr/local/opt/node/bin/node", "Homebrew Cellar or opt absolute path"],
    ["/nix/store/example-hash/bin/agy", "Nix workstation-local tool path"],
    ["file:///Users/alice/.local/bin/claude", "macOS or Linux user-home absolute path"],
    [
      "file://localhost/home/alice/.local/bin/agy",
      "macOS or Linux user-home absolute path"
    ],
    ["file:/private/tmp/relay-worktree/review.md", "temporary workspace absolute path"],
    ["file:///C:/Users/Alice/bin/grok.exe", "Windows user-home absolute path"]
  ];
  await writeFile(tracked, "placeholder\n");
  run("git", ["add", ".omx/artifacts/tracked.md"], fixture);
  for (const [secret, label] of cases) {
    await writeFile(tracked, `executable: ${secret}\n`);
    verify(fixture, 1, label, secret);
  }

  const repositoryRelativePaths = [
    "docs/root/index.md",
    "fixtures/tmp/case.md",
    "packages/home/alice/readme.md",
    "fixtures/private/tmp/case.md",
    "tools/opt/homebrew/bin/claude",
    "fixtures/usr/local/Cellar/node/readme.md",
    "fixtures/nix/store/example-hash/bin/agy",
    "문서/Users/alice/readme.md",
    "📁/private/tmp/case.md",
    String.raw`자료\C:\Users\Alice\bin\grok.exe`,
    String.raw`fixtures\\C:\\Users\\Alice\\bin\\grok.exe`,
    "fixtures//build-host/Users/Alice/bin/grok.exe"
  ];
  await writeFile(
    tracked,
    repositoryRelativePaths.map((path) => `repository-relative: ${path}`).join("\n") + "\n"
  );
  verify(fixture, 0);

  const tokenCases = [
    [`ghp_${"Ab3".repeat(12)}`, "GitHub access token"],
    ["AKIA1B2C3D4E5F6G7H8J", "AWS access key ID"],
    [`sk-proj-${"Ab3_".repeat(12)}`, "OpenAI API key"],
    [`xoxb-123456789012-123456789012-${"Ab3".repeat(8)}`, "Slack access token"],
    [`sk_live_${"Ab3".repeat(8)}`, "Stripe live secret key"],
    [`AIza${"Ab3_".repeat(8)}Ab3`, "Google API key"],
    [`npm_${"Ab3".repeat(12)}`, "npm access token"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----", "private key material"]
  ];
  for (const [secret, label] of tokenCases) {
    await writeFile(tracked, `credential: ${secret}\n`);
    verify(fixture, 1, label, secret);
  }

  const decoyThenTokenCases = [
    [`ghp_${"A".repeat(36)}`, `ghp_${"Ab3".repeat(12)}`, "GitHub access token"],
    ["AKIAIOSFODNN7EXAMPLE", "AKIA1B2C3D4E5F6G7H8J", "AWS access key ID"],
    [`sk-proj-${"A".repeat(40)}`, `sk-proj-${"Ab3_".repeat(12)}`, "OpenAI API key"],
    [
      `xoxb-123456789012-123456789012-${"A".repeat(24)}`,
      `xoxb-123456789012-123456789012-${"Ab3".repeat(8)}`,
      "Slack access token"
    ],
    [`sk_live_${"A".repeat(24)}`, `sk_live_${"Ab3".repeat(8)}`, "Stripe live secret key"],
    [`AIza${"A".repeat(35)}`, `AIza${"Ab3_".repeat(8)}Ab3`, "Google API key"],
    [`npm_${"A".repeat(36)}`, `npm_${"Ab3".repeat(12)}`, "npm access token"]
  ];
  for (const [decoy, secret, label] of decoyThenTokenCases) {
    await writeFile(tracked, `credentials: ${decoy} ${secret}\n`);
    verify(fixture, 1, label, secret);
  }

  await writeFile(tracked, "x".repeat(1024 * 1024 + 1));
  verify(fixture, 1, "tracked .omx artifact exceeds per-file byte limit");

  await writeFile(tracked, "safe\n");
  const aggregatePayload = "x".repeat(1024 * 1024);
  const aggregateFiles = [];
  for (let index = 0; index < 8; index += 1) {
    const path = `.omx/artifacts/aggregate-${index}.md`;
    aggregateFiles.push(path);
    await writeFile(join(fixture, path), aggregatePayload);
  }
  run("git", ["add", ...aggregateFiles], fixture);
  verify(fixture, 1, "tracked .omx artifacts exceed aggregate byte limit");
  for (const path of aggregateFiles) await writeFile(join(fixture, path), "");

  const denseSecret = `ghp_${"Ab3".repeat(12)}`;
  await writeFile(tracked, Array.from({ length: 60 }, () => denseSecret).join("\n"));
  const cappedOutput = verify(
    fixture,
    1,
    "further findings omitted after 50 diagnostics",
    denseSecret
  );
  if ((cappedOutput.match(/GitHub access token/g) || []).length !== 50) {
    throw new Error(`verifier diagnostic cap was not enforced: ${cappedOutput}`);
  }

  await writeFile(
    tracked,
    [
      "executable: grok (local path redacted)",
      "cwd: repository root (`.`)",
      "reference: https://example.com/home/alice/docs",
      "example: /home/example/project",
      "github_token: ghp_REPLACE_WITH_YOUR_TOKEN",
      "aws_access_key_id: AKIAIOSFODNN7EXAMPLE",
      "openai_api_key: sk-proj-example",
      "slack_token: xoxb-your-token",
      "stripe_key: sk_live_example",
      "google_api_key: AIza-your-api-key",
      "npm_token: npm_REPLACE_WITH_TOKEN",
      ""
    ].join("\n")
  );
  verify(fixture, 0);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
