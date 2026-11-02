import { createFileRoute } from "@tanstack/react-router";

import { MeshSettingsPanel } from "../components/workspaces/MeshSettingsPanel";

export const Route = createFileRoute("/_chat/settings/mesh")({
  component: MeshSettingsPanel,
});
