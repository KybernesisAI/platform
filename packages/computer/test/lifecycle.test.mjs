import assert from "node:assert/strict";
import { test } from "node:test";

import { computerUpCommand, startComputer } from "../dist/lifecycle.js";

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
