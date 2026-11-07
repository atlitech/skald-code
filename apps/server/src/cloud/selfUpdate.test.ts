// @effect-diagnostics nodeBuiltinImport:off - tests seed a real SQLite database and read it back.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_PROTOCOL, SERVICE_RESTART_PENDING_FILE } from "./serviceProtocol.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

interface HarnessOptions {
  readonly mode?: "web" | "desktop";
  readonly managed?: boolean;
  readonly preflight?: "ready" | "blocked";
  /** The version the staged runtime reports; the update target in each test. */
  readonly version?: string;
  /** ADMISSION.json per release version; a missing entry is a 404. */
  readonly admission?: Readonly<Record<string, string>>;
  readonly preflightDuration?: Duration.Input;
  readonly preflightStarted?: Deferred.Deferred<void>;
  readonly beforeDownload?: Effect.Effect<void>;
  readonly requestUpdate?: ServiceLauncherClient.ServiceLauncherClient["Service"]["requestUpdate"];
  readonly desktopAppUpdate?: DesktopAppUpdate.DesktopAppUpdate["Service"];
  /** An existing T3 home to update; a fresh one without a database by default. */
  readonly baseDir?: string;
  /** Called before every rename the update makes, so a test can observe or fail one. */
  readonly onRename?: (
    from: string,
    to: string,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>;
  readonly policy?: ManagedPolicyDocument;
}

const archiveBytes = new TextEncoder().encode("not really a tarball");
const archiveSha256 = Effect.promise(() => crypto.subtle.digest("SHA-256", archiveBytes)).pipe(
  Effect.map((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  ),
);
const admissionRecord = (version: string, sha256: string) =>
  JSON.stringify(
    { version, archive: `t3-${version}-linux-x64.tar.gz`, archiveSha256: sha256, checks: [] },
    null,
    2,
  );
const releaseHttpClient = (
  order: string[],
  urls: string[],
  publishedVersion: string,
  admission: Readonly<Record<string, string>> = {},
  beforeDownload?: Effect.Effect<void>,
) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      urls.push(request.url);
      const version = /\/v([^/]+)\/[^/]+$/.exec(request.url)?.[1] ?? "";
      if (request.url.endsWith("/SHA256SUMS")) {
        return HttpClientResponse.fromWeb(
          request,
          new Response(`${yield* archiveSha256}  t3-${publishedVersion}-linux-x64.tar.gz\n`),
        );
      }
      if (request.url.endsWith("/ADMISSION.json")) {
        order.push("admission");
        const record = admission[version];
        return HttpClientResponse.fromWeb(
          request,
          record === undefined ? new Response("Not Found", { status: 404 }) : new Response(record),
        );
      }
      if (beforeDownload) yield* beforeDownload;
      order.push("download");
      return HttpClientResponse.fromWeb(request, new Response(archiveBytes));
    }),
  );

