import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

function cmakeTools() {
  const sdkDirectories = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    NodePath.join(NodeOS.homedir(), "Library/Android/sdk"),
    NodePath.join(NodeOS.homedir(), "Android/Sdk"),
  ];
  const candidates = [
    process.env.T3CODE_TEST_CMAKE,
    "cmake",
    ...sdkDirectories.flatMap((sdk) => {
      if (!sdk) return [];
      const sdkCmake = NodePath.join(sdk, "cmake");
      return NodeFS.existsSync(sdkCmake)
        ? NodeFS.readdirSync(sdkCmake).map((version) =>
            NodePath.join(sdkCmake, version, "bin/cmake"),
          )
        : [];
    }),
  ];
  for (const cmake of candidates) {
    if (!cmake || NodeChildProcess.spawnSync(cmake, ["--version"]).status !== 0) continue;
    const siblingNinja = NodePath.join(NodePath.dirname(cmake), "ninja");
    const ninja = NodeFS.existsSync(siblingNinja) ? siblingNinja : "ninja";
    if (NodeChildProcess.spawnSync(ninja, ["--version"]).status === 0) return { cmake, ninja };
  }
  throw new Error(
    "The native cache fixture requires CMake and Ninja on PATH or in the Android SDK.",
  );
}

function nativeFixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-native cache-"));
  const bin = NodePath.join(directory, "bin");
  const calls = NodePath.join(directory, "calls.jsonl");
  NodeFS.mkdirSync(bin);
  NodeFS.mkdirSync(NodePath.join(directory, "module"));
  NodeFS.writeFileSync(
    NodePath.join(bin, "ccache"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.T3CODE_NATIVE_CACHE_TEST_LOG, JSON.stringify(args) + "\\n");
const result = spawnSync(args[0], args.slice(1), { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(
    NodePath.join(directory, "CMakeLists.txt"),
    `cmake_minimum_required(VERSION 3.22)
project(cache_fixture LANGUAGES C CXX)
if(REACT_NATIVE_HOOK)
  set_property(GLOBAL PROPERTY RULE_LAUNCH_COMPILE ccache)
  set_property(GLOBAL PROPERTY RULE_LAUNCH_LINK ccache)
endif()
add_subdirectory(module)
add_executable(cache_fixture main.c)
target_link_libraries(cache_fixture PRIVATE fixture_module)
`,
  );
  NodeFS.writeFileSync(
    NodePath.join(directory, "module/CMakeLists.txt"),
    "add_library(fixture_module STATIC module.cpp)\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(directory, "main.c"),
    '#include <stdio.h>\nint value(void);\nint main(void) { printf("%d\\n", value()); }\n',
  );
  const source = NodePath.join(directory, "module/module.cpp");
  NodeFS.writeFileSync(source, 'extern "C" int value() { return 3; }\n');
  return {
    directory,
    source,
    env: {
      ...process.env,
      PATH: `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
      T3CODE_NATIVE_CACHE_TEST_LOG: calls,
    },
    compilerCalls: () =>
      NodeFS.existsSync(calls)
        ? NodeFS.readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[])
        : [],
    [Symbol.dispose]() {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const reactNative of [false, true]) {
  NodeTest.test(`uses one C/C++ launcher with the React Native hook set to ${reactNative}`, () => {
    using fixture = nativeFixture();
    const { cmake, ninja } = cmakeTools();
    const build = NodePath.join(fixture.directory, "build");
    const env = { ...fixture.env, T3CODE_ANDROID_BUILD_CACHE: "1" };
    NodeChildProcess.execFileSync(
      cmake,
      [
        "-S",
        fixture.directory,
        "-B",
        build,
        "-G",
        "Ninja",
        `-DCMAKE_MAKE_PROGRAM=${ninja}`,
        `-DCMAKE_PROJECT_INCLUDE=${NodePath.join(import.meta.dirname, "android-ci-cache.cmake")}`,
        `-DREACT_NATIVE_HOOK=${reactNative ? "ON" : "OFF"}`,
      ],
      { env, stdio: "pipe" },
    );
    NodeChildProcess.execFileSync(cmake, ["--build", build], { env, stdio: "pipe" });
    const executable = NodePath.join(build, "cache_fixture");
    NodeAssert.equal(NodeChildProcess.execFileSync(executable, { encoding: "utf8" }).trim(), "3");
    NodeAssert.equal(fixture.compilerCalls().filter((args) => args.includes("-c")).length, 2);

    NodeFS.writeFileSync(fixture.source, 'extern "C" int value() { return 4; }\n');
    NodeChildProcess.execFileSync(cmake, ["--build", build], { env, stdio: "pipe" });
    NodeAssert.equal(NodeChildProcess.execFileSync(executable, { encoding: "utf8" }).trim(), "4");
    NodeAssert.equal(fixture.compilerCalls().filter((args) => args.includes("-c")).length, 3);
    NodeAssert.equal(
      fixture.compilerCalls().some((args) => NodePath.basename(args[0] ?? "") === "ccache"),
      false,
    );
  });
}

NodeTest.test("leaves native compilation alone without the CI opt-in", () => {
  using fixture = nativeFixture();
  const { cmake, ninja } = cmakeTools();
  const build = NodePath.join(fixture.directory, "build");
  const env = { ...fixture.env, T3CODE_ANDROID_BUILD_CACHE: "0" };
  NodeChildProcess.execFileSync(
    cmake,
    [
      "-S",
      fixture.directory,
      "-B",
      build,
      "-G",
      "Ninja",
      `-DCMAKE_MAKE_PROGRAM=${ninja}`,
      `-DCMAKE_PROJECT_INCLUDE=${NodePath.join(import.meta.dirname, "android-ci-cache.cmake")}`,
    ],
    { env, stdio: "pipe" },
  );
  NodeChildProcess.execFileSync(cmake, ["--build", build], { env, stdio: "pipe" });
  NodeAssert.deepEqual(fixture.compilerCalls(), []);
});
