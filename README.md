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
- Delete an item from the row context menu, or with `Delete` (`Cmd+Backspace` on macOS) while a row has focus. The row is marked in red and is deleted when you save; repeat the action to unmark it. This needs the `dynamodb:DeleteItem` permission and is not supported for tables with binary keys.

## Configuration

| Type       | Name                        | Description                                                        | Default                  |
| ---------- | --------------------------- | ------------------------------------------------------------------ | ------------------------ |
| Setting    | `dynamodb.defaultRegion`    | Fallback AWS region when the selected profile does not define one. | `us-east-1`              |
| Setting    | `dynamodb.pageSize`         | Maximum number of items to load per request.                       | `50`                     |
| Keybinding | `dynamodb.saveTableChanges` | Saves item edits while a table explorer is focused.                | `Cmd+S`/`Ctrl+S`         |
| Keybinding | `dynamodb.executeQuery`     | Runs the current scan or query while a table explorer is focused.  | `Cmd+Enter`/`Ctrl+Enter` |
