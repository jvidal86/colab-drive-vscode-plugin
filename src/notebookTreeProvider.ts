import * as vscode from 'vscode';
import { DriveService, FolderNode, NotebookFile } from './driveService';

/**
 * The single source of truth for what the view is doing. Drives both the
 * welcome views and title menus (see package.json):
 *   connecting      -> blank panel (nothing flashes before the state is known)
 *   needsCredentials -> "Set up credentials" welcome
 *   signedOut       -> "Sign in" welcome + Sign in icon
 *   signedIn        -> notebook list (or "No notebooks" hint) + Sign out
 */
export type AuthState =
  | 'connecting'
  | 'needsCredentials'
  | 'signedIn'
  | 'signedOut';

/** A folder row: expandable, holds its FolderNode so children render from the
 *  already-built tree without another fetch. */
export class FolderItem extends vscode.TreeItem {
  constructor(public readonly node: FolderNode) {
    super(node.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = vscode.ThemeIcon.Folder;
    this.contextValue = 'folder';
    this.tooltip = node.name;
  }
}

/** One notebook row in the sidebar tree. */
export class NotebookItem extends vscode.TreeItem {
  constructor(public readonly file: NotebookFile) {
    super(file.name, vscode.TreeItemCollapsibleState.None);

    const isColab = file.mimeType.includes('colaboratory');
    this.description = isColab ? 'Colab' : 'ipynb';
    this.tooltip = `${file.name}\n${
      file.modifiedTime
        ? 'Modified ' + file.modifiedTime.slice(0, 10)
        : ''
    }`;
    this.iconPath = new vscode.ThemeIcon('notebook');
    this.contextValue = 'notebook';
    this.command = {
      command: 'colabDrive.openNotebook',
      title: 'Open notebook',
      arguments: [file],
    };
  }
}

/** Either kind of row the sidebar tree can hold. */
export type DriveTreeItem = FolderItem | NotebookItem;

/**
 * Feeds the sidebar. Holds a reference to the DriveService (set once the
 * user is signed in) and caches the built folder tree.
 */
export class NotebookTreeProvider
  implements vscode.TreeDataProvider<DriveTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    DriveTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private service: DriveService | undefined;
  private root: FolderNode | undefined;
  private errorMessage: string | undefined;
  private setState: ((state: AuthState) => void) | undefined;

  /**
   * Lets the extension share its single state setter so the provider can flip
   * to 'signedIn' only after a fetch finishes (and back to 'connecting' while
   * a fetch is in flight), which is what keeps the welcome views from flashing.
   */
  setStateSetter(setState: (state: AuthState) => void): void {
    this.setState = setState;
  }

  setService(service: DriveService | undefined): void {
    this.service = service;
    this.root = undefined;
    this.errorMessage = undefined;
    this.refresh();
  }

  refresh(): void {
    this.root = undefined;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: DriveTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DriveTreeItem): Promise<DriveTreeItem[]> {
    // Folder rows render their children straight from the already-built tree.
    if (element instanceof FolderItem) {
      return toItems(element.node);
    }
    // Notebook rows are leaves.
    if (element) {
      return [];
    }
    if (!this.service) {
      return [];
    }

    if (this.root === undefined) {
      // Stay in 'connecting' while the tree loads so no welcome shows, then
      // settle on 'signedIn' once we have a result (even an empty/error one).
      this.setState?.('connecting');
      try {
        const folderName = vscode.workspace
          .getConfiguration('colabDrive')
          .get<string>('folderName', '');
        this.root = await this.service.fetchNotebookForest(folderName);
        this.errorMessage = undefined;
      } catch (err: any) {
        this.errorMessage = err?.message ?? String(err);
        vscode.window.showErrorMessage(
          `Colab Drive: ${this.errorMessage}`
        );
        this.root = { id: '', name: '', folders: [], notebooks: [] };
      } finally {
        this.setState?.('signedIn');
      }
    }

    return toItems(this.root);
  }
}

/** Map a folder node's children to tree rows: subfolders first, then notebooks. */
function toItems(node: FolderNode): DriveTreeItem[] {
  return [
    ...node.folders.map((f) => new FolderItem(f)),
    ...node.notebooks.map((n) => new NotebookItem(n)),
  ];
}
