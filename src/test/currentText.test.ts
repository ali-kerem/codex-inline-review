import * as assert from "node:assert/strict";
import { test } from "node:test";
import { readCurrentText } from "../currentText";

class FakeUri {
  public constructor(private readonly value: string) {}
  public toString(): string { return this.value; }
}

test("live editor text wins over stale stored text", async () => {
  const uri = new FakeUri("file:///workspace/file.txt");
  let storedTextRead = false;
  const result = await readCurrentText(
    uri,
    [{ uri, getText: () => "agent change restored by redo\n" }],
    async () => {
      storedTextRead = true;
      return "original text still on disk\n";
    },
  );

  assert.equal(result, "agent change restored by redo\n");
  assert.equal(storedTextRead, false);
});

test("stored text is used when the file is not open", async () => {
  const result = await readCurrentText(
    new FakeUri("file:///workspace/file.txt"),
    [],
    async () => "stored text\n",
  );

  assert.equal(result, "stored text\n");
});
