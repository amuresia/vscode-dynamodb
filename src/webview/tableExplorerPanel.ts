import * as vscode from "vscode";

import {
  buildDeleteItemInput,
  DynamoService,
  getErrorMessage,
} from "../aws/dynamoService";
import type {
  ConnectionSelection,
  DynamoCursor,
  TableMetadata,
} from "../types";
import { getTableExplorerHtml } from "./html";
import type {
  ExplorerBootstrap,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from "./protocol";

interface SaveEntry {
  originalItem: Record<string, unknown>;
  updatedItem: Record<string, unknown>;
}

// Applies one save: the edits, then the deletes. It stops at the first
// failure and reports what was applied before it, so the rest stays pending.
export async function saveChanges(
  service: DynamoService,
  connection: ConnectionSelection,
  metadata: TableMetadata,
  entries: SaveEntry[],
  deletes: Record<string, unknown>[],
): Promise<{
  items: {
    originalItem: Record<string, unknown>;
    item: Record<string, unknown>;
  }[];
  deletedKeys: Record<string, unknown>[];
  error?: unknown;
}> {
  const items = [];
  const deletedKeys = [];

  try {
    for (const { originalItem, updatedItem } of entries) {
      const item = await service.updateItem(connection, {
        tableName: metadata.tableName,
        metadata,
        originalItem,
        updatedItem,
      });
      items.push({ originalItem, item });
    }

    for (const itemKey of deletes) {
      await service.deleteItem(
        connection,
        buildDeleteItemInput(metadata, itemKey),
      );
      deletedKeys.push(itemKey);
    }
  } catch (error) {
    return { items, deletedKeys, error };
  }

  return { items, deletedKeys };
}

export class TableExplorerPanel implements vscode.Disposable {
  private static readonly panels = new Map<string, TableExplorerPanel>();
  private static activePanel: TableExplorerPanel | undefined;

  public static createOrReveal(
    extensionUri: vscode.Uri,
    service: DynamoService,
    connection: ConnectionSelection,
    metadata: TableMetadata,
    pageSize: number,
  ): void {
    const key = TableExplorerPanel.getPanelKey(connection, metadata.tableName);
    const existingPanel = TableExplorerPanel.panels.get(key);
    if (existingPanel) {
      existingPanel.panel.reveal(vscode.ViewColumn.One);
      TableExplorerPanel.activePanel = existingPanel;
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "dynamodbTableExplorer",
      `${metadata.tableName} (${connection.region})`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
        retainContextWhenHidden: true,
      },
    );

    const explorerPanel = new TableExplorerPanel(
      key,
      panel,
      extensionUri,
      service,
      connection,
      metadata,
      pageSize,
    );

    TableExplorerPanel.panels.set(key, explorerPanel);
    TableExplorerPanel.activePanel = explorerPanel;
  }

  public static requestDeleteForActivePanel(rowKey: string): boolean {
    return TableExplorerPanel.requestForActivePanel({
      type: "deleteRequested",
      rowKey,
    });
  }

  public static requestSaveForActivePanel(): boolean {
    return TableExplorerPanel.requestForActivePanel({
      type: "saveRequested",
    });
  }

  public static requestRunForActivePanel(): boolean {
    return TableExplorerPanel.requestForActivePanel({
      type: "executeRequested",
    });
  }

  private static requestForActivePanel(
    message: Extract<
      ExtensionToWebviewMessage,
      { type: "executeRequested" | "saveRequested" | "deleteRequested" }
    >,
  ): boolean {
    const activePanel = TableExplorerPanel.activePanel;
    if (!activePanel || !activePanel.panel.active) {
      return false;
    }

    activePanel.postMessage(message);
    return true;
  }

  private constructor(
    private readonly panelKey: string,
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly service: DynamoService,
    private readonly connection: ConnectionSelection,
    private readonly metadata: TableMetadata,
    private readonly pageSize: number,
  ) {
    const bootstrap: ExplorerBootstrap = {
      pageSize,
      metadata,
    };

    this.panel.webview.html = getTableExplorerHtml(
      this.panel.webview,
      this.extensionUri,
      bootstrap,
    );

    this.panel.onDidDispose(() => this.dispose());
    this.panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.active) {
        TableExplorerPanel.activePanel = this;
      }
    });
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => this.handleMessage(message),
    );
  }

  public dispose(): void {
    TableExplorerPanel.panels.delete(this.panelKey);
    if (TableExplorerPanel.activePanel === this) {
      TableExplorerPanel.activePanel = undefined;
    }
  }

  private async handleMessage(
    message: WebviewToExtensionMessage,
  ): Promise<void> {
    switch (message.type) {
      case "saveItems":
        await this.withLoading(async () =>
          this.saveItems(message.items, message.deletes),
        );
        return;
      case "runScan":
        await this.withLoading(async () => this.runScan(message.cursor));
        return;
      case "runQuery":
        await this.withLoading(async () => this.runQuery(message));
    }
  }

  private async withLoading(action: () => Promise<void>): Promise<void> {
    this.postMessage({
      type: "setLoading",
      loading: true,
    });

    try {
      await action();
      this.postMessage({
        type: "error",
        message: "",
      });
    } catch (error) {
      this.postMessage({
        type: "error",
        message: getErrorMessage(error),
      });
    } finally {
      this.postMessage({
        type: "setLoading",
        loading: false,
      });
    }
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async runScan(cursor?: DynamoCursor) {
    const result = await this.service.scanTable(
      this.connection,
      this.metadata.tableName,
      this.pageSize,
      cursor,
    );

    this.postResults(result.items, result.lastEvaluatedKey, Boolean(cursor));
  }

  private async runQuery(
    message: Extract<WebviewToExtensionMessage, { type: "runQuery" }>,
  ) {
    const result =
      message.target === "table"
        ? await this.service.queryTable(this.connection, {
            tableName: this.metadata.tableName,
            metadata: this.metadata,
            partitionKeyValue: message.partitionKeyValue,
            sortKeyValue: message.sortKeyValue,
            pageSize: this.pageSize,
            cursor: message.cursor,
          })
        : await this.queryIndex(message);

    this.postResults(
      result.items,
      result.lastEvaluatedKey,
      Boolean(message.cursor),
    );
  }

  private async queryIndex(
    message: Extract<
      WebviewToExtensionMessage,
      { type: "runQuery"; target: "index" }
    >,
  ) {
    const indexName = message.indexName;
    if (!indexName) {
      throw new Error("Select an index before running a query.");
    }

    const index = this.metadata.globalSecondaryIndexes.find(
      (candidate) => candidate.name === indexName,
    );
    if (!index) {
      throw new Error(`Index "${indexName}" was not found.`);
    }

    return this.service.queryIndex(this.connection, {
      tableName: this.metadata.tableName,
      index,
      partitionKeyValue: message.partitionKeyValue,
      sortKeyValue: message.sortKeyValue,
      pageSize: this.pageSize,
      cursor: message.cursor,
    });
  }

  private postResults(
    items: Record<string, unknown>[],
    cursor: DynamoCursor,
    append: boolean,
  ): void {
    this.postMessage({
      type: "results",
      append,
      items,
      cursor,
    });
  }

  private async saveItems(
    entries: SaveEntry[],
    deletes: Record<string, unknown>[],
  ): Promise<void> {
    const { error, ...saved } = await saveChanges(
      this.service,
      this.connection,
      this.metadata,
      entries,
      deletes,
    );

    this.postMessage({ type: "itemsSaved", ...saved });
    if (error) {
      throw error;
    }
  }

  private static getPanelKey(
    connection: ConnectionSelection,
    tableName: string,
  ): string {
    return `${connection.profile}:${connection.region}:${tableName}`;
  }
}
