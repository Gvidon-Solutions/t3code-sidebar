import { writeManagedSshdConfig } from "../lib/managed-sshd.mjs";

const [home, portText] = process.argv.slice(2);
const port = Number(portText);
if (!home || !Number.isInteger(port)) throw Error("Usage: managed-sshd.mjs ABSOLUTE_SSH_HOME PORT");
console.log(await writeManagedSshdConfig({ home, port }));