const makeHarness = Effect.fn("test.make_self_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir =
    options.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-test-" }));
  const order: string[] = [];
  const onRename = options.onRename;
  const updateFs: FileSystem.FileSystem =
    onRename === undefined
      ? fs
      : {
          ...fs,
          rename: (from, to) =>
            onRename(from, to).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.andThen(fs.rename(from, to)),
            ),
        };
  const urls: string[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (input.command === "tar") {
          order.push("extract");
          const stagingDir = input.args[input.args.indexOf("-C") + 1];
          if (stagingDir === undefined) return yield* Effect.die("missing tar target");
          yield* fs.writeFileString(path.join(stagingDir, "t3"), "#!/bin/sh\n").pipe(Effect.orDie);
          return {
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }
        if (options.preflightStarted) yield* Deferred.succeed(options.preflightStarted, undefined);
        if (options.preflightDuration !== undefined) {
          // Like the real runner, fail once the caller's timeout elapses.
          const timeout = Duration.fromInputUnsafe(input.timeout ?? "60 seconds");
          const finished = yield* Effect.sleep(options.preflightDuration).pipe(
            Effect.timeoutOption(timeout),
          );
          if (finished._tag === "None") {
            return yield* new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: Duration.toMillis(timeout),
            });
          }
        }
        order.push("preflight");
        const result =
          options.preflight === "blocked"
            ? {
                status: "blocked",
                version: options.version ?? "1.1.0",
                reason: "local update required",
              }
            : {
                status: "ready",
                version: options.version ?? "1.1.0",
                launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
              };
        return {
          stdout: JSON.stringify(result),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const launcher = ServiceLauncherClient.ServiceLauncherClient.of({
    managed: options.managed ?? true,
    requestUpdate:
      options.requestUpdate ??
      (() =>
        Effect.sync(() => {
          order.push("accept");
          return "launcher-id";
        })),
    prepareTrial: Effect.undefined,
  });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const selfUpdate = yield* ServerSelfUpdate.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, launcher),
    Effect.provideService(
      DesktopAppUpdate.DesktopAppUpdate,
      options.desktopAppUpdate ?? {
        available: false,
        run: () => Effect.die("unexpected desktop app update run"),
      },
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      releaseHttpClient(
        order,
        urls,
        options.version ?? "1.1.0",
        options.admission,
        options.beforeDownload,
      ),
    ),
    Effect.provideService(FileSystem.FileSystem, updateFs),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provide(
      Layer.merge(
        ServerConfig.layer({ ...config, mode: options.mode ?? "web" }),
        ManagedPolicy.layerTest(options.policy),
      ),
    ),
  );
  return { selfUpdate, order, urls, baseDir, dbPath: config.dbPath };
});

