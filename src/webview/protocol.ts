import type { DynamoCursor, TableMetadata } from "../types";

export interface ExplorerBootstrap {
  panelId: string;
  pageSize: number;
  metadata: TableMetadata;
}

export type WebviewToExtensionMessage =
  | {
      type: "runScan";
      cursor?: DynamoCursor;
    }
  | {
      type: "runQuery";
      target: "table";
      partitionKeyValue: string;
      sortKeyValue?: string;
      cursor?: DynamoCursor;
    }
  | {
      type: "runQuery";
      target: "index";
      indexName: string;
      partitionKeyValue: string;
      sortKeyValue?: string;
      cursor?: DynamoCursor;
    }
  | {
      type: "saveItems";
      items: {
        originalItem: Record<string, unknown>;
        updatedItem: Record<string, unknown>;
      }[];
    }
  | {
      type: "deleteItem";
      itemKey: unknown;
    };

export type ExtensionToWebviewMessage =
  | {
      type: "setLoading";
      loading: boolean;
      action?: "delete";
    }
  | {
      type: "executeRequested";
    }
  | {
      type: "saveRequested";
    }
  | {
      type: "deleteRequested";
    }
  | {
      type: "results";
      append: boolean;
      items: Record<string, unknown>[];
      cursor?: DynamoCursor;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "itemsSaved";
      items: {
        originalItem: Record<string, unknown>;
        item: Record<string, unknown>;
      }[];
    }
  | {
      type: "itemDeleted";
      itemKey: Record<string, unknown>;
    };
