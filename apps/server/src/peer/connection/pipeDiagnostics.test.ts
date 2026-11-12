// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Exercises banner observation against a private in-memory stream without consuming bytes.
import * as NodeStream from "node:stream";
import { afterEach, expect, it } from "vite-plus/test";
import { observeFirstReadable } from "./pipeDiagnostics.ts";

const previous = process.env.T3_MESH_TEST_MODE;
afterEach(() => {
  if (previous === undefined) delete process.env.T3_MESH_TEST_MODE;
  else process.env.T3_MESH_TEST_MODE = previous;
});

it("observes the first readable banner without consuming any bytes", async () => {
  process.env.T3_MESH_TEST_MODE = "1";
  const stream = new NodeStream.PassThrough();
  const readable = new Promise<void>((resolve) => stream.once("readable", () => resolve()));
  let observed: { stage: string; bufferedBytes: number } | undefined;
  observeFirstReadable(stream, (stage, fields) => {
    observed = { stage, bufferedBytes: fields.bufferedBytes ?? -1 };
  });
  const payload = Buffer.from("SSH-2.0-OpenSSH banner\r\n");
  stream.end(payload);
  await readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(observed).toEqual({ stage: "readable", bufferedBytes: payload.length });
  expect(Buffer.concat(chunks)).toEqual(payload);
});

it("stays silent outside the fixture runtime", () => {
  process.env.T3_MESH_TEST_MODE = "0";
  const stream = new NodeStream.PassThrough();
  observeFirstReadable(stream, () => {
    throw new Error("disabled pipe diagnostics must not report");
  });
  expect(stream.listenerCount("readable")).toBe(0);
});
