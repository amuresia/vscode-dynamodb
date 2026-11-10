import * as assert from "assert";

import {
  describeItemKey,
  formatKeyValueForDisplay,
  isPlainObject,
  supportsItemDelete,
} from "../../itemKeys";
import type { TableMetadata } from "../../types";

suite("Item key helpers", () => {
  const metadata: TableMetadata = {
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

  test("formats key values as JSON so their type is visible", () => {
    assert.strictEqual(formatKeyValueForDisplay("42"), '"42"');
    assert.strictEqual(formatKeyValueForDisplay(42), "42");
    assert.strictEqual(formatKeyValueForDisplay(42n), "42");
    assert.strictEqual(formatKeyValueForDisplay({ a: 1 }), '{"a":1}');
    assert.strictEqual(formatKeyValueForDisplay(undefined), "undefined");
  });

  test("neutralises line breaks in displayed key values", () => {
    const formatted = formatKeyValueForDisplay(
      "a\nThis cannot be undone.\r\u2028\u2029\u0085b",
    );

    assert.strictEqual(
      formatted,
      '"a\\nThis cannot be undone.\\r\\u2028\\u2029\\u0085b"',
    );
    assert.doesNotMatch(formatted, /[\n\r\u2028\u2029\u0085]/u);
  });

  test("truncates long displayed key values", () => {
    const formatted = formatKeyValueForDisplay("x".repeat(500));

    assert.strictEqual(formatted, `"${"x".repeat(79)}…`);
  });

  test("describes only the primary key attributes, one per line", () => {
    assert.strictEqual(
      describeItemKey(metadata, {
        tenantId: "tenant-1",
        orderId: 42,
        status: "open",
      }),
      '"tenantId": "tenant-1"\n"orderId": 42',
    );
  });

  test("recognises plain objects only", () => {
    assert.strictEqual(isPlainObject({ id: "1" }), true);
    assert.strictEqual(isPlainObject(Object.create(null)), true);
    assert.strictEqual(isPlainObject(null), false);
    assert.strictEqual(isPlainObject(["1"]), false);
    assert.strictEqual(isPlainObject(new Uint8Array([1])), false);
    assert.strictEqual(isPlainObject("id"), false);
  });

  test("supports deletes only for string and number keys", () => {
    assert.strictEqual(supportsItemDelete(metadata), true);
    assert.strictEqual(
      supportsItemDelete({
        ...metadata,
        sortKey: { name: "blobId", type: "B" },
      }),
      false,
    );
  });
});
