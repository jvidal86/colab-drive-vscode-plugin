import { drive as createDrive, drive_v3, auth as googleAuth } from '@googleapis/drive';

// See note in auth.ts: derive OAuth2Client from the drive package's auth
// namespace to avoid the duplicate google-auth-library type mismatch.
type OAuth2Client = InstanceType<typeof googleAuth.OAuth2>;

export interface NotebookFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  /** Drive parent folder IDs. Drive's single-parent model means parents[0] is
   *  effectively the containing folder; absent for some shared files. */
  parents?: string[];
}

/**
 * A node in the notebook folder tree: a folder, its subfolders, and the
 * notebooks directly inside it. Deliberately free of any vscode types so all
 * Drive/tree logic stays testable and UI-agnostic — the tree provider maps
 * these to TreeItems.
 */
export interface FolderNode {
  id: string;
  name: string;
  folders: FolderNode[];
  notebooks: NotebookFile[];
}

/**
 * Storage usage for the signed-in Google account, in bytes. This is the
 * Drive-account quota that backs your Colab/Jupyter notebooks — NOT the
 * ephemeral Colab VM disk, which is only visible from inside a runtime.
 *
 * `limit` is undefined for accounts with unlimited/pooled storage (e.g. some
 * Workspace tiers), in which case only usage figures are meaningful.
 */
export interface StorageQuota {
  limit?: number;
  usage?: number;
  usageInDrive?: number;
  usageInDriveTrash?: number;
  userEmail?: string;
}

/**
 * Matches both Colab-native notebooks and uploaded .ipynb files.
 * This is the query confirmed to work against the real Drive:
 *   - application/vnd.google.colaboratory  (Colab files)
 *   - application/x-ipynb+json             (uploaded .ipynb)
 *   - fileExtension='ipynb'                (reliable extension match)
 */
const NOTEBOOK_QUERY =
  "(mimeType='application/vnd.google.colaboratory' " +
  "or mimeType='application/x-ipynb+json' " +
  "or fileExtension='ipynb') and trashed=false";

/**
 * Escape a user-supplied value for use inside a single-quoted Drive query
 * string. Backslashes must be escaped before quotes, or the escapes double up.
 */
