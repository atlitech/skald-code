import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { hasPassedCheck } from "./fork-release-guard.ts";

import {
  ForkCheckError,
  upstreamCheckRuns,
  selectForkTests,
  forkTestCommands,
  forkCheck,
} from "./fork-check.ts";

const packageDirs = ["", "apps/server", "packages/shared", "scripts"];

describe("selectForkTests", () => {
  it("runs each changed test file in the closest package that has a test script", () => {
    const selection = selectForkTests(
      [
        "scripts/fork-release-guard.test.ts",
        "apps/server/src/cloud/releaseAdmission.test.ts",
        "apps/server/src/cli/recover.test.ts",
        "packages/shared/src/agentAwareness.test.ts",
        "scripts/linux-admission/probe.test.ts",
      ],
      packageDirs,
    );
    const server = selectForkTests(
      [
        "scripts/fork-release-guard.test.ts",
        "apps/server/src/cloud/releaseAdmission.test.ts",
        "packages/shared/src/agentAwareness.test.ts",
        "unowned.test.ts",
      ],
      packageDirs,
      "server",
    );
    const other = selectForkTests(
      [
        "scripts/fork-release-guard.test.ts",
        "apps/server/src/cloud/releaseAdmission.test.ts",
        "packages/shared/src/agentAwareness.test.ts",
        "unowned.test.ts",
      ],
      packageDirs,
      "other",
    );
    expect(server.groups.map((group) => group.packageDir)).toEqual(["apps/server"]);
    expect(other.groups.map((group) => group.packageDir)).toEqual(["packages/shared", "scripts"]);
    expect(server.orphans).toEqual(["unowned.test.ts"]);
    expect(other.orphans).toEqual(server.orphans);
    expect(selection).toEqual({
      groups: [
        {
          packageDir: "apps/server",
          files: ["src/cli/recover.test.ts", "src/cloud/releaseAdmission.test.ts"],
        },
        { packageDir: "packages/shared", files: ["src/agentAwareness.test.ts"] },
        {
          packageDir: "scripts",
          files: ["fork-release-guard.test.ts", "linux-admission/probe.test.ts"],
        },
      ],
      orphans: [],
    });
  });

  it("selects every extension Vitest runs", () => {
    const selection = selectForkTests(
      [
        "apps/desktop/scripts/electron-launcher.test.mjs",
        "apps/desktop/gnome-extension/captureService.test.js",
        "packages/shared/src/thing.spec.cts",
      ],
      [...packageDirs, "apps/desktop"],
    );
    expect(selection.groups).toEqual([
      {
        packageDir: "apps/desktop",
        files: ["gnome-extension/captureService.test.js", "scripts/electron-launcher.test.mjs"],
      },
      { packageDir: "packages/shared", files: ["src/thing.spec.cts"] },
    ]);
  });

  it("skips source files and vendored references", () => {
    const selection = selectForkTests(
      [
        "apps/server/src/cloud/releaseAdmission.ts",
        "docs/operations/fork-server.md",
        ".repos/effect-smol/packages/effect/test/Atom.test.ts",
      ],
      packageDirs,
    );
    expect(selection).toEqual({ groups: [], orphans: [] });
  });

  it("reports a test file no package runs instead of dropping it", () => {
    const selection = selectForkTests(
      ["apps/desktop/src/main.test.ts", "packages/shared/src/agentAwareness.test.tsx"],
      packageDirs,
    );
    expect(selection.orphans).toEqual(["apps/desktop/src/main.test.ts"]);
    expect(selection.groups).toEqual([
      { packageDir: "packages/shared", files: ["src/agentAwareness.test.tsx"] },
    ]);
  });

  it("does not match a package by a shared name prefix", () => {
    const selection = selectForkTests(["scripts-extra/thing.test.ts"], packageDirs);
    expect(selection.orphans).toEqual(["scripts-extra/thing.test.ts"]);
  });
});

it.effect("finds upstream Check when newer suites hide it from the commit endpoint", () =>
  Effect.gen(function* () {
    const checks = yield* upstreamCheckRuns("abc123", (endpoint) => {
      if (endpoint.includes("/actions/workflows/ci.yml/runs?")) {
        return Effect.succeed(JSON.stringify({ head_sha: "abc123", check_suite_id: 42 }));
      }
      if (endpoint.includes("/check-suites/42/check-runs?")) {
        return Effect.succeed(
          JSON.stringify({
            name: "Check",
            status: "completed",
            conclusion: "success",
            app: "github-actions",
          }),
        );
      }
      return Effect.succeed("");
    });
    expect(hasPassedCheck(checks)).toBe(true);
  }),
);

it.effect("rejects a passing workflow on another commit", () =>
  Effect.gen(function* () {
    const checks = yield* upstreamCheckRuns("abc123", () =>
      Effect.succeed(JSON.stringify({ head_sha: "different", check_suite_id: 42 })),
    );
    expect(hasPassedCheck(checks)).toBe(false);
  }),
);

