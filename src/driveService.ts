import { drive as createDrive, drive_v3, auth as googleAuth } from '@googleapis/drive';

// See note in auth.ts: derive OAuth2Client from the drive package's auth
// namespace to avoid the duplicate google-auth-library type mismatch.
type OAuth2Client = InstanceType<typeof googleAuth.OAuth2>;

export interface NotebookFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
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
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
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
        });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return notebooks;
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
