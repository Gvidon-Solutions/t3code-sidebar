import { describe, expect, it } from "vite-plus/test";
import {
  DRAFT_MACHINE_CARD_TEXT_MAX,
  draftMachineCatalogRequests,
  draftMachineCardState,
  draftMachineCardSync,
  draftMachineCardTexts,
  draftMachineCards,
  nextSelectableMachineCard,
  retainedCatalogRequests,
  shouldRefreshDraftMachineCatalogs,
} from "./draftMachineCards.ts";

describe("draftMachineCardState", () => {
  it("names a synced copy, a copy being made and an out-of-sync copy", () => {
    expect(
      draftMachineCardState({
        label: "cloudbox",
        connected: true,
        reachable: true,
        hasProject: true,
        hasUsableModels: true,
        sync: "synced",
      }),
    ).toEqual({ status: "synced", text: "Synced", selectable: true, guidance: null });
    expect(
      draftMachineCardState({
        label: "cloudbox",
        connected: true,
        reachable: true,
        hasProject: true,
        hasUsableModels: true,
        sync: "copying",
      }).text,
    ).toBe("Copying…");
    expect(
      draftMachineCardState({
        label: "cloudbox",
        connected: true,
        reachable: true,
        hasProject: true,
        hasUsableModels: true,
        sync: "out-of-sync",
      }).text,
    ).toBe("Out of sync");
  });

  it("offers to set up a copy on a connected machine without one", () => {
    expect(
      draftMachineCardState({
        label: "cloudbox",
        connected: true,
        reachable: true,
        hasProject: false,
        hasUsableModels: true,
      }),
    ).toEqual({
      status: "will-copy",
      text: "Will set up a copy",
      selectable: true,
      guidance: null,
    });
  });

  it("dims a machine with no usable models and names it", () => {
    expect(
      draftMachineCardState({
        label: "cloudbox",
        connected: true,
        reachable: true,
        hasProject: true,
        hasUsableModels: false,
      }),
    ).toEqual({
      status: "no-models",
      text: "No models here",
      selectable: false,
      guidance: null,
    });
  });

  it("disables a machine that cannot host a copy and gives the plain reason", () => {
    expect(
      draftMachineCardState({
        label: "oldbox",
        connected: true,
        reachable: true,
        hasProject: false,
        hasUsableModels: true,
        canHostCopy: false,
      }),
    ).toEqual({
      status: "cannot-host",
      text: "Can't host a copy",
      selectable: false,
      guidance: null,
    });
    // An existing copy on an older server is still usable.
    expect(
      draftMachineCardState({
        label: "oldbox",
        connected: true,
        reachable: true,
        hasProject: true,
        hasUsableModels: true,
        canHostCopy: false,
      }).status,
    ).toBe("synced");
  });

  it("tells the user when the draft's selected model is missing there", () => {
    const config = {
      machines: {
        studio: { title: "studio", tag: "ST" },
        cloudbox: { title: "cloudbox", tag: "CB" },
      },
    } as const;
    const state = draftMachineCardState({
      label: "cloudbox",
      connected: true,
      reachable: true,
      hasProject: true,
      hasUsableModels: true,
      hasSelectedModel: false,
    });
    expect(state.selectable).toBe(true);
    expect(state.guidance).toBe("Model not available here");
    const rows = draftMachineCards({
      config,
      choices: [
        {
          environmentId: "studio",
          label: "studio",
          projectId: "p1",
          primary: true,
          connected: true,
          hasUsableModels: true,
          hasSelectedModel: true,
        },
        {
          environmentId: "cloudbox",
          label: "cloudbox",
          projectId: "p1",
          primary: false,
          connected: true,
          hasUsableModels: true,
          hasSelectedModel: false,
        },
      ],
      reachability: {},
      selectedEnvironmentId: "studio",
    });
    expect(rows.find((row) => row.environmentId === "cloudbox")?.note).toBe(
      "Model not available here",
    );
  });

  it("names a mesh-reached machine's copy without calling it not connected", () => {
    expect(
      draftMachineCardState({
        label: "laptop",
        connected: false,
        reachable: true,
        viaLabel: "studio",
        hasProject: true,
        hasUsableModels: true,
        sync: "synced",
      }),
    ).toEqual({ status: "synced", text: "Synced", selectable: false, guidance: null });
    expect(
      draftMachineCardState({
        label: "laptop",
        connected: false,
        reachable: true,
        viaLabel: "studio",
        hasProject: false,
        hasUsableModels: true,
      }),
    ).toEqual({
      status: "will-copy",
      text: "Will set up a copy",
      selectable: false,
      guidance: null,
    });
    expect(
      draftMachineCardState({
        label: "laptop",
        connected: false,
        reachable: false,
        hasProject: false,
        hasUsableModels: null,
      }),
    ).toEqual({
      status: "unreachable",
      text: "Not connected here",
      selectable: false,
      guidance: null,
    });
  });
});

