#!/usr/bin/env node

// Requires passing upstream CI, then runs fork-changed tests in their owning packages.
// See docs/operations/fork-server.md.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { hasPassedCheck, REQUIRED_CHECK } from "./fork-release-guard.ts";
import { shardedTestFiles } from "./lib/sharded-tests.ts";

const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
// Vitest's default include, so no extension a package runs is skipped.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

type ForkSuite = "all" | "server" | "other";

interface ForkCheckOptions {
  readonly suite?: ForkSuite;
  readonly shard?: string;
  readonly cacheServer?: boolean;
  readonly report?: string;
}

interface ForkTestCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Record<string, string>;
}

export interface ForkTestGroup {
  /** Repository-relative package directory, where `vp run test` runs. */
  readonly packageDir: string;
  /** Test files relative to the package directory. */
  readonly files: ReadonlyArray<string>;
}

export interface ForkTestSelection {
  readonly groups: ReadonlyArray<ForkTestGroup>;
  /** Changed test files no package's `test` script runs. */
  readonly orphans: ReadonlyArray<string>;
}

/**
 * Groups changed test files under the closest package directory that has a
 * `test` script. `packageDirs` are repository-relative, "" for the root.
 */
export const selectForkTests = (
  changedPaths: ReadonlyArray<string>,
  packageDirs: ReadonlyArray<string>,
  suite: ForkSuite = "all",
): ForkTestSelection => {
  const byDepth = [...packageDirs].toSorted((left, right) => right.length - left.length);
  const groups = new Map<string, Array<string>>();
  const orphans: Array<string> = [];
  for (const path of changedPaths) {
    if (!TEST_FILE.test(path) || path.startsWith(".repos/")) continue;
    const packageDir = byDepth.find((dir) => dir !== "" && path.startsWith(`${dir}/`));
    if (packageDir === undefined) {
      orphans.push(path);
      continue;
    }
    const files = groups.get(packageDir) ?? [];
    files.push(path.slice(packageDir.length + 1));
    groups.set(packageDir, files);
  }
  return {
    groups: [...groups.entries()]
      .filter(([dir]) => suite === "all" || (dir === "apps/server") === (suite === "server"))
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([packageDir, files]) => ({ packageDir, files: files.toSorted() })),
    orphans: orphans.toSorted(),
  };
};

export function forkTestCommands(
  group: ForkTestGroup,
  options: Pick<ForkCheckOptions, "cacheServer" | "report"> = {},
): ReadonlyArray<ForkTestCommand> {
  if (group.files.length === 0) return [];
  if (group.packageDir === "apps/mobile") {
    // Appending files to the package's chained test script only filters its final Android command.
    return [
      {
        command: "vp",
        args: ["test", "run", "--project", "unit", "--project", "react", ...group.files],
        cwd: group.packageDir,
      },
      {
        command: "vp",
        args: [
          "test",
          "run",
          "--project",
          "react",
          ...new Set(["src/components/FilePreviewModal.test.tsx", ...group.files]),
        ],
        cwd: group.packageDir,
        env: { T3_MOBILE_TEST_PLATFORM: "android" },
      },
    ];
  }
  if (group.packageDir === "apps/server" && options.cacheServer) {
    return [
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
          ...(options.report ? ["--report", options.report] : []),
          ...group.files.map((file) => `${group.packageDir}/${file}`),
        ],
      },
    ];
  }
  return [{ command: "vp", args: ["run", "test", ...group.files], cwd: group.packageDir }];
}