it.effect.each(["failure", "cancelled", null])("rejects a Check with conclusion %s", (conclusion) =>
  Effect.gen(function* () {
    const checks = yield* upstreamCheckRuns("abc123", (endpoint) =>
      Effect.succeed(
        JSON.stringify(
          endpoint.includes("/actions/workflows/")
            ? { head_sha: "abc123", check_suite_id: 42 }
            : { name: "Check", status: "completed", conclusion, app: "github-actions" },
        ),
      ),
    );
    expect(hasPassedCheck(checks)).toBe(false);
  }),
);

it.effect("rejects missing CI and propagates lookup failures", () =>
  Effect.gen(function* () {
    expect(hasPassedCheck(yield* upstreamCheckRuns("abc123", () => Effect.succeed("")))).toBe(
      false,
    );
    const error = new ForkCheckError({ detail: "API unavailable" });
    expect(yield* upstreamCheckRuns("abc123", () => Effect.fail(error)).pipe(Effect.flip)).toBe(
      error,
    );
  }),
);

describe("forkTestCommands", () => {
  it("passes selected files to the default mobile run and retains the Android platform check", () => {
    const files = [
      "src/features/threads/thread-action-menu.test.ts",
      "src/lib/threadActivity.test.ts",
    ];
    expect(forkTestCommands({ packageDir: "apps/mobile", files })).toEqual([
      {
        command: "vp",
        cwd: "apps/mobile",
        args: ["test", "run", "--project", "unit", "--project", "react", ...files],
      },
      {
        command: "vp",
        cwd: "apps/mobile",
        args: [
          "test",
          "run",
          "--project",
          "react",
          "src/components/FilePreviewModal.test.tsx",
          ...files,
        ],
        env: { T3_MOBILE_TEST_PLATFORM: "android" },
      },
    ]);
    expect(forkTestCommands({ packageDir: "apps/mobile", files: [] })).toEqual([]);
  });

  it("runs only selected server files through the cache with serial execution and hit verification", () => {
    const files = ["src/cloud/releaseAdmission.test.ts", "src/cli/recover.test.ts"];
    expect(forkTestCommands({ packageDir: "apps/server", files })).toEqual([
      { command: "vp", cwd: "apps/server", args: ["run", "test", ...files] },
    ]);
    expect(
      forkTestCommands(
        { packageDir: "apps/server", files },
        { cacheServer: true, report: "/tmp/cache-report.json" },
      ),
    ).toEqual([
      {
        command: "node",
        cwd: ".",
        args: [
          "scripts/test-cached.ts",
          "--concurrency",
          "1",
          "--verify-hits",
          "1",
          "--uncached",
          "apps/server/integration/transferBudgetV2.integration.test.ts",
          "--report",
          "/tmp/cache-report.json",
          ...files.map((file) => `apps/server/${file}`),
        ],
      },
    ]);
    expect(
      forkTestCommands({ packageDir: "apps/server", files: [] }, { cacheServer: true }),
    ).toEqual([]);
  });
});

it.effect.each([false, true])(
  "propagates the selected server test result through forkCheck (cached=%s)",
  (cacheServer) =>
    Effect.gen(function* () {
      const file = "src/cloud/fixture.test.ts";
      for (const exitCode of [0, 1]) {
        let ranSelectedTest = false;
        const handle = (stdout: string, code = 0) =>
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(new TextEncoder().encode(stdout)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        const spawner = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command))
            return Effect.die(new Error("Unexpected pipeline"));
          if (command.command === "git") {
            const output: Record<string, string> = {
              fetch: "",
              "merge-base": "abc123",
              diff: `apps/server/${file}\0`,
              "ls-files": "package.json\0apps/server/package.json\0",
            };
            const operation = command.args[0];
            return Effect.succeed(
              handle(typeof operation === "string" ? (output[operation] ?? "") : ""),
            );
          }
          if (command.command === "gh") {
            const workflow = command.args.some(
              (arg) => typeof arg === "string" && arg.includes("/actions/workflows/"),
            );
            return Effect.succeed(
              handle(
                JSON.stringify(
                  workflow
                    ? { head_sha: "abc123", check_suite_id: 42 }
                    : {
                        name: "Check",
                        status: "completed",
                        conclusion: "success",
                        app: "github-actions",
                      },
                ),
              ),
            );
          }
          ranSelectedTest = command.args.includes(cacheServer ? `apps/server/${file}` : file);
          return Effect.succeed(handle("", ranSelectedTest ? exitCode : 0));
        });
        const result = yield* forkCheck({ suite: "server", cacheServer }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              readFileString: () =>
                Effect.succeed(JSON.stringify({ scripts: { test: "vp test run" } })),
            }),
          ),
          Effect.provide(Path.layer),
          Effect.result,
        );
        expect(ranSelectedTest).toBe(true);
        expect(result._tag).toBe(exitCode === 0 ? "Success" : "Failure");
        if (result._tag === "Failure")
          expect(result.failure.detail).toBe("Fork tests failed in apps/server.");
      }
    }),
);