describe("draftMachineCards", () => {
  const config = {
    machines: {
      studio: { title: "studio", tag: "ST" },
      cloudbox: { title: "cloudbox", tag: "CB" },
      laptop: { title: "laptop", tag: "LT" },
    },
  } as const;

  it("shows no cards for a single machine", () => {
    expect(
      draftMachineCards({
        config,
        choices: [
          {
            environmentId: "studio",
            label: "studio",
            projectId: "p1",
            primary: true,
            connected: true,
            hasUsableModels: true,
          },
        ],
        reachability: {},
        selectedEnvironmentId: "studio",
      }),
    ).toEqual([]);
  });

  it("orders the main copy first, then copies that can run, then the rest", () => {
    const rows = draftMachineCards({
      config,
      choices: [
        {
          environmentId: "laptop",
          label: "laptop",
          projectId: null,
          primary: false,
          connected: false,
          hasUsableModels: null,
        },
        {
          environmentId: "cloudbox",
          label: "cloudbox",
          projectId: null,
          primary: false,
          connected: true,
          hasUsableModels: true,
          sync: "copying",
        },
        {
          environmentId: "studio",
          label: "studio",
          projectId: "p1",
          primary: true,
          connected: true,
          hasUsableModels: true,
          sync: "synced",
        },
      ],
      reachability: { laptop: { reachable: true, viaLabel: "studio" } },
      selectedEnvironmentId: "studio",
    });
    expect(rows.map((row) => [row.environmentId, row.status, row.selected])).toEqual([
      ["studio", "synced", true],
      ["cloudbox", "copying", false],
      ["laptop", "will-copy", false],
    ]);
    expect(rows[0]?.machine.tag).toBe("ST");
    expect(rows[0]?.note).toBeNull();
    expect(rows[1]?.note).toBeNull();
    expect(rows[2]?.note).toBe("Available through studio");
    expect(rows[2]?.hint).toContain("The mesh reaches laptop through studio");
  });
});

describe("mesh-reached machine cards", () => {
  const config = {
    machines: {
      studio: { title: "studio", tag: "ST" },
      cloudbox: { title: "cloudbox", tag: "CB" },
    },
  } as const;

  it("names a reachable machine instead of calling it not connected here", () => {
    const rows = draftMachineCards({
      config,
      choices: [
        {
          environmentId: "studio",
          label: "studio",
          projectId: "p1",
          primary: true,
          connected: true,
          hasUsableModels: true,
        },
        {
          environmentId: "cloudbox",
          label: "cloudbox",
          projectId: "p1",
          primary: false,
          connected: false,
          hasUsableModels: true,
          sync: "synced",
        },
      ],
      reachability: {
        cloudbox: { reachable: true, viaLabel: "studio" },
      },
      selectedEnvironmentId: "studio",
    });
    const cloudbox = rows.find((row) => row.environmentId === "cloudbox");
    expect(cloudbox?.text).toBe("Synced");
    expect(cloudbox?.selectable).toBe(false);
    expect(cloudbox?.note).toBe("Available through studio");
    expect(cloudbox?.note).not.toBe("Not connected here");
    expect(cloudbox?.hint).toBe(
      "The mesh reaches cloudbox through studio. Connect this device to start a thread here.",
    );
  });

  it("still names an unreachable machine as not connected here", () => {
    const rows = draftMachineCards({
      config,
      choices: [
        {
          environmentId: "studio",
          label: "studio",
          projectId: "p1",
          primary: true,
          connected: true,
          hasUsableModels: true,
        },
        {
          environmentId: "cloudbox",
          label: "cloudbox",
          projectId: "p1",
          primary: false,
          connected: false,
          hasUsableModels: true,
        },
      ],
      reachability: {},
      selectedEnvironmentId: "studio",
    });
    const cloudbox = rows.find((row) => row.environmentId === "cloudbox");
    expect(cloudbox?.text).toBe("Not connected here");
    expect(cloudbox?.note).toBeNull();
  });
});

