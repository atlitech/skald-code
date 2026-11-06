import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliReleaseAssetUrl,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("keeps fork discovery and downloads on the fork, honoring explicit mirrors", () => {
    const version = "1.2.4-atli.10";
    const base = `https://github.com/atlitech/t3code/releases/download/v${version}`;
    expect(cliReleaseIndexPageUrl(2, version)).toBe(
      "https://api.github.com/repos/atlitech/t3code/releases?per_page=100&page=2",
    );
    expect(cliReleaseDownloadBaseUrl(version)).toBe(base);
    expect(cliReleaseAssetUrl(version, "SHA256SUMS")).toBe(`${base}/SHA256SUMS`);
    expect(cliReleaseAssetUrl(version, "SHA256SUMS", "https://mirror.example/releases")).toBe(
      `https://mirror.example/releases/v${version}/SHA256SUMS`,
    );
    expect(cliReleaseDownloadBaseUrl("1.2.4")).toBe(
      "https://github.com/pingdotgg/t3code/releases/download/v1.2.4",
    );
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
    const forkReleases = [
      { tag_name: "v1.2.4-atli.11", draft: true },
      { tag_name: "v1.2.4" },
      { tag_name: "v1.2.4-nightly.20261106.1" },
      { tag_name: "v1.2.4-atli.10" },
    ];
    expect(newestCliReleaseVersion(forkReleases, "stable", "1.2.4-atli.9")).toBe("1.2.4-atli.10");
    expect(newestCliReleaseVersion(forkReleases, "nightly", "1.2.4-atli.9")).toBeUndefined();
  });
});
