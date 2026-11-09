import { describe, expect, it } from "vite-plus/test";

import {
  buildPairingUrl,
  extractPairingUrlFromQrPayload,
  parsePairingUrl,
  resolvePairingInput,
} from "./pairing";

describe("buildPairingUrl", () => {
  it("uses HTTP for a schemeless IP address", () => {
    expect(buildPairingUrl("192.168.1.100:3773", "pairing-token")).toBe(
      "http://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("keeps HTTPS as the default for a schemeless hostname", () => {
    expect(buildPairingUrl("remote.example.com", "pairing-token")).toBe(
      "https://remote.example.com/#token=pairing-token",
    );
  });

  it("preserves an explicit scheme for an IP address", () => {
    expect(buildPairingUrl("https://192.168.1.100:3773", "pairing-token")).toBe(
      "https://192.168.1.100:3773/#token=pairing-token",
    );
  });
});

describe("extractPairingUrlFromQrPayload", () => {
  it("unwraps mobile deep links that carry an encoded pairing url", () => {
    expect(
      extractPairingUrlFromQrPayload(
        "t3code://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
      ),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });
});

describe("parsePairingUrl", () => {
  it("reads hosted pairing links into backend host fields", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
    });
  });
});

describe("resolvePairingInput", () => {
  it("uses a whole pairing link pasted into either field", () => {
    expect(resolvePairingInput("", "https://studio.example/pair#token=abc")).toBe(
      "https://studio.example/pair#token=abc",
    );
    expect(
      resolvePairingInput(
        "t3code://pair?pairingUrl=https%3A%2F%2Fstudio.example%2Fpair%23token%3Dabc",
        "",
      ),
    ).toBe("https://studio.example/pair#token=abc");
    expect(resolvePairingInput("studio.example", "abc")).toBe("https://studio.example/#token=abc");
    expect(resolvePairingInput("", "studio.example/pair#token=abc")).toBe(
      "https://studio.example/pair#token=abc",
    );
    expect(() =>
      resolvePairingInput("studio.example", "https://cloudbox.example/pair#token=abc"),
    ).toThrowError(/names its own server/);
  });
});
