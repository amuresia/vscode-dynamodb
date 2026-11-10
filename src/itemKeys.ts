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

export function supportsItemDelete(metadata: TableMetadata): boolean {
  return getPrimaryKeys(metadata).every((key) => key.type !== "B");
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const MAX_DISPLAY_VALUE_LENGTH = 80;

// Renders a key name or value for a confirmation prompt: quoted and escaped
// so it cannot span lines or imitate the surrounding text, and bounded.
export function formatKeyValueForDisplay(value: unknown): string {
  const text = (
    typeof value === "bigint"
      ? value.toString()
      : (JSON.stringify(value) ?? String(value))
  ).replace(
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const characters = Array.from(text);

  return characters.length > MAX_DISPLAY_VALUE_LENGTH
    ? `${characters.slice(0, MAX_DISPLAY_VALUE_LENGTH).join("")}…`
    : text;
}

export function describeItemKey(
  metadata: TableMetadata,
  itemKey: Record<string, unknown>,
): string {
  return getPrimaryKeys(metadata)
    .map(
      (key) =>
        `${formatKeyValueForDisplay(key.name)}: ${formatKeyValueForDisplay(itemKey[key.name])}`,
    )
    .join("\n");
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
  if (!Object.prototype.hasOwnProperty.call(item, attributeName)) {
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
