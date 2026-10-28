import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";

import { BrowserDocumentFrame, HtmlRenderDocument } from "./BrowserDocumentFrame";

const sizeChanged = (height: number) => ({
  jsonrpc: "2.0",
  method: "ui/notifications/size-changed",
  params: { height },
});

describe("HtmlRenderDocument", () => {
  it("reports the page's first height and ignores messages from other windows", async () => {
    using pageUrl = (() => {
      const page = `<script>parent.postMessage(${JSON.stringify(sizeChanged(321))}, "*");</script>`;
      const url = URL.createObjectURL(new Blob([page], { type: "text/html" }));
      return { url, [Symbol.dispose]: () => URL.revokeObjectURL(url) };
    })();
    const onContentHeight = vi.fn();
    await using _screen = await render(
      <HtmlRenderDocument src={pageUrl.url} title="Report" onContentHeight={onContentHeight} />,
    );

    await vi.waitFor(() => expect(onContentHeight).toHaveBeenCalledWith(321));

    // Listeners run in registration order, so once this one sees the message the frame's has too.
    const delivered = new Promise<void>((resolve) =>
      window.addEventListener("message", () => resolve(), { once: true }),
    );
    window.postMessage(sizeChanged(999), "*");
    await delivered;
    expect(onContentHeight).toHaveBeenCalledTimes(1);
  });
});

function pdfUrl(revision: string, pageCount: number): string {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let index = 0; index < pageCount; index++) {
    const text = `BT /F1 24 Tf 72 700 Td (${revision} page ${index + 1}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    );
  }
  // The revision leads the file so each one gets its own fingerprint.
  let body = `%PDF-1.4\n%${revision}\n`;
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return URL.createObjectURL(new Blob([body], { type: "application/pdf" }));
}

it("keeps the reader's place when a PDF is rebuilt", async () => {
  const frameUi = (src: string, documentKey: string) => (
    <div style={{ display: "flex", flexDirection: "column", width: 600, height: 500 }}>
      <BrowserDocumentFrame src={src} title="Paper" pdf documentKey={documentKey} />
    </div>
  );
  await using screen = await render(frameUi(pdfUrl("first", 6), "paper.pdf:1"));
  const { container } = screen;
  const scrollers = () =>
    [...container.querySelectorAll(".pdfViewer")].map(
      (viewer) => viewer.parentElement as HTMLDivElement,
    );
  await expect.poll(() => container.textContent, { timeout: 10_000 }).toContain("first page 1");
  const [first] = scrollers();
  first!.scrollTop = 2_000;

  await screen.rerender(frameUi(pdfUrl("second", 6), "paper.pdf:2"));
  await expect
    .poll(() => scrollers().length === 1 && scrollers()[0] !== first, { timeout: 10_000 })
    .toBe(true);
  const [second] = scrollers();
  expect(second!.style.visibility).toBe("");
  expect(second!.scrollTop).toBe(2_000);
  await expect.poll(() => container.textContent, { timeout: 10_000 }).toContain("second page");
});
