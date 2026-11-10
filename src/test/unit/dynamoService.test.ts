import * as assert from "assert";

import {
  BINARY_KEY_DELETE_UNSUPPORTED_MESSAGE,
  buildDeleteItemInput,
  buildItemKey,
  buildQueryInput,
  buildReplaceItemTransactionInput,
  buildUpdateItemInput,
  collectResultPage,
  toAttributeValue,
  unmarshallItems,
} from "../../aws/dynamoService";
import type { TableMetadata } from "../../types";

suite("DynamoDB service helpers", () => {
  const partitionOnlyMetadata: TableMetadata = {
    tableName: "Orders",
    partitionKey: {
      name: "id",
      type: "S",
    },
    globalSecondaryIndexes: [],
  };

  const compositeKeyMetadata: TableMetadata = {
    tableName: "Orders",
    partitionKey: {
      name: "tenantId",
      type: "S",
    },
    sortKey: {
      name: "orderId",
      type: "N",
    },
    globalSecondaryIndexes: [],
  };

  test("builds a GSI query with partition and sort key equality", () => {
    const input = buildQueryInput({
      tableName: "Orders",
      indexName: "CustomerCreatedAtIndex",
      partitionKey: {
        name: "customerId",
        type: "S",
      },
      sortKey: {
        name: "createdAt",
        type: "N",
      },
      partitionKeyValue: "cust#1",
      sortKeyValue: "1700000000",
      pageSize: 25,
    });

    assert.strictEqual(input.IndexName, "CustomerCreatedAtIndex");
    assert.strictEqual(input.KeyConditionExpression, "#pk = :pk AND #sk = :sk");
    assert.deepStrictEqual(input.ExpressionAttributeNames, {
      "#pk": "customerId",
      "#sk": "createdAt",
    });
  });

  test("builds a table query with partition and sort key equality", () => {
    const input = buildQueryInput({
      tableName: "Orders",
      partitionKey: compositeKeyMetadata.partitionKey,
      sortKey: compositeKeyMetadata.sortKey,
      partitionKeyValue: "tenant-1",
      sortKeyValue: "42",
      pageSize: 25,
    });

    assert.strictEqual(input.TableName, "Orders");
    assert.strictEqual(input.IndexName, undefined);
    assert.strictEqual(input.KeyConditionExpression, "#pk = :pk AND #sk = :sk");
    assert.deepStrictEqual(input.ExpressionAttributeNames, {
      "#pk": "tenantId",
      "#sk": "orderId",
    });
  });

  test("converts scalar key types into attribute values", () => {
    assert.deepStrictEqual(toAttributeValue("S", "abc"), { S: "abc" });
    assert.deepStrictEqual(toAttributeValue("N", "42"), { N: "42" });
    assert.deepStrictEqual(toAttributeValue("B", "hello"), {
      B: new TextEncoder().encode("hello"),
    });
  });

  test("rejects invalid numeric key values", () => {
    assert.throws(() => toAttributeValue("N", "forty-two"));
  });

  test("unmarshalls items for display", () => {
    const items = unmarshallItems([
      {
        id: { S: "1" },
        count: { N: "2" },
      },
    ]);

    assert.deepStrictEqual(items, [{ id: "1", count: 2 }]);
  });

  test("collects multiple DynamoDB pages until the requested page size is filled", async () => {
    const firstCursor = { id: { S: "2" } };
    const secondCursor = { id: { S: "3" } };
    const limits: number[] = [];

    const page = await collectResultPage(3, async (limit, cursor) => {
      limits.push(limit);

      if (!cursor) {
        return {
          Items: [{ id: { S: "1" } }],
          LastEvaluatedKey: firstCursor,
        };
      }

      if (cursor === firstCursor) {
        return {
          Items: [{ id: { S: "2" } }, { id: { S: "3" } }],
          LastEvaluatedKey: secondCursor,
        };
      }

      throw new Error("Unexpected cursor.");
    });

    assert.deepStrictEqual(page.items, [{ id: "1" }, { id: "2" }, { id: "3" }]);
    assert.deepStrictEqual(page.lastEvaluatedKey, secondCursor);
    assert.deepStrictEqual(limits, [3, 2]);
  });

  test("stops collecting when DynamoDB has no more pages", async () => {
    const page = await collectResultPage(3, async () => ({
      Items: [{ id: { S: "1" } }],
      LastEvaluatedKey: undefined,
    }));

    assert.deepStrictEqual(page.items, [{ id: "1" }]);
    assert.strictEqual(page.lastEvaluatedKey, undefined);
  });

  test("builds the correct DynamoDB key for partition-only tables", () => {
    const key = buildItemKey(partitionOnlyMetadata, {
      id: "row-1",
      status: "open",
    });

    assert.deepStrictEqual(key, {
      id: { S: "row-1" },
    });
  });

  test("builds the correct DynamoDB key for composite-key tables", () => {
    const key = buildItemKey(compositeKeyMetadata, {
      tenantId: "tenant-1",
      orderId: 42,
      status: "open",
    });

    assert.deepStrictEqual(key, {
      tenantId: { S: "tenant-1" },
      orderId: { N: "42" },
    });
  });

  test("builds a conditional delete for partition-only tables", () => {
    const input = buildDeleteItemInput({
      tableName: "Orders",
      metadata: partitionOnlyMetadata,
      itemKey: { id: "row-1", status: "open" },
    });

    assert.deepStrictEqual(input, {
      TableName: "Orders",
      Key: {
        id: { S: "row-1" },
      },
      ConditionExpression: "attribute_exists(#pk)",
      ExpressionAttributeNames: {
        "#pk": "id",
      },
    });
  });

  test("builds a typed delete key for composite-key tables", () => {
    const input = buildDeleteItemInput({
      tableName: "Orders",
      metadata: compositeKeyMetadata,
      itemKey: { tenantId: "42", orderId: 42.5 },
    });

    assert.deepStrictEqual(input.Key, {
      tenantId: { S: "42" },
      orderId: { N: "42.5" },
    });
    assert.deepStrictEqual(input.ExpressionAttributeNames, {
      "#pk": "tenantId",
    });
  });

  test("rejects delete keys whose values do not match the key schema", () => {
    assert.throws(
      () =>
        buildDeleteItemInput({
          tableName: "Orders",
          metadata: compositeKeyMetadata,
          itemKey: { tenantId: 1, orderId: 42 },
        }),
      /Key attribute "tenantId" must be a string\./u,
    );
    assert.throws(
      () =>
        buildDeleteItemInput({
          tableName: "Orders",
          metadata: compositeKeyMetadata,
          itemKey: { tenantId: "tenant-1", orderId: "42" },
        }),
      /Key attribute "orderId" must be a number\./u,
    );
    assert.throws(
      () =>
        buildDeleteItemInput({
          tableName: "Orders",
          metadata: compositeKeyMetadata,
          itemKey: { tenantId: "tenant-1", orderId: Number.NaN },
        }),
      /Key attribute "orderId" must be a number\./u,
    );
  });

  test("rejects malformed delete keys", () => {
    for (const itemKey of [undefined, null, "id", ["row-1"], new Map()]) {
      assert.throws(
        () =>
          buildDeleteItemInput({
            tableName: "Orders",
            metadata: partitionOnlyMetadata,
            itemKey,
          }),
        /The item key to delete is not valid\./u,
      );
    }

    assert.throws(
      () =>
        buildDeleteItemInput({
          tableName: "Orders",
          metadata: compositeKeyMetadata,
          itemKey: { tenantId: "tenant-1" },
        }),
      /Missing required item attribute "orderId"\./u,
    );
  });

  test("refuses number delete keys that may have lost precision", () => {
    // 0.12345678901234567891 in DynamoDB is read back as this rounded value.
    for (const orderId of [0.12345678901234568, 2 ** 53, 1e21, -(2 ** 60)]) {
      assert.throws(
        () =>
          buildDeleteItemInput({
            tableName: "Orders",
            metadata: compositeKeyMetadata,
            itemKey: { tenantId: "tenant-1", orderId },
          }),
        /Key attribute "orderId" has more precision/u,
      );
    }
  });

  test("accepts number delete keys that are represented exactly", () => {
    const cases: [number | bigint, string][] = [
      [0, "0"],
      [-7, "-7"],
      [Number.MAX_SAFE_INTEGER, "9007199254740991"],
      [0.1, "0.1"],
      [-123456.789012345, "-123456.789012345"],
      [1.5e-7, "1.5e-7"],
      [12345678901234567890n, "12345678901234567890"],
    ];

    for (const [orderId, expected] of cases) {
      const input = buildDeleteItemInput({
        tableName: "Orders",
        metadata: compositeKeyMetadata,
        itemKey: { tenantId: "tenant-1", orderId },
      });

      assert.deepStrictEqual(input.Key?.orderId, { N: expected });
    }
  });

  test("refuses deletes on tables with binary keys", () => {
    const binaryKeyMetadata: TableMetadata = {
      ...compositeKeyMetadata,
      sortKey: { name: "blobId", type: "B" },
    };

    assert.throws(
      () =>
        buildDeleteItemInput({
          tableName: "Orders",
          metadata: binaryKeyMetadata,
          itemKey: { tenantId: "tenant-1", blobId: new Uint8Array([1, 2]) },
        }),
      new RegExp(BINARY_KEY_DELETE_UNSUPPORTED_MESSAGE, "u"),
    );
  });

  test("rejects updates when the partition key changes", () => {
    assert.throws(() =>
      buildUpdateItemInput({
        tableName: "Orders",
        metadata: partitionOnlyMetadata,
        originalItem: {
          id: "row-1",
          status: "open",
        },
        updatedItem: {
          id: "row-2",
          status: "closed",
        },
      }),
    );
  });

  test("builds a replace transaction when the sort key changes", () => {
    const input = buildReplaceItemTransactionInput({
      tableName: "Orders",
      metadata: compositeKeyMetadata,
      originalItem: {
        tenantId: "tenant-1",
        orderId: 42,
        status: "open",
      },
      updatedItem: {
        tenantId: "tenant-1",
        orderId: 43,
        status: "closed",
      },
    });

    assert.deepStrictEqual(input, {
      TransactItems: [
        {
          Put: {
            TableName: "Orders",
            Item: {
              tenantId: { S: "tenant-1" },
              orderId: { N: "43" },
              status: { S: "closed" },
            },
          },
        },
        {
          Delete: {
            TableName: "Orders",
            Key: {
              tenantId: { S: "tenant-1" },
              orderId: { N: "42" },
            },
          },
        },
      ],
    });
  });

  test("rejects replace requests when the partition key changes", () => {
    assert.throws(
      () =>
        buildReplaceItemTransactionInput({
          tableName: "Orders",
          metadata: compositeKeyMetadata,
          originalItem: {
            tenantId: "tenant-1",
            orderId: 42,
            status: "open",
          },
          updatedItem: {
            tenantId: "tenant-2",
            orderId: 43,
            status: "closed",
          },
        }),
      /Primary key attribute "tenantId" cannot be edited\./u,
    );
  });

  test("treats equal binary sort keys as unchanged", () => {
    const binaryKeyMetadata: TableMetadata = {
      tableName: "Orders",
      partitionKey: {
        name: "tenantId",
        type: "S",
      },
      sortKey: {
        name: "blobId",
        type: "B",
      },
      globalSecondaryIndexes: [],
    };

    const input = buildUpdateItemInput({
      tableName: "Orders",
      metadata: binaryKeyMetadata,
      originalItem: {
        tenantId: "tenant-1",
        blobId: new Uint8Array([1, 2, 3]),
        status: "open",
      },
      updatedItem: {
        tenantId: "tenant-1",
        blobId: new Uint8Array([1, 2, 3]),
        status: "closed",
      },
    });

    assert.strictEqual(input.UpdateExpression, "SET #attr0 = :value0");
  });

  test("creates a SET-only update for changed non-key attributes", () => {
    const input = buildUpdateItemInput({
      tableName: "Orders",
      metadata: compositeKeyMetadata,
      originalItem: {
        tenantId: "tenant-1",
        orderId: 42,
        status: "open",
        note: "old",
      },
      updatedItem: {
        tenantId: "tenant-1",
        orderId: 42,
        status: "closed",
        note: "new",
      },
    });

    assert.strictEqual(
      input.UpdateExpression,
      "SET #attr0 = :value0, #attr1 = :value1",
    );
    assert.deepStrictEqual(input.ExpressionAttributeNames, {
      "#attr0": "status",
      "#attr1": "note",
    });
    assert.deepStrictEqual(input.ExpressionAttributeValues, {
      ":value0": { S: "closed" },
      ":value1": { S: "new" },
    });
    assert.strictEqual(input.ReturnValues, "ALL_NEW");
  });

  test("marshals object, array, boolean, and null values in updates", () => {
    const input = buildUpdateItemInput({
      tableName: "Orders",
      metadata: partitionOnlyMetadata,
      originalItem: {
        id: "row-1",
        details: {
          total: 10,
        },
        tags: ["new"],
        active: false,
        archivedAt: "2024-01-01",
      },
      updatedItem: {
        id: "row-1",
        details: {
          total: 12,
          currency: "EUR",
        },
        tags: ["new", "vip"],
        active: true,
        archivedAt: null,
      },
    });

    assert.deepStrictEqual(input.ExpressionAttributeValues, {
      ":value0": {
        M: {
          total: { N: "12" },
          currency: { S: "EUR" },
        },
      },
      ":value1": {
        L: [{ S: "new" }, { S: "vip" }],
      },
      ":value2": {
        BOOL: true,
      },
      ":value3": {
        NULL: true,
      },
    });
  });

  test("rejects update requests when there are no editable changes", () => {
    assert.throws(() =>
      buildUpdateItemInput({
        tableName: "Orders",
        metadata: partitionOnlyMetadata,
        originalItem: {
          id: "row-1",
          status: "open",
        },
        updatedItem: {
          id: "row-1",
          status: "open",
        },
      }),
    );
  });
});
