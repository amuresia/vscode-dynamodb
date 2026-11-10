import * as assert from "assert";

import * as vscode from "vscode";

suite("Extension Test Suite", () => {
  test("registers DynamoDB commands on activation", async function () {
    // Activation does real filesystem and extension-host work.
    // The default Mocha timeout is too tight for VS Code integration tests.
    this.timeout(10_000);

    const extension = vscode.extensions.getExtension(
      "riccardopll.vscode-dynamodb-explorer",
    );
    assert.ok(extension, "Extension should be available in the test host");

    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("dynamodb.selectProfile"));
    assert.ok(commands.includes("dynamodb.selectRegion"));
    assert.ok(commands.includes("dynamodb.refreshProfiles"));
    assert.ok(commands.includes("dynamodb.refreshTables"));
    assert.ok(commands.includes("dynamodb.searchTables"));
    assert.ok(commands.includes("dynamodb.clearTableSearch"));
    assert.ok(commands.includes("dynamodb.saveFavoriteTable"));
    assert.ok(commands.includes("dynamodb.removeFavoriteTable"));
    assert.ok(commands.includes("dynamodb.openTableExplorer"));
    assert.ok(commands.includes("dynamodb.executeQuery"));
    assert.ok(commands.includes("dynamodb.saveTableChanges"));
    assert.ok(commands.includes("dynamodb.deleteTableRow"));
  });
});
