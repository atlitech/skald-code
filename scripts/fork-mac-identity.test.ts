// @effect-diagnostics nodeBuiltinImport:off - Reads committed Info.plist and codesign fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { checkMacIdentity, classifyCodesign, readPlistStrings } from "./fork-mac-identity.ts";

// Fixtures: an electron-builder Info.plist converted with `plutil -convert
// xml1`, and `codesign -dv --verbose=2` output for an unsigned app, an ad hoc
// signed app, and the owner's Developer ID signed, notarized app.
const fixture = (name: string): string =>
  NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "fixtures", "fork-mac-identity", name),
    "utf8",
  );

const version = "0.0.46-atli.1";
const infoPlist = fixture("Info.plist");
const unsigned = fixture("codesign-unsigned.txt");
const adHoc = fixture("codesign-adhoc.txt");
const developerId = fixture("codesign-developer-id.txt");

it("reads top-level strings from the Info.plist", () => {
  assert.deepStrictEqual(readPlistStrings(infoPlist, "CFBundleIdentifier"), [
    "tech.atli.skaldcode",
  ]);
  assert.deepStrictEqual(readPlistStrings(infoPlist, "CFBundleShortVersionString"), [version]);
  assert.deepStrictEqual(readPlistStrings(infoPlist, "CFBundleMissing"), []);
});

it("tells an unsigned, ad hoc, and Developer ID signed app apart", () => {
  assert.deepStrictEqual(classifyCodesign(unsigned), { _tag: "Unsigned" });
  assert.deepStrictEqual(classifyCodesign(adHoc), { _tag: "AdHoc" });
  assert.deepStrictEqual(classifyCodesign(developerId), {
    _tag: "Signed",
    authority: "Developer ID Application: Atli LLC (H6L3F33KRM)",
  });
  assert.deepStrictEqual(classifyCodesign("codesign: no such file or directory\n"), {
    _tag: "Unrecognized",
  });
});

it.effect("accepts the release's app, signed with the owner's Developer ID and notarized", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* checkMacIdentity({ infoPlist, codesign: developerId, version }), {
      bundleIdentifier: "tech.atli.skaldcode",
      version,
      signature: "Developer ID Application: Atli LLC (H6L3F33KRM), notarized",
    });
  }),
);

it.effect("refuses a wrong identity, version, signer, or a missing notarization", () =>
  Effect.gen(function* () {
    const refused = [
      {
        infoPlist: infoPlist.replace("tech.atli.skaldcode", "com.t3tools.t3code"),
        codesign: developerId,
        version,
      },
      {
        infoPlist: infoPlist.replace(
          /(<key>CFBundleName<\/key>\s*<string>)Skald Code/,
          "$1T3 Code (Beta)",
        ),
        codesign: developerId,
        version,
      },
      { infoPlist, codesign: developerId, version: "0.0.46-atli.2" },
      {
        infoPlist: infoPlist.replace(/<key>CFBundleShortVersionString<\/key>/, ""),
        codesign: developerId,
        version,
      },
      // Another team's Developer ID, as upstream's own release is signed.
      {
        infoPlist,
        codesign: developerId.replaceAll("H6L3F33KRM", "ARK85ZXQ4Z"),
        version,
      },
      // Signed but never notarized: Gatekeeper refuses it after download.
      {
        infoPlist,
        codesign: developerId.replace("Notarization Ticket=stapled\n", ""),
        version,
      },
    ];
    for (const input of refused) {
      const error = yield* Effect.flip(checkMacIdentity(input));
      assert.strictEqual(error._tag, "MacIdentityError");
      assert.strictEqual(error.problems.length, 1, error.message);
    }
    for (const codesign of [unsigned, adHoc, "codesign: no such file or directory\n"]) {
      const error = yield* Effect.flip(checkMacIdentity({ infoPlist, codesign, version }));
      assert.match(error.message, /not by team H6L3F33KRM's Developer ID/);
      assert.match(error.message, /no stapled notarization ticket/);
    }
  }),
);
