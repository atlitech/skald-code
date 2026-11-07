// @effect-diagnostics nodeBuiltinImport:off - Reads every committed workflow as text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// Signing access is restricted to manual fork releases and their guarded delivery workflow.
// Mac signing files stay under RUNNER_TEMP; EAS manages the mobile signing material.
const WORKFLOWS_DIR = NodePath.join(import.meta.dirname, "..", ".github", "workflows");
const RELEASE_WORKFLOW = "fork-server-release.yml";
const DELIVERY_WORKFLOW = "fork-mobile-delivery.yml";
const SIGNING_MARKERS = [
  "EXPO_OTA_TOKEN",
  "personal-android-signing",
  "T3CODE_PERSONAL_ANDROID",
  "GOOGLE_SERVICES_JSON_BASE64",
  "personal-ios-signing",
  "T3CODE_IOS_",
  "personal-macos-signing",
  "T3CODE_PERSONAL_MACOS",
] as const;
const PULL_REQUEST_TRIGGERS = new Set(["pull_request", "pull_request_target"]);

const workflows: ReadonlyMap<string, string> = new Map(
  NodeFS.readdirSync(WORKFLOWS_DIR)
    .filter((file) => /\.ya?ml$/.test(file))
    .toSorted()
    .map((file) => [file, NodeFS.readFileSync(NodePath.join(WORKFLOWS_DIR, file), "utf8")]),
);

