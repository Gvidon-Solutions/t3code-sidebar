// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Exercises banner observation against a private in-memory stream without consuming bytes.
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import { afterEach, expect, it } from "vite-plus/test";
import { observeFirstReadable } from "./pipeDiagnostics.ts";

const previous = process.env.T3_MESH_TEST_MODE;
afterEach(() => {
  if (previous === undefined) delete process.env.T3_MESH_TEST_MODE;
  else process.env.T3_MESH_TEST_MODE = previous;
});

it("observes the first piped data chunk without consuming buffered or later bytes", async () => {
  process.env.T3_MESH_TEST_MODE = "1";
  const source = new NodeStream.PassThrough();
  const sink = new NodeStream.PassThrough();
  const banner = Buffer.from("SSH-2.0-OpenSSH banner\r\n");
  const later = Buffer.from("payload after the banner\n");
  source.write(banner);

  let observed: { stage: string; bytes: number } | undefined;
  let markObserved = () => {};
  const firstObserved = new Promise<void>((resolve) => {
    markObserved = resolve;
  });
  observeFirstReadable(source, (stage, fields) => {
    observed = { stage, bytes: fields.bufferedBytes ?? -1 };
    markObserved();
  });
  const chunks: Buffer[] = [];
  sink.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  source.pipe(sink);
  await firstObserved;
  source.write(later);
  source.end();
  await NodeStreamPromises.finished(sink);

  expect(observed?.stage).toBe("data");
  expect(observed?.bytes).toBe(banner.length);
  expect(Buffer.concat(chunks)).toEqual(Buffer.concat([banner, later]));
});

it("stays silent outside the fixture runtime", () => {
  process.env.T3_MESH_TEST_MODE = "0";
  const stream = new NodeStream.PassThrough();
  observeFirstReadable(stream, () => {
    throw new Error("disabled pipe diagnostics must not report");
  });
  expect(stream.listenerCount("data")).toBe(0);
  expect(stream.listenerCount("readable")).toBe(0);
});
