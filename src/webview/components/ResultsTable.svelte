<script lang="ts">
  import { createEventDispatcher } from "svelte";

  import { buildPrimaryKeyRecord, supportsItemDelete } from "../../itemKeys";
  import type { TableMetadata } from "../../types";
  import {
    formatCell,
    formatEditableValue,
    getCellKey,
    getRowKey,
    hasOwnColumn,
    isDeleteRowShortcut,
    isPartitionKeyColumn,
  } from "../editing";

  interface UpdateCellDraftDetail {
    item: Record<string, unknown>;
    column: string;
    value: string;
  }

  export let columns: string[];
  export let columnMinWidths: Record<string, string> = {};
  export let items: Record<string, unknown>[];
  export let metadata: TableMetadata;
  export let panelId: string;
  export let dirtyRows: string[] = [];
  export let dirtyColumnsByRowKey: Record<string, string[]> = {};
  export let editedRowsByKey: Record<string, Record<string, unknown>> = {};
  export let cellDrafts: Record<string, string> = {};
  export let invalidCellKeys: string[] = [];
  export let busy = false;
  export let selectedRowKey = "";

  const dispatch = createEventDispatcher<{
    updateCellDraft: UpdateCellDraftDetail;
    selectRow: { item: Record<string, unknown> };
    deleteRow: { item: Record<string, unknown> };
  }>();

  const isMac = /mac/iu.test(navigator.platform);

  // Tables with binary keys get no row context, which hides the Delete Row
  // menu entry: such keys do not survive the trip to the extension host.
  function getRowContext(item: Record<string, unknown>): string | undefined {
    if (!supportsItemDelete(metadata)) {
      return undefined;
    }

    return JSON.stringify({
      webviewSection: "row",
      panelId,
      itemKey: buildPrimaryKeyRecord(metadata, item),
    });
  }

  // Only reacts when the row itself has focus, never a cell editor inside it.
  function handleRowKeydown(
    event: KeyboardEvent,
    item: Record<string, unknown>,
  ): void {
    if (
      event.target !== event.currentTarget ||
      busy ||
      !isDeleteRowShortcut(event, isMac)
    ) {
      return;
    }

    event.preventDefault();
    dispatch("deleteRow", { item });
  }

  function getDisplayValue(
    item: Record<string, unknown>,
    column: string,
  ): unknown {
    const rowKey = getRowKey(item, metadata);
    return editedRowsByKey[rowKey]?.[column] ?? item[column];
  }

  function isEditableCell(
    item: Record<string, unknown>,
    column: string,
  ): boolean {
    return !isPartitionKeyColumn(column, metadata) && hasOwnColumn(item, column);
  }

  function getColumnRole(column: string): "PK" | "SK" | undefined {
    if (column === metadata.partitionKey.name) {
      return "PK";
    }

    if (column === metadata.sortKey?.name) {
      return "SK";
    }

    return undefined;
  }

  function getDraftValue(
    item: Record<string, unknown>,
    column: string,
  ): string {
    const rowKey = getRowKey(item, metadata);
    const cellKey = getCellKey(rowKey, column);
    if (cellKey in cellDrafts) {
      return cellDrafts[cellKey];
    }

    return formatEditableValue(getDisplayValue(item, column));
  }

  function getColumnMinWidth(column: string): string | undefined {
    return columnMinWidths[column];
  }

  function getEditorSize(item: Record<string, unknown>, column: string): number {
    return Math.max(1, Math.min(getDraftValue(item, column).length, 48));
  }

  function isDirtyCell(rowKey: string, column: string): boolean {
    return dirtyColumnsByRowKey[rowKey]?.includes(column) ?? false;
  }

  function isInvalidCell(rowKey: string, column: string): boolean {
    return invalidCellKeys.includes(getCellKey(rowKey, column));
  }

  function isDirtyRow(rowKey: string): boolean {
    return dirtyRows.includes(rowKey);
  }

  function updateCellDraft(
    item: Record<string, unknown>,
    column: string,
    value: string,
  ): void {
    dispatch("updateCellDraft", {
      item,
      column,
      value,
    });
  }

  function focusCellEditor(
    cell: HTMLTableCellElement,
    selectContents = false,
  ): void {
    if (busy) {
      return;
    }

    const editor = cell.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      "input, textarea",
    );
    if (!editor) {
      return;
    }

    editor.focus();

    if (selectContents) {
      editor.select();
    }
  }
</script>

