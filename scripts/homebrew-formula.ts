const [version, darwinArm64Sha, darwinX64Sha, linuxArm64Sha, linuxX64Sha] =
  Bun.argv.slice(2);

if (
  version === undefined ||
  darwinArm64Sha === undefined ||
  darwinX64Sha === undefined ||
  linuxArm64Sha === undefined ||
  linuxX64Sha === undefined
) {
  throw new Error(
    "Usage: homebrew-formula <version> <darwin-arm64-sha> <darwin-x64-sha> <linux-arm64-sha> <linux-x64-sha>",
  );
}

const releaseVersion = version.replace(/^v/, "");
const archive = (target: string) =>
  `https://github.com/cdelmoral/arty/releases/download/v${releaseVersion}/arty-v${releaseVersion}-${target}.tar.gz`;

process.stdout.write(`class Arty < Formula
  desc "Publish temporary static Artifacts to your Cloudflare account"
  homepage "https://github.com/cdelmoral/arty"
  version "${releaseVersion}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "${archive("darwin-arm64")}"
      sha256 "${darwinArm64Sha}"
    else
      url "${archive("darwin-x64")}"
      sha256 "${darwinX64Sha}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "${archive("linux-arm64")}"
      sha256 "${linuxArm64Sha}"
    else
      url "${archive("linux-x64")}"
      sha256 "${linuxX64Sha}"
    end
  end

  def install
    bin.install "arty"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/arty --version")
  end
end
`);
