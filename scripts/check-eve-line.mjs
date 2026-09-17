#!/usr/bin/env node
/**
 * A per-eve-line build must be COMPILED against the eve line it declares.
 *
 * These packages ship one build per eve line, and the only thing distinguishing
 * them is `peerDependencies.eve`. It is therefore possible — and it happened —
 * to bump the peer range, rebuild, and publish a "0.49 build" that was actually
 * compiled against eve 0.51, because the devDependency was never moved.
 *
 * Nothing catches that at publish time. The tarball installs cleanly, npm is
 * satisfied, and the peer range is correct. It fails much later, on the client's
 * host, at start: eve cannot bind the extension the wrong runtime produced
 * ("Selected module binding \"extensions/notify.ts\" has no compile or runtime
 * usage"), and because the agent unit builds before every start, the agent does
 * not come up at all. notify 0.1.5 took two production agents down that way.
 *
 * So: the eve a package builds against and the eve it claims to support must be
 * the same minor line. Run before every publish.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const line = (range) => {
  const m = /(\d+)\.(\d+)\.\d+/.exec(range ?? "");
  return m ? `${m[1]}.${m[2]}` : null;
};

let bad = 0;
for (const path of process.argv.slice(2)) {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const peer = pkg.peerDependencies?.eve;
  const dev = pkg.devDependencies?.eve;
  if (!peer) continue; // not a per-line package (the CLI has no eve peer)
  if (!dev) {
    console.error(`${pkg.name}: declares peer eve ${peer} but pins no eve devDependency to build against.`);
    bad++;
    continue;
  }
  if (line(peer) !== line(dev)) {
    console.error(
      `${pkg.name} ${pkg.version}: declares peer eve ${peer} (line ${line(peer)}) ` +
        `but builds against devDependency eve ${dev} (line ${line(dev)}).\n` +
        `  Install the matching eve before building, or this ships a ${line(dev)} build labelled ${line(peer)}.`
    );
    bad++;
  } else {
    console.log(`${pkg.name} ${pkg.version}: eve ${line(peer)} build, declared for eve ${line(peer)} — consistent.`);
  }

  /**
   * The artifact itself, when it has already been built. eve stamps the eve it
   * was built with — and the hook/extension ABI versions it therefore requires
   * — into the extension manifest. That stamp is what actually decides whether
   * a client's eve can bind the extension: notify 0.1.5 asked for hook ABI 20,
   * eve 0.49 provides 16, so eve refused the binding and the agent would not
   * start. The devDependency is the cause; this is the evidence.
   */
  const manifestPath = join(dirname(path), "dist/extension/_manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const built = manifest.builtWithEve;
    if (built && line(built) !== line(peer)) {
      console.error(
        `${pkg.name} ${pkg.version}: built artifact says builtWithEve ${built} (line ${line(built)}) ` +
          `but the package is declared for eve line ${line(peer)}.\n` +
          `  requires: ${JSON.stringify(manifest.requires)} — a client on eve ${line(peer)} will refuse to bind this.\n` +
          `  Rebuild after installing eve@^${line(peer)}.0.`
      );
      bad++;
    } else if (built) {
      console.log(`  artifact builtWithEve ${built}, requires ${JSON.stringify(manifest.requires)} — matches.`);
    }
  }
}
process.exit(bad === 0 ? 0 : 1);
