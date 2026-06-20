import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { google } from 'googleapis';

// Use the OAuth2Client type bundled with googleapis (via googleapis-common)
// so it stays compatible with google.drive(). Importing it from the
// standalone google-auth-library package pulls in a different copy whose
// private fields make the types structurally incompatible.
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;
const TOKEN_SECRET_KEY = 'colabDrive.googleToken';
// Abandon the local sign-in server if the user never completes the flow, so we
// don't hold the redirect port open forever.
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Reads client_secret.json from the extension folder.
 * The user drops the file downloaded from Google Cloud Console here.
 */
function loadClientConfig(context: vscode.ExtensionContext): {
  clientId: string;
  clientSecret: string;
} {
  const secretsPath = path.join(context.extensionPath, 'client_secret.json');
  if (!fs.existsSync(secretsPath)) {
    throw new Error(
      'client_secret.json not found. Download it from Google Cloud Console ' +
        '(OAuth 2.0 Client ID, Desktop app) and place it in the extension folder.'
    );
  }
  const raw = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  const cfg = raw.installed || raw.web;
  if (!cfg) {
    throw new Error('client_secret.json has an unexpected format.');
  }
  return { clientId: cfg.client_id, clientSecret: cfg.client_secret };
}

/**
 * Returns an authenticated OAuth2 client.
 * Reuses a stored token if present; otherwise runs the browser login flow.
 */
export async function getAuthClient(
  context: vscode.ExtensionContext,
  forceLogin = false
): Promise<OAuth2Client> {
  const { clientId, clientSecret } = loadClientConfig(context);
  const oAuth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    REDIRECT_URI
  );

  // Persist rotated tokens whenever the library refreshes them — attached once
  // here so it covers both the cached-token path and a fresh browser login.
  // Merging preserves the refresh_token, which a refresh response may omit.
  oAuth2Client.on('tokens', (tokens) => {
    const merged = { ...oAuth2Client.credentials, ...tokens };
    void context.secrets.store(TOKEN_SECRET_KEY, JSON.stringify(merged));
  });

  if (!forceLogin) {
    const stored = await context.secrets.get(TOKEN_SECRET_KEY);
    if (stored) {
      oAuth2Client.setCredentials(JSON.parse(stored));
      return oAuth2Client;
    }
  }

  return loginWithBrowser(context, oAuth2Client);
}

/**
 * Opens the system browser, runs a one-shot local server to catch the
 * OAuth2 redirect, exchanges the code for tokens, and stores them.
 */
function loginWithBrowser(
  context: vscode.ExtensionContext,
  oAuth2Client: OAuth2Client
): Promise<OAuth2Client> {
  // Opaque value echoed back by Google so we can reject any redirect that
  // didn't originate from the auth URL we just opened (CSRF protection).
  const expectedState = crypto.randomBytes(16).toString('hex');
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state: expectedState,
  });

  return new Promise((resolve, reject) => {
    // Close the server and cancel the timeout exactly once, no matter which
    // path (success, error, timeout) gets there first.
    let settled = false;
    const cleanup = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      server.close();
    };
    const finish = (res: http.ServerResponse, message: string): void => {
      res.end(message);
      cleanup();
    };

    const server = http.createServer(async (req, res) => {
      try {
        if (!req.url || !req.url.startsWith('/oauth2callback')) {
          res.end('Waiting for Google authorization...');
          return;
        }
        const url = new URL(req.url, REDIRECT_URI);
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');

        if (error) {
          finish(res, `Authorization failed: ${error}. You can close this tab.`);
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        if (state !== expectedState) {
          finish(res, 'Authorization could not be verified. Please sign in again.');
          reject(new Error('OAuth state mismatch — sign-in aborted.'));
          return;
        }
        if (!code) {
          res.end('No authorization code received.');
          return;
        }

        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        await context.secrets.store(TOKEN_SECRET_KEY, JSON.stringify(tokens));

        finish(
          res,
          'Authentication successful. You can close this tab and return to VS Code.'
        );
        resolve(oAuth2Client);
      } catch (err) {
        finish(res, 'Something went wrong. Check VS Code for details.');
        reject(err);
      }
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Sign-in timed out. Please try again.'));
    }, LOGIN_TIMEOUT_MS);

    server.on('error', (err) => {
      cleanup();
      reject(err);
    });

    server.listen(REDIRECT_PORT, () => {
      vscode.env.openExternal(vscode.Uri.parse(authUrl));
      vscode.window.showInformationMessage(
        'Colab Drive: complete the Google sign-in in your browser.'
      );
    });
  });
}

/** Clears the stored token (sign out). */
export async function signOut(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.secrets.delete(TOKEN_SECRET_KEY);
}

/** True if a token is currently stored. */
export async function isSignedIn(
  context: vscode.ExtensionContext
): Promise<boolean> {
  return (await context.secrets.get(TOKEN_SECRET_KEY)) !== undefined;
}
