import * as assert from "assert";

import {
  BINARY_KEY_DELETE_UNSUPPORTED_MESSAGE,
  DynamoService,
  ITEM_NO_LONGER_EXISTS_MESSAGE,
} from "../../aws/dynamoService";
import { buildPrimaryKeyRecord } from "../../itemKeys";
import { canonicalItems, LOCAL_CONNECTION, LocalDynamo } from "./localDynamo";

// Drives DynamoService with its real client against a local DynamoDB: rows
// are loaded through the service and deleted by the key it returned, exactly
// as the table explorer does.
suite("Delete item against a local DynamoDB", function () {
  this.timeout(20_000);

  const service = new DynamoService();
  let dynamo: LocalDynamo;

  suiteSetup(async () => {
    dynamo = await LocalDynamo.start();
  });

  suiteTeardown(async () => {
    await dynamo.stop();
  });

  async function loadRows(tableName: string) {
    const metadata = await service.describeTable(LOCAL_CONNECTION, tableName);
    const page = await service.scanTable(LOCAL_CONNECTION, tableName, 50);

    return { metadata, rows: page.items };
  }

  test("deletes only the targeted item from a string-key table", async () => {
    const tableName = "DeleteStringKey";
    await dynamo.createTable(tableName, { name: "id", type: "S" });
    await dynamo.putItems(tableName, [
      { id: { S: "a" }, note: { S: "first" } },
      { id: { S: "b" }, note: { S: "second" } },
      { id: { S: "1" }, note: { S: "looks numeric" } },
    ]);

    const { metadata, rows } = await loadRows(tableName);
    const target = rows.find((row) => row.id === "b");
    assert.ok(target);

    await service.deleteItem(LOCAL_CONNECTION, {
      tableName,
      metadata,
      itemKey: buildPrimaryKeyRecord(metadata, target),
    });

    assert.deepStrictEqual(
      canonicalItems(await dynamo.readItems(tableName)),
      canonicalItems([
        { id: { S: "a" }, note: { S: "first" } },
        { id: { S: "1" }, note: { S: "looks numeric" } },
      ]),
    );
  });

  test("deletes only the targeted item from a number-key table", async () => {
    const tableName = "DeleteNumberKey";
    await dynamo.createTable(tableName, { name: "id", type: "N" });
    await dynamo.putItems(tableName, [
      { id: { N: "1" } },
      { id: { N: "1.5" } },
      { id: { N: "-3" } },
      { id: { N: "9007199254740991" } },
    ]);

    const { metadata, rows } = await loadRows(tableName);
    for (const id of [1.5, 9007199254740991]) {
      const target = rows.find((row) => row.id === id);
      assert.ok(target);

      await service.deleteItem(LOCAL_CONNECTION, {
        tableName,
        metadata,
        itemKey: buildPrimaryKeyRecord(metadata, target),
      });
    }

    assert.deepStrictEqual(
      canonicalItems(await dynamo.readItems(tableName)),
      canonicalItems([{ id: { N: "1" } }, { id: { N: "-3" } }]),
    );
  });

  test("deletes only the targeted item from a composite-key table", async () => {
    const tableName = "DeleteCompositeKey";
    await dynamo.createTable(
      tableName,
      { name: "tenantId", type: "S" },
      { name: "orderId", type: "N" },
    );
    await dynamo.putItems(tableName, [
      { tenantId: { S: "t1" }, orderId: { N: "1" } },
      { tenantId: { S: "t1" }, orderId: { N: "2" }, status: { S: "open" } },
      { tenantId: { S: "t2" }, orderId: { N: "2" } },
    ]);

    const { metadata, rows } = await loadRows(tableName);
    const target = rows.find(
      (row) => row.tenantId === "t1" && row.orderId === 2,
    );
    assert.ok(target);

    await service.deleteItem(LOCAL_CONNECTION, {
      tableName,
      metadata,
      itemKey: buildPrimaryKeyRecord(metadata, target),
    });

    assert.deepStrictEqual(
      canonicalItems(await dynamo.readItems(tableName)),
      canonicalItems([
        { tenantId: { S: "t1" }, orderId: { N: "1" } },
        { tenantId: { S: "t2" }, orderId: { N: "2" } },
      ]),
    );
  });

  test("reports a missing item and leaves the table unchanged", async () => {
    const tableName = "DeleteMissingItem";
    await dynamo.createTable(
      tableName,
      { name: "tenantId", type: "S" },
      { name: "orderId", type: "N" },
    );
    await dynamo.putItems(tableName, [
      { tenantId: { S: "t1" }, orderId: { N: "1" } },
    ]);

    const { metadata } = await loadRows(tableName);
    const before = await dynamo.readItems(tableName);
    const deletesBefore = dynamo.countOperations("DeleteItem");

    // Same partition, other sort key; and the same item deleted twice.
    for (const itemKey of [
      { tenantId: "t1", orderId: 2 },
      { tenantId: "gone", orderId: 1 },
    ]) {
      await assert.rejects(
        service.deleteItem(LOCAL_CONNECTION, { tableName, metadata, itemKey }),
        { message: ITEM_NO_LONGER_EXISTS_MESSAGE },
      );
    }

    assert.strictEqual(
      dynamo.countOperations("DeleteItem"),
      deletesBefore + 2,
      "the conditional delete should have reached DynamoDB",
    );
    assert.deepStrictEqual(
      canonicalItems(await dynamo.readItems(tableName)),
      canonicalItems(before),
    );

    const itemKey = { tenantId: "t1", orderId: 1 };
    await service.deleteItem(LOCAL_CONNECTION, {
      tableName,
      metadata,
      itemKey,
    });
    await assert.rejects(
      service.deleteItem(LOCAL_CONNECTION, { tableName, metadata, itemKey }),
      { message: ITEM_NO_LONGER_EXISTS_MESSAGE },
    );
    assert.deepStrictEqual(await dynamo.readItems(tableName), []);
  });

  test("refuses binary-key tables without sending a request", async () => {
    const tableName = "DeleteBinaryKey";
    await dynamo.createTable(
      tableName,
      { name: "tenantId", type: "S" },
      { name: "blobId", type: "B" },
    );
    await dynamo.putItems(tableName, [
      { tenantId: { S: "t1" }, blobId: { B: new Uint8Array([1, 2, 3]) } },
    ]);

    const { metadata, rows } = await loadRows(tableName);
    assert.strictEqual(metadata.sortKey?.type, "B");
    const deletesBefore = dynamo.countOperations("DeleteItem");

    await assert.rejects(
      service.deleteItem(LOCAL_CONNECTION, {
        tableName,
        metadata,
        itemKey: buildPrimaryKeyRecord(metadata, rows[0]),
      }),
      { message: BINARY_KEY_DELETE_UNSUPPORTED_MESSAGE },
    );

    assert.strictEqual(dynamo.countOperations("DeleteItem"), deletesBefore);
    assert.strictEqual((await dynamo.readItems(tableName)).length, 1);
  });

  test("refuses lossy number keys without sending a request", async () => {
    const tableName = "DeleteLossyNumberKey";
    await dynamo.createTable(tableName, { name: "id", type: "N" });
    await dynamo.putItems(tableName, [
      // Stored with 20 significant digits; read back as a rounded double.
      { id: { N: "0.12345678901234567891" } },
      // The value that rounded double prints as: a different, real item.
      { id: { N: "0.12345678901234568" } },
    ]);

    const { metadata, rows } = await loadRows(tableName);
    assert.deepStrictEqual(
      rows.map((row) => row.id),
      [0.12345678901234568, 0.12345678901234568],
    );
    const deletesBefore = dynamo.countOperations("DeleteItem");

    await assert.rejects(
      service.deleteItem(LOCAL_CONNECTION, {
        tableName,
        metadata,
        itemKey: buildPrimaryKeyRecord(metadata, rows[0]),
      }),
      /Key attribute "id" has more precision/u,
    );

    assert.strictEqual(dynamo.countOperations("DeleteItem"), deletesBefore);
    assert.strictEqual((await dynamo.readItems(tableName)).length, 2);
  });
});
