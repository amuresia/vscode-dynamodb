# DynamoDB Explorer for VS Code

[![Release](https://github.com/riccardopll/vscode-dynamodb/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/riccardopll/vscode-dynamodb/actions/workflows/release.yml)

DynamoDB Explorer gives you a fast and focused workspace inside VS Code so you can inspect tables, query data and make small fixes without leaving the project you are already working in.

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=riccardopll.vscode-dynamodb-explorer) or [Open VSX](https://open-vsx.org/extension/riccardopll/vscode-dynamodb-explorer).

![DynamoDB Explorer demo](media/demo-2x-readme.gif)
![DynamoDB Explorer screenshot](media/screenshot-readme.png)

## Features

- Browse DynamoDB tables directly from the sidebar
- Switch between AWS profiles and regions
- Run table scans and query global secondary indexes
- Edit item values inline and save changes
- Delete an item from the row context menu or the `Delete` key (`Cmd+Backspace` on macOS), with a confirmation prompt

## Configuration

| Type       | Name                        | Description                                                                                                                                               | Default                             |
| ---------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Setting    | `dynamodb.defaultRegion`    | Fallback AWS region when the selected profile does not define one.                                                                                        | `us-east-1`                         |
| Setting    | `dynamodb.pageSize`         | Maximum number of items to load per request.                                                                                                              | `50`                                |
| Keybinding | `dynamodb.saveTableChanges` | Saves item edits while a table explorer is focused.                                                                                                       | `Cmd+S`/`Ctrl+S`                    |
| Keybinding | `dynamodb.executeQuery`     | Runs the current scan or query while a table explorer is focused.                                                                                         | `Cmd+Enter`/`Ctrl+Enter`            |
| Shortcut   | `dynamodb.deleteTableRow`   | Deletes the focused row after confirmation. Only works while a row itself has focus: click a key cell, `Tab` to the row, or press `Esc` in a cell editor. | `Delete` (`Cmd+Backspace` on macOS) |

The delete shortcut is handled inside the results table rather than contributed as a VS Code keybinding, so it never fires while focus is elsewhere. To use a different key, bind the `dynamodb.deleteTableRow` command yourself; it still only acts on a focused row.

## Permissions

The selected AWS profile needs these IAM actions on the tables you work with:

| Action                                    | Used for                                  |
| ----------------------------------------- | ----------------------------------------- |
| `dynamodb:ListTables`                     | Listing tables in the sidebar             |
| `dynamodb:DescribeTable`                  | Opening a table explorer                  |
| `dynamodb:Scan`, `dynamodb:Query`         | Loading rows                              |
| `dynamodb:UpdateItem`                     | Saving edited values                      |
| `dynamodb:PutItem`, `dynamodb:DeleteItem` | Saving an edited sort key (a transaction) |
| `dynamodb:DeleteItem`                     | Deleting a row                            |

## Limitations

- Rows cannot be deleted from tables whose partition or sort key is binary (`B`). The context-menu entry is hidden for those tables and the shortcut reports an error.
- Rows whose number key has more precision than a JavaScript number holds exactly (more than 15 significant digits, or an integer beyond ±2^53 − 1) cannot be deleted from here, because the value shown may be a rounded copy of the stored key.
- A delete only succeeds if the item still exists. If it was removed or re-keyed elsewhere in the meantime, the row stays and an "item no longer exists" error is shown.
