import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  type DeleteItemCommandInput,
  DescribeTableCommand,
  ListTablesCommand,
  TransactWriteItemsCommand,
  type TransactWriteItemsCommandInput,
  QueryCommand,
  type QueryCommandInput,
  ScanCommand,
  UpdateItemCommand,
  type UpdateItemCommandInput,
  type AttributeValue,
  type DescribeTableCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

import type {
  ConnectionSelection,
  DynamoCursor,
  IndexMetadata,
  KeyMetadata,
  ResultPage,
  ScalarKeyType,
  TableMetadata,
  TableSummary,
} from "../types";
import { buildPrimaryKeyRecord, getPrimaryKeys } from "../itemKeys";
import { areValuesEqual } from "../valueEquality";
import { createDynamoDbClient } from "./dynamoClient";

interface QueryIndexInputArgs {
  tableName: string;
  index: IndexMetadata;
  partitionKeyValue: string;
  sortKeyValue?: string;
  pageSize: number;
  cursor?: DynamoCursor;
}

interface QueryTableInputArgs {
  tableName: string;
  metadata: Pick<TableMetadata, "partitionKey" | "sortKey">;
  partitionKeyValue: string;
  sortKeyValue?: string;
  pageSize: number;
  cursor?: DynamoCursor;
}

interface QueryInputArgs {
  tableName: string;
  partitionKey: KeyMetadata;
  sortKey?: KeyMetadata;
  partitionKeyValue: string;
  sortKeyValue?: string;
  pageSize: number;
  cursor?: DynamoCursor;
  indexName?: string;
}

interface UpdateItemInputArgs {
  tableName: string;
  metadata: TableMetadata;
  originalItem: Record<string, unknown>;
  updatedItem: Record<string, unknown>;
}

interface DynamoPageResponse {
  Items?: Record<string, AttributeValue>[];
  LastEvaluatedKey?: Record<string, AttributeValue>;
}

export class DynamoService {
  public async listTables(
    connection: ConnectionSelection,
  ): Promise<TableSummary[]> {
    const client = createDynamoDbClient(connection);
    const tableNames: string[] = [];
    let lastEvaluatedTableName: string | undefined;

    do {
      const response = await client.send(
        new ListTablesCommand({
          ExclusiveStartTableName: lastEvaluatedTableName,
        }),
      );
      tableNames.push(...(response.TableNames ?? []));
      lastEvaluatedTableName = response.LastEvaluatedTableName;
    } while (lastEvaluatedTableName);

    return tableNames
      .sort((left, right) => left.localeCompare(right))
      .map((name) => ({ name }));
  }

  public async describeTable(
    connection: ConnectionSelection,
    tableName: string,
  ): Promise<TableMetadata> {
    const client = createDynamoDbClient(connection);
    const response = await client.send(
      new DescribeTableCommand({
        TableName: tableName,
      }),
    );

    return mapTableMetadata(response);
  }

  public async scanTable(
    connection: ConnectionSelection,
    tableName: string,
    pageSize: number,
    cursor?: DynamoCursor,
  ): Promise<ResultPage> {
    const client = createDynamoDbClient(connection);
    return collectResultPage(
      pageSize,
      (limit, pageCursor) =>
        client.send(
          new ScanCommand({
            TableName: tableName,
            Limit: limit,
            ExclusiveStartKey: pageCursor,
          }),
        ),
      cursor,
    );
  }

  public async queryIndex(
    connection: ConnectionSelection,
    input: QueryIndexInputArgs,
  ): Promise<ResultPage> {
    return this.queryItems(connection, {
      tableName: input.tableName,
      indexName: input.index.name,
      partitionKey: input.index.partitionKey,
      sortKey: input.index.sortKey,
      partitionKeyValue: input.partitionKeyValue,
      sortKeyValue: input.sortKeyValue,
      pageSize: input.pageSize,
      cursor: input.cursor,
    });
  }

