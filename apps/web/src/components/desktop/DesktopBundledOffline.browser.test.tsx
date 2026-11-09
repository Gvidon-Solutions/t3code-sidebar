import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { DesktopBundledOffline } from "./DesktopBundledOffline";
import {
  desktopBundledFallback,
  desktopBundledRetryUrl,
  desktopFallbackServerLabel,
} from "./desktopBundledFallback";

it("reads the offline fallback from the desktop query and labels the server", () => {
  const fallback = desktopBundledFallback(
    "?desktopWindowId=7&bundled=1&server=https%3A%2F%2Fstudio.example%2F",
  );
  expect(fallback).toEqual({ server: "https://studio.example/" });
  expect(desktopFallbackServerLabel(fallback!.server)).toBe("studio.example");
  expect(desktopBundledFallback("?desktopWindowId=7")).toBeNull();
});

it("retries by asking the shell for the server UI again", () => {
  const retry = new URL(
    desktopBundledRetryUrl(
      "t3code://app/?desktopWindowId=7&bundled=1&server=https%3A%2F%2Fstudio.example%2F#/settings",
    ),
  );
  expect(retry.searchParams.get("bundled")).toBeNull();
  expect(retry.searchParams.get("server")).toBeNull();
  expect(retry.searchParams.get("desktopWindowId")).toBe("7");
  expect(retry.hash).toBe("#/settings");
});

it("shows the unreachable server and a retry action", async () => {
  await using screen = await render(
    <DesktopBundledOffline
      fallback={{ server: "https://studio.example/" }}
      retryHref="t3code://app/?desktopWindowId=7"
    />,
    { router: false },
  );
  await expect
    .element(screen.getByRole("heading", { name: "Can't reach studio.example" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Retry" }))
    .toHaveAttribute("href", "t3code://app/?desktopWindowId=7");
});
