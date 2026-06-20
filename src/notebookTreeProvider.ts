import * as vscode from 'vscode';
import { DriveService, NotebookFile } from './driveService';

/**
 * The single source of truth for what the view is doing. Drives both the
 * welcome views and title menus (see package.json):
 *   connecting -> blank panel (nothing flashes before the real state is known)
 *   signedOut  -> "Sign in" welcome + Sign in icon
 *   signedIn   -> notebook list (or "No notebooks" hint) + Sign out
 */
export type AuthState = 'connecting' | 'signedIn' | 'signedOut';

/** One row in the sidebar tree. */
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

/**
 * Feeds the sidebar. Holds a reference to the DriveService (set once the
 * user is signed in) and the configured folder name.
 */
export class NotebookTreeProvider
  implements vscode.TreeDataProvider<NotebookItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    NotebookItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private service: DriveService | undefined;
  private cache: NotebookFile[] | undefined;
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
    this.cache = undefined;
    this.errorMessage = undefined;
    this.refresh();
  }

  refresh(): void {
    this.cache = undefined;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: NotebookItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: NotebookItem): Promise<NotebookItem[]> {
    if (element) {
      return [];
    }
    if (!this.service) {
      return [];
    }

    if (this.cache === undefined) {
      // Stay in 'connecting' while the list loads so no welcome shows, then
      // settle on 'signedIn' once we have a result (even an empty/error one).
      this.setState?.('connecting');
      try {
        const folderName = vscode.workspace
          .getConfiguration('colabDrive')
          .get<string>('folderName', 'Colab Notebooks');
        this.cache = await this.service.listNotebooks(folderName);
        this.errorMessage = undefined;
      } catch (err: any) {
        this.errorMessage = err?.message ?? String(err);
        vscode.window.showErrorMessage(
          `Colab Drive: ${this.errorMessage}`
        );
        this.cache = [];
      } finally {
        this.setState?.('signedIn');
      }
    }

    return this.cache.map((f) => new NotebookItem(f));
  }
}
