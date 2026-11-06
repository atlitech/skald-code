// @effect-diagnostics nodeBuiltinImport:off - Reads CI workflows and executes the aggregate gate.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// Fork Check validates upstream CI and fork tests on PRs and atli pushes.
// Release requires the push Check plus the full suite on the released commit.
const read = (file: string) =>
  NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "..", ".github", "workflows", file),
    "utf8",
  );
const workflow = read("fork-ci.yml");
const fullSuite = read("fork-full-suite.yml");
const lines = workflow.split("\n");

const job = (name: string): ReadonlyArray<string> => {
  const start = lines.indexOf(`  ${name}:`);
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[\w-]+:$/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
};

const gateCommand = (body: ReadonlyArray<string>) => {
  const start = body.findIndex((line) => /^ {8}run:/.test(line));
  expect(start).toBeGreaterThan(-1);
  const command = body[start]!.slice("        run: ".length);
  if (command !== "|") return command;
  const script: string[] = [];
  for (const line of body.slice(start + 1)) {
    if (line.trim().length > 0 && !line.startsWith("          ")) break;
    script.push(line.slice(10));
  }
  return script.join("\n");
};

const triggerBranches = (event: "pull_request" | "push"): ReadonlyArray<string> => {
  const start = lines.indexOf(`  ${event}:`);
  expect(start).toBeGreaterThan(-1);
  const block: Array<string> = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^ {4}/.test(line)) break;
    block.push(line);
  }
  const branchesAt = block.indexOf("    branches:");
  expect(branchesAt).toBeGreaterThan(-1);
  return block
    .slice(branchesAt + 1)
    .map((line) => /^ {6}- (\S+)\s*$/.exec(line)?.[1])
    .filter((branch): branch is string => branch !== undefined);
};

const runners = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(/^ {4}runs-on: (.+)$/gm)].flatMap((match) => {
    const value = match[1]!.trim();
    const profile =
      /^\$\{\{ inputs\.runner-profile == 'github' && '([^']+)' \|\| '([^']+)' \}\}$/.exec(value);
    return profile ? [profile[1]!, profile[2]!] : [value];
  });

describe("fork CI workflow", () => {
  it("runs on pull requests into atli only", () => {
    expect(triggerBranches("pull_request")).toEqual(["atli"]);
  });

  it("runs on pushes to atli only", () => {
    expect(triggerBranches("push")).toEqual(["atli"]);
  });

  it.each(["success", "failure", "cancelled", "skipped"])(
    "makes the required Check reject a prerequisite unless it succeeded (%s)",
    (result) => {
      const gate = job("check");
      const gateText = gate.join("\n");
      expect(gateText).toMatch(/^ {4}name: Check$/m);
      expect(gateText).toMatch(/if:.*always\(\).*github\.repository == 'atlitech\/t3code'/);
      expect(gateText).toContain("NEEDS: ${{ toJSON(needs) }}");
      const prerequisites = /^ {4}needs: \[([^\]]+)\]$/m
        .exec(gateText)?.[1]
        ?.split(",")
        .map((name) => name.trim());
      const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
      const allPrerequisites = [...jobs.matchAll(/^ {2}([\w-]+):$/gm)]
        .map((match) => match[1]!)
        .filter((name) => name !== "check");
      expect(prerequisites?.toSorted()).toEqual(allPrerequisites.toSorted());
      expect(allPrerequisites.length).toBeGreaterThan(0);
      for (const changed of allPrerequisites) {
        const needs = Object.fromEntries(
          allPrerequisites.map((name) => [name, { result: name === changed ? result : "success" }]),
        );
        const completed = NodeChildProcess.spawnSync(
          "bash",
          ["-e", "-o", "pipefail", "-c", gateCommand(gate)],
          {
            env: { ...process.env, NEEDS: JSON.stringify(needs) },
            encoding: "utf8",
          },
        );
        expect(completed.error).toBeUndefined();
        expect(completed.status === 0, `${changed}: ${result}: ${completed.stderr}`).toBe(
          result === "success",
        );
      }
    },
  );

  it("checks out history so the fork check can find the upstream commit", () => {
    expect(workflow).toMatch(/fetch-depth: 0\n\s+filter: blob:none/);
  });

  it("runs the fork check, lint, and typecheck", () => {
    expect(job("tests").join("\n")).toMatch(/node scripts\/fork-check\.ts --suite other(?:\s|$)/);
    const server = job("server").join("\n");
    expect(server).toMatch(/node scripts\/fork-check\.ts --suite server(?:\s|$)/);
    expect(server).toMatch(/shard: \[1, 2\]/);
    expect(server).toMatch(/--shard \$\{\{ matrix\.shard \}\}\/2/);
    expect(server).toContain("fail-fast: false");
    expect(job("static").join("\n")).toMatch(/run: vp check\n/);
    expect(job("static").join("\n")).toMatch(/run: vpr typecheck(?:\n|$)/);
  });

  it("tests the web client as releases build it", () => {
    expect(fullSuite).toMatch(
      /run: env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY vp run --filter @t3tools\/web test$/m,
    );
  });

  it("runs every fork CI job on an Ubuntu runner", () => {
    for (const text of [workflow, fullSuite]) {
      const found = runners(text);
      expect(found.length).toBeGreaterThan(0);
      for (const runner of found)
        expect(runner).toMatch(/^(ubuntu-\d{2}\.\d{2}|blacksmith-\d+vcpu-ubuntu-\d{4})$/);
    }
  });
});