describe("offline machine cards", () => {
  const config = {
    machines: {
      studio: { title: "studio", tag: "ST" },
      laptop: { title: "laptop", tag: "LT" },
    },
  } as const;

  it("says Offline for a machine the mesh reports offline", () => {
    expect(
      draftMachineCardState({
        label: "laptop",
        connected: false,
        reachable: false,
        offline: true,
        offlineText: "Offline · 3 min",
        hasProject: true,
        hasUsableModels: null,
      }),
    ).toEqual({
      status: "offline",
      text: "Offline",
      selectable: false,
      guidance: null,
    });
  });

  it("keeps the offline age in the card tooltip", () => {
    const rows = draftMachineCards({
      config,
      choices: [
        {
          environmentId: "studio",
          label: "studio",
          projectId: "p1",
          primary: true,
          connected: true,
          hasUsableModels: true,
        },
        {
          environmentId: "laptop",
          label: "laptop",
          projectId: "p1",
          primary: false,
          connected: false,
          hasUsableModels: null,
        },
      ],
      reachability: {
        laptop: { reachable: false, offline: true, offlineText: "Offline · 3 min" },
      },
      selectedEnvironmentId: "studio",
    });
    const laptop = rows.find((row) => row.environmentId === "laptop");
    expect(laptop?.status).toBe("offline");
    expect(laptop?.text).toBe("Offline");
    expect(laptop?.note).toBeNull();
    expect(laptop?.hint).toBe("Offline · 3 min");
  });
});

describe("draftMachineCardSync", () => {
  it("maps live replica states to the three card words", () => {
    expect(draftMachineCardSync("watching")).toBe("synced");
    expect(draftMachineCardSync("mounting")).toBe("copying");
    expect(draftMachineCardSync("pending")).toBe("copying");
    expect(draftMachineCardSync("error")).toBe("out-of-sync");
    expect(draftMachineCardSync("conflict")).toBe("out-of-sync");
    expect(draftMachineCardSync(undefined)).toBeNull();
  });
});

it("polls catalogs only for unconnected machines and keeps a bounded key set", () => {
  expect(
    draftMachineCatalogRequests({ activeProjectEnvironmentId: "studio", environmentIds: [] }),
  ).toEqual([]);
  expect(
    draftMachineCatalogRequests({
      activeProjectEnvironmentId: "studio",
      environmentIds: ["cloudbox", "cloudbox", "laptop"],
    }),
  ).toEqual(["studio:cloudbox", "studio:laptop"]);
  expect(
    shouldRefreshDraftMachineCatalogs({ activeProjectEnvironmentId: "studio", environmentIds: [] }),
  ).toBe(false);
  expect(
    shouldRefreshDraftMachineCatalogs({
      activeProjectEnvironmentId: "studio",
      environmentIds: ["cloudbox"],
    }),
  ).toBe(true);
  expect(
    retainedCatalogRequests(["studio:cloudbox", "studio:old"], new Set(["studio:cloudbox"])),
  ).toEqual(["studio:cloudbox"]);
});

