import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";
import { MachineTag } from "./MachineTag";

const machine = { label: "Long machine name", tag: "QA", color: "#6d8cff" };

it("draws the tinted, solid and outline styles with readable text in both themes", async () => {
  await using screen = await render(<div />);
  for (const theme of ["light", "dark"]) {
    await screen.rerender(
      <div className={theme} style={{ color: theme === "dark" ? "#ffffff" : "#000000" }}>
        <MachineTag machine={machine} appearance={{ style: "tinted", textColor: "machine" }} />
        <MachineTag machine={machine} appearance={{ style: "tinted", textColor: "neutral" }} />
        <MachineTag machine={machine} appearance={{ style: "solid", textColor: "machine" }} />
        <MachineTag machine={machine} appearance={{ style: "outline", textColor: "machine" }} />
        <span className="text-foreground" data-reference>
          Reference text
        </span>
      </div>,
    );
    const tags = [...screen.container.querySelectorAll<HTMLElement>('[role="img"]')];
    expect(tags).toHaveLength(4);
    const [tinted, neutral, solid, outline] = tags;
    expect(tinted).toBeDefined();
    expect(neutral).toBeDefined();
    expect(solid).toBeDefined();
    expect(outline).toBeDefined();
    if (!tinted || !neutral || !solid || !outline) return;
    const reference = screen.container.querySelector("[data-reference]");
    expect(reference).not.toBeNull();
    const referenceColor = getComputedStyle(reference!).color;

    expect(getComputedStyle(tinted).backgroundColor).toMatch(/^rgba\(/);
    expect(getComputedStyle(tinted).color).not.toBe(referenceColor);
    expect(getComputedStyle(neutral).color).toBe(referenceColor);

    expect(getComputedStyle(solid).backgroundColor).toBe("rgb(109, 140, 255)");
    expect(["rgb(0, 0, 0)", "rgb(255, 255, 255)"]).toContain(getComputedStyle(solid).color);

    expect(getComputedStyle(outline).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(outline).borderTopWidth).toBe("1px");
    expect(getComputedStyle(outline).borderTopColor).toBe(getComputedStyle(outline).color);
  }
});

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
      const tag = screen.container.querySelector<HTMLElement>('[role="img"]');
      const reference = screen.container.querySelector<HTMLElement>("[data-reference]");
      expect(tag).not.toBeNull();
      expect(reference).not.toBeNull();
      if (tag && reference) {
        expect(getComputedStyle(tag).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
        expect(getComputedStyle(tag).color).not.toBe(referenceColorOf(reference));
      }
    }
  }
});

function referenceColorOf(element: HTMLElement): string {
  return getComputedStyle(element).color;
}
