import * as assert from "assert";

import type { TableMetadata } from "../../types";
import {
  formatEditableValue,
  getDirtyColumns,
  getRowKey,
  parseEditedValue,
} from "../../webview/editing";

suite("Webview editing helpers", () => {
  const metadata: TableMetadata = {
    tableName: "Orders",
    partitionKey: {
      name: "id",
      type: "S",
    },
    sortKey: {
      name: "version",
      type: "N",
    },
    globalSecondaryIndexes: [],
  };

  test("formats string editor values without JSON quotes", () => {
    assert.strictEqual(formatEditableValue("hello"), "hello");
  });

  test("formats structured editor values as single-line JSON", () => {
    assert.strictEqual(
      formatEditableValue({
        active: true,
        count: 2,
      }),
      '{"active":true,"count":2}',
    );
  });

  test("parses non-string values from JSON text", () => {
    assert.deepStrictEqual(
      parseEditedValue({ active: false }, '{"active":true}'),
      {
        ok: true,
        value: {
          active: true,
        },
      },
    );
  });

  test("returns a validation error for invalid JSON", () => {
    assert.deepStrictEqual(parseEditedValue({ active: false }, "{bad"), {
      ok: false,
      message: "Enter a valid JSON value.",
    });
  });

  test("dirty-column detection ignores only the partition key", () => {
    const dirtyColumns = getDirtyColumns(
      {
        id: "row-1",
        version: 1,
        status: "open",
        count: 1,
      },
      {
        id: "row-1",
        version: 2,
        status: "closed",
        count: 1,
      },
      metadata,
    );

    assert.deepStrictEqual(dirtyColumns, ["version", "status"]);
  });

  test("row identity is stable for key values", () => {
    const rowKey = getRowKey(
      {
        id: "row-1",
        version: 2,
        status: "open",
      },
      metadata,
    );

    assert.strictEqual(rowKey, JSON.stringify({ id: "row-1", version: 2 }));
  });

  test("dirty-column detection treats nested objects with the same value as equal", () => {
    const dirtyColumns = getDirtyColumns(
      {
        id: "row-1",
        version: 1,
        details: {
          total: 10,
          currency: "EUR",
        },
      },
      {
        id: "row-1",
        version: 1,
        details: {
          total: 10,
          currency: "EUR",
        },
      },
      metadata,
    );

    assert.deepStrictEqual(dirtyColumns, []);
  });

  test("dirty-column detection treats equal binary values as unchanged", () => {
    const dirtyColumns = getDirtyColumns(
      {
        id: "row-1",
        version: 1,
        attachment: new Uint8Array([1, 2, 3]),
      },
      {
        id: "row-1",
        version: 1,
        attachment: new Uint8Array([1, 2, 3]),
      },
      metadata,
    );

    assert.deepStrictEqual(dirtyColumns, []);
  });
});
