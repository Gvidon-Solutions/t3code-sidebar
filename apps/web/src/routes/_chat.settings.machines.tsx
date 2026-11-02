import { createFileRoute } from "@tanstack/react-router";

import { MachinesSettingsPanel } from "../components/workspaces/MachinesSettingsPanel";

export const Route = createFileRoute("/_chat/settings/machines")({
  component: MachinesSettingsPanel,
});
