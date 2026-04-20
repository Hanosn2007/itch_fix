import { actions } from "common/actions";
import { hookLogging } from "common/butlerd/utils";
import * as messages from "common/butlerd/messages";
import { Profile } from "common/butlerd/messages";
import urls from "common/constants/urls";
import { Store } from "common/types";
import { partitionForUser } from "common/util/partition-for-user";
import { Watcher } from "common/util/watcher";
import { mcall } from "main/butlerd/mcall";
import { mainLogger } from "main/logger";
import modals from "main/modals";
import { promisedModal } from "main/reactors/modals";
import { restoreTabs, saveTabs } from "main/reactors/tab-save";
import { registerItchProtocol } from "main/net/register-itch-protocol";
import { session } from "electron";
import { elapsed } from "common/format/datetime";
import { withTimeout } from "common/helpers/with-timeout";
import { asRequestError } from "common/butlerd/errors";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import env from "main/env";
import { delay } from "main/reactors/delay";
import { runNetworkDiagnostics } from "main/reactors/proxy";

const logger = mainLogger.child(__filename);
const LOGIN_TIMEOUT = 20 * 1000;
const LOGIN_RETRY_TIMEOUT = 30 * 1000;
const OAUTH_CALLBACK_TIMEOUT = 90 * 1000;
const OAUTH_RETRY_DELAY = 1500;

// State for OAuth PKCE flow
let oauthState: string | null = null;
let codeVerifier: string | null = null;
let oauthCallbackTimer: NodeJS.Timeout | null = null;

const OAUTH_CLIENT_ID = "85252daf268d27fbefac93e1ac462bfd";
const OAUTH_REDIRECT_URI = "itch://oauth-callback";
const OAUTH_SCOPE = "itch";

// PKCE helper functions
function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  const hash = crypto.createHash("sha256").update(verifier).digest();
  return base64UrlEncode(hash);
}

function clearOAuthCallbackTimer() {
  if (oauthCallbackTimer) {
    clearTimeout(oauthCallbackTimer);
    oauthCallbackTimer = null;
  }
}

function scheduleOAuthCallbackTimeout(store: Store) {
  clearOAuthCallbackTimer();

  oauthCallbackTimer = setTimeout(() => {
    if (!oauthState) {
      return;
    }

    logger.warn(
      `OAuth callback was not received within ${OAUTH_CALLBACK_TIMEOUT}ms`
    );
    store.dispatch(
      actions.networkDiagnosticsUpdated({
        updatedAt: Date.now(),
        oauthStatus: "callback-timeout",
        oauthLastError:
          "OAuth callback was not received. The browser may have logged in successfully, but the app never received the redirect.",
      })
    );
  }, OAUTH_CALLBACK_TIMEOUT);
}

function shouldRetryOAuthExchange(e: Error, attempt: number): boolean {
  if (attempt >= 2) {
    return false;
  }

  const re = asRequestError(e);
  if (re?.rpcError?.code === messages.Code.NetworkDisconnected) {
    return true;
  }

  return /timed out/i.test(e.message || "");
}

function describeOAuthFailure(store: Store, e: Error): Error {
  const re = asRequestError(e);
  const diagnostics = store.getState().system.networkDiagnostics || {};

  if (re?.rpcError?.code === messages.Code.NetworkDisconnected) {
    if (diagnostics.dnsItchio?.startsWith("error:")) {
      return new Error(
        `OAuth login failed: DNS resolution for itch.io failed (${diagnostics.dnsItchio}).`
      );
    }

    if (diagnostics.apiPingStatus === "failed") {
      return new Error(
        `OAuth login failed: the app's API reachability probe failed (${diagnostics.apiPingDetail || "unknown"}).`
      );
    }

    return new Error(
      "OAuth login failed: butler reported an offline condition while Electron-side probes were not fully offline. This usually points to a proxy / TUN / network-extension mismatch. Try Preferences > Advanced and switch to Direct or Manual proxy mode."
    );
  }

  if (/timed out/i.test(e.message || "")) {
    return new Error(
      "OAuth code exchange timed out. The browser callback reached the app, but the desktop client did not finish the API exchange in time."
    );
  }

  return e;
}