describe("draftMachineCardState host and copy wording", () => {
  const base = {
    label: "cloudbox",
    connected: true,
    reachable: true,
    hasUsableModels: true,
  };

  it("does not talk about copies when the draft has no project", () => {
    expect(draftMachineCardState({ ...base, hasProject: false, draftHasProject: false })).toEqual({
      status: "available",
      text: "Available",
      selectable: true,
      guidance: null,
    });
    expect(
      draftMachineCardState({
        ...base,
        hasProject: false,
        draftHasProject: false,
        canHostCopy: false,
      }),
    ).toEqual({
      status: "available",
      text: "Available",
      selectable: true,
      guidance: null,
    });
  });

  it("only refuses a copy when a project needs one and the server is known unable", () => {
    expect(draftMachineCardState({ ...base, hasProject: false, canHostCopy: false })).toEqual({
      status: "cannot-host",
      text: "Can't host a copy",
      selectable: false,
      guidance: null,
    });
    expect(draftMachineCardState({ ...base, hasProject: true, canHostCopy: true }).status).toBe(
      "synced",
    );
  });
});

describe("nextSelectableMachineCard", () => {
  const cards = [
    { environmentId: "studio", selectable: true },
    { environmentId: "cloudbox", selectable: false },
    { environmentId: "laptop", selectable: true },
  ];

  it("skips disabled cards in both directions and wraps", () => {
    expect(nextSelectableMachineCard(cards, "studio", 1)).toBe("laptop");
    expect(nextSelectableMachineCard(cards, "laptop", 1)).toBe("studio");
    expect(nextSelectableMachineCard(cards, "laptop", -1)).toBe("studio");
  });

  it("returns null when nothing can be picked", () => {
    expect(
      nextSelectableMachineCard([{ environmentId: "studio", selectable: false }], "studio", 1),
    ).toBeNull();
    expect(nextSelectableMachineCard([], null, 1)).toBeNull();
  });
});

describe("draft card model resolution", () => {
  const instanceId = "codex";
  const catalog = {
    providers: [
      {
        instanceId,
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        auth: { status: "authenticated" },
        models: [{ slug: "fixture" }],
      },
    ],
  } as never;
  const config = {
    machines: {
      studio: { title: "studio", tag: "ST" },
      laptop: { title: "laptop", tag: "LT" },
    },
  } as const;

  it("judges a fresh draft by the model the composer will send on each machine", () => {
    const rows = draftMachineCards({
      config,
      choices: [
        {
          environmentId: "studio",
          label: "studio",
          projectId: "p1",
          primary: true,
          connected: true,
          hasUsableModels: true,
          config: catalog,
        },
        {
          environmentId: "laptop",
          label: "laptop",
          projectId: "p1",
          primary: false,
          connected: true,
          hasUsableModels: true,
          config: catalog,
        },
      ],
      reachability: {},
      selectedEnvironmentId: "studio",
      selection: null,
    });
    expect(rows.map((row) => row.text)).toEqual(["Synced", "Synced"]);
    expect(rows.map((row) => row.guidance)).toEqual([null, null]);
    expect(rows.map((row) => row.note)).toEqual([null, null]);
  });

  it("still names a model the person explicitly chose and that is missing", () => {
    const rows = draftMachineCards({
      config,
      choices: [
        {
          environmentId: "studio",
          label: "studio",
          projectId: "p1",
          primary: true,
          connected: true,
          hasUsableModels: true,
          config: catalog,
        },
        {
          environmentId: "laptop",
          label: "laptop",
          projectId: "p1",
          primary: false,
          connected: true,
          hasUsableModels: true,
          config: catalog,
        },
      ],
      reachability: {},
      selectedEnvironmentId: "studio",
      selection: { instanceId, model: "gone" } as never,
    });
    expect(rows.find((row) => row.environmentId === "laptop")?.guidance).toBe(
      "Model not available here",
    );
    expect(rows.find((row) => row.environmentId === "laptop")?.note).toBe(
      "Model not available here",
    );
  });

  it("keeps every short phrase inside the one-line budget", () => {
    for (const text of Object.values(draftMachineCardTexts))
      expect(text.length).toBeLessThanOrEqual(DRAFT_MACHINE_CARD_TEXT_MAX);
    expect(draftMachineCardTexts.modelMissing.length).toBe(24);
  });
});
