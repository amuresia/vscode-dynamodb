import * as assert from "assert";

import * as vscode from "vscode";

import type { ExtensionTestApi } from "../../extension";
import { canonicalItems, LocalDynamo, type RawItem } from "./localDynamo";

// Runs the real dynamodb.deleteTableRow command of the activated extension
// against a local DynamoDB. A table explorer is opened for real; the test
// stands in for the row context menu (which supplies the panel id and the
// row key) and for the user answering the confirmation dialog.
suite("dynamodb.deleteTableRow command against a local DynamoDB", function () {
  this.timeout(30_000);

  const compositeTable = "CommandCompositeKey";
  const numberTable = "CommandNumberKey";
  const binaryTable = "CommandBinaryKey";
  const compositeItems: RawItem[] = [
    { tenantId: { S: "t1" }, orderId: { N: "1" }, status: { S: "open" } },
    { tenantId: { S: "t1" }, orderId: { N: "2" } },
    { tenantId: { S: "t2" }, orderId: { N: "1" } },
  ];

  const realShowWarningMessage = vscode.window.showWarningMessage;
  let dynamo: LocalDynamo;
  let api: ExtensionTestApi;
  let dialogAnswer: string | undefined;
  let dialogs: { message: string; detail?: string }[];
  let warnings: string[];

  suiteSetup(async () => {
    dynamo = await LocalDynamo.start();
    await dynamo.createTable(
      compositeTable,
      { name: "tenantId", type: "S" },
      { name: "orderId", type: "N" },
    );
    await dynamo.putItems(compositeTable, compositeItems);
    await dynamo.createTable(numberTable, { name: "id", type: "N" });
    await dynamo.putItems(numberTable, [
      { id: { N: "0.12345678901234567891" } },
      { id: { N: "7" } },
    ]);
    await dynamo.createTable(
      binaryTable,
      { name: "tenantId", type: "S" },
      { name: "blobId", type: "B" },
    );
    await dynamo.putItems(binaryTable, [
      { tenantId: { S: "t1" }, blobId: { B: new Uint8Array([1, 2, 3]) } },
    ]);

    const extension = vscode.extensions.getExtension<ExtensionTestApi>(
      "riccardopll.vscode-dynamodb-explorer",
    );
    assert.ok(extension, "Extension should be available in the test host");
    api = await extension.activate();
    assert.ok(api, "The test API should be exposed in test mode");

    // The confirmation is a modal, which VS Code cannot show in tests.
    Object.assign(vscode.window, {
      showWarningMessage: async (
        message: string,
        options?: vscode.MessageOptions,
      ) => {
        if (options?.modal) {
          dialogs.push({ message, detail: options.detail });
          return dialogAnswer;
        }

        warnings.push(message);
        return undefined;
      },
    });
  });

  suiteTeardown(async () => {
    Object.assign(vscode.window, {
      showWarningMessage: realShowWarningMessage,
    });
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await dynamo.stop();
  });

  setup(() => {
    dialogAnswer = "Delete";
    dialogs = [];
    warnings = [];
  });

  async function openExplorer(tableName: string): Promise<string> {
    await vscode.commands.executeCommand(
      "dynamodb.openTableExplorer",
      tableName,
    );
    const panelId = api.getActiveTableExplorerPanelId();
    assert.ok(panelId, `A table explorer should be open for ${tableName}`);

    return panelId;
  }

  async function deleteRow(panelId: string, itemKey: unknown): Promise<void> {
    await vscode.commands.executeCommand("dynamodb.deleteTableRow", {
      webviewSection: "row",
      panelId,
      itemKey,
    });
  }

  test("does nothing when the confirmation is dismissed", async () => {
    const panelId = await openExplorer(compositeTable);
    dialogAnswer = undefined;

    await deleteRow(panelId, { tenantId: "t1", orderId: 2 });

    assert.strictEqual(dialogs.length, 1);
    assert.strictEqual(dynamo.countOperations("DeleteItem"), 0);
    assert.deepStrictEqual(
      canonicalItems(await dynamo.readItems(compositeTable)),
      canonicalItems(compositeItems),
    );
  });

  test("deletes the confirmed row and keeps the others", async () => {
    const panelId = await openExplorer(compositeTable);

    await deleteRow(panelId, { tenantId: "t1", orderId: 2 });

    assert.deepStrictEqual(dialogs, [
      {
        message: `Delete item from "${compositeTable}"?`,
        detail:
          '"tenantId": "t1"\n"orderId": 2\n\nThis permanently deletes the item in local (us-east-1) and cannot be undone.',
      },
    ]);
    assert.deepStrictEqual(
      canonicalItems(await dynamo.readItems(compositeTable)),
      canonicalItems([compositeItems[0], compositeItems[2]]),
    );
  });

  test("changes nothing when the row no longer exists", async () => {
    const panelId = await openExplorer(compositeTable);
    const deletesBefore = dynamo.countOperations("DeleteItem");

    await deleteRow(panelId, { tenantId: "t1", orderId: 2 });

    assert.strictEqual(dialogs.length, 1);
    assert.strictEqual(dynamo.countOperations("DeleteItem"), deletesBefore + 1);
    assert.deepStrictEqual(
      canonicalItems(await dynamo.readItems(compositeTable)),
      canonicalItems([compositeItems[0], compositeItems[2]]),
    );
  });

  test("ignores a row key that belongs to another panel", async () => {
    await openExplorer(compositeTable);
    const deletesBefore = dynamo.countOperations("DeleteItem");

    await deleteRow("not-a-panel-id", { tenantId: "t1", orderId: 1 });

    assert.strictEqual(dialogs.length, 0);
    assert.deepStrictEqual(warnings, [
      "Select a row in a DynamoDB table explorer to delete it.",
    ]);
    assert.strictEqual(dynamo.countOperations("DeleteItem"), deletesBefore);
  });

  test("refuses malformed and lossy keys before asking or sending", async () => {
    const panelId = await openExplorer(numberTable);
    const deletesBefore = dynamo.countOperations("DeleteItem");

    await deleteRow(panelId, { id: 0.12345678901234568 });
    await deleteRow(panelId, { id: "7" });
    await deleteRow(panelId, ["7"]);

    assert.strictEqual(dialogs.length, 0);
    assert.strictEqual(dynamo.countOperations("DeleteItem"), deletesBefore);
    assert.strictEqual((await dynamo.readItems(numberTable)).length, 2);
  });

  test("refuses binary-key tables before asking or sending", async () => {
    const panelId = await openExplorer(binaryTable);
    const deletesBefore = dynamo.countOperations("DeleteItem");

    await deleteRow(panelId, { tenantId: "t1", blobId: { 0: 1, 1: 2, 2: 3 } });

    assert.strictEqual(dialogs.length, 0);
    assert.strictEqual(dynamo.countOperations("DeleteItem"), deletesBefore);
    assert.strictEqual((await dynamo.readItems(binaryTable)).length, 1);
  });
});
