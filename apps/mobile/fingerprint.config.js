// @ts-check
const mobileVersion = require("./mobile-version.json");

// Include the major version, which Expo ignores, to prevent OTAs reaching older store binaries.
const version = process.env.T3CODE_MOBILE_VERSION ?? mobileVersion.version;
const majorVersion = version?.match(/^(\d+)\./)?.[1];
if (!majorVersion) {
  throw new Error("fingerprint.config.js requires a numeric mobile major version");
}

module.exports = {
  nativeModuleSourceType: "files",
  extraSources: [{ type: "contents", id: "appMajorVersion", contents: majorVersion }],
};
