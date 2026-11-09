import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  tryCopy: vi.fn(async () => false),
  prompt: vi.fn(),
}));

vi.mock("expo-linking", () => ({ createURL: () => "t3code://new", openURL: vi.fn() }));
vi.mock("react-native", () => ({ View: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/Dialog", () => ({
  prompt: (request: unknown) => mocks.prompt(request),
}));
vi.mock("../../lib/copyTextWithHaptic", () => ({
  tryCopyTextWithHaptic: mocks.tryCopy,
}));

import { copyMeshPrompt } from "./MeshAgentFixActions";

it("shows the prompt selected for manual copy when the mobile clipboard fails", async () => {
  await expect(copyMeshPrompt("Fix the mesh")).resolves.toBe(false);
  expect(mocks.prompt).toHaveBeenCalledWith({
    title: "Copy the prompt by hand",
    message: "The clipboard is unavailable. The text is selected; copy it from here.",
    initialValue: "Fix the mesh",
    confirmText: "Done",
    onConfirm: expect.any(Function),
  });
});
