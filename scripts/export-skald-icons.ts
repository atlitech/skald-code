#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/cli";
import sharp from "sharp";

import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const exportIcons = Effect.fn("skaldIcons.export")(function* (check: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const directory = path.join(root, "assets/skald");
  const install = yield* fs.readFileString(path.join(directory, "icon-install.svg"));
  const favicon = yield* fs.readFileString(path.join(directory, "favicon.svg"));
  const lightMark = yield* fs.readFileString(path.join(directory, "skald-mark.svg"));
  const darkMark = yield* fs.readFileString(path.join(directory, "skald-mark-on-dark.svg"));
  const body = install.slice(install.indexOf(">") + 1, install.lastIndexOf("</svg>"));
  const node = body.replace(/<rect\b[^>]*\/>/, "");
  const svg = (content: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">${content}</svg>`;
  const adaptive = svg(`<g transform="translate(15 15) scale(.7)">${node}</g>`);
  const monochrome = adaptive.replaceAll("#B094E2", "#FFFFFF");
  const mac = svg(
    `<defs><clipPath id="tile"><rect x="9.765625" y="9.765625" width="80.46875" height="80.46875" rx="18"/></clipPath></defs><g clip-path="url(#tile)"><g transform="translate(9.765625 9.765625) scale(.8046875)">${body}</g></g>`,
  );
  const render = (source: string, size: number) =>
    Effect.promise(() =>
      sharp(Buffer.from(source), { density: 768 }).resize(size, size).png().toBuffer(),
    );
  const write = Effect.fn("skaldIcons.write")(function* (relativePath: string, data: Uint8Array) {
    const destination = path.join(root, relativePath);
    if (check) {
      const current = yield* fs.readFile(destination);
      if (!Buffer.from(current).equals(data)) {
        return yield* Effect.die(new Error(`Stale Skald asset: ${relativePath}`));
      }
    } else {
      yield* fs.writeFile(destination, data);
    }
  });

  yield* write("assets/skald/icon-1024.png", yield* render(install, 1024));
  yield* write("assets/skald/icon-macos-1024.png", yield* render(mac, 1024));
  yield* write("assets/skald/apple-touch-icon.png", yield* render(install, 180));
  for (const size of [192, 512]) {
    yield* write(`assets/skald/icon-${size}x${size}.png`, yield* render(install, size));
  }
  yield* write("assets/skald/splash-light.png", yield* render(lightMark, 1024));
  yield* write("assets/skald/splash-dark.png", yield* render(darkMark, 1024));
  yield* write("assets/skald/android-foreground.png", yield* render(adaptive, 432));
  yield* write("assets/skald/android-monochrome.png", yield* render(monochrome, 432));
  yield* write(
    "assets/skald/android-notification.png",
    yield* render(svg(node.replaceAll("#B094E2", "#FFFFFF")), 96),
  );
  yield* write("assets/skald/android-splash.png", yield* render(adaptive, 1152));
  yield* write(
    "assets/skald/android-splash-light.png",
    yield* render(adaptive.replaceAll("#B094E2", "#7E5DB1"), 1152),
  );

  const renditions = yield* Effect.forEach(WINDOWS_ICON_SIZES, (size) =>
    render(favicon, size).pipe(Effect.map((contents) => ({ size, contents }))),
  );
  yield* write("assets/skald/icon-windows.ico", encodePngIco(renditions));
  yield* write(
    "assets/skald/favicon.ico",
    encodePngIco(renditions.filter(({ size }) => [16, 32, 48].includes(size))),
  );
  for (const size of [16, 32]) {
    yield* write(`assets/skald/favicon-${size}x${size}.png`, yield* render(favicon, size));
  }
  for (const file of [
    "favicon.ico",
    "favicon-16x16.png",
    "favicon-32x32.png",
    "apple-touch-icon.png",
    "icon-192x192.png",
    "icon-512x512.png",
  ]) {
    yield* write(`apps/web/public/${file}`, yield* fs.readFile(path.join(directory, file)));
  }
});

Command.run(
  Command.make(
    "export-skald-icons",
    { check: Flag.Boolean("check").pipe(Flag.withDefault(false)) },
    ({ check }) => exportIcons(check),
  ),
  { version: "0.0.0" },
).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