const stripComment = (value: string): string => value.replace(/\s+#.*$/, "").trim();
const unquote = (value: string): string => value.replace(/^["']|["']$/g, "");

/** The events of a workflow's top-level `on:`, in its scalar, list, or mapping form. */
const triggersOf = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^["']?on["']?\s*:/.test(line));
  if (start === -1) return [];
  const inline = stripComment(lines[start]!.replace(/^["']?on["']?\s*:/, ""));
  if (inline.length > 0) {
    return (/^\[(.*)\]$/.exec(inline)?.[1] ?? inline)
      .split(",")
      .map((event) => unquote(event.trim()))
      .filter((event) => event.length > 0);
  }
  const block: Array<string> = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    block.push(line);
  }
  const indent = /^(\s*)/.exec(block[0] ?? "")?.[1]?.length ?? 0;
  return block
    .filter((line) => /^(\s*)/.exec(line)![1]!.length === indent)
    .map((line) => {
      const entry = stripComment(line).replace(/^-\s*/, "");
      return unquote(entry.replace(/\s*:.*$/, ""));
    })
    .filter((event) => event.length > 0);
};

const mentionsSigning = (text: string): boolean =>
  SIGNING_MARKERS.some((marker) => text.includes(marker));

describe("fork workflow signing isolation", () => {
  it("reads the trigger events of every workflow", () => {
    expect(workflows.size).toBeGreaterThan(0);
    for (const [file, text] of workflows) expect(triggersOf(text), file).not.toEqual([]);
    expect(triggersOf("on: push\n")).toEqual(["push"]);
    expect(triggersOf("on: [push, pull_request]\n")).toEqual(["push", "pull_request"]);
    expect(triggersOf('"on":\n  - push\n  - pull_request_target\n')).toEqual([
      "push",
      "pull_request_target",
    ]);
    expect(
      triggersOf("on:\n  # comment\n  pull_request:\n    branches:\n      - atli\n  push:\n"),
    ).toEqual(["pull_request", "push"]);
  });

  it("names the signing environment in no workflow a pull request triggers", () => {
    const pullRequestWorkflows = [...workflows].filter(([, text]) =>
      triggersOf(text).some((event) => PULL_REQUEST_TRIGGERS.has(event)),
    );
    expect(pullRequestWorkflows.length).toBeGreaterThan(0);
    for (const [file, text] of pullRequestWorkflows) {
      for (const marker of SIGNING_MARKERS) expect(text, file).not.toContain(marker);
    }
  });

  it("allows signing only for the manual release and explicitly guarded delivery", () => {
    const mentioning = [...workflows]
      .filter(([, text]) => mentionsSigning(text))
      .map(([file]) => file);
    expect(mentioning).toEqual([DELIVERY_WORKFLOW, RELEASE_WORKFLOW]);
    expect(triggersOf(workflows.get(RELEASE_WORKFLOW)!)).toEqual(["workflow_dispatch"]);
    const delivery = workflows.get(DELIVERY_WORKFLOW)!;
    expect(triggersOf(delivery)).toEqual(["workflow_call"]);
    const jobs = delivery
      .slice(delivery.indexOf("\njobs:\n"))
      .split(/(?=^ {2}[A-Za-z0-9_-]+:\s*$)/m)
      .slice(1);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job).toContain("github.repository_id == '1406026313'");
      expect(job).toContain("github.ref == 'refs/heads/atli'");
      expect(job).toContain("github.event_name == 'workflow_dispatch'");
      if (/secrets\./.test(job))
        expect(job).toMatch(/^ {4}environment: .*personal-(?:android|ios)-signing/m);
    }
    const callers = [...workflows].filter(([, text]) =>
      text.includes("uses: ./.github/workflows/fork-mobile-delivery.yml"),
    );
    expect(callers.map(([file]) => file)).toEqual(["fork-mobile-update.yml", RELEASE_WORKFLOW]);
    for (const [, text] of callers) expect(triggersOf(text)).toEqual(["workflow_dispatch"]);
  });

  describe("in the authorized release workflows", () => {
    const text = [workflows.get(RELEASE_WORKFLOW)!, workflows.get(DELIVERY_WORKFLOW)!].join("\n");
    const lines = text.split("\n");
    // Env names a step maps a secret to, for example `KEYSTORE_BASE64: ${{ secrets.X }}`.
    const secretEnv = lines
      .map((line) => /^\s+([A-Za-z0-9_]+):\s*\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}\s*$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match[1]!);
    const references = (line: string, name: string): boolean =>
      new RegExp(`\\$\\{?${name}\\b`).test(line);
    const secretLines = lines.filter((line) => secretEnv.some((name) => references(line, name)));
    const DECODE_TO_TEMP =
      /^\s*printf '%s' "\$[A-Z0-9_]+" \| base64 -d > "\$RUNNER_TEMP\/[A-Za-z0-9._-]+"$/;

    it("keeps credentials in step env or the EAS action input", () => {
      expect(secretEnv).toEqual(
        expect.arrayContaining([
          "API_KEY_BASE64",
          "PROFILE_BASE64",
          "CSC_LINK",
          "CSC_KEY_PASSWORD",
          "ASC_KEY_BASE64",
          "token",
        ]),
      );
      for (const line of lines.filter((line) => /secrets\./.test(line))) {
        expect(line).toMatch(/^ {10}[A-Za-z0-9_]+: \$\{\{ secrets\.[A-Za-z0-9_]+ \}\}$/);
      }
      for (const step of text
        .split(/(?=^ {6}- )/m)
        .filter((step) => step.includes("secrets.EXPO_OTA_TOKEN"))) {
        expect(step).toMatch(/uses: expo\/expo-github-action@/);
        expect(step).toContain("token: ${{ secrets.EXPO_OTA_TOKEN }}");
      }
      expect(text).not.toMatch(
        /secrets\.(?:T3CODE_PERSONAL_ANDROID|T3CODE_IOS_(?:DISTRIBUTION|APP_PROFILE|WIDGETS_PROFILE|SHARING_PROFILE))/,
      );
    });

    it("never traces the shell", () => {
      for (const line of lines) {
        expect(line).not.toMatch(/\bset\s+(?:-[A-Za-z]*x[A-Za-z]*|-o\s+xtrace)\b/);
        expect(line).not.toMatch(/\bbash\s+-[A-Za-z]*x[A-Za-z]*\b/);
      }
    });

    it("never prints a secret, only decodes it to a file under RUNNER_TEMP", () => {
      expect(secretLines.some((line) => DECODE_TO_TEMP.test(line))).toBe(true);
      for (const line of secretLines) {
        if (/\b(?:echo|printf|cat|tee|print)\b/.test(line)) expect(line).toMatch(DECODE_TO_TEMP);
        expect(line).not.toMatch(/GITHUB_(?:ENV|OUTPUT|STEP_SUMMARY)/);
      }
    });

    it("writes every file it makes from a secret under RUNNER_TEMP", () => {
      for (const line of secretLines) {
        for (const target of line.matchAll(/>{1,2}\s*(\S+)/g)) {
          expect(target[1], line).toMatch(/^"\$RUNNER_TEMP\//);
        }
      }
      for (const name of ["T3CODE_MACOS_PROVISIONING_PROFILE", "APPLE_API_KEY"]) {
        const exports = lines.filter((line) => line.includes(`${name}=`));
        expect(exports, name).toHaveLength(1);
        expect(exports[0], name).toMatch(new RegExp(`${name}=\\$RUNNER_TEMP/`));
      }
    });
  });
});
