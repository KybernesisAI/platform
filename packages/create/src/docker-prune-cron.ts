const MANAGED_PREFIX = "# kyb-managed-eve-app-dirs: ";

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function registeredDockerPruneAppDirs(installedContent: string | null): string[] {
  if (!installedContent) return [];
  const line = installedContent.split("\n").find((candidate) => candidate.startsWith(MANAGED_PREFIX));
  if (!line) return [];
  try {
    const parsed = JSON.parse(line.slice(MANAGED_PREFIX.length));
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string") ? parsed : [];
  } catch {
    return [];
  }
}

export interface DockerPruneCronArtifact {
  content: Buffer;
  appDirs: string[];
  manualCommand: string;
}

/** Render the package script with a managed, mergeable app-directory header. */
export function dockerPruneCronArtifact(
  packageSource: string,
  currentAppDir: string,
  installedContent: string | null,
  targetPath: string,
): DockerPruneCronArtifact {
  const appDirs = [...new Set([...registeredDockerPruneAppDirs(installedContent), currentAppDir])];
  const newline = packageSource.indexOf("\n");
  const shebang = newline === -1 ? packageSource : packageSource.slice(0, newline);
  const body = newline === -1 ? "" : packageSource.slice(newline + 1);
  const joined = appDirs.join(":");
  const content = Buffer.from(
    `${shebang}\n` +
      `${MANAGED_PREFIX}${JSON.stringify(appDirs)}\n` +
      `if [ -z "\${EVE_APP_DIRS:-}" ]; then EVE_APP_DIRS=${shellSingleQuote(joined)}; fi\n` +
      `export EVE_APP_DIRS\n` +
      body,
  );
  const encoded = content.toString("base64");
  return {
    content,
    appDirs,
    manualCommand:
      `printf %s ${shellSingleQuote(encoded)} | base64 -d | ` +
      `sudo install -m 0755 /dev/stdin ${shellSingleQuote(targetPath)}`,
  };
}
