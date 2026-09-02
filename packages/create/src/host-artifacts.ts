import { readFileSync, statSync } from "node:fs";

export type HostArtifactInspection =
  | { state: "missing" }
  | { state: "current" }
  | { state: "drifted"; differences: Array<"content" | "mode"> }
  | { state: "unreadable"; error: Error };

export type HostArtifactReconcileResult = "missing" | "current" | "updated" | "failed" | "unreadable";

export interface HostArtifactOptions {
  targetPath: string;
  desiredContent: Uint8Array;
  expectedMode: number;
  installIfMissing: boolean;
  owner: string;
  update: () => boolean;
  manualCommand: string;
  log?: (message: string) => void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function inspectHostArtifact(
  targetPath: string,
  desiredContent: Uint8Array,
  expectedMode: number,
): HostArtifactInspection {
  let stat;
  try {
    stat = statSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "unreadable", error: asError(error) };
  }

  let installed: Buffer;
  try {
    installed = readFileSync(targetPath);
  } catch (error) {
    return { state: "unreadable", error: asError(error) };
  }

  const differences: Array<"content" | "mode"> = [];
  if (!installed.equals(Buffer.from(desiredContent))) differences.push("content");
  if ((stat.mode & 0o777) !== expectedMode) differences.push("mode");
  return differences.length === 0 ? { state: "current" } : { state: "drifted", differences };
}

export function reconcileHostArtifact(options: HostArtifactOptions): HostArtifactReconcileResult {
  const log = options.log ?? console.log;
  const before = inspectHostArtifact(options.targetPath, options.desiredContent, options.expectedMode);

  if (before.state === "current") return "current";
  if (before.state === "missing" && !options.installIfMissing) return "missing";
  if (before.state === "unreadable") {
    log(
      `  ! could not verify ${options.targetPath} against ${options.owner}: ${before.error.message}\n` +
        `    Check it manually. To restore the package-owned file, run:\n` +
        `    ${options.manualCommand}`,
    );
    return "unreadable";
  }

  if (before.state === "drifted") {
    log(
      `  ! ${options.targetPath} differs from ${options.owner} ` +
        `(${before.differences.join(" and ")}); replacing the installed file.`,
    );
  }

  if (!options.update()) {
    log(`  ! could not update ${options.targetPath}. Run:\n    ${options.manualCommand}`);
    return "failed";
  }

  const after = inspectHostArtifact(options.targetPath, options.desiredContent, options.expectedMode);
  if (after.state !== "current") {
    log(`  ! ${options.targetPath} is still not current after the update. Run:\n    ${options.manualCommand}`);
    return "failed";
  }

  log(`  + ${before.state === "missing" ? "installed" : "refreshed"} ${options.targetPath} from ${options.owner}`);
  return "updated";
}
