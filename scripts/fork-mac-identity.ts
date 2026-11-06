#!/usr/bin/env node

// Validate DMG Info.plist and codesign output against app identity and release version:
// signed with the owner's Developer ID and notarized, or Gatekeeper blocks the download.
// See the fork runbook.

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Digest from "effect/crypto/Digest";
import * as Base64 from "effect/encoding/Base64";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { PERSONAL_APPLE_TEAM_ID } from "./fork-ios-identity.ts";
import { DESKTOP_APP_ID, DESKTOP_PRODUCT_NAME } from "./lib/desktop-app-id.ts";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every `<string>` value stored under `key` in an XML property list. */
export const readPlistStrings = (plist: string, key: string): ReadonlyArray<string> =>
  Array.from(
    plist.matchAll(new RegExp(`<key>${escapeRegExp(key)}</key>\\s*<string>([^<]*)</string>`, "g")),
    (match) => match[1]!,
  );

export type MacSignature =
  | { readonly _tag: "Unsigned" }
  | { readonly _tag: "AdHoc" }
  | { readonly _tag: "Signed"; readonly authority: string }
  | { readonly _tag: "Unrecognized" };

/** Reads what signs the app from `codesign -dv --verbose=2` output. */
export const classifyCodesign = (output: string): MacSignature => {
  if (/: code object is not signed at all$/m.test(output)) return { _tag: "Unsigned" };
  const authority = /^Authority=(.+)$/m.exec(output)?.[1];
  if (authority) return { _tag: "Signed", authority };
  const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1];
  if (team && team !== "not set") return { _tag: "Signed", authority: `team ${team}` };
  if (/^Signature=adhoc$/m.test(output)) return { _tag: "AdHoc" };
  return { _tag: "Unrecognized" };
};

export class MacIdentityError extends Schema.TaggedError<MacIdentityError>()("MacIdentityError", {
  problems: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `The Mac app is not the release's signed app: ${this.problems.join(" ")}`;
  }
}

const readOne = (plist: string, key: string, expected: string): string | undefined => {
  const values = readPlistStrings(plist, key);
  if (values.length !== 1) return `Info.plist has ${values.length} ${key} strings, not one.`;
  if (values[0] !== expected) return `${key} is '${values[0]}', not '${expected}'.`;
  return undefined;
};

const describeSignature = (signature: MacSignature): string => {
  switch (signature._tag) {
    case "Unsigned":
      return "unsigned";
    case "AdHoc":
      return "signed ad hoc";
    case "Signed":
      return `signed by '${signature.authority}'`;
    case "Unrecognized":
      return "signed in a way codesign output does not name";
  }
};

export const checkMacIdentity = Effect.fn("checkMacIdentity")(function* (input: {
  readonly infoPlist: string;
  readonly codesign: string;
  readonly version: string;
}) {
  const signature = classifyCodesign(input.codesign);
  const team = /^TeamIdentifier=(.+)$/m.exec(input.codesign)?.[1];
  const developerId =
    signature._tag === "Signed" &&
    signature.authority.startsWith("Developer ID Application: ") &&
    team === PERSONAL_APPLE_TEAM_ID;
  const problems = [
    readOne(input.infoPlist, "CFBundleIdentifier", DESKTOP_APP_ID),
    readOne(input.infoPlist, "CFBundleName", DESKTOP_PRODUCT_NAME),
    readOne(input.infoPlist, "CFBundleShortVersionString", input.version),
    developerId
      ? undefined
      : `the app is ${describeSignature(signature)}, not by team ${PERSONAL_APPLE_TEAM_ID}'s Developer ID.`,
    /^Notarization Ticket=stapled$/m.test(input.codesign)
      ? undefined
      : "the app carries no stapled notarization ticket.",
  ].filter((problem): problem is string => problem !== undefined);
  if (problems.length > 0 || signature._tag !== "Signed") {
    return yield* new MacIdentityError({ problems });
  }
  return {
    bundleIdentifier: DESKTOP_APP_ID,
    version: input.version,
    signature: `${signature.authority}, notarized`,
  } as const;
});

const AppUpdate = fromYaml(
  Schema.Struct({
    provider: Schema.Literal("github"),
    owner: Schema.Literal("atlitech"),
    repo: Schema.Literal("skald-code"),
    channel: Schema.Literal("atli"),
  }),
);
const UpdateManifest = fromYaml(
  Schema.Struct({
    version: Schema.String,
    files: Schema.Array(
      Schema.Struct({ url: Schema.String, sha512: Schema.String, size: Schema.Number }),
    ),
  }),
);

const decodeAppUpdate = Schema.decodeEffect(AppUpdate);
const decodeUpdateManifest = Schema.decodeEffect(UpdateManifest);

export const checkMacUpdateArtifacts = Effect.fn("checkMacUpdateArtifacts")(function* (input: {
  readonly appUpdateYml: string;
  readonly releaseDir: string;
  readonly version: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  yield* decodeAppUpdate(input.appUpdateYml);
  const manifest = yield* decodeUpdateManifest(
    yield* fs.readFileString(path.join(input.releaseDir, "atli-mac.yml")),
  );
  const zip = `T3-Code-${input.version}-arm64.zip`;
  const dmg = `T3-Code-${input.version}-arm64.dmg`;
  if (manifest.version !== input.version || !manifest.files.some((file) => file.url === zip)) {
    return yield* new MacIdentityError({
      problems: ["The OTA manifest must name this release and its ZIP payload."],
    });
  }
  for (const file of manifest.files) {
    if (file.url !== zip && file.url !== dmg) {
      return yield* new MacIdentityError({ problems: [`Unexpected OTA payload: ${file.url}.`] });
    }
    const bytes = yield* fs.readFile(path.join(input.releaseDir, file.url));
    const sha512 = Base64.encode(yield* digest.digest(Digest.sha512, bytes));
    if (bytes.length !== file.size || sha512 !== file.sha512) {
      return yield* new MacIdentityError({
        problems: [`OTA checksum or size mismatch for ${file.url}.`],
      });
    }
  }
  const blockmap = yield* fs.stat(path.join(input.releaseDir, `${zip}.blockmap`));
  if (blockmap.size === 0n) {
    return yield* new MacIdentityError({ problems: ["The ZIP blockmap is empty."] });
  }
});

const command = Command.make(
  "fork-mac-identity",
  {
    appUpdateYml: Flag.String("app-update-yml"),
    releaseDir: Flag.String("release-dir"),
    infoPlist: Flag.String("info-plist").pipe(
      Flag.withDescription("The app's Info.plist as XML (plutil -convert xml1)."),
    ),
    codesign: Flag.String("codesign").pipe(
      Flag.withDescription("Output of `codesign -dv --verbose=2 <app>`, stderr included."),
    ),
    // `--version` is the runner's own flag.
    version: Flag.String("release-version").pipe(
      Flag.withDescription("Fork version, for example 0.0.46-atli.1."),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const identity = yield* checkMacIdentity({
        infoPlist: yield* fs.readFileString(options.infoPlist),
        codesign: yield* fs.readFileString(options.codesign),
        version: options.version,
      });
      yield* checkMacUpdateArtifacts({
        appUpdateYml: yield* fs.readFileString(options.appUpdateYml),
        releaseDir: options.releaseDir,
        version: options.version,
      });
      yield* Effect.log(
        `${identity.bundleIdentifier} ${identity.version}, ${identity.signature}: the release's app.`,
      );
    }),
).pipe(
  Command.withDescription("Check the fork Mac app's bundle identifier, version and signature."),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    NodeRuntime.runMain,
  );
}
