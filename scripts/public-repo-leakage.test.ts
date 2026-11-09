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
    /(?:152\.89\.244|78\.17\.147|91\.77\.163|138\.249)\.|id_malan[i]ya|\.nvm\/versions\/node\/v26\.12\.1|gor-trans[f]er|vpn-[o]ps|bolych[e]v|nobodysh[u]rt|\/home\/user\b|\/home\/anto[n]\b|\/root\/\.t3\b|(?<!com\.)\bgvi[d]on\b(?!-Solutions)|\boper[a]lia\b|gor\.local|\bgo[r]\b(?!\\.|-)|\.vp[n]\b|Ант[о]н|(?<!\p{L})\u0433\u0432\u0438\u0434\u043e\u043d|(?<!\p{L})\u043e\u043f\u0435\u0440\u0430\u043b\u0438[\u0430\u044f](?!\p{L})|(?<!\p{L})\u0433\u043e\u0440[\u0430\u0435\u0443](?!\p{L})|vtb[f]amily|potential[p]lus|edu[p]latform|non-stand[a]rt/iu;
  const leaked = [...new Set([...files, ...archives])].filter((file) => {
    const data = NodeFS.readFileSync(NodePath.join(root, file));
    return (
      (/^(?:scripts|docs)\//.test(file) && /\.t3-sidebar-serv[e]r/.test(data.toString("utf8"))) ||
      forbidden.test((file.endsWith(".gz") ? NodeZlib.gunzipSync(data) : data).toString("utf8"))
    );
  });
  expect(leaked).toEqual([]);
});
