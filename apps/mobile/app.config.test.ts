import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

type WidgetEntry = {
  readonly name: string;
  readonly ios?: { readonly initialLayout?: string };
  readonly android?: { readonly initialLayout?: string } | null;
};

function widgetEntries(config: Awaited<ReturnType<typeof loadConfig>>): readonly WidgetEntry[] {
  for (const plugin of (config.plugins ?? []) as readonly unknown[]) {
    if (!Array.isArray(plugin) || plugin[0] !== "expo-widgets") continue;
    return ((plugin[1] as { widgets?: readonly WidgetEntry[] }).widgets ?? []) as WidgetEntry[];
  }
  return [];
}

// The iOS build exits 65 when a widget points at a layout file the merge removed.
it("registers only widget layouts that exist in the app tree", async () => {
  const config = await loadConfig("sidebar");
  const widgets = widgetEntries(config);
  expect(widgets.map((widget) => widget.name)).toEqual(["SubscriptionUsage"]);
  const appDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  for (const widget of widgets) {
    for (const layout of [widget.ios?.initialLayout, widget.android?.initialLayout]) {
      if (layout === undefined) continue;
      expect(NodeFS.existsSync(NodePath.resolve(appDir, layout))).toBe(true);
    }
  }
});