  public async queryTable(
    connection: ConnectionSelection,
    input: QueryTableInputArgs,
  ): Promise<ResultPage> {
    return this.queryItems(connection, {
      tableName: input.tableName,
      partitionKey: input.metadata.partitionKey,
      sortKey: input.metadata.sortKey,
      partitionKeyValue: input.partitionKeyValue,
      sortKeyValue: input.sortKeyValue,
      pageSize: input.pageSize,
      cursor: input.cursor,
    });
  }

  private async queryItems(
    connection: ConnectionSelection,
    input: QueryInputArgs,
  ): Promise<ResultPage> {
    const client = createDynamoDbClient(connection);
    return collectResultPage(
      input.pageSize,
      (limit, pageCursor) =>
        client.send(
          new QueryCommand(
            buildQueryInput({
              ...input,
              pageSize: limit,
              cursor: pageCursor,
            }),
          ),
        ),
      input.cursor,
    );
  }

  public async deleteItem(
    connection: ConnectionSelection,
    input: DeleteItemCommandInput,
  ): Promise<void> {
    try {
      await createDynamoDbClient(connection).send(new DeleteItemCommand(input));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new Error("The item no longer exists; nothing was deleted.");
      }
      throw error;
    }
  }

  public async updateItem(
    connection: ConnectionSelection,
    input: UpdateItemInputArgs,
  ): Promise<Record<string, unknown>> {
    const client = createDynamoDbClient(connection);
    const changedPrimaryKeys = getChangedPrimaryKeys(
      input.metadata,
      input.originalItem,
      input.updatedItem,
    );

    if (changedPrimaryKeys.length > 0) {
      await client.send(
        new TransactWriteItemsCommand(buildReplaceItemTransactionInput(input)),
      );

      return input.updatedItem;
    }

    const response = await client.send(
      new UpdateItemCommand(buildUpdateItemInput(input)),
    );

    return response.Attributes
      ? (unmarshall(response.Attributes) as Record<string, unknown>)
      : input.updatedItem;
  }
}

export function buildQueryInput({
  tableName,
  partitionKey,
  sortKey,
  partitionKeyValue,
  sortKeyValue,
  pageSize,
  cursor,
  indexName,
}: QueryInputArgs): QueryCommandInput {
  const expressionAttributeNames: Record<string, string> = {
    "#pk": partitionKey.name,
  };
  const expressionAttributeValues: Record<string, AttributeValue> = {
    ":pk": toAttributeValue(partitionKey.type, partitionKeyValue),
  };

  let keyConditionExpression = "#pk = :pk";
  if (sortKey && sortKeyValue) {
    expressionAttributeNames["#sk"] = sortKey.name;
    expressionAttributeValues[":sk"] = toAttributeValue(
      sortKey.type,
      sortKeyValue,
    );
    keyConditionExpression += " AND #sk = :sk";
  }

  return {
    TableName: tableName,
    IndexName: indexName,
    KeyConditionExpression: keyConditionExpression,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    Limit: pageSize,
    ExclusiveStartKey: cursor,
  };
}

export function toAttributeValue(
  keyType: ScalarKeyType,
  value: string,
): AttributeValue {
  const trimmedValue = value.trim();

  switch (keyType) {
    case "S":
      return { S: trimmedValue };
    case "N":
      if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/u.test(trimmedValue)) {
        throw new Error(`"${value}" is not a valid numeric key value.`);
      }
      return { N: trimmedValue };
    case "B":
      return { B: new TextEncoder().encode(trimmedValue) };
  }
}

export function unmarshallItems(
  items: Record<string, AttributeValue>[] | undefined,
): Record<string, unknown>[] {
  return (items ?? []).map(
    (item) => unmarshall(item) as Record<string, unknown>,
  );
}

export async function collectResultPage(
  pageSize: number,
  loadPage: (
    limit: number,
    cursor?: DynamoCursor,
  ) => Promise<DynamoPageResponse>,
  cursor?: DynamoCursor,
): Promise<ResultPage> {
  const items: Record<string, unknown>[] = [];
  let nextCursor = cursor;

  while (items.length < pageSize) {
    const response = await loadPage(pageSize - items.length, nextCursor);
    const pageItems = unmarshallItems(response.Items);

    items.push(...pageItems);
    nextCursor = response.LastEvaluatedKey;

    if (!nextCursor || pageItems.length === 0) {
      break;
    }
  }

  return {
    items,
    lastEvaluatedKey: nextCursor,
  };
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected DynamoDB error.";
}

