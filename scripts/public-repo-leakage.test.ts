import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

it("keeps private machine infrastructure out of tracked text", () => {
  const root = NodePath.resolve(import.meta.dirname, "..");
  const files = NodeChildProcess.execFileSync(
    "git",
    ["grep", "-I", "-l", "-z", "-e", "", "--", "."],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter(Boolean);
  const forbidden =
    /(?:152\.89\.244|78\.17\.147|91\.77\.163)\.|id_malan[i]ya|gor-trans[f]er|vpn-[o]ps|bolych[e]v|nobodysh[u]rt|\/home\/user\b|(?<!com\.)\bgvi[d]on\b(?!-Solutions)|\boper[a]lia\b/iu;
  const leaked = files.filter((file) =>
    forbidden.test(NodeFS.readFileSync(NodePath.join(root, file), "utf8")),
  );
  expect(leaked).toEqual([]);
});