export class ForkCheckError extends Schema.TaggedError<ForkCheckError>()("ForkCheckError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const spawnFailed = (command: string) => (cause: unknown) =>
  new ForkCheckError({ detail: `${command} failed to run`, cause });

/** Runs a command and returns its stdout, failing on a non-zero exit. */
const read = Effect.fn("ForkCheck.read")(
  function* (command: string, args: ReadonlyArray<string>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make(command, args));
    return yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
  },
  Effect.scoped,
  (effect, command, args) =>
    effect.pipe(
      Effect.mapError(spawnFailed(command)),
      Effect.flatMap(([stdout, stderr, exitCode]) =>
        exitCode === 0
          ? Effect.succeed(stdout)
          : Effect.fail(
              new ForkCheckError({
                detail: `${command} ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`,
              }),
            ),
      ),
    ),
);

/** Runs a command in `cwd` with its output streamed to this process's own; returns the exit code. */
const runInherited = Effect.fn("ForkCheck.runInherited")(
  function* ({ command, args, cwd, env }: ForkTestCommand) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        cwd,
        env,
        extendEnv: true,
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    return Number(yield* child.exitCode);
  },
  Effect.scoped,
  (effect, { command }) => effect.pipe(Effect.mapError(spawnFailed(command))),
);

const CheckRunLine = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    status: Schema.String,
    conclusion: Schema.NullOr(Schema.String),
    app: Schema.NullOr(Schema.String),
  }),
);
const decodeCheckRunLine = Schema.decodeEffect(CheckRunLine);

/** The newest upstream commit HEAD contains. */
const upstreamBase = Effect.gen(function* () {
  yield* read("git", [
    "fetch",
    "--quiet",
    "--no-tags",
    "--filter=blob:none",
    `https://github.com/${UPSTREAM_REPOSITORY}.git`,
    "main",
  ]);
  return (yield* read("git", ["merge-base", "HEAD", "FETCH_HEAD"])).trim();
});

const githubApi = (endpoint: string, jq: string) =>
  read("gh", ["api", "--paginate", endpoint, "--jq", jq]);

export const upstreamCheckRuns = Effect.fn("upstreamCheckRuns")(function* <R>(
  sha: string,
  api: (endpoint: string, jq: string) => Effect.Effect<string, ForkCheckError, R>,
) {
  // The commit endpoint only searches the newest 1,000 suites; busy upstream
  // commits can lose their CI result behind unrelated automation runs.
  const runs = yield* api(
    `repos/${UPSTREAM_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&event=push&per_page=100`,
    ".workflow_runs[] | {head_sha, check_suite_id}",
  );
  const decodeRun = Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        head_sha: Schema.String,
        check_suite_id: Schema.Number,
      }),
    ),
  );
  const suites = new Set<number>();
  for (const line of runs.split("\n").filter((line) => line.trim().length > 0)) {
    const run = yield* decodeRun(line).pipe(
      Effect.mapError((cause) => new ForkCheckError({ detail: "unreadable workflow run", cause })),
    );
    if (run.head_sha === sha) suites.add(run.check_suite_id);
  }
  const checks = yield* Effect.forEach([...suites], (suite) =>
    Effect.gen(function* () {
      const stdout = yield* api(
        `repos/${UPSTREAM_REPOSITORY}/check-suites/${suite}/check-runs?check_name=${REQUIRED_CHECK}&filter=all&per_page=100`,
        ".check_runs[] | {name, status, conclusion, app: .app.slug}",
      );
      return yield* Effect.forEach(
        stdout.split("\n").filter((line) => line.trim().length > 0),
        (line) =>
          decodeCheckRunLine(line).pipe(
            Effect.mapError(
              (cause) => new ForkCheckError({ detail: "unreadable check run", cause }),
            ),
          ),
      );
    }),
  );
  return checks.flat();
});

const PackageScripts = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
);
const decodePackageScripts = Schema.decodeEffect(PackageScripts);