export function buildItemKey(
  metadata: TableMetadata,
  item: Record<string, unknown>,
): Record<string, AttributeValue> {
  return marshall(buildPrimaryKeyRecord(metadata, item));
}

// The existence condition makes a delete of a missing item fail instead of
// silently succeeding. Binary keys reach the extension host as the same
// Uint8Array the item was read with. Number keys beyond what a JavaScript
// number holds exactly cannot be sent back exactly and are refused.
export function buildDeleteItemInput(
  metadata: TableMetadata,
  itemKey: Record<string, unknown>,
): DeleteItemCommandInput {
  const toKeyValue = (key: KeyMetadata): AttributeValue => {
    const value = itemKey[key.name];
    if (key.type === "S" && typeof value === "string") {
      return { S: value };
    }
    if (key.type === "B" && value instanceof Uint8Array) {
      return { B: value };
    }
    if (key.type === "N" && typeof value === "number") {
      const digits = String(value).replace(/e.*$|[-.]/gu, "");
      if (
        Number.isSafeInteger(value) ||
        (Number.isFinite(value) &&
          !Number.isInteger(value) &&
          digits.replace(/^0+/u, "").length <= 15)
      ) {
        return { N: String(value) };
      }
    }
    throw new Error(
      `Key "${key.name}" cannot be sent back exactly, so the item cannot be deleted from here.`,
    );
  };

  return {
    TableName: metadata.tableName,
    Key: Object.fromEntries(
      getPrimaryKeys(metadata).map((key) => [key.name, toKeyValue(key)]),
    ),
    ConditionExpression: "attribute_exists(#pk)",
    ExpressionAttributeNames: { "#pk": metadata.partitionKey.name },
  };
}

