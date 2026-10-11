const { withAppBuildGradle } = require("expo/config-plugins");

// Sidebar fork: signs release builds with the fork's own key when
// T3_ANDROID_KEYSTORE is set at Gradle time (CI and local builds share it, so
// every APK installs over the previous one). Without it the template's debug
// signing stays.
const SIGNING_CONFIG = `
        release {
            if (System.getenv("T3_ANDROID_KEYSTORE")) {
                storeFile file(System.getenv("T3_ANDROID_KEYSTORE"))
                storePassword System.getenv("T3_ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("T3_ANDROID_KEY_ALIAS") ?: "t3-sidebar"
                keyPassword System.getenv("T3_ANDROID_KEYSTORE_PASSWORD")
            }
        }`;

module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    let gradle = nextConfig.modResults.contents;
    if (gradle.includes('System.getenv("T3_ANDROID_KEYSTORE")')) return nextConfig;
    gradle = gradle.replace(
      /(signingConfigs \{\n\s*debug \{[^}]*\})/,
      (match) => `${match}${SIGNING_CONFIG}`,
    );
    gradle = gradle.replace(
      /(release \{\n(?:\s*\/\/.*\n)*\s*)signingConfig signingConfigs\.debug/,
      (_match, prefix) =>
        `${prefix}signingConfig System.getenv("T3_ANDROID_KEYSTORE") ? signingConfigs.release : signingConfigs.debug`,
    );
    nextConfig.modResults.contents = gradle;
    return nextConfig;
  });
};
