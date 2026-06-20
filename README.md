# Colab Drive — VS Code extension

Browse your Colab and Jupyter notebooks from Google Drive in a VS Code sidebar,
and open them straight into the editor.

## One-time setup

1. Install dependencies and compile:

   ```bash
   npm install
   npm run compile
   ```

2. Put your Google OAuth credentials in the project root as `client_secret.json`.
   This is the same Desktop-app OAuth client you created in Google Cloud Console
   (the file Google lets you download from APIs & Services → Credentials).

   The folder should look like:

   ```
   colab-drive/
     client_secret.json   <-- your downloaded OAuth client
     package.json
     src/
     ...
   ```

3. Make sure the Google Drive API is enabled for that Cloud project, and that
   your Google account is added as a Test user on the OAuth consent screen.

## Run it

1. Open this folder in VS Code.
2. Press `F5`. A second VS Code window ("Extension Development Host") opens.
3. In that window, click the Colab Drive icon in the Activity Bar (left edge).
4. Click the sign-in icon in the view title, complete Google login in the browser.
5. Your notebooks appear in the sidebar. Click one to open it.

## Configuration

`colabDrive.folderName` (default: `Colab Notebooks`) — restricts the listing to a
single Drive folder by name. Set it to an empty string to search your whole Drive.

## Notes

- The token is stored in VS Code's encrypted SecretStorage, not on disk.
- Opening a notebook downloads it to a temp file and opens it with VS Code's
  built-in notebook editor. Install the Jupyter extension (`ms-toolsai.jupyter`)
  to run cells.
- This is read-only for now (drive.readonly scope). Saving changes back to Drive
  is a future step.
