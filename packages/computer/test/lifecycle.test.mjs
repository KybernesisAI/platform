import assert from "node:assert/strict";
import { test } from "node:test";

import { computerUpCommand, prepareComputer, startComputer } from "../dist/lifecycle.js";

const sandbox = (upExit) => {
  const commands = [];
  return {
    commands,
    resolvePath: (path) => `/workspace/${path}`,
    run: async ({ command }) => {
      commands.push(command);
      if (command === computerUpCommand(sandbox(0))) return { exitCode: upExit, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
};

test("the up check keeps only the newest settings daemon and tests eve's display, window manager and driver", () => {
  const command = computerUpCommand({ resolvePath: (path) => `/workspace/${path}` });
  assert.match(command, /pgrep -n -x xfsettingsd/);
  assert.match(command, /kill "\$pid"/);
  assert.match(command, /xdpyinfo -display :99/);
  assert.match(command, /_NET_SUPPORTING_WM_CHECK/);
  assert.match(command, /\/workspace\/computer-use\/cua-driver\.sock/);
  assert.match(command, /\/workspace\/\.eve-code\/computer-use-driver\/client\.mjs/);
});

test("a computer that is already up does not start eve's display again", async () => {
  const box = sandbox(0);
  await startComputer(box);
  assert.equal(box.commands.length, 2);
  assert.ok(!box.commands.some((command) => command.includes("pkill -x xfsettingsd")));
  assert.ok(!box.commands.some((command) => command.includes("dbus-launch")));
  assert.match(box.commands[1], /xfce4-panel/);
});

test("a computer that is down clears old settings daemons before eve starts the display", async () => {
  const box = sandbox(1);
  await startComputer(box);
  const kill = box.commands.findIndex((command) => command === "pkill -x xfsettingsd || true");
  const display = box.commands.findIndex((command) => command.includes("dbus-launch"));
  assert.ok(kill > 0 && display > kill, box.commands.map((c) => c.slice(0, 40)).join(" | "));
});

// A fake computer for prepare: `test -f` answers from `markers`, and eve's
// install script exits with `installExit`.
const preparing = ({ markers = [], installExit = 0 } = {}) => {
  const commands = [];
  const files = [];
  return {
    commands,
    files,
    resolvePath: (path) => `/workspace/${path}`,
    writeTextFile: async ({ path }) => { files.push(path); },
    run: async ({ command }) => {
      commands.push(command);
      if (command.startsWith("test -f /usr/local/share/kybernesis-computer/")) {
        const found = command.split(" || ").some((part) => markers.some((m) => part.endsWith(`/${m}`) || part.includes(`/${m}-`)));
        return { exitCode: found ? 0 : 1, stdout: "", stderr: "" };
      }
      if (command.includes("install-computer-use.sh")) return { exitCode: installExit, stdout: "", stderr: "Mozilla's repository does not offer the Firefox ESR 140 line" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
};

test("a computer an earlier build installed for this bake key is not installed again", async () => {
  const box = preparing({ markers: ["installed"] });
  await prepareComputer(box);
  assert.equal(box.files.length, 0);
  assert.ok(!box.commands.some((command) => command.includes("install-computer-use.sh")));
});

test("a full install records the bake key so the next build skips it", async () => {
  const box = preparing();
  await prepareComputer(box);
  assert.ok(box.commands.some((command) => command.includes("install-computer-use.sh")));
  assert.ok(box.commands.some((command) => /touch \/usr\/local\/share\/kybernesis-computer\/installed-[0-9a-f]{10}/.test(command)));
});

test("a failed install keeps a computer an earlier prepare finished, and still starts it", async () => {
  const box = preparing({ markers: ["prepared"], installExit: 1 });
  await prepareComputer(box);
  assert.ok(!box.commands.some((command) => /touch \S*\/installed-/.test(command)));
  assert.ok(box.commands.some((command) => command.includes("xfce4-panel")));
});

test("a failed install on a computer that was never prepared fails the build", async () => {
  const box = preparing({ installExit: 1 });
  await assert.rejects(prepareComputer(box), /computer-use installation failed/);
});
