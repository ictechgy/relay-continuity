#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_ISSUES = 50;
const prohibitedPaths = [
  {
    label: "macOS or Linux user-home absolute path",
    pattern: /(?:^|[\s"'`(\[{=,:;])\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/|(?=$|[\s"'`),.;:\]}]))/
  },
  {
    label: "privileged Unix user-home absolute path",
    pattern: /(?:^|[\s"'`(\[{=,:;])\/(?:var\/)?root(?:\/|(?=$|[\s"'`),.;:\]}]))/
  },
  {
    label: "temporary workspace absolute path",
    pattern: /(?:^|[\s"'`(\[{=,:;])\/(?:tmp|private\/tmp|var\/tmp|var\/folders)(?:\/|(?=$|[\s"'`),.;:\]}]))/
  },
  {
    label: "Windows user-home absolute path",
    pattern: /(?:^|[\s"'`(\[{=,:;])[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n\t"'`<>]+(?:[\\/]+|(?=$|[\s"'`),.;:\]}]))/i
  },
  {
    label: "UNC user-home absolute path",
    pattern: /(?:^|[\s"'`(\[{=,:;])(?:\\{2,}|\/{2})[^\\/\s"'`<>]+[\\/]+(?:(?:[A-Za-z]\$|[^\\/\s"'`<>]+)[\\/]+)?(?:Users|home)[\\/]+[^\\/\r\n\t"'`<>]+(?:[\\/]+|(?=$|[\s"'`),.;:\]}]))/i
  },
  {
    label: "workstation-local tool path",
    pattern: /(?:^|[\s"'`(\[{=,:;])\/(?:opt\/homebrew|usr\/local)\/(?:s?bin)\/[A-Za-z0-9._+@%-]+/
  },
  {
    label: "Homebrew Cellar or opt absolute path",
    pattern: /(?:^|[\s"'`(\[{=,:;])\/(?:opt\/homebrew|usr\/local)\/(?:Cellar|opt)\/[^\s"'`<>]+/i
  },
  {
    label: "Nix workstation-local tool path",
    pattern: /(?:^|[\s"'`(\[{=,:;])\/nix\/store\/[A-Za-z0-9._+-]+\/(?:s?bin)\/[A-Za-z0-9._+@%-]+/
  }
];

const prohibitedSecrets = [
  {
    label: "GitHub access token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/,
    validate: (value) => mixedPayload(value.replace(/^(?:gh[pousr]_|github_pat_)/, ""))
  },
  {
    label: "AWS access key ID",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    validate: (value) => {
      const payload = value.slice(4);
      return !payload.endsWith("EXAMPLE") && /[A-Z]/.test(payload) && /\d/.test(payload);
    }
  },
  {
    label: "OpenAI API key",
    pattern: /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{40,255}\b/,
    validate: (value) => mixedPayload(value.replace(/^sk-(?:proj|svcacct)-/, ""))
  },
  {
    label: "Slack access token",
    pattern: /\bxox[baprs]-\d{10,13}-\d{10,13}-[A-Za-z0-9]{24,255}\b/,
    validate: (value) => mixedPayload(value.slice(value.lastIndexOf("-") + 1))
  },
  {
    label: "Stripe live secret key",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{24,255}\b/,
    validate: (value) => mixedPayload(value.replace(/^(?:sk|rk)_live_/, ""))
  },
  {
    label: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    validate: (value) => mixedPayload(value.slice(4))
  },
  {
    label: "npm access token",
    pattern: /\bnpm_[A-Za-z0-9]{36,255}\b/,
    validate: (value) => mixedPayload(value.slice(4))
  },
  {
    label: "private key material",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
  }
];

function argumentsFrom(argv) {
  if (argv.length === 2) return { root: defaultRoot };
  if (argv.length === 4 && argv[2] === "--root") return { root: resolve(argv[3]) };
  throw new Error("usage: verify-public-artifacts.mjs [--root <git-worktree>]");
}

function trackedOmxFiles(root) {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z", "--", ".omx"], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error("unable to list tracked .omx artifacts");
  }
  return result.stdout.split("\0").filter(Boolean);
}

function normalized(line) {
  return line.replaceAll("\\/", "/");
}

function mixedPayload(value) {
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}

function withoutRemoteUrls(line) {
  return line.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, "[remote-url]");
}

function withoutLocalFileUrlScheme(line) {
  return line
    .replace(/\bfile:\/\/localhost(?=\/)/gi, "")
    .replace(/\bfile:\/\/\/(?=[A-Za-z]:[\\/])/gi, "")
    .replace(/\bfile:\/\/(?=\/)/gi, "")
    .replace(/\bfile:(?=\/)/gi, "");
}

function withoutDocumentedPlaceholders(line) {
  return line.replace(
    /\/home\/example\/project(?=$|[\s"'`),.;:\]}])/g,
    "[documented-path-placeholder]"
  );
}

function matches(pattern, value) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return value.matchAll(new RegExp(pattern.source, flags));
}

async function scan(root, paths) {
  const issues = [];
  let truncated = false;
  let totalBytes = 0;
  const record = (issue) => {
    if (issues.length >= MAX_ISSUES) {
      truncated = true;
      return false;
    }
    issues.push(issue);
    return true;
  };

  scanFiles: for (const path of paths) {
    const artifact = join(root, path);
    let metadata;
    try {
      metadata = await lstat(artifact);
    } catch {
      if (!record({ path, line: 1, label: "tracked .omx entry is unreadable" })) break;
      continue;
    }
    if (!metadata.isFile()) {
      if (!record({ path, line: 1, label: "tracked .omx entry is not a regular file" })) break;
      continue;
    }
    if (metadata.size > MAX_FILE_BYTES) {
      if (!record({ path, line: 1, label: "tracked .omx artifact exceeds per-file byte limit" })) break;
      continue;
    }
    if (totalBytes + metadata.size > MAX_TOTAL_BYTES) {
      record({ path, line: 1, label: "tracked .omx artifacts exceed aggregate byte limit" });
      break;
    }

    let handle;
    let bytes;
    try {
      handle = await open(artifact, constants.O_RDONLY | constants.O_NOFOLLOW);
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isFile()) {
        if (!record({ path, line: 1, label: "tracked .omx entry is not a regular file" })) break;
        continue;
      }
      if (openedMetadata.size > MAX_FILE_BYTES) {
        if (!record({ path, line: 1, label: "tracked .omx artifact exceeds per-file byte limit" })) break;
        continue;
      }
      if (totalBytes + openedMetadata.size > MAX_TOTAL_BYTES) {
        record({ path, line: 1, label: "tracked .omx artifacts exceed aggregate byte limit" });
        break;
      }
      const buffer = Buffer.alloc(openedMetadata.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_FILE_BYTES) {
        if (!record({ path, line: 1, label: "tracked .omx artifact exceeds per-file byte limit" })) break;
        continue;
      }
      if (length !== openedMetadata.size) {
        if (!record({ path, line: 1, label: "tracked .omx artifact changed while scanning" })) break;
        continue;
      }
      if (totalBytes + length > MAX_TOTAL_BYTES) {
        record({ path, line: 1, label: "tracked .omx artifacts exceed aggregate byte limit" });
        break;
      }
      bytes = buffer.subarray(0, length);
      totalBytes += length;
    } catch {
      if (!record({ path, line: 1, label: "tracked .omx entry is unreadable" })) break;
      continue;
    } finally {
      await handle?.close().catch(() => {});
    }
    let contents;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      if (!record({ path, line: 1, label: "artifact is not valid UTF-8 text" })) break;
      continue;
    }
    if (contents.includes("\0")) {
      if (!record({ path, line: 1, label: "non-text artifact cannot be privacy-scanned" })) break;
      continue;
    }
    for (const [index, line] of contents.split("\n").entries()) {
      const normalizedLine = normalized(line);
      const pathLine = withoutDocumentedPlaceholders(
        withoutRemoteUrls(withoutLocalFileUrlScheme(normalizedLine))
      );
      for (const { label, pattern } of prohibitedPaths) {
        if (pattern.test(pathLine) && !record({ path, line: index + 1, label })) {
          break scanFiles;
        }
      }
      for (const { label, pattern, validate } of prohibitedSecrets) {
        for (const match of matches(pattern, normalizedLine)) {
          if (validate && !validate(match[0])) continue;
          if (!record({ path, line: index + 1, label })) break scanFiles;
          break;
        }
      }
    }
  }
  return { issues, truncated };
}

try {
  const { root } = argumentsFrom(process.argv);
  const paths = trackedOmxFiles(root);
  const { issues, truncated } = await scan(root, paths);
  if (issues.length > 0) {
    process.stderr.write("Tracked .omx artifacts contain private metadata:\n");
    for (const issue of issues) {
      process.stderr.write(`- ${JSON.stringify(issue.path)}:${issue.line}: ${issue.label}\n`);
    }
    if (truncated) {
      process.stderr.write(`- further findings omitted after ${MAX_ISSUES} diagnostics\n`);
    }
    process.stderr.write("Use repository-relative paths, tool basenames, or explicit redaction placeholders.\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`Verified ${paths.length} tracked .omx artifacts contain no private metadata.\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
