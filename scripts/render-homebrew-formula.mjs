#!/usr/bin/env node

function argumentsFrom(argv) {
  const result = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("expected --key value pairs");
    result[key.slice(2)] = value;
  }
  for (const key of ["version", "macos-arm64", "macos-x64", "linux-x64"]) {
    if (!result[key]) throw new Error(`missing --${key}`);
  }
  return result;
}

const args = argumentsFrom(process.argv);
const base = `https://github.com/ictechgy/relay-continuity/releases/download/v${args.version}`;
process.stdout.write(`class Relay < Formula
  desc "Local, evidence-first continuity for AI-assisted software work"
  homepage "https://github.com/ictechgy/relay-continuity"
  license "MIT"
  version "${args.version}"

  on_macos do
    if Hardware::CPU.arm?
      url "${base}/relay-macos-arm64"
      sha256 "${args["macos-arm64"]}"
    else
      url "${base}/relay-macos-x86_64"
      sha256 "${args["macos-x64"]}"
    end
  end

  on_linux do
    url "${base}/relay-linux-x86_64"
    sha256 "${args["linux-x64"]}"
  end

  def install
    bin.install Dir["relay-*"][0] => "relay"
  end

  test do
    system bin/"relay", "help"
  end
end
`);
