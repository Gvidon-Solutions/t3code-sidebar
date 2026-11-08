import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { applyAndroidSigningEnvironment } from "./android-signing-env.mjs";

NodeTest.test(
  "signing requires an explicit file and never discovers an account's signing configuration",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "android-signing-"));
    try {
      const directory = NodePath.join(root, ".local/share/t3-ws");
      NodeFS.mkdirSync(directory, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(directory, "android-signing.env"),
        "T3_ANDROID_KEYSTORE=implicit\n",
      );
      const env = { HOME: root };
      applyAndroidSigningEnvironment(env);
      NodeAssert.equal(env.T3_ANDROID_KEYSTORE, undefined);
      const file = NodePath.join(root, "explicit.env");
      NodeFS.writeFileSync(
        file,
        "export T3_ANDROID_KEYSTORE='/fixture/key store'\nT3_ANDROID_KEY_ALIAS=fixture\nUNRELATED=ignored\n",
      );
      const configured = { T3_ANDROID_SIGNING_ENV: file };
      applyAndroidSigningEnvironment(configured);
      NodeAssert.equal(configured.T3_ANDROID_KEYSTORE, "/fixture/key store");
      NodeAssert.equal(configured.T3_ANDROID_KEY_ALIAS, "fixture");
      NodeAssert.equal(configured.UNRELATED, undefined);
      NodeAssert.throws(
        () => applyAndroidSigningEnvironment({ T3_ANDROID_SIGNING_ENV: `${root}/missing` }),
        /ENOENT/,
      );
      NodeAssert.doesNotThrow(() =>
        applyAndroidSigningEnvironment({
          T3_ANDROID_KEYSTORE: "explicit",
          T3_ANDROID_SIGNING_ENV: `${root}/missing`,
        }),
      );
      NodeAssert.doesNotThrow(() =>
        applyAndroidSigningEnvironment({ T3_ANDROID_SIGNING_ENV: `${root}/missing` }, true),
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
