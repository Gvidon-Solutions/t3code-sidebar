import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";
import { MachineTag } from "./MachineTag";

it("keeps machine names readable with pale and dark custom tag colors in both themes", async () => {
  await using screen = await render(<div />);
  for (const theme of ["light", "dark"]) {
    for (const color of ["#ffffff", "#000000", "#6d8cff", "#e0795b"]) {
      await screen.rerender(
        <div className={theme} style={{ color: theme === "dark" ? "#ffffff" : "#000000" }}>
          <MachineTag machine={{ label: "Long machine name", tag: "QA", color }} />
          <span className="text-foreground" data-reference>
            Reference text
          </span>
        </div>,
      );
      await expect
        .element(screen.getByRole("img", { name: "Machine: Long machine name" }))
        .toBeVisible();
      const tag = screen.container.querySelector('[role="img"]');
      const reference = screen.container.querySelector("[data-reference]");
      expect(tag).not.toBeNull();
      expect(reference).not.toBeNull();
      if (tag && reference) {
        expect(getComputedStyle(tag).color).toBe(getComputedStyle(reference).color);
        expect(getComputedStyle(tag).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      }
    }
  }
});
