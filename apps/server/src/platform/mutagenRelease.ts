// https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/SHA256SUMS
export const mutagenChecksums: Readonly<Record<string, string>> = {
  linux_amd64: "7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f",
  linux_arm64: "bcba735aebf8cbc11da9b3742118a665599ac697fa06bc5751cac8dcd540db8a",
  darwin_amd64: "7d06f7d8fcfe90bc7e55cc834a2f2f20c2e0af9ea9bc35911fc4341ad56a9bbf",
  darwin_arm64: "6f810416d9e5fc4fd5e18431146f8b3c5a2056ba5a24f76c1e66da86eb3257e2",
  windows_amd64: "3e237e77f69959ed520a0f877330a431507bb0a85d9da7919764ba0c87b702c7",
  windows_arm64: "9ac53447e46f019be9d37f49c00eeed8635966b885ed29ef06b3ff19afdee532",
};
export const MUTAGEN_VERSION = "0.18.1";
export const mutagenTarget = (platform: string, architecture: string) =>
  `${platform === "win32" ? "windows" : platform}_${architecture === "x64" ? "amd64" : architecture}`;
export const mutagenArchiveName = (target: string) =>
  `mutagen_${target}_v${MUTAGEN_VERSION}.tar.gz`;
export const mutagenReleaseUrl = (target: string) =>
  `https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/${mutagenArchiveName(target)}`;
