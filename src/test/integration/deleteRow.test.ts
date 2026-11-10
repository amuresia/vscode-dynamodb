import * as assert from "assert";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  CreateTableCommand,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import dynalite from "dynalite";
import * as vscode from "vscode";

import { DynamoService } from "../../aws/dynamoService";
import { buildStableRowKey } from "../../itemKeys";
import type { ScalarKeyType } from "../../types";
import { saveChanges } from "../../webview/tableExplorerPanel";

type Key = [name: string, type: ScalarKeyType];
type RawItem = Record<string, AttributeValue>;

// Runs the extension's real delete path against dynalite, an in-memory
// DynamoDB. The AWS SDK endpoint variable points every client in the
// extension host at it; "local" is the fake profile from .vscode-test.mjs.
suite("Delete row against a local DynamoDB", function () {
  this.timeout(30_000);

  const connection = { profile: "local", region: "us-east-1" };
  const service = new DynamoService();
  let server: Server;
  let client: DynamoDBClient;
  let deleteRequests = 0;
  let openScans = 0;
  let finishedScans = 0;

  suiteSetup(async () => {
    server = dynalite({ createTableMs: 0 });
    server.on("request", (request, response) => {
      const operation = String(request.headers["x-amz-target"]);
      if (operation.endsWith("DeleteItem")) {
        deleteRequests += 1;
      } else if (operation.endsWith("Scan")) {
        openScans += 1;
        response.on("finish", () => {
          openScans -= 1;
          finishedScans += 1;
        });
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.AWS_ENDPOINT_URL_DYNAMODB = endpoint;
    client = new DynamoDBClient({
      endpoint,
      region: connection.region,
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    client.destroy();
    server.closeAllConnections();
    server.close();
  });

  setup(() => {
    deleteRequests = 0;
  });

  async function seed(
    tableName: string,
    keys: Key[],
    items: RawItem[],
  ): Promise<void> {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: keys.map(([name, type]) => ({
          AttributeName: name,
          AttributeType: type,
        })),
        KeySchema: keys.map(([name], index) => ({
          AttributeName: name,
          KeyType: index === 0 ? "HASH" : "RANGE",
        })),
      }),
    );
    for (const item of items) {
      await client.send(
        new PutItemCommand({ TableName: tableName, Item: item }),
      );
    }
  }

  // The remaining items, as sorted JSON for order-independent comparison.
  async function remaining(tableName: string): Promise<string[]> {
    const { Items = [] } = await client.send(
      new ScanCommand({ TableName: tableName }),
    );
    return Items.map((item) => JSON.stringify(item)).sort();
  }

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(condition: () => boolean | Promise<boolean>) {
    while (!(await condition())) {
      await sleep(50);
    }
  }

  // Opens the real table explorer and loads its rows through the webview,
  // which also proves the webview is up before the test sends it commands.
  async function openExplorer(tableName: string): Promise<void> {
    await vscode.commands.executeCommand(
      "dynamodb.openTableExplorer",
      tableName,
    );
    const scansBefore = finishedScans;
    for (let attempt = 0; finishedScans === scansBefore; attempt += 1) {
      if (attempt % 20 === 0) {
        await vscode.commands.executeCommand("dynamodb.executeQuery");
      }
      await sleep(50);
    }
    await waitFor(() => openScans === 0);
    await sleep(300);
  }

  // What the row context menu does: run the command with the row's key.
  async function toggleDelete(
    tableName: string,
    itemKey: Record<string, unknown>,
  ): Promise<void> {
    const metadata = await service.describeTable(connection, tableName);
    await vscode.commands.executeCommand("dynamodb.deleteTableRow", {
      rowKey: buildStableRowKey(metadata, itemKey),
    });
  }

  test("deletes a marked row on save (composite key)", async () => {
    const items: RawItem[] = [
      { tenantId: { S: "t1" }, orderId: { N: "1" } },
      { tenantId: { S: "t1" }, orderId: { N: "2.5" }, note: { S: "target" } },
      { tenantId: { S: "t2" }, orderId: { N: "2.5" } },
    ];
    await seed(
      "MarkAndSave",
      [
        ["tenantId", "S"],
        ["orderId", "N"],
      ],
      items,
    );
    await openExplorer("MarkAndSave");

    await toggleDelete("MarkAndSave", { tenantId: "t1", orderId: 2.5 });
    await sleep(300);
    assert.strictEqual(deleteRequests, 0, "marking must not delete");

    await vscode.commands.executeCommand("dynamodb.saveTableChanges");
    await waitFor(async () => (await remaining("MarkAndSave")).length === 2);

    assert.deepStrictEqual(
      await remaining("MarkAndSave"),
      [items[0], items[2]].map((item) => JSON.stringify(item)).sort(),
    );
    assert.strictEqual(deleteRequests, 1);
  });

  test("does not delete a row that was marked and then unmarked", async () => {
    await seed(
      "Unmark",
      [["id", "N"]],
      [{ id: { N: "1" } }, { id: { N: "2" } }],
    );
    await openExplorer("Unmark");

    await toggleDelete("Unmark", { id: 1 });
    await toggleDelete("Unmark", { id: 1 });
    await toggleDelete("Unmark", { id: 2 });
    await vscode.commands.executeCommand("dynamodb.saveTableChanges");
    await waitFor(async () => (await remaining("Unmark")).length === 1);

    assert.deepStrictEqual(await remaining("Unmark"), ['{"id":{"N":"1"}}']);
    assert.strictEqual(deleteRequests, 1);
  });

  test("applies an edit and a delete in one save", async () => {
    await seed(
      "Batch",
      [["id", "S"]],
      [{ id: { S: "a" }, note: { S: "old" } }, { id: { S: "b" } }],
    );
    const metadata = await service.describeTable(connection, "Batch");

    const result = await saveChanges(
      service,
      connection,
      metadata,
      [
        {
          originalItem: { id: "a", note: "old" },
          updatedItem: { id: "a", note: "new" },
        },
      ],
      [{ id: "b" }],
    );

    assert.deepStrictEqual(result, {
      items: [
        {
          originalItem: { id: "a", note: "old" },
          item: { id: "a", note: "new" },
        },
      ],
      deletedKeys: [{ id: "b" }],
    });
    assert.deepStrictEqual(await remaining("Batch"), [
      '{"id":{"S":"a"},"note":{"S":"new"}}',
    ]);
  });

  test("reports a missing item and keeps the remaining deletes pending", async () => {
    await seed(
      "Missing",
      [["id", "S"]],
      [{ id: { S: "a" } }, { id: { S: "c" } }],
    );
    const metadata = await service.describeTable(connection, "Missing");

    const result = await saveChanges(
      service,
      connection,
      metadata,
      [],
      [{ id: "a" }, { id: "gone" }, { id: "c" }],
    );

    assert.deepStrictEqual(result.deletedKeys, [{ id: "a" }]);
    assert.match(String(result.error), /no longer exists/u);
    assert.deepStrictEqual(await remaining("Missing"), ['{"id":{"S":"c"}}']);
  });

  test("deletes a marked row on save (composite binary key)", async () => {
    const items: RawItem[] = [
      { tenantId: { S: "t1" }, blobId: { B: new Uint8Array([0, 1, 255]) } },
      { tenantId: { S: "t1" }, blobId: { B: new Uint8Array([0, 1, 254]) } },
    ];
    await seed(
      "BinaryKey",
      [
        ["tenantId", "S"],
        ["blobId", "B"],
      ],
      items,
    );
    await openExplorer("BinaryKey");

    await toggleDelete("BinaryKey", {
      tenantId: "t1",
      blobId: new Uint8Array([0, 1, 255]),
    });
    await vscode.commands.executeCommand("dynamodb.saveTableChanges");
    await waitFor(async () => (await remaining("BinaryKey")).length === 1);

    assert.deepStrictEqual(await remaining("BinaryKey"), [
      JSON.stringify(items[1]),
    ]);
    assert.strictEqual(deleteRequests, 1);
  });

  test("saves an edit to an item with a binary key", async () => {
    const metadata = await service.describeTable(connection, "BinaryKey");
    const key = { tenantId: "t1", blobId: new Uint8Array([0, 1, 254]) };

    const { error } = await saveChanges(
      service,
      connection,
      metadata,
      [
        {
          originalItem: { ...key, note: "old" },
          updatedItem: { ...key, note: "new" },
        },
      ],
      [],
    );

    assert.strictEqual(error, undefined);
    assert.match((await remaining("BinaryKey"))[0], /"note":\{"S":"new"\}/u);
    assert.strictEqual((await remaining("BinaryKey")).length, 1);
  });

  test("refuses lossy number keys without a request", async () => {
    // Stored with 20 digits; the explorer reads it back as a rounded double.
    await seed(
      "LossyKey",
      [["id", "N"]],
      [{ id: { N: "0.12345678901234567891" } }],
    );
    const metadata = await service.describeTable(connection, "LossyKey");

    const result = await saveChanges(
      service,
      connection,
      metadata,
      [],
      [{ id: 0.12345678901234568 }],
    );

    assert.match(String(result.error), /cannot be sent back exactly/u);
    assert.strictEqual((await remaining("LossyKey")).length, 1);
    assert.strictEqual(deleteRequests, 0);
  });
});