export function buildUpdateItemInput({
  tableName,
  metadata,
  originalItem,
  updatedItem,
}: UpdateItemInputArgs): UpdateItemCommandInput {
  const changedPrimaryKeys = getChangedPrimaryKeys(
    metadata,
    originalItem,
    updatedItem,
  );
  if (changedPrimaryKeys.length > 0) {
    throw new Error(
      `Primary key attribute "${changedPrimaryKeys[0].name}" cannot be edited.`,
    );
  }

  const changedAttributes = getChangedEditableAttributes(
    metadata,
    originalItem,
    updatedItem,
  );

  if (changedAttributes.length === 0) {
    throw new Error("No editable changes to save.");
  }

  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, AttributeValue> = {};
  const setExpressions = changedAttributes.map((attributeName, index) => {
    const nameKey = `#attr${index}`;
    const valueKey = `:value${index}`;

    expressionAttributeNames[nameKey] = attributeName;
    expressionAttributeValues[valueKey] = toDocumentAttributeValue(
      updatedItem[attributeName],
    );

    return `${nameKey} = ${valueKey}`;
  });

  return {
    TableName: tableName,
    Key: buildItemKey(metadata, originalItem),
    UpdateExpression: `SET ${setExpressions.join(", ")}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: "ALL_NEW",
  };
}

export function buildReplaceItemTransactionInput({
  tableName,
  metadata,
  originalItem,
  updatedItem,
}: UpdateItemInputArgs): TransactWriteItemsCommandInput {
  const changedPrimaryKeys = getChangedPrimaryKeys(
    metadata,
    originalItem,
    updatedItem,
  );
  const changedPartitionKey = changedPrimaryKeys.find(
    (key) => key.name === metadata.partitionKey.name,
  );
  if (changedPartitionKey) {
    throw new Error(
      `Primary key attribute "${changedPartitionKey.name}" cannot be edited.`,
    );
  }

  if (
    !metadata.sortKey ||
    changedPrimaryKeys.length !== 1 ||
    changedPrimaryKeys[0].name !== metadata.sortKey.name
  ) {
    throw new Error("Sort key changes are required to replace an item.");
  }

  return {
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: marshall(updatedItem),
        },
      },
      {
        Delete: {
          TableName: tableName,
          Key: buildItemKey(metadata, originalItem),
        },
      },
    ],
  };
}

function mapTableMetadata(response: DescribeTableCommandOutput): TableMetadata {
  const table = response.Table;
  if (!table?.TableName || !table.KeySchema || !table.AttributeDefinitions) {
    throw new Error("DynamoDB returned incomplete table metadata.");
  }

  const attributeTypes = new Map<string, ScalarKeyType>(
    table.AttributeDefinitions.flatMap((definition) => {
      if (!definition.AttributeName || !definition.AttributeType) {
        return [];
      }

      return [
        [definition.AttributeName, definition.AttributeType as ScalarKeyType],
      ];
    }),
  );

  return {
    tableName: table.TableName,
    partitionKey: requireKeyMetadata(
      readKeyMetadata(table.KeySchema, attributeTypes, "HASH"),
      "table partition key",
    ),
    sortKey: readKeyMetadata(table.KeySchema, attributeTypes, "RANGE"),
    globalSecondaryIndexes: (table.GlobalSecondaryIndexes ?? []).flatMap(
      (index) => {
        if (!index.IndexName || !index.KeySchema) {
          return [];
        }

        return [
          {
            name: index.IndexName,
            partitionKey: requireKeyMetadata(
              readKeyMetadata(index.KeySchema, attributeTypes, "HASH"),
              `index partition key for ${index.IndexName}`,
            ),
            sortKey: readKeyMetadata(index.KeySchema, attributeTypes, "RANGE"),
          },
        ];
      },
    ),
  };
}

function toDocumentAttributeValue(value: unknown): AttributeValue {
  return marshall({ value }).value as AttributeValue;
}

function isPrimaryKeyAttribute(
  attributeName: string,
  metadata: TableMetadata,
): boolean {
  return getPrimaryKeys(metadata).some((key) => key.name === attributeName);
}

function getChangedPrimaryKeys(
  metadata: TableMetadata,
  originalItem: Record<string, unknown>,
  updatedItem: Record<string, unknown>,
): KeyMetadata[] {
  return getPrimaryKeys(metadata).filter((key) => {
    const originalValue = requireItemValue(originalItem, key.name);
    const updatedValue = requireItemValue(updatedItem, key.name);
    return !areValuesEqual(originalValue, updatedValue);
  });
}

function getChangedEditableAttributes(
  metadata: TableMetadata,
  originalItem: Record<string, unknown>,
  updatedItem: Record<string, unknown>,
): string[] {
  return Object.keys(originalItem).filter(
    (attributeName) =>
      !isPrimaryKeyAttribute(attributeName, metadata) &&
      attributeName in updatedItem &&
      !areValuesEqual(originalItem[attributeName], updatedItem[attributeName]),
  );
}

function requireItemValue(
  item: Record<string, unknown>,
  attributeName: string,
): unknown {
  if (!(attributeName in item)) {
    throw new Error(`Missing required item attribute "${attributeName}".`);
  }

  return item[attributeName];
}

function readKeyMetadata(
  keySchema:
    | NonNullable<DescribeTableCommandOutput["Table"]>["KeySchema"]
    | undefined,
  attributeTypes: Map<string, ScalarKeyType>,
  keyType: "HASH" | "RANGE",
): KeyMetadata | undefined {
  if (!keySchema) {
    return undefined;
  }

  const schema = keySchema.find((entry) => entry.KeyType === keyType);
  if (!schema?.AttributeName) {
    return undefined;
  }

  const attributeType = attributeTypes.get(schema.AttributeName);
  if (!attributeType) {
    throw new Error(
      `Missing attribute type for key "${schema.AttributeName}".`,
    );
  }

  return {
    name: schema.AttributeName,
    type: attributeType,
  };
}

function requireKeyMetadata(
  metadata: KeyMetadata | undefined,
  label: string,
): KeyMetadata {
  if (!metadata) {
    throw new Error(`Missing ${label} in DynamoDB metadata.`);
  }

  return metadata;
}
