import * as NodeHttp from "node:http";
const { request } = NodeHttp;
import * as NodeFS from "node:fs";
const { readFileSync } = NodeFS;
import * as NodeOS from "node:os";
const { homedir } = NodeOS;
import * as NodePath from "node:path";
const { join } = NodePath;

export function requestDelivery(payload) {
  const configPath = process.env.T3_DELIVERY_CONFIG || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "t3-delivery/config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!config.socket) throw new Error(`No builder socket configured in ${configPath}`);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: config.socket, method: "POST", path: "/deliver", headers: { "content-type": "application/json" } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const result = JSON.parse(text);
          if (res.statusCode !== 200) reject(new Error(result.error || `Builder HTTP ${res.statusCode}`));
          else resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
}
