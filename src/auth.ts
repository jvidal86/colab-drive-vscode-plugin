import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { auth as googleAuth } from '@googleapis/drive';

// Derive the OAuth2Client type from the auth namespace shipped with
// @googleapis/drive so it stays compatible with drive(). Importing OAuth2Client
// from a separately-resolved google-auth-library copy would reintroduce the
// "separate declarations of private property" type mismatch.
type OAuth2Client = InstanceType<typeof googleAuth.OAuth2>;

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;
const TOKEN_SECRET_KEY = 'colabDrive.googleToken';
const CLIENT_SECRET_KEY = 'colabDrive.clientSecret';
// Abandon the local sign-in server if the user never completes the flow, so we
// don't hold the redirect port open forever.
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface ClientConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Thrown when no OAuth credentials are configured, so the UI can prompt the
 * user to run "Set up credentials" instead of showing a raw error.
 */
export class MissingCredentialsError extends Error {
  constructor() {
    super('No Google credentials configured.');
    this.name = 'MissingCredentialsError';
  }
}

/** Validate and extract the bits we need from a Google OAuth client JSON. */
function parseClientConfig(raw: string): ClientConfig {
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('The credentials file is not valid JSON.');
  }
  const cfg = json.installed || json.web;
  if (!cfg || !cfg.client_id || !cfg.client_secret) {
    throw new Error(
      'Unexpected credentials format — expected a Google OAuth client ' +
        'JSON with an "installed" or "web" section (Desktop app type).'
    );
  }
  return { clientId: cfg.client_id, clientSecret: cfg.client_secret };
}

/**
 * Loads the OAuth client config, preferring SecretStorage (set via the
 * "Set up credentials" command) and falling back to a client_secret.json in
 * the extension folder — handy when running from source with F5.
 */
async function loadClientConfig(
  context: vscode.ExtensionContext
): Promise<ClientConfig> {
  const stored = await context.secrets.get(CLIENT_SECRET_KEY);
  if (stored) {
    return parseClientConfig(stored);
  }
  const secretsPath = path.join(context.extensionPath, 'client_secret.json');
  if (fs.existsSync(secretsPath)) {
    return parseClientConfig(fs.readFileSync(secretsPath, 'utf8'));
  }
  throw new MissingCredentialsError();
}

/** Validate and persist a raw client_secret.json into SecretStorage. */
export async function storeClientConfig(
  context: vscode.ExtensionContext,
  raw: string
): Promise<void> {
  parseClientConfig(raw); // throws if the file is malformed
  await context.secrets.store(CLIENT_SECRET_KEY, raw);
}

/** True if credentials are configured (in SecretStorage or the folder). */
export async function hasClientConfig(
  context: vscode.ExtensionContext
): Promise<boolean> {
  if (await context.secrets.get(CLIENT_SECRET_KEY)) {
    return true;
  }
  return fs.existsSync(path.join(context.extensionPath, 'client_secret.json'));
}

/**
 * Returns an authenticated OAuth2 client.
 * Reuses a stored token if present; otherwise runs the browser login flow.
 */
export async function getAuthClient(
  context: vscode.ExtensionContext,
  forceLogin = false
): Promise<OAuth2Client> {
  const { clientId, clientSecret } = await loadClientConfig(context);
  const oAuth2Client = new googleAuth.OAuth2(
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
