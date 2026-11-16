// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - also invoked directly by the recovery verifier's shell script.
import * as NodeFS from "node:fs";

export function readLauncherTarget(launcher: string): string | undefined {
  try {
    const info = NodeFS.lstatSync(launcher);
    if (info.isSymbolicLink()) return NodeFS.readlinkSync(launcher);
    if (!info.isFile() || info.size > 4096) return undefined;
    const contents = NodeFS.readFileSync(launcher, "utf8");
    const quoted = /^#!\/bin\/sh\nexec '((?:[^']|'\\'')*)' "\$@"\n$/.exec(contents)?.[1];
    return quoted?.replaceAll("'\\''", "'");
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  const target = process.argv[2] && readLauncherTarget(process.argv[2]);
  if (target) console.log(target);
  else process.exitCode = 1;
}