it.layer(NodeServices.layer)("server self update", (it) => {
  it.effect("stages and preflights before asking the launcher for an update ID", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness();
      expect(yield* selfUpdate.update({ targetVersion: "1.1.0" })).toEqual({
        targetVersion: "1.1.0",
        method: "boot-service",
        updateId: "launcher-id",
      });
      expect(order).toEqual(["download", "extract", "preflight", "accept"]);
    }),
  );

  it.effect("installs a fork version whose admission record names the archive", () =>
    Effect.gen(function* () {
      const version = "0.0.47-atli.1";
      const { selfUpdate, order } = yield* makeHarness({
        version,
        admission: { [version]: admissionRecord(version, yield* archiveSha256) },
      });
      expect((yield* selfUpdate.update({ targetVersion: version })).targetVersion).toBe(version);
      expect(order).toEqual(["admission", "download", "extract", "preflight", "accept"]);
    }),
  );

  it.effect.each([
    ["no admission record", "0.0.47-atli.1", undefined, "has no admission record"],
    // The owner override is `t3 update`'s alone; in-app updates never skip admission.
    ["a pre-admission version", "0.0.46-atli.2", undefined, "has no admission record"],
    [
      "a record for another archive digest",
      "0.0.47-atli.1",
      "0".repeat(64),
      "is not the archive its admission record admitted",
    ],
  ] as const)("refuses a fork version with %s before downloading it", ([, version, sha, reason]) =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness({
        version,
        admission: sha === undefined ? {} : { [version]: admissionRecord(version, sha) },
      });
      const error = yield* selfUpdate.update({ targetVersion: version }).pipe(Effect.flip);
      expect(error.reason).toContain(reason);
      expect(order).toEqual(["admission"]);
    }),
  );

  // regression: #5181 make remote updates rollback-safe
  it.effect("rejects invalid versions and desktop-managed servers before staging", () =>
    Effect.gen(function* () {
      const web = yield* makeHarness();
      expect(
        (yield* web.selfUpdate.update({ targetVersion: "latest" }).pipe(Effect.flip)).reason,
      ).toBe("'latest' is not an exact t3 version.");
      const desktop = yield* makeHarness({ mode: "desktop" });
      expect(
        (yield* desktop.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
      ).toContain("desktop app");
      expect([...web.order, ...desktop.order]).toEqual([]);
    }),
  );

  it.effect("refuses every update when the managed policy turns updates off", () =>
    Effect.gen(function* () {
      const policy: ManagedPolicyDocument = {
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { updates: { mode: "off" } },
      };
      const service = yield* makeHarness({ policy });
      const desktop = yield* makeHarness({
        mode: "desktop",
        policy,
        desktopAppUpdate: {
          available: true,
          run: () => Effect.die("unexpected desktop app update run"),
          commit: () => Effect.never,
        },
      });
      for (const harness of [service, desktop]) {
        expect(
          (yield* harness.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
        ).toBe("Example Corp manages T3 Code updates.");
      }
      expect([...service.order, ...desktop.order]).toEqual([]);
    }),
  );

  it.effect("lets a user start an update, but only to stable without nightly", () =>
    Effect.gen(function* () {
      const { selfUpdate, order, urls } = yield* makeHarness({
        policy: {
          schemaVersion: 1,
          organization: "Example Corp",
          limits: {
            updates: {
              mode: "auto",
              allowNightly: false,
              feedUrl: "https://updates.example.com/t3code/",
            },
          },
        },
      });
      expect(
        (yield* selfUpdate.update({ targetVersion: "1.2.0-nightly.20261028.1" }).pipe(Effect.flip))
          .reason,
      ).toBe("Example Corp manages T3 Code updates. Only stable releases can be installed.");
      expect(order).toEqual([]);
      // The mirror lists only 1.1.0's archive.
      expect((yield* selfUpdate.update({ targetVersion: "1.2.0" }).pipe(Effect.flip)).reason).toBe(
        "Example Corp's update mirror has no t3@1.2.0 for this machine.",
      );
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" })).updateId).toBe("launcher-id");
      // The release comes from the policy's mirror, not GitHub.
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls)
        expect(url).toMatch(/^https:\/\/updates\.example\.com\/t3code\/v1\.[12]\.0\//);
    }),
  );

  it.effect("delegates desktop-managed updates to the desktop app when available", () =>
    Effect.gen(function* () {
      const stages: string[] = [];
      const { selfUpdate, order } = yield* makeHarness({
        mode: "desktop",
        desktopAppUpdate: {
          available: true,
          run: (reportProgress) =>
            reportProgress("downloading").pipe(
              Effect.andThen(reportProgress("installing")),
              Effect.as({ targetVersion: "1.2.0", method: "desktop-app" as const }),
            ),
          commit: () => Effect.never,
        },
      });
      const result = yield* selfUpdate.update({ targetVersion: "1.1.0" }, (stage) =>
        Effect.sync(() => void stages.push(stage)),
      );
      expect(result).toEqual({ targetVersion: "1.2.0", method: "desktop-app" });
      expect(stages).toEqual(["downloading", "installing"]);
      expect(order).toEqual([]);
    }),
  );

  it.effect("allows only one update at a time", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<string>();
      const { selfUpdate } = yield* makeHarness({
        requestUpdate: () =>
          Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
      });
      const first = yield* Effect.forkChild(selfUpdate.update({ targetVersion: "1.1.0" }), {
        startImmediately: true,
      });
      yield* Deferred.await(requested);
      expect((yield* selfUpdate.update({ targetVersion: "1.1.1" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
      yield* Deferred.succeed(accepted, "launcher-id");
      expect((yield* Fiber.join(first)).updateId).toBe("launcher-id");
    }),
  );

  // regression: #28198 a slow staged preflight on a loaded host no longer fails the update
  it.effect("waits for a staged preflight that takes a minute on a loaded host", () =>
    Effect.gen(function* () {
      const preflightStarted = yield* Deferred.make<void>();
      const { selfUpdate, order } = yield* makeHarness({
        preflightDuration: "60 seconds",
        preflightStarted,
      });
      const update = yield* Effect.forkChild(selfUpdate.update({ targetVersion: "1.1.0" }), {
        startImmediately: true,
      });
      yield* Deferred.await(preflightStarted);
      yield* TestClock.adjust("60 seconds");
      const exit = yield* Fiber.await(update);
      expect(exit._tag === "Failure" ? String(exit.cause) : "launcher handoff").toBe(
        "launcher handoff",
      );
      expect(order).toEqual(["download", "extract", "preflight", "accept"]);
    }),
  );

  it.effect("keeps preparing after the progress stream closes", () =>
    Effect.gen(function* () {
      const releaseDownload = yield* Deferred.make<void>();
      const sawDownloading = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<void>();
      const { selfUpdate, order } = yield* makeHarness({
        beforeDownload: Deferred.await(releaseDownload),
        requestUpdate: () =>
          Effect.sync(() => {
            order.push("accept");
          }).pipe(Effect.andThen(Deferred.succeed(accepted, undefined)), Effect.as("launcher-id")),
      });

      const consumed = yield* ServerSelfUpdate.updateProgressStream(selfUpdate, {
        targetVersion: "1.1.0",
      }).pipe(
        Stream.tap((event) =>
          event.type === "progress" && event.stage === "downloading"
            ? Deferred.succeed(sawDownloading, undefined)
            : Effect.void,
        ),
        Stream.runDrain,
        Effect.forkChild,
      );

      yield* Deferred.await(sawDownloading);
      yield* Fiber.interrupt(consumed);
      expect((yield* selfUpdate.update({ targetVersion: "1.2.0" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );

      yield* Deferred.succeed(releaseDownload, undefined);
      yield* Deferred.await(accepted);
      expect(order).toEqual(["download", "extract", "preflight", "accept"]);
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
    }),
  );
});

const fileSha256 = (filePath: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(filePath)).digest("hex");
// The in-app update runs inside the service's server, so the running version is this build's.
const SERVICE_VERSION = packageJson.version;
const SERVICE_ARCHIVE_SHA256 = "cd".repeat(32);
const SERVICE_STATE = `${JSON.stringify({ protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: SERVICE_VERSION })}\n`;

/**
 * restartPendingVersion models a deferred restart: service state names the new runtime
 * while the old server still owns the database.
 */
const makeHomeWithDatabase = Effect.fn("test.make_self_update_home")(function* (options: {
  readonly serviceState: boolean;
  readonly database?: "sqlite" | "garbage";
  readonly restartPendingVersion?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-home-" });
  const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  if (options.database === "garbage") {
    yield* fs.writeFileString(dbPath, "this is not a SQLite database\n".repeat(64));
  } else {
    const database = new NodeSqlite.DatabaseSync(dbPath);
    database.exec("create table notes (value text); insert into notes values ('kept');");
    database.close();
  }
  const fromVersion = SERVICE_VERSION;
  const fromRuntime = path.join(baseDir, "runtime", "versions", fromVersion);
  yield* fs.makeDirectory(fromRuntime, { recursive: true });
  yield* fs.writeFileString(path.join(fromRuntime, "t3"), "#!/bin/sh\n");
  const serviceStatePath = path.join(baseDir, "runtime", "service-state.json");
  if (options.serviceState) {
    yield* fs.writeFileString(
      path.join(fromRuntime, ".archive-sha256"),
      `${SERVICE_ARCHIVE_SHA256}\n`,
    );
    yield* fs.writeFileString(
      serviceStatePath,
      options.restartPendingVersion === undefined
        ? SERVICE_STATE
        : `${JSON.stringify({ protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: options.restartPendingVersion })}\n`,
    );
    if (options.restartPendingVersion !== undefined) {
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", SERVICE_RESTART_PENDING_FILE),
        `${options.restartPendingVersion}\n`,
      );
    }
  }
  const displacedPath = path.join(
    baseDir,
    "recovery/displaced/19700101T000000000Z-earlier/statev2.sqlite",
  );
  yield* fs.makeDirectory(path.dirname(displacedPath), { recursive: true });
  yield* fs.writeFileString(displacedPath, "an earlier database\n");
  return {
    baseDir,
    dbPath,
    fromVersion,
    fromRuntime,
    serviceStatePath,
    displacedPath,
    pointsDir: path.join(baseDir, "recovery", "points"),
  };
});

it.layer(NodeServices.layer)("server self update backup retention", (it) => {
  it.effect.each([false, true])(
    "updates without touching recovery storage (existing: %s)",
    (existing) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* makeHomeWithDatabase({ serviceState: true });
        if (existing) yield* fs.writeFileString(home.pointsDir, "legacy recovery storage");
        const before = fileSha256(home.dbPath);
        const { selfUpdate, order } = yield* makeHarness({ baseDir: home.baseDir });
        yield* selfUpdate.update({ targetVersion: "1.1.0" });
        expect(order).toEqual(["download", "extract", "preflight", "accept"]);
        if (existing)
          expect(yield* fs.readFileString(home.pointsDir)).toBe("legacy recovery storage");
        else expect(yield* fs.exists(home.pointsDir)).toBe(false);
        expect(fileSha256(home.dbPath)).toBe(before);
        expect(yield* fs.readFileString(home.displacedPath)).toBe("an earlier database\n");
      }),
  );
});

it.layer(NodeServices.layer)("pruning runtimes on start", (it) => {
  const staleVersion = "0.0.1";
  const otherProcesses = ProcessRunner.ProcessRunner.of({
    run: () =>
      Effect.succeed({
        stdout: "p42\nftxt\nn/bin/sh\n",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });

  const pruneOnStart = Effect.fn("test.prune_on_start")(function* (input: {
    readonly executable: "own runtime" | "elsewhere";
    readonly managed?: boolean;
    readonly symlinkedHome?: boolean;
    readonly updateStatus?: "committed" | "pending" | "rolled-back";
    readonly activeVersion?: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-prune-on-start-" });
    const realHome = path.join(tempDir, "home");
    const baseDir = input.symlinkedHome ? path.join(tempDir, "linked-home") : realHome;
    const versionsDir = path.join(baseDir, "runtime", "versions");
    yield* TestClock.setTime(24 * 60 * 60 * 1000);
    for (const version of [staleVersion, packageJson.version]) {
      const directory = path.join(realHome, "runtime", "versions", version);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "t3"), "");
      const sentinel = path.join(directory, ".install-complete");
      yield* fs.writeFileString(sentinel, `${version}\n`);
      yield* fs.utimes(sentinel, 0, 0);
    }
    if (input.symlinkedHome) yield* fs.symlink(realHome, baseDir);
    const launcher = path.join(tempDir, "bin", "t3");
    if (input.updateStatus !== undefined) {
      yield* fs.makeDirectory(path.dirname(launcher));
      yield* fs.symlink(path.join(versionsDir, staleVersion, "t3"), launcher);
      yield* fs.writeFileString(path.join(baseDir, "runtime", "launchers"), `${launcher}\n`);
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", "service-state.json"),
        JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion:
            input.updateStatus === "pending"
              ? staleVersion
              : (input.activeVersion ?? packageJson.version),
          update: {
            id: "update-1",
            fromVersion: input.updateStatus === "rolled-back" ? packageJson.version : staleVersion,
            targetVersion:
              input.updateStatus === "rolled-back"
                ? "99.0.0"
                : (input.activeVersion ?? packageJson.version),
            status: input.updateStatus,
            ...(input.updateStatus === "pending" ? { dbPath: "/unused.sqlite" } : {}),
          },
        }),
      );
    }
    // Like `process.execPath`, the running runtime is reported by its real path.
    const executablePath =
      input.executable === "own runtime"
        ? yield* fs.realPath(path.join(versionsDir, packageJson.version, "t3"))
        : "/usr/local/bin/node";
    const removed = yield* ServerSelfUpdate.pruneRuntimesOnStart({
      baseDir,
      managed: input.managed ?? false,
    }).pipe(
      Effect.provideService(HostProcess.ExecutablePath, executablePath),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(HostProcess.HomeDirectory, tempDir),
      Effect.provideService(ProcessRunner.ProcessRunner, otherProcesses),
    );
    return {
      removed,
      remaining: (yield* fs.readDirectory(versionsDir)).toSorted(),
      launcherTarget: yield* fs.readLink(launcher).pipe(Effect.orElseSucceed(() => undefined)),
      expectedTarget: path.join(versionsDir, packageJson.version, "t3"),
    };
  });

  // The SSH launcher runs `t3 serve` straight from the pinned runtime, with no boot service.
  it.effect("prunes for a server started from its home's pinned runtime", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({ executable: "own runtime" });
      expect(removed).toEqual([staleVersion]);
      expect(remaining).toEqual([packageJson.version]);
    }),
  );

  it.effect("recognizes its runtime through a symlinked T3 home", () =>
    Effect.gen(function* () {
      const { removed } = yield* pruneOnStart({ executable: "own runtime", symlinkedHome: true });
      expect(removed).toEqual([staleVersion]);
    }),
  );

  it.effect("prunes for a boot-service server wherever it runs from", () =>
    Effect.gen(function* () {
      const { removed } = yield* pruneOnStart({ executable: "elsewhere", managed: true });
      expect(removed).toEqual([staleVersion]);
    }),
  );

  it.effect.each(["committed", "rolled-back"] as const)(
    "synchronizes recorded shell launchers with the active runtime after %s",
    (updateStatus) =>
      Effect.gen(function* () {
        const { launcherTarget, expectedTarget } = yield* pruneOnStart({
          executable: "own runtime",
          managed: true,
          updateStatus,
          symlinkedHome: true,
        });
        expect(launcherTarget).toBe(expectedTarget);
      }),
  );

  it.effect.each([
    { managed: true, updateStatus: "pending" as const },
    { managed: false, updateStatus: "committed" as const },
    { managed: true, updateStatus: "committed" as const, activeVersion: "99.0.0" },
  ])(
    "leaves shell launchers alone unless this is the active managed runtime ($managed, $updateStatus, $activeVersion)",
    (input) =>
      Effect.gen(function* () {
        const { launcherTarget, expectedTarget } = yield* pruneOnStart({
          executable: "own runtime",
          ...input,
        });
        expect(launcherTarget).not.toBe(expectedTarget);
      }),
  );

  it.effect("leaves runtimes alone for an unmanaged server started elsewhere", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({ executable: "elsewhere" });
      expect(removed).toEqual([]);
      expect(remaining).toEqual([staleVersion, packageJson.version].toSorted());
    }),
  );
});

