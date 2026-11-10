import type { KeyMetadata, TableMetadata } from "./types";

export function getPrimaryKeys(metadata: TableMetadata): KeyMetadata[] {
  return metadata.sortKey
    ? [metadata.partitionKey, metadata.sortKey]
    : [metadata.partitionKey];
}

export function buildPrimaryKeyRecord(
  metadata: TableMetadata,
  item: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    getPrimaryKeys(metadata).map((key) => [
      key.name,
      requireItemValue(item, key.name),
    ]),
  );
}

export function buildStableRowKey(
  metadata: TableMetadata,
  item: Record<string, unknown>,
): string {
  const stableKey = Object.fromEntries(
    Object.entries(buildPrimaryKeyRecord(metadata, item)).map(
      ([key, value]) => [key, toStableJsonValue(value)],
    ),
  );

  return JSON.stringify(stableKey);
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

function toStableJsonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return Array.from(value);
  }

  return value;
}