function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export class DriveService {
  private drive: drive_v3.Drive;

  constructor(auth: OAuth2Client) {
    this.drive = createDrive({ version: 'v3', auth });
  }

  /** Look up a folder's ID by name. Returns undefined if not found. */
  async findFolderId(folderName: string): Promise<string | undefined> {
    const res = await this.drive.files.list({
      q:
        `mimeType='application/vnd.google-apps.folder' ` +
        `and name='${escapeQueryValue(folderName)}' and trashed=false`,
      fields: 'files(id, name)',
      pageSize: 1,
    });
    return res.data.files?.[0]?.id ?? undefined;
  }

  /**
   * List notebooks. If folderName is provided and found, only notebooks
   * inside that folder are returned; otherwise the whole Drive is searched.
   */
  async listNotebooks(folderName?: string): Promise<NotebookFile[]> {
    let q = NOTEBOOK_QUERY;

    if (folderName && folderName.trim().length > 0) {
      const folderId = await this.findFolderId(folderName.trim());
      if (folderId) {
        q = `'${folderId}' in parents and ${NOTEBOOK_QUERY}`;
      }
    }

    const notebooks: NotebookFile[] = [];
    let pageToken: string | undefined;

    // Page through every result so Drives with more than one page (>100
    // notebooks) are listed in full rather than silently truncated.
    do {
      const res = await this.drive.files.list({
        q,
        fields:
          'nextPageToken, files(id, name, mimeType, modifiedTime, parents)',
        orderBy: 'modifiedTime desc',
        pageSize: 100,
        pageToken,
      });

      for (const f of res.data.files ?? []) {
        if (!f.id || !f.name) {
          continue;
        }
        notebooks.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType ?? '',
          modifiedTime: f.modifiedTime ?? undefined,
          parents: f.parents ?? undefined,
        });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return notebooks;
  }

  /** The ID of the account's "My Drive" root folder. */
  private async getRootId(): Promise<string> {
    const res = await this.drive.files.get({ fileId: 'root', fields: 'id' });
    return res.data.id ?? 'root';
  }

  /** Fetch a folder's name and (first) parent. */
  private async getFolderMeta(
    id: string
  ): Promise<{ id: string; name: string; parentId?: string }> {
    const res = await this.drive.files.get({
      fileId: id,
      fields: 'id, name, parents',
    });
    return {
      id: res.data.id ?? id,
      name: res.data.name ?? '(unnamed folder)',
      parentId: res.data.parents?.[0] ?? undefined,
    };
  }

  /**
   * Build the notebook folder tree. Lists every notebook once, then resolves
   * only the folders that are ancestors of a notebook and assembles them into a
   * tree. Because folders are discovered solely by walking up from notebooks,
   * the result is naturally pruned — no folder appears unless it contains a
   * notebook somewhere beneath it.
   *
   * Returns the node to display as the root: My Drive by default, or the
   * configured folder's subtree (recursive) when `folderName` is set and found.
   * Notebooks whose parent is the root, missing, or unresolvable (e.g. a shared
   * folder we can't read) are attached at the top level so nothing is hidden.
   */
  async fetchNotebookForest(folderName?: string): Promise<FolderNode> {
    const notebooks = await this.listNotebooks();
    const rootId = await this.getRootId();

    // Resolve the metadata of every ancestor folder, breadth-first by level so
    // each level's lookups run in parallel. `folderMeta` doubles as the
    // visited-set, so cycles or repeated parents can't loop forever.
    const folderMeta = new Map<
      string,
      { id: string; name: string; parentId?: string }
    >();
    let frontier = new Set<string>();
    for (const nb of notebooks) {
      const pid = nb.parents?.[0];
      if (pid && pid !== rootId) {
        frontier.add(pid);
      }
    }
    while (frontier.size > 0) {
      const ids = [...frontier].filter((id) => !folderMeta.has(id));
      frontier = new Set();
      const metas = await Promise.all(
        // Tolerate folders we can't read (permission/shared) — that notebook
        // just lands at the top level rather than failing the whole tree.
        ids.map((id) => this.getFolderMeta(id).catch(() => undefined))
      );
      for (const m of metas) {
        if (!m) {
          continue;
        }
        folderMeta.set(m.id, m);
        if (m.parentId && m.parentId !== rootId && !folderMeta.has(m.parentId)) {
          frontier.add(m.parentId);
        }
      }
    }

    // Materialize one FolderNode per resolved folder, plus the synthetic root.
    const nodeById = new Map<string, FolderNode>();
    const nodeFor = (id: string, name: string): FolderNode => {
      let node = nodeById.get(id);
      if (!node) {
        node = { id, name, folders: [], notebooks: [] };
        nodeById.set(id, node);
      }
      return node;
    };
    const root = nodeFor(rootId, 'My Drive');

    // Link each folder under its parent (folders whose parent we couldn't
    // resolve hang off the root so they stay visible).
    for (const m of folderMeta.values()) {
      const node = nodeFor(m.id, m.name);
      const parent =
        m.parentId && folderMeta.has(m.parentId)
          ? nodeFor(m.parentId, folderMeta.get(m.parentId)!.name)
          : root;
      parent.folders.push(node);
    }

    // Place each notebook in its containing folder (or the root).
    for (const nb of notebooks) {
      const pid = nb.parents?.[0];
      const target = pid && nodeById.has(pid) ? nodeById.get(pid)! : root;
      target.notebooks.push(nb);
    }

    // Folders alphabetical; notebooks keep the modified-desc order from listing.
    const sortFolders = (node: FolderNode): void => {
      node.folders.sort((a, b) => a.name.localeCompare(b.name));
      node.folders.forEach(sortFolders);
    };
    sortFolders(root);

    // Restrict to a named folder's subtree when configured.
    if (folderName && folderName.trim().length > 0) {
      const folderId = await this.findFolderId(folderName.trim());
      if (folderId) {
        // The folder exists: show its subtree, or an empty node if it holds no
        // notebooks. (If it isn't found, fall through to the whole-Drive root.)
        return (
          nodeById.get(folderId) ?? {
            id: folderId,
            name: folderName.trim(),
            folders: [],
            notebooks: [],
          }
        );
      }
    }

    return root;
  }

  /**
   * Fetch the signed-in account's Drive storage quota. Works with the
   * existing drive.readonly scope — about.get needs no extra permission.
   */
  async getStorageQuota(): Promise<StorageQuota> {
    const res = await this.drive.about.get({
      fields: 'storageQuota, user(emailAddress)',
    });
    const q = res.data.storageQuota ?? {};
    const toNum = (v?: string | null): number | undefined =>
      v === undefined || v === null ? undefined : Number(v);
    return {
      // Drive returns these as numeric strings; coerce to numbers (and to
      // undefined when absent, e.g. limit for unlimited accounts).
      limit: toNum(q.limit),
      usage: toNum(q.usage),
      usageInDrive: toNum(q.usageInDrive),
      usageInDriveTrash: toNum(q.usageInDriveTrash),
      userEmail: res.data.user?.emailAddress ?? undefined,
    };
  }

  /**
   * Download a notebook's raw .ipynb JSON.
   * Colab files and uploaded .ipynb files both return valid JSON via alt=media.
   */
  async downloadNotebook(fileId: string): Promise<string> {
    const res = await this.drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'text' }
    );
    return res.data as unknown as string;
  }
}
