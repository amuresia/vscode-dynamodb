<script lang="ts">
  import { onMount } from "svelte";

  import { buildPrimaryKeyRecord } from "../itemKeys";
  import type { DynamoCursor, ExplorerMode, KeyMetadata } from "../types";
  import ResultsTable from "./components/ResultsTable.svelte";
  import {
    formatEditableValue,
    getCellKey,
    getDirtyColumns,
    getRowKey,
    parseEditedValue,
  } from "./editing";
  import type {
    ExplorerBootstrap,
    ExtensionToWebviewMessage,
    WebviewToExtensionMessage,
  } from "./protocol";
  import { collectColumnMinWidths, collectResultColumns } from "./results";
  interface ResultPage {
    items: Record<string, unknown>[];
    nextCursor?: DynamoCursor;
  }

  interface QueryRequestScan {
    type: "runScan";
  }

  interface QueryRequestIndex {
    type: "runQuery";
    target: "index";
    indexName: string;
    partitionKeyValue: string;
    sortKeyValue?: string;
  }

  interface QueryRequestTable {
    type: "runQuery";
    target: "table";
    partitionKeyValue: string;
    sortKeyValue?: string;
  }

  interface UpdateCellDraftDetail {
    item: Record<string, unknown>;
    column: string;
    value: string;
  }

  type QueryRequest = QueryRequestScan | QueryRequestIndex | QueryRequestTable;
  type QueryDefinition = QueryRequestIndex | QueryRequestTable;
  type QueryTarget = QueryDefinition["target"];
  type BusyAction = "query" | "save" | undefined;

  interface VsCodeApi {
    postMessage(message: WebviewToExtensionMessage): void;
  }

  export let bootstrap: ExplorerBootstrap;
  export let vscode: VsCodeApi;

  let mode: ExplorerMode = "scan";
  let queryTarget: QueryTarget = "table";
  let selectedIndexName =
    bootstrap.metadata.globalSecondaryIndexes[0]?.name ?? "";
  let partitionKeyValue = "";
  let sortKeyValue = "";
  let pages: ResultPage[] = [];
  let currentPageIndex = 0;
  let loading = false;
  let busyAction: BusyAction;
  let requestError = "";
  let lastQuery: QueryRequest | undefined;
  let pendingPageIndex: number | undefined;
  let originalRowsByKey: Record<string, Record<string, unknown>> = {};
  let editedRowsByKey: Record<string, Record<string, unknown>> = {};
  let dirtyColumnsByRowKey: Record<string, string[]> = {};
  let cellDrafts: Record<string, string> = {};
  let invalidCells: Record<string, string> = {};
  let pendingDeletes: Record<string, Record<string, unknown>> = {};
  let savedMessageVisible = false;
  let savedMessageTimer: ReturnType<typeof setTimeout> | undefined;

  $: queryIndexes = bootstrap.metadata.globalSecondaryIndexes;
  $: selectedIndex = queryIndexes.find(
    (index) => index.name === selectedIndexName,
  );
  $: queryKeys = getQueryKeys();
  $: queryPartitionKey = queryKeys?.partitionKey;
  $: querySortKey = queryKeys?.sortKey;
  $: currentPage = pages[currentPageIndex];
  $: items = currentPage?.items ?? [];
  $: loadedItems = pages.flatMap((page) => page.items);
  $: columns = collectResultColumns(loadedItems, bootstrap.metadata);
  $: columnMinWidths = collectColumnMinWidths(
    columns,
    loadedItems,
    bootstrap.metadata,
  );
  $: hasResults = items.length > 0;
  $: canRunQuery =
    !loading && (queryTarget === "table" || Boolean(selectedIndex));
  $: canGoPrevious = !loading && currentPageIndex > 0;
  $: canGoNext =
    !loading &&
    Boolean(currentPageIndex < pages.length - 1 || currentPage?.nextCursor);
  $: currentPageNumber = currentPageIndex + 1;
  $: dirtyRowKeys = Object.keys(dirtyColumnsByRowKey);
  $: invalidCellKeys = Object.keys(invalidCells);
  $: dirtyCellCount = dirtyRowKeys.reduce(
    (count, rowKey) => count + dirtyColumnsByRowKey[rowKey].length,
    0,
  );
  $: deletedRowKeys = Object.keys(pendingDeletes);
  $: hasPendingEdits =
    dirtyRowKeys.length > 0 ||
    invalidCellKeys.length > 0 ||
    deletedRowKeys.length > 0;
  $: canSave =
    !loading &&
    (dirtyRowKeys.length > 0 || deletedRowKeys.length > 0) &&
    invalidCellKeys.length === 0;
  $: busyLabel =
    busyAction === "save" && loading
      ? "Saving..."
      : loading
        ? "Running..."
        : "";
  $: validationError =
    invalidCellKeys.length > 0 ? invalidCells[invalidCellKeys[0]] : "";
  $: error = validationError || requestError;

  onMount(() => {
    const handleMessage = (
      event: MessageEvent<ExtensionToWebviewMessage>,
    ): void => {
      const message = event.data;

      switch (message.type) {
        case "setLoading":
          loading = message.loading;
          if (!message.loading) {
            busyAction = undefined;
          }
          return;
        case "error":
          pendingPageIndex = undefined;
          requestError = message.message;
          return;
        case "results":
          applyResultsPage(message.items, message.cursor, message.append);
          pendingPageIndex = undefined;
          clearEditingState();
          return;
        case "deleteRequested":
          toggleDelete(message.itemKey);
          return;
        case "itemsSaved":
          for (const entry of message.items) {
            applySavedItem(
              entry.item,
              getRowKey(entry.originalItem, bootstrap.metadata),
            );
          }
          message.deletedKeys.forEach(applyDeletedItem);
          requestError = "";
          if (message.items.length + message.deletedKeys.length > 0) {
            showSavedMessage();
          }
          return;
        case "executeRequested":
          runActiveRequest();
          return;
        case "saveRequested":
          saveChanges();
          return;
      }
    };

    window.addEventListener("message", handleMessage);

    return () => {
      window.removeEventListener("message", handleMessage);
      clearSavedMessageTimer();
    };
  });

  function switchMode(nextMode: ExplorerMode): void {
    if (nextMode === mode) {
      return;
    }

    updateResultContext(() => {
      mode = nextMode;
    });
  }

  function selectIndex(nextIndexName: string): void {
    if (nextIndexName === selectedIndexName) {
      return;
    }

    updateResultContext(() => {
      selectedIndexName = nextIndexName;
      clearQueryInputs();
    });
  }

  function selectQueryTarget(nextTarget: QueryTarget): void {
    if (nextTarget === queryTarget) {
      return;
    }

    if (nextTarget === "index" && queryIndexes.length === 0) {
      return;
    }

    updateResultContext(() => {
      queryTarget = nextTarget;
      clearQueryInputs();
    });
  }

  function updatePartitionKey(value: string): void {
    if (value === partitionKeyValue) {
      return;
    }

    updateResultContext(() => {
      partitionKeyValue = value;
    });
  }

  function updateSortKey(value: string): void {
    if (value === sortKeyValue) {
      return;
    }

    updateResultContext(() => {
      sortKeyValue = value;
    });
  }

  function runScan(): void {
    resetResults();
    lastQuery = { type: "runScan" };
    busyAction = "query";
    postMessage({ type: "runScan" });
  }

  function runQuery(): void {
    if (!queryKeys) {
      requestError =
        queryTarget === "table"
          ? "Table key metadata is unavailable."
          : "Select an index before running a query.";
      return;
    }

    if (!partitionKeyValue.trim()) {
      requestError = `${queryKeys.partitionKey.name} is required.`;
      return;
    }

    const nextQuery = buildQueryRequest();
    if (!nextQuery) {
      requestError = "Select an index before running a query.";
      return;
    }

    resetResults();
    lastQuery = nextQuery;
    busyAction = "query";
    postQueryRequest(nextQuery);
  }

  function runActiveRequest(): void {
    if (!confirmDiscardPendingEdits()) {
      return;
    }

    if (mode === "scan") {
      runScan();
      return;
    }

    runQuery();
  }

  function loadMore(): void {
    if (!lastQuery) {
      return;
    }

    if (!confirmDiscardPendingEdits()) {
      return;
    }

    if (currentPageIndex < pages.length - 1) {
      currentPageIndex += 1;
      return;
    }

    const cursor = currentPage?.nextCursor;
    if (!cursor) {
      return;
    }

    pendingPageIndex = currentPageIndex + 1;
    busyAction = "query";
    postQueryRequest(lastQuery, cursor);
  }

  function showPreviousPage(): void {
    if (currentPageIndex === 0 || loading) {
      return;
    }

    if (!confirmDiscardPendingEdits()) {
      return;
    }

    currentPageIndex -= 1;
  }

  function handleUpdateCellDraft(
    event: CustomEvent<UpdateCellDraftDetail>,
  ): void {
    const { item, column, value } = event.detail;
    const rowKey = getRowKey(item, bootstrap.metadata);
    const cellKey = getCellKey(rowKey, column);
    const originalRow = originalRowsByKey[rowKey] ?? structuredClone(item);
    const originalValue = originalRow[column];

    originalRowsByKey = {
      ...originalRowsByKey,
      [rowKey]: originalRow,
    };
    cellDrafts = {
      ...cellDrafts,
      [cellKey]: value,
    };
    requestError = "";
    clearSavedMessage();

    const result = parseEditedValue(originalValue, value);
    if (!result.ok) {
      invalidCells = {
        ...invalidCells,
        [cellKey]: result.message,
      };
      return;
    }

    invalidCells = omitKey(invalidCells, cellKey);

    const nextEditedRow = structuredClone(
      editedRowsByKey[rowKey] ?? originalRow,
    );
    nextEditedRow[column] = result.value;

    const nextDirtyColumns = getDirtyColumns(
      originalRow,
      nextEditedRow,
      bootstrap.metadata,
    );

    if (nextDirtyColumns.length === 0) {
      editedRowsByKey = omitKey(editedRowsByKey, rowKey);
      dirtyColumnsByRowKey = omitKey(dirtyColumnsByRowKey, rowKey);
      cellDrafts = omitKey(cellDrafts, cellKey);
      return;
    }

    editedRowsByKey = {
      ...editedRowsByKey,
      [rowKey]: nextEditedRow,
    };
    dirtyColumnsByRowKey = {
      ...dirtyColumnsByRowKey,
      [rowKey]: nextDirtyColumns,
    };

    if (value === formatEditableValue(result.value)) {
      cellDrafts = omitKey(cellDrafts, cellKey);
    }
  }

  function saveChanges(): void {
    if (!canSave) {
      return;
    }

    requestError = "";
    busyAction = "save";
    clearSavedMessage();
    postMessage({
      type: "saveItems",
      items: dirtyRowKeys.map((rowKey) => ({
        originalItem: originalRowsByKey[rowKey],
        updatedItem: editedRowsByKey[rowKey],
      })),
      deletes: Object.values(pendingDeletes),
    });
  }

  function confirmDiscardPendingEdits(): boolean {
    if (!hasPendingEdits) {
      return true;
    }

    const shouldDiscard = window.confirm("Discard unsaved changes?");
    if (!shouldDiscard) {
      return false;
    }

    clearEditingState();
    requestError = "";
    return true;
  }

  function applySavedItem(
    item: Record<string, unknown>,
    previousRowKey: string,
  ): void {
    const nextPageItems = items.map((candidate) =>
      getRowKey(candidate, bootstrap.metadata) === previousRowKey
        ? item
        : candidate,
    );

    pages = pages.map((page, index) =>
      index === currentPageIndex
        ? {
            ...page,
            items: nextPageItems,
          }
        : page,
    );

    clearRowEditingState(previousRowKey);
  }

  // Marks a row for deletion, or unmarks it. Nothing is deleted until save.
  function toggleDelete(itemKey: Record<string, unknown>): void {
    const { partitionKey, sortKey } = bootstrap.metadata;
    const rowKey = getRowKey(itemKey, bootstrap.metadata);
    if (loading) {
      return;
    }

    clearSavedMessage();
    if (rowKey in pendingDeletes) {
      pendingDeletes = omitKey(pendingDeletes, rowKey);
    } else if (partitionKey.type === "B" || sortKey?.type === "B") {
      requestError = "Deleting items with binary keys is not supported.";
    } else {
      // The delete wins over any edits staged on the row.
      clearRowEditingState(rowKey);
      pendingDeletes = { ...pendingDeletes, [rowKey]: itemKey };
    }
  }

  function applyDeletedItem(itemKey: Record<string, unknown>): void {
    const rowKey = getRowKey(itemKey, bootstrap.metadata);
    pages = pages.map((page) => ({
      ...page,
      items: page.items.filter(
        (item) => getRowKey(item, bootstrap.metadata) !== rowKey,
      ),
    }));
    pendingDeletes = omitKey(pendingDeletes, rowKey);
    clearRowEditingState(rowKey);
  }

  function clearRowEditingState(rowKey: string): void {
    originalRowsByKey = omitKey(originalRowsByKey, rowKey);
    editedRowsByKey = omitKey(editedRowsByKey, rowKey);
    dirtyColumnsByRowKey = omitKey(dirtyColumnsByRowKey, rowKey);
    cellDrafts = omitPrefixedKeys(cellDrafts, `${rowKey}:`);
    invalidCells = omitPrefixedKeys(invalidCells, `${rowKey}:`);
  }

  function clearEditingState(): void {
    originalRowsByKey = {};
    editedRowsByKey = {};
    dirtyColumnsByRowKey = {};
    cellDrafts = {};
    invalidCells = {};
    pendingDeletes = {};
    clearSavedMessage();
  }

  function resetResults(): void {
    pages = [];
    currentPageIndex = 0;
    pendingPageIndex = undefined;
    clearEditingState();
    requestError = "";
  }

  function updateResultContext(change: () => void): void {
    if (!confirmDiscardPendingEdits()) {
      return;
    }

    change();
    resetResults();
  }

  function applyResultsPage(
    items: Record<string, unknown>[],
    nextCursor: DynamoCursor,
    append: boolean,
  ): void {
    if (!append) {
      pages = [{ items, nextCursor }];
      currentPageIndex = 0;
      return;
    }

    const nextPageIndex = pendingPageIndex ?? pages.length;
    pages = [...pages.slice(0, nextPageIndex), { items, nextCursor }];
    currentPageIndex = nextPageIndex;
  }

  function getQueryKeys():
    | {
        partitionKey: KeyMetadata;
        sortKey?: KeyMetadata;
      }
    | undefined {
    if (queryTarget === "table") {
      return {
        partitionKey: bootstrap.metadata.partitionKey,
        sortKey: bootstrap.metadata.sortKey,
      };
    }

    if (!selectedIndex) {
      return undefined;
    }

    return {
      partitionKey: selectedIndex.partitionKey,
      sortKey: selectedIndex.sortKey,
    };
  }

  function buildQueryRequest(): QueryDefinition | undefined {
    if (queryTarget === "table") {
      return {
        type: "runQuery",
        target: "table",
        partitionKeyValue,
        sortKeyValue: sortKeyValue || undefined,
      };
    }

    if (!selectedIndex) {
      return undefined;
    }

    return {
      type: "runQuery",
      target: "index",
      indexName: selectedIndex.name,
      partitionKeyValue,
      sortKeyValue: sortKeyValue || undefined,
    };
  }

  function postQueryRequest(query: QueryRequest, cursor?: DynamoCursor): void {
    if (query.type === "runScan") {
      postMessage({
        type: "runScan",
        cursor,
      });
      return;
    }

    postMessage({
      ...query,
      cursor,
    });
  }

  function clearQueryInputs(): void {
    partitionKeyValue = "";
    sortKeyValue = "";
  }

  function postMessage(message: WebviewToExtensionMessage): void {
    vscode.postMessage(message);
  }

  function getEmptyMessage(): string {
    if (loading) {
      return "Loading rows...";
    }

    if (lastQuery) {
      return "No rows returned for this request.";
    }

    return "Run a scan or query to load rows.";
  }

  function omitKey<T extends Record<string, unknown>>(
    record: T,
    key: string,
  ): T {
    const { [key]: _removed, ...rest } = record;
    return rest as T;
  }

  function omitPrefixedKeys<T extends Record<string, unknown>>(
    record: T,
    prefix: string,
  ): T {
    return Object.fromEntries(
      Object.entries(record).filter(([key]) => !key.startsWith(prefix)),
    ) as T;
  }

  function showSavedMessage(): void {
    clearSavedMessageTimer();
    savedMessageVisible = true;
    savedMessageTimer = setTimeout(() => {
      savedMessageVisible = false;
      savedMessageTimer = undefined;
    }, 2000);
  }

  function clearSavedMessage(): void {
    clearSavedMessageTimer();
    savedMessageVisible = false;
  }

  function clearSavedMessageTimer(): void {
    if (!savedMessageTimer) {
      return;
    }

    clearTimeout(savedMessageTimer);
    savedMessageTimer = undefined;
  }
