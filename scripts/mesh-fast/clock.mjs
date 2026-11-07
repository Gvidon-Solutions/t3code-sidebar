import * as NodeFS from "node:fs";
const OriginalDate = Date;
const offset = () => Number(NodeFS.readFileSync(process.env.MESH_FAST_CLOCK_FILE, "utf8"));
globalThis.Date = class extends OriginalDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(OriginalDate.now() + offset());
  }
  static now() {
    return OriginalDate.now() + offset();
  }
};
