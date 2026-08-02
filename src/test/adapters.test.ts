import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type * as vscode from "vscode";
import { AppServerEventAdapter } from "../appServerAdapter";
import { parseUnifiedDiff } from "../diff";
import { RolloutEventAdapter, type WorkspacePathResolver } from "../rolloutAdapter";

class FakeUri {
  public constructor(public readonly fsPath: string) {}
  public toString(): string { return `file://${this.fsPath}`; }
}

const resolver: WorkspacePathResolver = {
  async resolve(candidate: string): Promise<vscode.Uri | undefined> {
    return candidate.startsWith("/workspace/") ? new FakeUri(candidate) as unknown as vscode.Uri : undefined;
  },
};

async function fixtureEvents(): Promise<unknown[]> {
  return JSON.parse(await readFile("src/test/fixtures/rollout-events.json", "utf8")) as unknown[];
}

test("rollout adapter accepts only completed successful patch events", async () => {
  const adapter = new RolloutEventAdapter(resolver);
  const events = await fixtureEvents();
  const valid = await adapter.adapt(JSON.stringify(events[0]), { identity: "file-id", offset: 42 });
  assert.equal(valid?.source, "rollout");
  assert.equal(valid?.changes.length, 1);
  assert.match(valid?.eventId ?? "", /file-id:42:call-one:turn-one/u);

  const failed = structuredClone(events[0]) as { payload: { success: boolean } };
  failed.payload.success = false;
  assert.equal(await adapter.adapt(JSON.stringify(failed), { identity: "id", offset: 0 }), undefined);
  assert.equal(await adapter.adapt("not json", { identity: "id", offset: 0 }), undefined);

  const invalidTimestamp = structuredClone(events[0]) as { timestamp: string };
  invalidTimestamp.timestamp = "invalid";
  assert.equal(await adapter.adapt(JSON.stringify(invalidTimestamp), { identity: "id", offset: 0 }), undefined);
});

test("rollout adapter normalizes multiple updated files", async () => {
  const adapter = new RolloutEventAdapter(resolver);
  const events = await fixtureEvents();
  const batch = await adapter.adapt(JSON.stringify(events[2]), { identity: "id", offset: 10 });
  assert.equal(batch?.changes.length, 2);
  assert.deepEqual(batch?.changes.map((change) => change.kind), ["update", "update"]);
});

test("captured multi-hunk update remains a single two-hunk file change", async () => {
  const adapter = new RolloutEventAdapter(resolver);
  const events = await fixtureEvents();
  const batch = await adapter.adapt(JSON.stringify(events[1]), { identity: "id", offset: 9 });
  assert.equal(batch?.changes.length, 1);
  assert.equal(parseUnifiedDiff(batch?.changes[0]?.unifiedDiff ?? "").hunks.length, 2);
});

test("captured creation/deletion shape produces exactly one add and one delete", async () => {
  const adapter = new RolloutEventAdapter(resolver);
  const events = await fixtureEvents();
  const batch = await adapter.adapt(JSON.stringify(events[3]), { identity: "id", offset: 20 });
  assert.equal(batch?.changes.length, 2);
  assert.equal(batch?.changes.filter((change) => change.kind === "add").length, 1);
  assert.equal(batch?.changes.filter((change) => change.kind === "delete").length, 1);
  for (const change of batch?.changes ?? []) {
    assert.equal(parseUnifiedDiff(change.unifiedDiff).hunks.length, 1);
  }
});

test("rollout adapter filters changes outside every workspace", async () => {
  const adapter = new RolloutEventAdapter(resolver);
  const event = {
    timestamp: "2026-08-01T00:00:00Z",
    type: "event_msg",
    payload: {
      type: "patch_apply_end",
      call_id: "call",
      turn_id: "turn",
      success: true,
      status: "completed",
      changes: { "/outside/secret.txt": { type: "add", content: "secret\n" } },
    },
  };
  assert.equal(await adapter.adapt(JSON.stringify(event), { identity: "id", offset: 0 }), undefined);
});

test("app-server adapter is isolated from rollout schema", async () => {
  const adapter = new AppServerEventAdapter(resolver);
  const batch = await adapter.adapt({
    method: "item/completed",
    params: {
      threadId: "thread",
      turnId: "turn",
      item: {
        type: "fileChange",
        id: "item",
        status: "completed",
        changes: [{ path: "/workspace/file.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new\n" }],
      },
    },
  });
  assert.equal(batch?.source, "appServer");
  assert.equal(batch?.eventId, "appServer:turn:item");
  assert.equal(batch?.changes.length, 1);
});