async function exchangeOAuthCode(store: Store, code: string): Promise<boolean> {
  if (!codeVerifier) {
    logger.error("No code verifier available for OAuth exchange");
    store.dispatch(
      actions.loginFailed({
        username: "OAuth",
        error: new Error(
          "OAuth flow error (missing verifier). Please restart the login process."
        ),
      })
    );
    return false;
  }

  // Store verifier locally and clear state
  const verifier = codeVerifier;
  oauthState = null;
  codeVerifier = null;
  clearOAuthCallbackTimer();

  store.dispatch(actions.attemptLogin({}));
  store.dispatch(
    actions.networkDiagnosticsUpdated({
      updatedAt: Date.now(),
      oauthStatus: "exchange-started",
      oauthLastError: undefined,
    })
  );

  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < 2) {
    attempt++;
    try {
      const timeout = attempt === 1 ? LOGIN_TIMEOUT : LOGIN_RETRY_TIMEOUT;
      const { profile, cookie } = await withTimeout(
        `OAuth code exchange (attempt ${attempt})`,
        timeout,
        mcall(messages.ProfileLoginWithOAuthCode, {
          code,
          codeVerifier: verifier,
          redirectUri: OAUTH_REDIRECT_URI,
          clientId: OAUTH_CLIENT_ID,
        })
      );
      logger.debug(`OAuth code exchange succeeded on attempt ${attempt}`);

      if (cookie) {
        try {
          logger.info(`Setting cookies...`);
          await setCookie(profile, cookie);
        } catch (e) {
          logger.error(`Could not set cookie: ${e.stack}`);
        }
      }

      store.dispatch(
        actions.networkDiagnosticsUpdated({
          updatedAt: Date.now(),
          oauthStatus: "exchange-succeeded",
        })
      );

      await loginSucceeded(store, profile);
      return true;
    } catch (e) {
      lastError = e;
      logger.error(
        `OAuth code exchange attempt ${attempt} failed: ${e.stack || e.message || e}`
      );

      await runNetworkDiagnostics(store, `oauth-exchange-attempt-${attempt}`);
      if (!shouldRetryOAuthExchange(e, attempt)) {
        break;
      }

      logger.info(`Retrying OAuth code exchange after transient failure...`);
      await delay(OAUTH_RETRY_DELAY);
    }
  }

  const describedError = describeOAuthFailure(
    store,
    lastError || new Error("OAuth code exchange failed")
  );
  store.dispatch(
    actions.networkDiagnosticsUpdated({
      updatedAt: Date.now(),
      oauthStatus: "exchange-failed",
      oauthLastError: describedError.message,
    })
  );
  store.dispatch(actions.loginFailed({ username: "OAuth", error: describedError }));
  return false;
}