<div class="table-shell">
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          {#each columns as column (column)}
            <th
              class:key-column={isPartitionKeyColumn(column, metadata)}
              style:min-width={getColumnMinWidth(column)}
            >
              <div class="header-cell">
                <span>{column}</span>
                {#if getColumnRole(column)}
                  <span class="column-badge">{getColumnRole(column)}</span>
                {/if}
              </div>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each items as item, index (`${index}`)}
          {@const rowKey = getRowKey(item, metadata)}
          <tr
            class:dirty-row={isDirtyRow(rowKey)}
            class:selected-row={rowKey === selectedRowKey}
            aria-selected={rowKey === selectedRowKey}
            data-row-key={rowKey}
            data-vscode-context={getRowContext(item)}
            tabindex="0"
            on:keydown={(event) => handleRowKeydown(event, item)}
            on:click={() => dispatch("selectRow", { item })}
            on:contextmenu={() => dispatch("selectRow", { item })}
            on:focusin={() => dispatch("selectRow", { item })}
          >
            {#each columns as column (column)}
              {@const displayValue = getDisplayValue(item, column)}
              {@const editable = isEditableCell(item, column)}
              <td
                class:dirty-cell={isDirtyCell(rowKey, column)}
                class:invalid-cell={isInvalidCell(rowKey, column)}
                class:key-cell={isPartitionKeyColumn(column, metadata)}
                style:min-width={getColumnMinWidth(column)}
                on:click={(event) => {
                  if (editable) {
                    focusCellEditor(event.currentTarget);
                  }
                }}
                on:dblclick={(event) => {
                  if (editable) {
                    focusCellEditor(event.currentTarget, true);
                  }
                }}
                title={formatCell(displayValue)}
              >
                {#if editable}
                  <input
                    class="cell-editor"
                    disabled={busy}
                    on:keydown={(event) => {
                      if (event.key === "Escape") {
                        // Hand focus to the row so it stays keyboard-reachable.
                        event.currentTarget.closest("tr")?.focus();
                      }
                    }}
                    on:input={(event) =>
                      updateCellDraft(item, column, event.currentTarget.value)}
                    size={getEditorSize(item, column)}
                    type="text"
                    value={getDraftValue(item, column)}
                  />
                {:else}
                  <code class="cell-value">{formatCell(displayValue)}</code>
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style>
  .table-shell {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    width: 100%;
  }

  .table-scroll {
    min-width: 0;
    min-height: 0;
  }

  .table-scroll {
    --header-height: 34px;
    --row-odd: var(--vscode-editor-background);
    --row-even: color-mix(
      in srgb,
      var(--vscode-editor-background) 90%,
      var(--vscode-editor-foreground) 10%
    );
    --row-hover: color-mix(
      in srgb,
      var(--vscode-editor-background) 86%,
      var(--vscode-editor-foreground) 14%
    );
    --row-dirty: color-mix(
      in srgb,
      var(--vscode-editor-background) 78%,
      var(--vscode-focusBorder) 22%
    );
    --cell-dirty: color-mix(
      in srgb,
      var(--vscode-editor-background) 68%,
      var(--vscode-inputValidation-warningBackground, #8a5a00) 32%
    );
    --cell-invalid: color-mix(
      in srgb,
      var(--vscode-editor-background) 72%,
      var(--vscode-inputValidation-errorBackground, #7f1d1d) 28%
    );
    --row-selected: var(
      --vscode-list-inactiveSelectionBackground,
      color-mix(
        in srgb,
        var(--vscode-editor-background) 80%,
        var(--vscode-editor-foreground) 20%
      )
    );
    flex: 1 1 auto;
    width: 100%;
    overflow: auto;
  }

  table {
    width: max-content;
    min-width: 0;
    border-collapse: collapse;
    table-layout: auto;
  }

  th,
  td {
    position: relative;
    padding: 0;
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    max-width: 48ch;
    text-align: left;
    vertical-align: top;
    white-space: nowrap;
  }

  thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    height: var(--header-height);
    padding: 0 12px;
    vertical-align: middle;
    background: color-mix(
      in srgb,
      var(--vscode-editor-background) 92%,
      var(--vscode-editor-foreground) 8%
    );
    color: var(--vscode-editor-foreground);
    font-size: 0.82rem;
    font-weight: 600;
  }

  thead th.key-column {
    color: var(--vscode-textPreformat-foreground, var(--vscode-editor-foreground));
  }

  .header-cell {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
  }

  .column-badge {
    margin-left: auto;
    color: var(
      --vscode-descriptionForeground,
      color-mix(in srgb, var(--vscode-editor-foreground) 72%, transparent)
    );
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    line-height: 1;
    white-space: nowrap;
  }

  tbody tr:nth-child(odd) td {
    background: var(--row-odd);
  }

  tbody tr:nth-child(even) td {
    background: var(--row-even);
  }

  tbody tr:hover td {
    background: var(--row-hover);
  }

  tbody tr.dirty-row td {
    background: var(--row-dirty);
  }

  tbody tr.selected-row td {
    background: var(--row-selected);
  }

  tbody tr:focus-visible {
    outline: 1px solid
      var(--vscode-focusBorder, var(--vscode-button-background));
    outline-offset: -1px;
  }

  td.dirty-cell {
    background: var(--cell-dirty) !important;
  }

  td.invalid-cell {
    background: var(--cell-invalid) !important;
  }

  td:focus-within::after {
    content: "";
    position: absolute;
    inset: 0;
    border: 1px solid
      var(--vscode-focusBorder, var(--vscode-button-background));
    pointer-events: none;
  }

  .cell-value,
  .cell-editor {
    display: block;
    min-width: 0;
    margin: 0;
    padding: 8px 12px;
    overflow: hidden;
    border: 0;
    background: transparent;
    box-sizing: border-box;
    box-shadow: none;
    color: var(--vscode-editor-foreground);
    font-family: var(
      --vscode-editor-font-family,
      ui-monospace,
      "SFMono-Regular",
      monospace
    );
    font-size: 0.82rem;
  }

  .cell-value {
    line-height: 18px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cell-editor {
    width: 100%;
    height: 34px;
    min-height: 34px;
    line-height: 18px;
    white-space: nowrap;
  }

  .cell-editor:focus-visible {
    outline: none;
  }
</style>
