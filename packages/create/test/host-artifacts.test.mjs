import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectHostArtifact, reconcileHostArtifact } from "../dist/host-artifacts.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "kyb-host-artifact-"));
  const targetPath = join(dir, "installed");
  const desiredContent = Buffer.from("package version\n");
  return {
    dir,
    targetPath,
    desiredContent,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function install(targetPath, desiredContent, mode = 0o755) {
  writeFileSync(targetPath, desiredContent, { mode });
  chmodSync(targetPath, mode);
}

test("a stale artifact is announced before it is replaced, then becomes idempotent", () => {
  const f = fixture();
  try {
    install(f.targetPath, "operator or old package version\n");
    const events = [];
    const options = {
      targetPath: f.targetPath,
      desiredContent: f.desiredContent,
      expectedMode: 0o755,
      installIfMissing: true,
      owner: "the packaged source",
      manualCommand: "sudo install -m 0755 source target",
      log: (message) => events.push(`log:${message}`),
      update: () => {
        events.push("update");
        install(f.targetPath, f.desiredContent);
        return true;
      },
    };

    assert.equal(reconcileHostArtifact(options), "updated");
    assert.match(events[0], /differs from the packaged source/);
    assert.equal(events[1], "update");
    assert.deepEqual(inspectHostArtifact(f.targetPath, f.desiredContent, 0o755), { state: "current" });

    events.length = 0;
    assert.equal(reconcileHostArtifact(options), "current");
    assert.deepEqual(events, []);
  } finally {
    f.cleanup();
  }
});

test("mode drift alone is repaired", () => {
  const f = fixture();
  try {
    install(f.targetPath, f.desiredContent, 0o644);
    const logs = [];
    assert.equal(
      reconcileHostArtifact({
        targetPath: f.targetPath,
        desiredContent: f.desiredContent,
        expectedMode: 0o755,
        installIfMissing: true,
        owner: "the packaged source",
        manualCommand: "repair mode",
        log: (message) => logs.push(message),
        update: () => {
          chmodSync(f.targetPath, 0o755);
          return true;
        },
      }),
      "updated",
    );
    assert.match(logs[0], /\(mode\)/);
  } finally {
    f.cleanup();
  }
});

test("a failed refresh leaves local edits and prints the exact manual command", () => {
  const f = fixture();
  try {
    install(f.targetPath, "local customization\n");
    const logs = [];
    const manualCommand = "sudo install -m 0755 '/package/source' /etc/cron.daily/kyb-docker-prune";
    assert.equal(
      reconcileHostArtifact({
        targetPath: f.targetPath,
        desiredContent: f.desiredContent,
        expectedMode: 0o755,
        installIfMissing: true,
        owner: "the packaged source",
        manualCommand,
        log: (message) => logs.push(message),
        update: () => false,
      }),
      "failed",
    );
    assert.equal(readFileSync(f.targetPath, "utf8"), "local customization\n");
    assert.match(logs[0], /differs/);
    assert.ok(logs[1].includes(manualCommand));
  } finally {
    f.cleanup();
  }
});

test("missing artifacts respect install policy", () => {
  const f = fixture();
  try {
    let updates = 0;
    const options = {
      targetPath: f.targetPath,
      desiredContent: f.desiredContent,
      expectedMode: 0o755,
      owner: "the packaged source",
      manualCommand: "repair",
      log: () => {},
      update: () => {
        updates += 1;
        install(f.targetPath, f.desiredContent);
        return true;
      },
    };

    assert.equal(reconcileHostArtifact({ ...options, installIfMissing: false }), "missing");
    assert.equal(updates, 0);
    assert.equal(reconcileHostArtifact({ ...options, installIfMissing: true }), "updated");
    assert.equal(updates, 1);
  } finally {
    f.cleanup();
  }
});


test("an unreadable target is reported as unchecked and is not replaced", () => {
  const f = fixture();
  try {
    const directoryTarget = join(f.dir, "directory-target");
    writeFileSync(join(f.dir, "marker"), "present");
    mkdirSync(directoryTarget);
    let updated = false;
    const logs = [];
    assert.equal(
      reconcileHostArtifact({
        targetPath: directoryTarget,
        desiredContent: f.desiredContent,
        expectedMode: 0o755,
        installIfMissing: true,
        owner: "the packaged source",
        manualCommand: "repair unreadable",
        log: (message) => logs.push(message),
        update: () => {
          updated = true;
          return true;
        },
      }),
      "unreadable",
    );
    assert.equal(updated, false);
    assert.match(logs[0], /could not verify/);
    assert.match(logs[0], /repair unreadable/);
  } finally {
    f.cleanup();
  }
});
