import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { DesktopBundledOffline } from "./DesktopBundledOffline";
import {
  desktopBundledFallback,
  desktopBundledRetryUrl,
  desktopFallbackServerAddress,
  desktopFallbackServerLabel,
} from "./desktopBundledFallback";

it("reads the offline fallback from the desktop query and names the machine", () => {
  const fallback = desktopBundledFallback(
    "?desktopWindowId=7&bundled=1&server=https%3A%2F%2Fstudio.example%2F&name=studio",
  );
  expect(fallback).toEqual({ server: "https://studio.example/", name: "studio" });
  expect(desktopFallbackServerLabel(fallback!)).toBe("studio");
  expect(desktopFallbackServerAddress(fallback!)).toBe("studio.example");
  expect(desktopBundledFallback("?desktopWindowId=7")).toBeNull();
});

it("shortens an unnamed server without showing its address in the sentence", () => {
  expect(
    desktopFallbackServerLabel({ server: "https://cloudbox.example/prefix", name: null }),
  ).toBe("cloudbox");
  expect(desktopFallbackServerLabel({ server: "http://127.0.0.1:9", name: null })).toBe(
    "this machine",
  );
  expect(desktopFallbackServerLabel({ server: null, name: null })).toBe("the server");
});

it("retries by asking the shell for the server UI again", () => {
  const retry = new URL(
    desktopBundledRetryUrl(
      "t3code://app/?desktopWindowId=7&bundled=1&server=https%3A%2F%2Fstudio.example%2F&name=studio#/settings",
    ),
  );
  expect(retry.searchParams.get("bundled")).toBeNull();
  expect(retry.searchParams.get("server")).toBeNull();
  expect(retry.searchParams.get("name")).toBeNull();
  expect(retry.searchParams.get("desktopWindowId")).toBe("7");
  expect(retry.hash).toBe("#/settings");
});

it("shows plain copy, the machine name and a muted address detail", async () => {
  await using screen = await render(
    <DesktopBundledOffline
      fallback={{ server: "https://studio.example/", name: "studio" }}
      retryHref="t3code://app/?desktopWindowId=7"
    />,
    { router: false },
  );
  await expect.element(screen.getByRole("heading", { name: "Can't reach studio" })).toBeVisible();
  await expect
    .element(
      screen.getByText("T3 Code can't reach studio. Make sure it is running, then try again."),
    )
    .toBeVisible();
  await expect.element(screen.getByText("studio.example")).toBeVisible();
  expect(screen.container.textContent).not.toContain("bundled UI");
  await expect
    .element(screen.getByRole("link", { name: "Retry" }))
    .toHaveAttribute("href", "t3code://app/?desktopWindowId=7");
});
