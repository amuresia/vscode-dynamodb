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

import { buildDeleteItemInput, DynamoService } from "../../aws/dynamoService";
import type { ScalarKeyType, TableMetadata } from "../../types";

type Key = [name: string, type: ScalarKeyType];
type RawItem = Record<string, AttributeValue>;

// Runs the extension's real delete path against dynalite, an in-memory
// DynamoDB. The AWS SDK endpoint variable points every client in the
// extension host at it; "local" is the fake profile from .vscode-test.mjs.
suite("Delete row against a local DynamoDB", function () {
  this.timeout(30_000);

  const connection = { profile: "local", region: "us-east-1" };
  const realShowWarningMessage = vscode.window.showWarningMessage;
  let server: Server;
  let client: DynamoDBClient;
  let deleteRequests = 0;
  let confirm = true;
  let dialogs = 0;

  suiteSetup(async () => {
    server = dynalite({ createTableMs: 0 });
    server.on("request", (request) => {
      if (String(request.headers["x-amz-target"]).endsWith("DeleteItem")) {
        deleteRequests += 1;
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

    // VS Code cannot show the modal confirmation in tests.
    Object.assign(vscode.window, {
      showWarningMessage: async () => {
        dialogs += 1;
        return confirm ? "Delete" : undefined;
      },
    });
  });

  suiteTeardown(async () => {
    Object.assign(vscode.window, {
      showWarningMessage: realShowWarningMessage,
    });
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    client.destroy();
    server.closeAllConnections();
    server.close();
  });

  setup(() => {
    deleteRequests = 0;
    confirm = true;
    dialogs = 0;
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

  // What the row context menu does: run the command with the row's key
  // against the table explorer that is open for the table.
  async function deleteRow(
    tableName: string,
    itemKey: Record<string, unknown>,
  ): Promise<void> {
    await vscode.commands.executeCommand(
      "dynamodb.openTableExplorer",
      tableName,
    );
    await vscode.commands.executeCommand("dynamodb.deleteTableRow", {
      itemKey,
    });
  }

  const cases: [string, Key[], RawItem[], Record<string, unknown>][] = [
    [
      "StringKey",
      [["id", "S"]],
      [{ id: { S: "a" } }, { id: { S: "b" } }, { id: { S: "1" } }],
      { id: "b" },
    ],
    [
      "NumberKey",
      [["id", "N"]],
      [{ id: { N: "1" } }, { id: { N: "1.5" } }, { id: { N: "-3" } }],
      { id: 1.5 },
    ],
    [
      "CompositeKey",
      [
        ["tenantId", "S"],
        ["orderId", "N"],
      ],
      [
        { tenantId: { S: "t1" }, orderId: { N: "1" } },
        { tenantId: { S: "t1" }, orderId: { N: "2" }, note: { S: "target" } },
        { tenantId: { S: "t2" }, orderId: { N: "2" } },
      ],
      { tenantId: "t1", orderId: 2 },
    ],
  ];

  for (const [tableName, keys, items, itemKey] of cases) {
    test(`deletes only the confirmed row (${tableName})`, async () => {
      await seed(tableName, keys, items);

      await deleteRow(tableName, itemKey);

      const kept = [items[0], items[2]];
      assert.strictEqual(dialogs, 1);
      assert.deepStrictEqual(
        await remaining(tableName),
        kept.map((item) => JSON.stringify(item)).sort(),
      );
    });
  }

  test("deletes nothing when the confirmation is cancelled", async () => {
    await seed("Cancelled", [["id", "S"]], [{ id: { S: "a" } }]);
    confirm = false;

    await deleteRow("Cancelled", { id: "a" });

    assert.strictEqual(dialogs, 1);
    assert.strictEqual(deleteRequests, 0);
    assert.strictEqual((await remaining("Cancelled")).length, 1);
  });

  test("fails cleanly when the item no longer exists", async () => {
    await seed("Missing", [["id", "S"]], [{ id: { S: "a" } }]);
    const metadata: TableMetadata = {
      tableName: "Missing",
      partitionKey: { name: "id", type: "S" },
      globalSecondaryIndexes: [],
    };

    await assert.rejects(
      new DynamoService().deleteItem(
        connection,
        buildDeleteItemInput(metadata, { id: "gone" }),
      ),
      /no longer exists/u,
    );

    assert.strictEqual(deleteRequests, 1);
    assert.strictEqual((await remaining("Missing")).length, 1);
  });

  test("refuses binary and lossy number keys before asking", async () => {
    await seed(
      "BinaryKey",
      [["id", "B"]],
      [{ id: { B: new Uint8Array([1, 2]) } }],
    );
    // Stored with 20 digits; the explorer reads it back as a rounded double.
    await seed(
      "LossyKey",
      [["id", "N"]],
      [{ id: { N: "0.12345678901234567891" } }],
    );

    await deleteRow("BinaryKey", { id: { 0: 1, 1: 2 } });
    await deleteRow("LossyKey", { id: 0.12345678901234568 });

    assert.strictEqual(dialogs, 0);
    assert.strictEqual(deleteRequests, 0);
    assert.strictEqual((await remaining("BinaryKey")).length, 1);
    assert.strictEqual((await remaining("LossyKey")).length, 1);
  });
});
