# Colab Drive — VS Code extension

Browse your Colab and Jupyter notebooks from Google Drive in a VS Code sidebar,
and open them straight into the editor.

This is a **bring-your-own-credentials** tool: you connect it to Google using a
free OAuth client that you create in your own Google Cloud project. Nothing is
shared with a third party and there are no fees.

## Install

**Option A — build and install the `.vsix`** (recommended for everyday use):

```bash
npm install
npm run compile
npx vsce package
code --install-extension colab-drive-1.1.0.vsix
```

**Option B — run from source:** open this folder in VS Code and press `F5` to
launch an Extension Development Host window with the extension loaded.

## Setup

You need a Google OAuth client so the extension can read your Drive. This is a
one-time setup, all on free Google services.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create (or pick) a project.
2. **APIs & Services → Library →** enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen:**
   - User type: **External**.
   - Add your own Google account under **Test users**.
   - Add the scope `.../auth/drive.readonly`.
   - *(Optional but recommended)* Click **Publish app → In production**. As the
     only user of your own app you can accept the "unverified app" notice; this
     stops Google from expiring your login every 7 days.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type: **Desktop app**.
   - **Download JSON** — this is your `client_secret.json`.
5. In VS Code, open the **Colab Drive** view (icon in the Activity Bar) and
   click **Set up credentials** (or run the command
   `Colab Drive: Set up credentials`), then select the file you downloaded.

Your credentials are stored in VS Code's encrypted **SecretStorage** — not as a
plaintext file — so they survive reinstalls and upgrades.

## Use

1. Click the **Colab Drive** icon in the Activity Bar.
2. Click **Sign in to Google** and complete the login in your browser.
3. Your notebooks appear in the sidebar. Click one to open it.

To reconfigure, use **Set up credentials** again (in the `…` menu) to load a
different client, or **Sign out** to clear the stored token.

## Configuration

`colabDrive.folderName` (default: `Colab Notebooks`) — restricts the listing to
a single Drive folder by name. Set it to an empty string to search your whole
Drive.

## Notes

- The token is stored in VS Code's encrypted SecretStorage, not on disk.
- Opening a notebook downloads it to a temp file and opens it with VS Code's
  built-in notebook editor. Install the Jupyter extension (`ms-toolsai.jupyter`)
  to run cells.
- This is read-only (`drive.readonly` scope). Saving changes back to Drive is a
  future step.

## License

[MIT](LICENSE)