export default function (watcher: Watcher) {
  watcher.on(actions.initiateOAuthLogin, async (store, action) => {
    logger.info("Initiating OAuth login with PKCE...");

    // Generate PKCE credentials
    oauthState = uuidv4();
    codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const params = new URLSearchParams();
    params.append("client_id", OAUTH_CLIENT_ID);
    params.append("scope", OAUTH_SCOPE);
    params.append("redirect_uri", OAUTH_REDIRECT_URI);
    params.append("state", oauthState);
    params.append("response_type", "code");
    params.append("code_challenge", codeChallenge);
    params.append("code_challenge_method", "S256");
    if (env.appName !== "itch") {
      params.append("app_name", env.appName);
    }

    const loginUrl = `${urls.itchio}/user/oauth?${params.toString()}`;
    logger.info(`Opening OAuth URL: ${loginUrl}`);
    store.dispatch(actions.oauthURLGenerated({ url: loginUrl }));
    store.dispatch(
      actions.networkDiagnosticsUpdated({
        updatedAt: Date.now(),
        oauthStatus: "browser-opened",
        oauthBrowserOpenedAt: Date.now(),
        oauthCallbackReceivedAt: undefined,
        oauthLastError: undefined,
      })
    );
    scheduleOAuthCallbackTimeout(store);
    store.dispatch(actions.openInExternalBrowser({ url: loginUrl }));
  });

  watcher.on(actions.handleOAuthCallback, async (store, action) => {
    const { code, state } = action.payload;
    logger.info("Handling OAuth callback...");
    clearOAuthCallbackTimer();
    store.dispatch(
      actions.networkDiagnosticsUpdated({
        updatedAt: Date.now(),
        oauthStatus: "callback-received",
        oauthCallbackReceivedAt: Date.now(),
      })
    );

    if (state !== oauthState) {
      logger.error(
        `OAuth state mismatch! Expected ${oauthState}, got ${state}`
      );
      store.dispatch(
        actions.networkDiagnosticsUpdated({
          updatedAt: Date.now(),
          oauthStatus: "callback-state-mismatch",
          oauthLastError:
            "OAuth callback was received, but the state parameter did not match the active login attempt.",
        })
      );
      store.dispatch(
        actions.loginFailed({
          username: "OAuth",
          error: new Error(
            "Security check failed (state mismatch). Please try again."
          ),
        })
      );
      return;
    }

    logger.info("OAuth state verified. Exchanging code for profile...");
    await exchangeOAuthCode(store, code);
  });

  watcher.on(actions.submitOAuthCode, async (store, action) => {
    const { code } = action.payload;
    logger.info("Manual OAuth code entry...");
    clearOAuthCallbackTimer();
    store.dispatch(
      actions.networkDiagnosticsUpdated({
        updatedAt: Date.now(),
        oauthStatus: "manual-code-submitted",
      })
    );
    await exchangeOAuthCode(store, code);
  });

  watcher.on(actions.loginWithPassword, async (store, action) => {
    const { username, password } = action.payload;

    logger.info(`Attempting password login for user ${username}`);
    store.dispatch(actions.attemptLogin({}));

    try {
      // integration tests for the integration test goddess
      if (username === "#api-key") {
        logger.info(`Doing direct API key login...`);
        const { profile } = await withTimeout(
          "API key login",
          LOGIN_TIMEOUT,
          mcall(messages.ProfileLoginWithAPIKey, {
            apiKey: password,
          })
        );
        logger.debug(`ProfileLoginWithAPIKey call succeeded`);
        await loginSucceeded(store, profile);
        return;
      }

      logger.info(`Doing username/password login...`);
      const { profile, cookie } = await mcall(
        messages.ProfileLoginWithPassword,
        {
          username,
          password,
          forceRecaptcha: process.env.ITCH_FORCE_RECAPTCHA === "1",
        },
        (client) => {
          logger.debug(`Setting up handlers for TOTP & captcha`);
          client.onRequest(
            messages.ProfileRequestCaptcha,
            async ({ recaptchaUrl }) => {
              logger.info(`Showing captcha`);
              const modalRes = await promisedModal(
                store,
                modals.recaptchaInput.make({
                  wind: "root",
                  title: "Captcha",
                  message: "",
                  widgetParams: {
                    url: recaptchaUrl || urls.itchio + "/captcha",
                  },
                  fullscreen: true,
                })
              );

              if (modalRes) {
                logger.info(`Captcha solved`);
                return { recaptchaResponse: modalRes.recaptchaResponse };
              } else {
                // abort
                logger.info(`Captcha cancelled`);
                return { recaptchaResponse: null };
              }
            }
          );

          client.onRequest(messages.ProfileRequestTOTP, async () => {
            logger.info(`Showing TOTP`);
            const modalRes = await promisedModal(
              store,
              modals.twoFactorInput.make({
                wind: "root",
                title: ["login.two_factor.title"],
                message: "",
                widgetParams: {
                  username,
                },
              })
            );

            if (modalRes) {
              logger.info(`TOTP answered`);
              return { code: modalRes.totpCode };
            } else {
              // abort
              logger.info(`TOTP cancelled`);
              return { code: null };
            }
          });
        }
      );

      if (cookie) {
        try {
          logger.info(`Setting cookies...`);
          await setCookie(profile, cookie);
        } catch (e) {
          logger.error(`Could not set cookie: ${e.stack}`);
        }
      }

      await loginSucceeded(store, profile);
    } catch (e) {
      logger.error(`Password login failed: ${e.stack}`);
      store.dispatch(actions.loginFailed({ username, error: e }));
    }
  });

  watcher.on(actions.useSavedLogin, async (store, action) => {
    const profileId = action.payload.profile.id;
    logger.info(`Attempting saved login for profile ${profileId}`);
    store.dispatch(actions.attemptLogin({}));

    try {
      const { profile } = await withTimeout(
        "Saved login",
        LOGIN_TIMEOUT,
        mcall(
          messages.ProfileUseSavedLogin,
          {
            profileId,
          },
          (convo) => {
            hookLogging(convo, logger);
          }
        )
      );
      logger.info(`Saved login succeeded!`);
      await loginSucceeded(store, profile);
    } catch (e) {
      // TODO: handle offline login
      const originalProfile = action.payload.profile;
      store.dispatch(
        actions.loginFailed({
          username: originalProfile.user.username,
          error: e,
        })
      );
    }
  });

  watcher.on(actions.requestLogout, async (store, action) => {
    await saveTabs(store);
    store.dispatch(actions.loggedOut({}));
  });
}

