// @effect-diagnostics nodeBuiltinImport:off -- Exercises Git’s tracked-file boundary, including compressed fixtures.
import * as NodeZlib from "node:zlib";
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
  const archives = NodeChildProcess.execFileSync("git", ["ls-files", "-z", "--", "*.gz"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const forbidden =
    /(?:152\.89\.244|78\.17\.147|91\.77\.163)\.|id_malan[i]ya|\.nvm\/versions\/node\/v26\.12\.1|laptop-trans[f]er|vpn-[o]ps|bolych[e]v|nobodysh[u]rt|\/home\/user\b|(?<!com\.)\bgvi[d]on\b(?!-Solutions)|\boper[a]lia\b/iu;
  const leaked = [...new Set([...files, ...archives])].filter((file) => {
    const data = NodeFS.readFileSync(NodePath.join(root, file));
    return forbidden.test(
      (file.endsWith(".gz") ? NodeZlib.gunzipSync(data) : data).toString("utf8"),
    );
  });
  expect(leaked).toEqual([]);
});
