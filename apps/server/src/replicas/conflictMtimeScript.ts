export function conflictMtimeScript(root: string, paths: readonly string[]): string {
  if (
    paths.some(
      (path) =>
        !path ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").some((part) => !part || part === "." || part === ".."),
    )
  )
    throw new Error("Unsafe conflict path");
  return `const fs = require("node:fs"); const path = require("node:path"); const root = fs.realpathSync(${JSON.stringify(root)}); const paths = ${JSON.stringify(paths)}; let max = 0;
function visit(target) {
  let stat; try { stat = fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  max = Math.max(max, stat.mtimeMs);
  if (stat.isDirectory()) for (const entry of fs.readdirSync(target)) visit(path.join(target, entry));
}
for (const entry of paths) { const target = path.resolve(root, entry); const relative = path.relative(root, target); if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Outside conflict root"); let parent = path.dirname(target); while (parent !== root) { try { if (fs.lstatSync(parent).isSymbolicLink()) throw new Error("Symlink parent"); } catch (error) { if (error.code !== "ENOENT") throw error; } parent = path.dirname(parent); } visit(target); }
process.stdout.write(String(max));`;
}