const YEAR_IN_SECONDS =
  365.25 /* days */ * 24 /* hours */ * 60 /* minutes */ * 60; /* seconds */

async function setCookie(profile: Profile, cookie: { [key: string]: string }) {
  const partition = partitionForUser(String(profile.user.id));
  const session = require("electron").session.fromPartition(partition, {
    cache: false,
  });

  for (const name of Object.keys(cookie)) {
    const value = cookie[name];
    const epoch = Date.now() * 0.001;
    const parsed = new URL(urls.itchio);
    const opts = {
      name,
      value: encodeURIComponent(value),
      url: `${parsed.protocol}//${parsed.hostname}`,
      domain: "." + parsed.hostname,
      secure: parsed.protocol === "https:",
      httpOnly: true,
      expirationDate: epoch + YEAR_IN_SECONDS, // have it valid for a year
    };
    try {
      await session.cookies.set(opts);
    } catch (error) {
      logger.error(`Cookie error: ${JSON.stringify(error)}`);
      throw error;
    }
  }
}

async function loginSucceeded(store: Store, profile: Profile) {
  logger.info(`Login succeeded, setting up session`);
  try {
    const userId = profile.id;
    const partition = partitionForUser(String(userId));
    const customSession = session.fromPartition(partition, { cache: true });
    logger.info(`Registering itch protocol for session ${partition}`);
    registerItchProtocol(store, customSession);
  } catch (e) {
    logger.warn(`Could not register itch protocol for session: ${e.stack}`);
  }

  try {
    logger.info(`Restoring tabs...`);
    await restoreTabs(store, profile);
  } catch (e) {
    logger.warn(`Could not restore tabs: ${e.stack}`);
  }

  logger.info(`Dispatching login succeeded`);
  store.dispatch(actions.loginSucceeded({ profile }));

  try {
    logger.info(`Fetching owned keys...`);
    let t1 = Date.now();
    await mcall(
      messages.FetchProfileOwnedKeys,
      {
        profileId: profile.id,
        fresh: true,
        limit: 1,
      },
      (convo) => {
        hookLogging(convo, logger);
      }
    );
    let t2 = Date.now();
    logger.info(`Fetched owned keys in ${elapsed(t1, t2)}`);
    store.dispatch(actions.ownedKeysFetched({}));
  } catch (e) {
    logger.warn(`In initial owned keys fetch: ${e.stack}`);
  }
}
