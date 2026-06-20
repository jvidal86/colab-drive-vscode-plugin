import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  getAuthClient,
  signOut,
  isSignedIn,
  storeClientConfig,
  hasClientConfig,
  MissingCredentialsError,
} from './auth';
import { DriveService, NotebookFile } from './driveService';
import { NotebookTreeProvider, AuthState } from './notebookTreeProvider';

export async function activate(context: vscode.ExtensionContext) {
  const treeProvider = new NotebookTreeProvider();
  vscode.window.registerTreeDataProvider(
    'colabDriveNotebooks',
    treeProvider
  );

  // The connected service is shared between the tree view and the open-notebook
  // command so we authenticate once per session rather than per action.
  let driveService: DriveService | undefined;

  // Pushes the current AuthState into a context key that drives the welcome
  // views and title menus (see AuthState docs / package.json). The default
  // (unset) and 'connecting' match no welcome, so nothing flashes before the
  // real state is known.
  function setState(state: AuthState): void {
    vscode.commands.executeCommand('setContext', 'colabDrive.state', state);
  }
  treeProvider.setStateSetter(setState);
  setState('connecting');

  // Build the DriveService from a (possibly cached) token and wire it up.
  async function connect(forceLogin = false): Promise<void> {
    setState('connecting');
    try {
      const auth = await getAuthClient(context, forceLogin);
      driveService = new DriveService(auth);
      // setService kicks off the list fetch; the provider flips state to
      // 'signedIn' once results (or an empty result) come back.
      treeProvider.setService(driveService);
      vscode.window.showInformationMessage(
        'Colab Drive: connected to Google Drive.'
      );
    } catch (err: any) {
      if (err instanceof MissingCredentialsError) {
        // Not an error the user did anything wrong — guide them to setup.
        setState('needsCredentials');
        return;
      }
      setState('signedOut');
      vscode.window.showErrorMessage(
        `Colab Drive: ${err?.message ?? String(err)}`
      );
    }
  }

  // Let the user load their own Google OAuth client_secret.json. Stored in
  // SecretStorage (encrypted), so it survives reinstalls and isn't left as a
  // plaintext file in the extension folder.
  async function setupCredentials(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Use this credentials file',
      title: 'Select your Google OAuth client_secret.json',
      filters: { 'OAuth client JSON': ['json'] },
    });
    if (!picked || picked.length === 0) {
      return;
    }
    try {
      const raw = await fs.promises.readFile(picked[0].fsPath, 'utf8');
      await storeClientConfig(context, raw);
      vscode.window.showInformationMessage(
        'Colab Drive: credentials saved. Signing in…'
      );
      await connect(true);
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Colab Drive: ${err?.message ?? String(err)}`
      );
    }
  }

  // Set up credentials
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'colabDrive.setupCredentials',
      setupCredentials
    )
  );

  // Sign in
  context.subscriptions.push(
    vscode.commands.registerCommand('colabDrive.signIn', () =>
      connect(true)
    )
  );

  // Sign out
  context.subscriptions.push(
    vscode.commands.registerCommand('colabDrive.signOut', async () => {
      await signOut(context);
      driveService = undefined;
      treeProvider.setService(undefined);
      setState('signedOut');
      vscode.window.showInformationMessage('Colab Drive: signed out.');
    })
  );

  // Refresh
  context.subscriptions.push(
    vscode.commands.registerCommand('colabDrive.refresh', () =>
      treeProvider.refresh()
    )
  );

  // Show storage quota: report the signed-in account's Drive usage. This is
  // the storage that backs your Colab/Jupyter notebooks — the Colab VM's own
  // disk isn't reachable from the Drive API (see README).
  context.subscriptions.push(
    vscode.commands.registerCommand('colabDrive.showQuota', async () => {
      try {
        const drive =
          driveService ?? new DriveService(await getAuthClient(context));
        const q = await drive.getStorageQuota();

        const used = q.usage ?? 0;
        const parts: string[] = [];
        if (q.limit && q.limit > 0) {
          const pct = ((used / q.limit) * 100).toFixed(1);
          parts.push(
            `${formatBytes(used)} of ${formatBytes(q.limit)} used (${pct}%)`
          );
        } else {
          parts.push(`${formatBytes(used)} used (no fixed limit)`);
        }
        if (q.usageInDrive !== undefined) {
          parts.push(`Drive files: ${formatBytes(q.usageInDrive)}`);
        }
        if (q.usageInDriveTrash !== undefined) {
          parts.push(`Trash: ${formatBytes(q.usageInDriveTrash)}`);
        }

        const who = q.userEmail ? ` (${q.userEmail})` : '';
        vscode.window.showInformationMessage(
          `Colab Drive storage${who}: ${parts.join(' · ')}`
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Colab Drive: could not read storage quota — ${
            err?.message ?? String(err)
          }`
        );
      }
    })
  );

  // Open a notebook: download its JSON to a temp file, open in the editor.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'colabDrive.openNotebook',
      async (file: NotebookFile) => {
        try {
          // Reuse the session's authenticated client; fall back to a fresh one
          // if the command is somehow invoked before connecting.
          const drive =
            driveService ?? new DriveService(await getAuthClient(context));
          const content = await drive.downloadNotebook(file.id);

          const tmpPath = path.join(
            os.tmpdir(),
            tempFileName(file.id, file.name)
          );
          await fs.promises.writeFile(tmpPath, content, 'utf8');

          const uri = vscode.Uri.file(tmpPath);
          await vscode.commands.executeCommand('vscode.open', uri);
        } catch (err: any) {
          vscode.window.showErrorMessage(
            `Colab Drive: could not open notebook — ${
              err?.message ?? String(err)
            }`
          );
        }
      }
    )
  );

  // Decide the startup state. Stays 'connecting' (set above) during these
  // async checks so no welcome flashes before the real state is known:
  //   no credentials -> prompt setup
  //   have token     -> auto-connect
  //   otherwise      -> prompt sign in
  if (!(await hasClientConfig(context))) {
    setState('needsCredentials');
  } else if (await isSignedIn(context)) {
    await connect(false);
  } else {
    setState('signedOut');
  }
}

/**
 * Build a collision-resistant, filesystem-safe temp filename. The Drive id
 * keeps it unique; the (sanitized) name keeps the editor tab readable. Names
 * from Drive are untrusted, so anything outside a safe set becomes '_' to
 * prevent path traversal or invalid characters.
 */
/**
 * Format a byte count as a human-readable string using binary units (the same
 * GiB Drive's UI shows), e.g. 16106127360 -> "15.0 GB".
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const decimals = value >= 100 || i === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[i]}`;
}

function tempFileName(fileId: string, fileName: string): string {
  const base = fileName.replace(/[^\w.\- ]+/g, '_').trim() || 'notebook';
  const safeName = base.endsWith('.ipynb') ? base : `${base}.ipynb`;
  const safeId = fileId.replace(/[^\w-]+/g, '_');
  return `colabdrive_${safeId}_${safeName}`;
}

export function deactivate() {}
