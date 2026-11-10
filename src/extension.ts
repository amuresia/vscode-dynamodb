import * as vscode from "vscode";

import { DynamoService, getErrorMessage } from "./aws/dynamoService";
import { KNOWN_DYNAMODB_REGIONS } from "./aws/profiles";
import { SessionState } from "./state/sessionState";
import type { ConnectionSelection } from "./types";
import { ConnectionTreeProvider } from "./views/connectionTreeProvider";
import { TableTreeProvider } from "./views/tableTreeProvider";
import { TableExplorerPanel } from "./webview/tableExplorerPanel";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const settings = getExtensionSettings();
  const service = new DynamoService();
  const sessionState = new SessionState(
    context.globalState,
    () => settings.defaultRegion,
  );

  const connectionTreeProvider = new ConnectionTreeProvider(sessionState);
  const tableTreeProvider = new TableTreeProvider(sessionState);

  const connectionTreeView = vscode.window.createTreeView(
    "dynamodbConnection",
    {
      treeDataProvider: connectionTreeProvider,
      showCollapseAll: false,
    },
  );
  const tablesTreeView = vscode.window.createTreeView("dynamodbTables", {
    treeDataProvider: tableTreeProvider,
    showCollapseAll: false,
  });

  context.subscriptions.push(connectionTreeView, tablesTreeView);

  const syncTableSearchContext = async (): Promise<void> => {
    await vscode.commands.executeCommand(
      "setContext",
      "dynamodb.tablesFilterActive",
      tableTreeProvider.hasSearchQuery(),
    );
  };

  const setTableSearchQuery = async (searchQuery: string): Promise<void> => {
    tableTreeProvider.setSearchQuery(searchQuery);
    await syncTableSearchContext();
  };

  const refreshTables = async (showErrors = true): Promise<void> => {
    const connection = sessionState.getConnection();
    if (!connection) {
      tableTreeProvider.refresh("Select an AWS profile to begin");
      connectionTreeView.message = "No AWS profiles found";
      tablesTreeView.message = undefined;
      return;
    }

    tableTreeProvider.refresh("Loading DynamoDB tables...");
    connectionTreeView.message = `${connection.profile} / ${connection.region}`;
    tablesTreeView.message = undefined;

    try {
      const tables = await service.listTables(connection);
      sessionState.setTables(tables);
      connectionTreeView.message = `${connection.profile} / ${connection.region}`;
      tablesTreeView.message = undefined;
    } catch (error) {
      sessionState.clearTables();
      const message = getErrorMessage(error);
      tableTreeProvider.refresh("Unable to load tables");
      connectionTreeView.message = `${connection.profile} / ${connection.region}`;
      tablesTreeView.message = message;
      if (showErrors) {
        void vscode.window.showErrorMessage(
          `Unable to load DynamoDB tables for ${connection.profile} in ${connection.region}: ${message}`,
        );
      }
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("dynamodb.selectProfile", async () => {
      const profiles = sessionState.getProfiles();
      if (profiles.length === 0) {
        void vscode.window.showWarningMessage(
          "No AWS profiles were found in ~/.aws/config or ~/.aws/credentials.",
        );
        return;
      }

      const selectedProfile = await vscode.window.showQuickPick(
        profiles.map((profile) => ({
          label: profile.name,
          description: profile.defaultRegion,
        })),
        {
          placeHolder: "Select an AWS profile",
        },
      );

      if (!selectedProfile) {
        return;
      }

      await sessionState.setActiveProfile(selectedProfile.label);
      await refreshTables();
    }),
    vscode.commands.registerCommand("dynamodb.selectRegion", async () => {
      const connection = sessionState.getConnection();
      if (!connection) {
        void vscode.window.showWarningMessage(
          "Select an AWS profile before choosing a region.",
        );
        return;
      }

      const selectedRegion = await vscode.window.showQuickPick(
        buildRegionQuickPickItems(connection),
        {
          placeHolder: "Select an AWS region",
        },
      );

      if (!selectedRegion) {
        return;
      }

      await sessionState.setActiveRegion(selectedRegion.label);
      await refreshTables();
    }),
    vscode.commands.registerCommand("dynamodb.refreshProfiles", async () => {
      try {
        await sessionState.reloadProfiles();
        const connection = sessionState.getConnection();
        connectionTreeView.message = connection
          ? `${connection.profile} / ${connection.region}`
          : "No AWS profiles found";
        tablesTreeView.message = undefined;
        await refreshTables(false);
      } catch (error) {
        const message = getErrorMessage(error);
        const connection = sessionState.getConnection();
        connectionTreeView.message = connection
          ? `${connection.profile} / ${connection.region}`
          : "No AWS profiles found";
        tablesTreeView.message = message;
        void vscode.window.showErrorMessage(
          `Unable to refresh AWS profiles: ${message}`,
        );
      }
    }),
    vscode.commands.registerCommand("dynamodb.refreshTables", async () => {
      await refreshTables();
    }),
    vscode.commands.registerCommand("dynamodb.searchTables", async () => {
      const input = vscode.window.createInputBox();
      input.title = "Search DynamoDB Tables";
      input.placeholder = "Type a table name";
      input.value = tableTreeProvider.getSearchQuery();

      const disposables: vscode.Disposable[] = [];
      disposables.push(
        input.onDidChangeValue((value) => {
          void setTableSearchQuery(value);
        }),
      );
      disposables.push(
        input.onDidAccept(() => {
          input.hide();
        }),
      );
      disposables.push(
        input.onDidHide(() => {
          vscode.Disposable.from(...disposables).dispose();
          input.dispose();
        }),
      );

      input.show();
    }),
    vscode.commands.registerCommand("dynamodb.clearTableSearch", async () => {
      await setTableSearchQuery("");
    }),
    vscode.commands.registerCommand(
      "dynamodb.saveFavoriteTable",
      async (item?: { tableName?: string } | string) => {
        const tableName = getTableName(item);
        if (!tableName) {
          return;
        }

        await sessionState.setFavoriteTable(tableName, true);
      },
    ),
    vscode.commands.registerCommand(
      "dynamodb.removeFavoriteTable",
      async (item?: { tableName?: string } | string) => {
        const tableName = getTableName(item);
        if (!tableName) {
          return;
        }

        await sessionState.setFavoriteTable(tableName, false);
      },
    ),
    vscode.commands.registerCommand(
      "dynamodb.openTableExplorer",
      async (tableName: string) => {
        const connection = sessionState.getConnection();
        if (!connection) {
          void vscode.window.showWarningMessage(
            "Select an AWS profile before opening a table explorer.",
          );
          return;
        }

        try {
          const metadata = await service.describeTable(connection, tableName);
          TableExplorerPanel.createOrReveal(
            context.extensionUri,
            service,
            connection,
            metadata,
            settings.pageSize,
          );
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Unable to open ${tableName}: ${getErrorMessage(error)}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand("dynamodb.executeQuery", async () => {
      if (TableExplorerPanel.requestRunForActivePanel()) {
        return;
      }

      void vscode.window.showWarningMessage(
        "Open a DynamoDB table explorer to run a scan or query.",
      );
    }),
    vscode.commands.registerCommand(
      "dynamodb.deleteTableRow",
      async (context?: { panelId?: unknown; itemKey?: unknown }) => {
        if (context?.itemKey !== undefined) {
          if (
            await TableExplorerPanel.deleteItemForPanel(
              context.panelId,
              context.itemKey,
            )
          ) {
            return;
          }
        } else if (TableExplorerPanel.requestDeleteForActivePanel()) {
          return;
        }

        void vscode.window.showWarningMessage(
          "Select a row in a DynamoDB table explorer to delete it.",
        );
      },
    ),
    vscode.commands.registerCommand("dynamodb.saveTableChanges", async () => {
      if (TableExplorerPanel.requestSaveForActivePanel()) {
        return;
      }

      void vscode.window.showWarningMessage(
        "Open a DynamoDB table explorer to save item changes.",
      );
    }),
  );

  await sessionState.initialize();
  await syncTableSearchContext();
  {
    const connection = sessionState.getConnection();
    connectionTreeView.message = connection
      ? `${connection.profile} / ${connection.region}`
      : "No AWS profiles found";
    tablesTreeView.message = undefined;
  }
  await refreshTables(false);
}

export function deactivate(): void {}

function buildRegionQuickPickItems(
  connection: ConnectionSelection,
): vscode.QuickPickItem[] {
  const regions = new Set<string>([
    connection.region,
    ...KNOWN_DYNAMODB_REGIONS,
  ]);
  return [...regions]
    .sort((left, right) => left.localeCompare(right))
    .map((region) => ({
      label: region,
      description: region === connection.region ? "Current region" : undefined,
    }));
}

function getExtensionSettings(): {
  defaultRegion: string;
  pageSize: number;
} {
  const configuration = vscode.workspace.getConfiguration();
  const configured = configuration.get<number>("dynamodb.pageSize", 50);

  return {
    defaultRegion: configuration.get<string>(
      "dynamodb.defaultRegion",
      "us-east-1",
    ),
    pageSize: Math.max(1, Math.min(500, configured)),
  };
}

function getTableName(
  item?: { tableName?: string } | string,
): string | undefined {
  if (typeof item === "string") {
    return item;
  }

  return item?.tableName;
}
