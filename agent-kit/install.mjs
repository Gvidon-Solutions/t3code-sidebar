import * as NodeFS from "node:fs";
const fs = NodeFS;
import * as NodePath from "node:path";
const path = NodePath;
import * as NodeURL from "node:url";
const { fileURLToPath } = NodeURL;
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--dest") {
  throw new Error(
    "Use agent-kit/install.sh --dest DIR to stage a skill. Servers install and reconcile the mesh agent kit from config.",
  );
}
const source = fileURLToPath(new URL("./skills/t3", import.meta.url));
const destination = path.resolve(args[1]);
if (destination === source || source.startsWith(destination + path.sep))
  throw new Error("Unsafe staging destination");
fs.mkdirSync(destination, { recursive: true });
fs.cpSync(source, destination, {
  recursive: true,
  filter: (p) => !p.split(path.sep).includes("global") && !p.endsWith(".test.mjs"),
});
console.log("skill copied to " + destination);