</script>

<svelte:head>
  <title>DynamoDB Explorer</title>
</svelte:head>

<div class="shell">
  <section class="controls-panel">
    <div class="controls-row">
      <label class="field mode-field">
        <span>Mode</span>
        <select
          disabled={loading}
          on:change={(event) =>
            switchMode(event.currentTarget.value as ExplorerMode)}
          value={mode}
        >
          <option value="scan">Scan</option>
          <option value="query">Query</option>
        </select>
      </label>

      {#if mode === "query"}
        {#if queryIndexes.length > 0}
          <label class="field query-field">
            <span>Target</span>
            <select
              disabled={loading}
              on:change={(event) =>
                selectQueryTarget(
                  event.currentTarget.value as "table" | "index",
                )}
              value={queryTarget}
            >
              <option value="table">Table</option>
              <option value="index">GSI</option>
            </select>
          </label>
        {/if}

        {#if queryTarget === "index"}
          <label class="field query-field">
            <span>Index</span>
            <select
              disabled={loading || queryIndexes.length === 0}
              on:change={(event) => selectIndex(event.currentTarget.value)}
              value={selectedIndexName}
            >
              {#each queryIndexes as index (index.name)}
                <option value={index.name}>{index.name}</option>
              {/each}
            </select>
          </label>
        {/if}

        {#if queryPartitionKey}
          <label class="field query-field">
            <span>{queryPartitionKey.name}</span>
            <input
              disabled={loading}
              on:input={(event) =>
                updatePartitionKey(event.currentTarget.value)}
              placeholder={queryPartitionKey.type}
              value={partitionKeyValue}
            />
          </label>

          {#if querySortKey}
            <label class="field query-field">
              <span>{querySortKey.name}</span>
              <input
                disabled={loading}
                on:input={(event) => updateSortKey(event.currentTarget.value)}
                placeholder={querySortKey.type}
                value={sortKeyValue}
              />
            </label>
          {/if}
        {/if}
      {/if}

      <div class="actions">
        <button
          aria-label={mode === "scan" ? "Run Scan" : "Run Query"}
          class="run-button"
          disabled={loading || (mode === "query" && !canRunQuery)}
          on:click={runActiveRequest}
          type="button"
        >
          ▶
        </button>
      </div>
    </div>

    <div class="meta-row">
      <span>{bootstrap.metadata.tableName}</span>
      <span>{bootstrap.pageSize} / page</span>
      {#if busyLabel}
        <span>{busyLabel}</span>
      {/if}
      {#if !loading && savedMessageVisible}
        <span>Saved!</span>
      {/if}
      {#if deletedRowKeys.length > 0}
        <span
          >{deletedRowKeys.length} row{deletedRowKeys.length === 1 ? "" : "s"} to
          delete</span
        >
      {/if}
      {#if dirtyCellCount > 0}
        <span
          >{dirtyCellCount} field{dirtyCellCount === 1 ? "" : "s"} staged</span
        >
      {/if}
      {#if dirtyCellCount + deletedRowKeys.length > 0}
        <button
          class="save-link"
          disabled={!canSave}
          on:click={saveChanges}
          type="button"
        >
          Save changes?
        </button>
      {/if}
      {#if pages.length > 0}
        <div aria-label="Pagination" class="pager" role="group">
          <button
            aria-label="Previous page"
            class="pager-button"
            disabled={!canGoPrevious}
            on:click={showPreviousPage}
            type="button"
          >
            ←
          </button>
          <span class="pager-label">Page {currentPageNumber}</span>
          <button
            aria-label="Next page"
            class="pager-button"
            disabled={!canGoNext}
            on:click={loadMore}
            type="button"
          >
            →
          </button>
        </div>
      {/if}
    </div>

    {#if error}
      <p class="error-banner" role="alert">{error}</p>
    {/if}
  </section>

  <section class="results-panel">
    <div class="results-content">
      {#if hasResults}
        <ResultsTable
          {columns}
          {columnMinWidths}
          {items}
          metadata={bootstrap.metadata}
          busy={loading}
          dirtyRows={dirtyRowKeys}
          {dirtyColumnsByRowKey}
          {editedRowsByKey}
          {cellDrafts}
          {invalidCellKeys}
          on:updateCellDraft={handleUpdateCellDraft}
          deletedRows={deletedRowKeys}
          on:deleteRow={(event) =>
            toggleDelete(
              buildPrimaryKeyRecord(bootstrap.metadata, event.detail.item),
            )}
        />
      {:else}
        <div class="empty-state">
          <p>{getEmptyMessage()}</p>
        </div>
      {/if}
    </div>
  </section>
</div>

<style>
  :global(html),
  :global(body),
  :global(#root) {
    min-height: 100%;
  }

  :global(body) {
    margin: 0;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    overflow: hidden;
  }

  :global(button),
  :global(input),
  :global(select) {
    font: inherit;
  }

  .shell {
    --bg: var(--vscode-editor-background);
    --border: var(
      --vscode-panel-border,
      color-mix(in srgb, var(--vscode-editor-foreground) 16%, transparent)
    );
    --text: var(--vscode-editor-foreground);
    --text-muted: var(
      --vscode-descriptionForeground,
      color-mix(in srgb, var(--text) 64%, transparent)
    );
    --accent: var(--vscode-button-background);
    --accent-foreground: var(--vscode-button-foreground);
    --focus: var(--vscode-focusBorder, var(--accent));
    --input-bg: var(--vscode-input-background, var(--bg));
    --input-border: var(--vscode-input-border, var(--border));
    --input-text: var(--vscode-input-foreground, var(--text));
    --danger: var(--vscode-errorForeground, #c72e2e);
    --danger-bg: color-mix(in srgb, var(--danger) 14%, var(--bg));

    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 10px;
    gap: 10px;
    box-sizing: border-box;
    overflow-y: scroll;
    scrollbar-gutter: stable;
    scrollbar-color: color-mix(
        in srgb,
        var(--vscode-editor-foreground) 28%,
        transparent
      )
      color-mix(in srgb, var(--vscode-editor-background) 92%, var(--border));
    scrollbar-width: auto;
  }

  .shell::-webkit-scrollbar {
    width: 12px;
  }

  .shell::-webkit-scrollbar-track {
    background: color-mix(
      in srgb,
      var(--vscode-editor-background) 92%,
      var(--border)
    );
  }

  .shell::-webkit-scrollbar-thumb {
    background: color-mix(
      in srgb,
      var(--vscode-editor-foreground) 28%,
      transparent
    );
    border: 3px solid
      color-mix(in srgb, var(--vscode-editor-background) 92%, var(--border));
    border-radius: 999px;
  }

  .controls-panel,
  .results-panel {
    border: 1px solid var(--border);
    background: var(--bg);
  }

  .controls-panel {
    flex: 0 0 auto;
    padding: 10px;
  }

  .controls-row {
    display: flex;
    align-items: end;
    gap: 10px;
    flex-wrap: nowrap;
  }

  .mode-field {
    flex: 1 1 0;
    min-width: 0;
  }

  .field {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .query-field {
    flex: 1 1 0;
  }

  .field span,
  .meta-row {
    color: var(--text-muted);
    font-family: var(
      --vscode-editor-font-family,
      ui-monospace,
      "SFMono-Regular",
      monospace
    );
    font-size: 0.78rem;
  }

  .field input,
  .field select {
    width: 100%;
    min-height: 32px;
    padding: 0 10px;
    border: 1px solid var(--input-border);
    border-radius: 0;
    background: var(--input-bg);
    color: var(--input-text);
    box-sizing: border-box;
  }

  .actions {
    display: flex;
    align-items: end;
    flex: 0 0 auto;
  }

  .run-button,
  .pager-button {
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 0;
    cursor: pointer;
  }

  .run-button {
    background: var(--accent);
    color: var(--accent-foreground);
  }

  .pager {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
  }

  .pager-button {
    min-width: 32px;
    min-height: 24px;
    padding: 0 6px;
    background: transparent;
    color: var(--text-muted);
    border: 0;
  }

  .pager-button:not(:disabled):hover {
    color: var(--text);
  }

  .pager-label {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 0 4px;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .meta-row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    min-height: 24px;
    padding-top: 10px;
  }

  .save-link {
    display: inline-flex;
    align-items: center;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--vscode-textLink-foreground, var(--text));
    cursor: pointer;
    font: inherit;
    line-height: inherit;
    text-decoration: underline;
  }

  .save-link:hover:not(:disabled) {
    color: var(--vscode-textLink-activeForeground, var(--text));
  }

  .error-banner {
    margin: 10px 0 0;
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
    background: var(--danger-bg);
    color: var(--danger);
  }

  .results-panel {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  .results-content {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    width: 100%;
  }

  .empty-state {
    display: grid;
    flex: 1 1 auto;
    place-items: center;
    width: 100%;
    min-height: 0;
    box-sizing: border-box;
  }

  .empty-state p {
    margin: 0;
    color: var(--text-muted);
  }

  button:disabled,
  input:disabled,
  select:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  button:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: 1px solid var(--focus);
    outline-offset: -1px;
  }
</style>
