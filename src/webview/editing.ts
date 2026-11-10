import type { TableMetadata } from "../types";
import { buildStableRowKey } from "../itemKeys";
import { areValuesEqual } from "../valueEquality";

interface ParseEditedValueSuccess {
  ok: true;
  value: unknown;
}

interface ParseEditedValueFailure {
  ok: false;
  message: string;
}

export type ParseEditedValueResult =
  | ParseEditedValueSuccess
  | ParseEditedValueFailure;

export function getRowKey(
  item: Record<string, unknown>,
  metadata: TableMetadata,
): string {
  return buildStableRowKey(metadata, item);
}

export function isPartitionKeyColumn(
  column: string,
  metadata: TableMetadata,
): boolean {
  return column === metadata.partitionKey.name;
}

export function hasOwnColumn(
  item: Record<string, unknown>,
  column: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(item, column);
}

export function formatCell(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

export function formatEditableValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "";
  }

  return JSON.stringify(value);
}

export function parseEditedValue(
  originalValue: unknown,
  draftText: string,
): ParseEditedValueResult {
  if (typeof originalValue === "string") {
    return {
      ok: true,
      value: draftText,
    };
  }

  const parsed = tryParseJson(draftText);
  if (!parsed.ok) {
    return parsed;
  }

  if (typeof originalValue === "number") {
    if (typeof parsed.value !== "number" || !Number.isFinite(parsed.value)) {
      return {
        ok: false,
        message: "Enter a valid JSON number.",
      };
    }
  }

  if (typeof originalValue === "boolean" && typeof parsed.value !== "boolean") {
    return {
      ok: false,
      message: "Enter true or false.",
    };
  }

  if (originalValue === null && parsed.value !== null) {
    return {
      ok: false,
      message: "Enter null.",
    };
  }

  if (Array.isArray(originalValue) && !Array.isArray(parsed.value)) {
    return {
      ok: false,
      message: "Enter a JSON array.",
    };
  }

  if (
    isPlainObject(originalValue) &&
    (!isPlainObject(parsed.value) || Array.isArray(parsed.value))
  ) {
    return {
      ok: false,
      message: "Enter a JSON object.",
    };
  }

  return parsed;
}

export function getDirtyColumns(
  originalItem: Record<string, unknown>,
  editedItem: Record<string, unknown>,
  metadata: TableMetadata,
): string[] {
  return Object.keys(originalItem).filter((column) => {
    if (isPartitionKeyColumn(column, metadata)) {
      return false;
    }

    if (!(column in editedItem)) {
      return false;
    }

    return !areValuesEqual(originalItem[column], editedItem[column]);
  });
}

export function getCellKey(rowKey: string, column: string): string {
  return `${rowKey}:${column}`;
}

function tryParseJson(draftText: string): ParseEditedValueResult {
  try {
    return {
      ok: true,
      value: JSON.parse(draftText),
    };
  } catch {
    return {
      ok: false,
      message: "Enter a valid JSON value.",
    };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