it("a host crosses tracks only to a release that knows its whole database", () => {
  const cross = (
    serverVersion: string,
    targetVersion: string,
    targetDatabaseMigration: number | undefined,
    databaseMigration = 72,
  ) =>
    ServerSelfUpdate.trackSwitchBlockReason({
      serverVersion,
      targetVersion,
      targetDatabaseMigration,
      databaseMigration: () => databaseMigration,
    });
  const nightly = "0.1.4-nightly.20261027.3796";

  expect(cross(nightly, "0.1.4", 72)).toBeNull();
  // Another client moved this host to a newer Nightly after the switch was planned.
  expect(cross(nightly, "0.1.4", 72, 73)).toContain("does not support yet");
  expect(cross(nightly, "0.1.4", undefined)).toContain("Cannot confirm");
  // A Stable tag can carry a migration the latest Nightly lacks.
  expect(cross("0.1.4", nightly, 72, 73)).toContain("does not support yet");
  expect(cross("0.1.3", "0.1.4", undefined)).toBeNull();
  // A database that exists but cannot be read proves nothing.
  expect(
    ServerSelfUpdate.trackSwitchBlockReason({
      serverVersion: nightly,
      targetVersion: "0.1.4",
      targetDatabaseMigration: 72,
      databaseMigration: () => undefined,
    }),
  ).toContain("Cannot confirm");
});