/** Repository-relative directories of the tracked packages that have a `test` script. */
const testedPackageDirs = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const manifests = (yield* read("git", [
    "ls-files",
    "-z",
    "--",
    "package.json",
    "**/package.json",
  ]))
    .split("\0")
    .filter((path) => path.length > 0 && !path.startsWith(".repos/"));
  const dirs = yield* Effect.forEach(manifests, (manifest) =>
    fs.readFileString(manifest).pipe(
      Effect.flatMap(decodePackageScripts),
      Effect.map((pkg) =>
        pkg.scripts?.test === undefined ? undefined : manifest.slice(0, -"package.json".length),
      ),
      Effect.mapError((cause) => new ForkCheckError({ detail: `unreadable ${manifest}`, cause })),
    ),
  );
  return dirs
    .filter((dir): dir is string => dir !== undefined)
    .map((dir) => dir.replace(/\/$/, ""));
});

export const forkCheck = Effect.fn("forkCheck")(function* (options: ForkCheckOptions = {}) {
  if ((options.shard || options.cacheServer) && options.suite !== "server") {
    return yield* new ForkCheckError({
      detail: "--shard and --cache-server require --suite server.",
    });
  }
  if (options.report && !options.cacheServer) {
    return yield* new ForkCheckError({ detail: "--report requires --cache-server." });
  }
  const base = yield* upstreamBase;
  yield* Effect.log(`Built on upstream ${UPSTREAM_REPOSITORY}@${base}.`);

  if (!hasPassedCheck(yield* upstreamCheckRuns(base, githubApi))) {
    return yield* new ForkCheckError({
      detail: `Upstream ${base} has no successful ${REQUIRED_CHECK} run. Merge an upstream commit whose CI passed.`,
    });
  }
  yield* Effect.log(`Upstream ${base} passed its ${REQUIRED_CHECK}.`);

  // -z: raw paths, NUL-separated; without it git quotes unusual ones.
  const changed = (yield* read("git", [
    "diff",
    "-z",
    "--name-only",
    "--diff-filter=d",
    base,
    "HEAD",
  ]))
    .split("\0")
    .filter((path) => path.length > 0);
  const selection = selectForkTests(changed, yield* testedPackageDirs, options.suite);
  if (selection.orphans.length > 0) {
    return yield* new ForkCheckError({
      detail: `No package runs these fork test files: ${selection.orphans.join(", ")}`,
    });
  }

  const failed: Array<string> = [];
  for (const group of selection.groups) {
    const path = yield* Path.Path;
    const root = path.resolve(group.packageDir);
    const files = options.shard
      ? (yield* Effect.tryPromise({
          try: () => shardedTestFiles(root, options.shard!, group.files),
          catch: (cause) =>
            new ForkCheckError({ detail: `Could not discover shard ${options.shard}.`, cause }),
        })).map((file) => path.relative(root, file).replaceAll("\\", "/"))
      : group.files;
    yield* Effect.log(
      `${group.packageDir}: ${files.length} fork test file(s)${options.shard ? ` in shard ${options.shard}` : ""}.`,
    );
    for (const testCommand of forkTestCommands({ ...group, files }, options)) {
      const exitCode = yield* runInherited(testCommand);
      if (exitCode !== 0) {
        failed.push(group.packageDir);
        break;
      }
    }
  }
  if (failed.length > 0) {
    return yield* new ForkCheckError({ detail: `Fork tests failed in ${failed.join(", ")}.` });
  }
});

const command = Command.make(
  "fork-check",
  {
    suite: Flag.Literals("suite", ["all", "server", "other"]).pipe(Flag.withDefault("all")),
    shard: Flag.String("shard").pipe(Flag.optional),
    cacheServer: Flag.Boolean("cache-server").pipe(Flag.withDefault(false)),
    report: Flag.String("report").pipe(Flag.optional),
  },
  (input) =>
    forkCheck({
      suite: input.suite,
      cacheServer: input.cacheServer,
      ...Option.match(input.shard, { onNone: () => ({}), onSome: (shard) => ({ shard }) }),
      ...Option.match(input.report, { onNone: () => ({}), onSome: (report) => ({ report }) }),
    }),
).pipe(Command.withDescription("Check the fork's changes on top of a green upstream commit."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
