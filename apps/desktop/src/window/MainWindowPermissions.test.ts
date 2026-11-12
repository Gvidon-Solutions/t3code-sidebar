import { describe, expect, it } from "vite-plus/test";

import {
  allowMainWindowMediaCheck,
  decideMainWindowMediaRequest,
  isAppUrl,
} from "./MainWindowPermissions.ts";

const APP_URL = "t3code://app/";
const PACKAGED_APP_URL = "t3code://app/?desktopWindowId=7";
const serverUi = (rendererId: number) => `t3code://server-${rendererId}-${"a".repeat(24)}`;

function decide(overrides: Partial<Parameters<typeof decideMainWindowMediaRequest>[0]> = {}) {
  return decideMainWindowMediaRequest({
    requestingUrl: "t3code://app/threads/abc",
    appUrl: APP_URL,
    isMainFrame: true,
    mediaTypes: ["audio"],
    platform: "darwin",
    microphoneStatus: () => "granted",
    ...overrides,
  });
}

describe("isAppUrl", () => {
  it("matches the app shell and nothing that merely shares its prefix", () => {
    expect(isAppUrl("t3code://app", APP_URL)).toBe(true);
    expect(isAppUrl("t3code://app/settings", APP_URL)).toBe(true);
    expect(isAppUrl("t3code://application/", APP_URL)).toBe(false);
    expect(isAppUrl("https://example.com/", APP_URL)).toBe(false);
    expect(isAppUrl(undefined, APP_URL)).toBe(false);
  });

  it("matches the packaged window URL that carries its window id", () => {
    expect(isAppUrl("t3code://app", PACKAGED_APP_URL)).toBe(true);
    expect(isAppUrl("t3code://app/settings/voice", PACKAGED_APP_URL)).toBe(true);
    expect(isAppUrl("https://app/", PACKAGED_APP_URL)).toBe(false);
  });

  it("accepts a server UI host only for the renderer it was minted for", () => {
    expect(isAppUrl(`${serverUi(7)}/settings`, PACKAGED_APP_URL, 7)).toBe(true);
    // A second window shares the session: its own server host counts for its own id.
    expect(isAppUrl(`${serverUi(9)}/settings`, PACKAGED_APP_URL, 9)).toBe(true);
    expect(isAppUrl(`${serverUi(8)}/settings`, PACKAGED_APP_URL, 7)).toBe(false);
    expect(isAppUrl(`${serverUi(7)}/`, PACKAGED_APP_URL)).toBe(false);
  });

  it("rejects opaque and synthetic origins", () => {
    expect(isAppUrl("null", PACKAGED_APP_URL, 7)).toBe(false);
    expect(isAppUrl("about:blank", PACKAGED_APP_URL, 7)).toBe(false);
    expect(isAppUrl("data:text/html,hi", PACKAGED_APP_URL, 7)).toBe(false);
  });
});

describe("decideMainWindowMediaRequest", () => {
  it("denies media to frames outside the app shell", () => {
    expect(decide({ requestingUrl: "https://example.com/embed" })).toBe("deny");
  });

  it("denies media to subframes even on the app's own hosts", () => {
    expect(decide({ isMainFrame: false })).toBe("deny");
    expect(
      decide({
        appUrl: PACKAGED_APP_URL,
        rendererId: 7,
        requestingUrl: `${serverUi(7)}/mcp-app`,
        isMainFrame: false,
        platform: "linux",
      }),
    ).toBe("deny");
  });

  it("lets the packaged app shell use the microphone (it was always denied)", () => {
    expect(
      decide({
        appUrl: PACKAGED_APP_URL,
        requestingUrl: "t3code://app/settings/voice",
        platform: "linux",
      }),
    ).toBe("grant");
    expect(
      decide({
        appUrl: PACKAGED_APP_URL,
        rendererId: 7,
        requestingUrl: `${serverUi(7)}/settings/voice`,
        platform: "win32",
      }),
    ).toBe("grant");
  });

  it("asks macOS for the microphone until the user has granted it", () => {
    expect(decide({ microphoneStatus: () => "not-determined" })).toBe("ask-microphone");
    expect(decide({ microphoneStatus: () => "denied" })).toBe("ask-microphone");
    expect(decide()).toBe("grant");
  });

  it("grants the microphone directly off macOS", () => {
    expect(decide({ platform: "win32", microphoneStatus: () => "unknown" })).toBe("grant");
  });

  it("keeps granting video-only capture such as preview tab recording", () => {
    expect(decide({ mediaTypes: ["video"], microphoneStatus: () => "denied" })).toBe("grant");
  });
});

describe("allowMainWindowMediaCheck", () => {
  it("passes the app shell's main frame and nothing else", () => {
    const base = { appUrl: PACKAGED_APP_URL, rendererId: 7, isMainFrame: true };
    expect(allowMainWindowMediaCheck({ ...base, requestingOrigin: "t3code://app" })).toBe(true);
    expect(allowMainWindowMediaCheck({ ...base, requestingOrigin: serverUi(7) })).toBe(true);
    expect(
      allowMainWindowMediaCheck({ ...base, requestingOrigin: serverUi(7), isMainFrame: false }),
    ).toBe(false);
    expect(allowMainWindowMediaCheck({ ...base, requestingOrigin: serverUi(8) })).toBe(false);
    expect(
      allowMainWindowMediaCheck({ ...base, rendererId: undefined, requestingOrigin: serverUi(7) }),
    ).toBe(false);
  });
});
