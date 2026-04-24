import { Watcher } from "common/util/watcher";
import { actions } from "common/actions";
import { NET_PARTITION_NAME } from "common/constants/net";
import urls from "common/constants/urls";
import {
  NetworkProxyMode,
  PreferencesState,
  ProxySettings,
  Store,
} from "common/types";
import {
  partitionForApp,
  partitionForUser,
} from "common/util/partition-for-user";
import { session, Session } from "electron";
import { mainLogger } from "main/logger";
import dns from "dns";

const logger = mainLogger.child(__filename);

const originalProxyEnv = {
  httpProxy: process.env.http_proxy,
  httpsProxy: process.env.https_proxy,
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  allProxy: process.env.all_proxy,
  ALL_PROXY: process.env.ALL_PROXY,
  noProxy: process.env.no_proxy,
  NO_PROXY: process.env.NO_PROXY,
};

const LOCAL_BYPASS_RULES = "localhost,127.0.0.1,::1,*.local";

function normalizeProxyString(proxy?: string | null): string | null {
  const trimmed = (proxy || "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function setEnvPair(lowerKey: string, upperKey: string, value?: string | null) {
  if (value) {
    process.env[lowerKey] = value;
    process.env[upperKey] = value;
  } else {
    delete process.env[lowerKey];
    delete process.env[upperKey];
  }
}

function setProxyEnv(proxy?: string | null, noProxy?: string | null) {
  setEnvPair("http_proxy", "HTTP_PROXY", proxy);
  setEnvPair("https_proxy", "HTTPS_PROXY", proxy);
  setEnvPair("all_proxy", "ALL_PROXY", proxy);
  setEnvPair("no_proxy", "NO_PROXY", noProxy);
}

function effectiveNoProxyForSystemMode() {
  return (
    normalizeProxyString(originalProxyEnv.noProxy || originalProxyEnv.NO_PROXY) ||
    LOCAL_BYPASS_RULES
  );
}

function systemProxyToEnvProxy(proxy?: string | null): string | null {
  const normalized = normalizeProxyString(proxy);
  if (!normalized) {
    return null;
  }

  // Electron's resolveProxy() returns tokens like:
  // "PROXY 127.0.0.1:7897", "HTTPS 127.0.0.1:7897", "SOCKS5 127.0.0.1:7897",
  // sometimes chained as "PROXY host:port; DIRECT".
  for (const candidate of normalized.split(";")) {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.toUpperCase() === "DIRECT") {
      continue;
    }

    const match = trimmed.match(/^([A-Z0-9_]+)\s+(.+)$/i);
    if (!match) {
      if (/^[a-z]+:\/\//i.test(trimmed)) {
        return trimmed;
      }
      return `http://${trimmed}`;
    }

    const [, schemeToken, address] = match;
    const scheme = schemeToken.toUpperCase();
    switch (scheme) {
      case "PROXY":
      case "HTTP":
      case "HTTPS":
        return `http://${address}`;
      case "SOCKS":
      case "SOCKS4":
        return `socks4://${address}`;
      case "SOCKS5":
        return `socks5://${address}`;
      default:
        return `http://${address}`;
    }
  }

  return null;
}

export function readEnvironmentProxySettings(
  source: Record<string, string> = process.env as Record<string, string>
) {
  const httpProxy = normalizeProxyString(
    source.http_proxy || source.HTTP_PROXY
  );
  const httpsProxy = normalizeProxyString(
    source.https_proxy || source.HTTPS_PROXY
  );
  const allProxy = normalizeProxyString(
    source.all_proxy || source.ALL_PROXY
  );
  const noProxy = normalizeProxyString(source.no_proxy || source.NO_PROXY);

  return {
    httpProxy,
    httpsProxy,
    allProxy,
    noProxy,
    proxy: httpsProxy || httpProxy || allProxy,
  };
}

async function detectSystemProxy(): Promise<string | null> {
  const detectSession = session.fromPartition(`proxy-detect-${Date.now()}`, {
    cache: false,
  });

  try {
    await (detectSession as any).setProxy({ mode: "system" });
    const resolved = await detectSession.resolveProxy(urls.itchio);
    const normalized = normalizeProxyString(resolved);
    if (!normalized || normalized.toUpperCase() === "DIRECT") {
      return null;
    }
    return normalized;
  } catch (e) {
    logger.warn(`Could not resolve system proxy: ${e.stack || e.message || e}`);
    return null;
  }
}

function computeEffectiveProxySettings(
  prefs: PreferencesState,
  detectedSystemProxy?: string | null,
  envSettings = readEnvironmentProxySettings()
): ProxySettings & { mode: NetworkProxyMode } {
  const preferredMode = prefs.networkProxyMode || "system";
  const manualProxy = normalizeProxyString(prefs.networkProxyRules);
  const manualBypass = normalizeProxyString(prefs.networkProxyBypassRules);

  switch (preferredMode) {
    case "manual":
      if (manualProxy) {
        return {
          mode: "manual",
          proxy: manualProxy,
          proxySource: "manual",
          proxyBypassRules: manualBypass,
        };
      }

      logger.warn(
        "Manual proxy mode selected without proxy rules, falling back to direct mode"
      );
      return {
        mode: "direct",
        proxy: null,
        proxySource: "direct",
      };

    case "env":
      if (envSettings.proxy) {
        return {
          mode: "env",
          proxy: envSettings.proxy,
          proxySource: "env",
          proxyBypassRules: envSettings.noProxy,
        };
      }

      logger.warn(
        "Environment proxy mode selected without HTTP(S)_PROXY, falling back to direct mode"
      );
      return {
        mode: "direct",
        proxy: null,
        proxySource: "direct",
      };

    case "direct":
      return {
        mode: "direct",
        proxy: null,
        proxySource: "direct",
      };

    case "system":
    default:
      return {
        mode: "system",
        proxy: detectedSystemProxy,
        proxySource: detectedSystemProxy ? "os" : "direct",
      };
  }
}

function applyProcessProxyEnvironment(settings: ProxySettings & { mode: NetworkProxyMode }) {
  switch (settings.mode) {
    case "manual":
      setProxyEnv(settings.proxy, settings.proxyBypassRules);
      break;

    case "env":
      setEnvPair(
        "http_proxy",
        "HTTP_PROXY",
        originalProxyEnv.httpProxy || originalProxyEnv.HTTP_PROXY
      );
      setEnvPair(
        "https_proxy",
        "HTTPS_PROXY",
        originalProxyEnv.httpsProxy || originalProxyEnv.HTTPS_PROXY
      );
      setEnvPair(
        "all_proxy",
        "ALL_PROXY",
        originalProxyEnv.allProxy || originalProxyEnv.ALL_PROXY
      );
      setEnvPair(
        "no_proxy",
        "NO_PROXY",
        originalProxyEnv.noProxy || originalProxyEnv.NO_PROXY
      );
      break;

    case "direct":
      setProxyEnv(null, null);
      break;

    case "system":
      if (settings.proxy) {
        // Butler does not understand Electron's "system" proxy mode. Export the
        // resolved system proxy as HTTP(S)_PROXY so child processes inherit it.
        const envProxy = systemProxyToEnvProxy(settings.proxy);
        setProxyEnv(envProxy, effectiveNoProxyForSystemMode());
      } else {
        setProxyEnv(null, null);
      }
      break;

    default:
      setProxyEnv(null, null);
      break;
  }
}

async function applyProxySettingsToSession(
  ourSession: Session,
  settings: ProxySettings & { mode: NetworkProxyMode }
) {
  if (process.env.ITCH_EMULATE_OFFLINE === "1") {
    ourSession.enableNetworkEmulation({
      offline: true,
    });
  }

  switch (settings.mode) {
    case "manual":
    case "env":
      await (ourSession as any).setProxy({
        mode: "fixed_servers",
        proxyRules: settings.proxy,
        proxyBypassRules: settings.proxyBypassRules || undefined,
      });
      break;

    case "direct":
      await (ourSession as any).setProxy({
        mode: "direct",
      });
      break;

    case "system":
    default:
      await (ourSession as any).setProxy({
        mode: "system",
      });
      break;
  }
}

async function lookupHost(hostname: string): Promise<string> {
  try {
    const results = await dns.promises.lookup(hostname, { all: true });
    if (!results.length) {
      return "no records";
    }
    return results.map((result) => result.address).join(", ");
  } catch (e) {
    return `error: ${e.code || e.message || e}`;
  }
}

async function runApiPing(ourSession: Session): Promise<{
  status: "ok" | "failed" | "unknown";
  detail: string;
}> {
  try {
    const fetchImpl =
      typeof (ourSession as any).fetch === "function"
        ? (ourSession as any).fetch.bind(ourSession)
        : null;

    if (!fetchImpl) {
      return {
        status: "unknown",
        detail: "session.fetch is not available in this Electron runtime",
      };
    }

    const response = await fetchImpl(`${urls.itchio}/country`, {
      method: "GET",
      cache: "no-store",
    });
    return {
      status: response.ok ? "ok" : "failed",
      detail: `HTTP ${response.status} ${response.statusText}`,
    };
  } catch (e) {
    return {
      status: "failed",
      detail: e.message || `${e}`,
    };
  }
}

export async function runNetworkDiagnostics(
  store: Store,
  reason: string,
  settings?: ProxySettings & { mode: NetworkProxyMode }
) {
  const envSettings = readEnvironmentProxySettings(
    process.env as Record<string, string>
  );
  const effectiveSettings =
    settings ||
    computeEffectiveProxySettings(
      store.getState().preferences,
      store.getState().system.networkDiagnostics?.detectedProxy,
      readEnvironmentProxySettings(originalProxyEnv as Record<string, string>)
    );
  const netSession = session.fromPartition(NET_PARTITION_NAME, {
    cache: false,
  });

  const [detectedProxy, dnsItchio, dnsBroth, apiPing] = await Promise.all([
    detectSystemProxy(),
    lookupHost(new URL(urls.itchio).hostname),
    lookupHost(new URL(urls.brothRepo).hostname),
    runApiPing(netSession),
  ]);

  logger.info(
    `Network diagnostics (${reason}): mode=${effectiveSettings.mode} detectedProxy=${
      detectedProxy || "DIRECT"
    } effectiveProxy=${effectiveSettings.proxy || "DIRECT"} api=${apiPing.status} ${
      apiPing.detail
    }`
  );

  store.dispatch(
    actions.networkDiagnosticsUpdated({
      updatedAt: Date.now(),
      lastReason: reason,
      envHttpProxy: envSettings.httpProxy,
      envHttpsProxy: envSettings.httpsProxy,
      envAllProxy: envSettings.allProxy,
      envNoProxy: envSettings.noProxy,
      detectedProxy,
      detectedProxySource: detectedProxy ? "os" : "direct",
      effectiveMode: effectiveSettings.mode,
      effectiveProxy: effectiveSettings.proxy,
      effectiveProxySource: effectiveSettings.proxySource,
      effectiveProxyBypassRules: effectiveSettings.proxyBypassRules,
      dnsItchio,
      dnsBroth,
      apiPingStatus: apiPing.status,
      apiPingDetail: apiPing.detail,
    })
  );
}

export async function refreshProxyState(store: Store, reason: string) {
  const envSettings = readEnvironmentProxySettings(
    originalProxyEnv as Record<string, string>
  );
  const detectedSystemProxy = await detectSystemProxy();
  const effectiveSettings = computeEffectiveProxySettings(
    store.getState().preferences,
    detectedSystemProxy,
    envSettings
  );

  logger.info(
    `Applying proxy settings (${reason}): detected=${
      detectedSystemProxy || "DIRECT"
    } mode=${effectiveSettings.mode} effective=${
      effectiveSettings.proxy || "DIRECT"
    } bypass=${effectiveSettings.proxyBypassRules || "<none>"}`
  );

  store.dispatch(
    actions.proxySettingsDetected({
      proxy: effectiveSettings.proxy,
      source: effectiveSettings.proxySource,
      proxyBypassRules: effectiveSettings.proxyBypassRules,
    })
  );

  applyProcessProxyEnvironment(effectiveSettings);

  const sessionsToApply: Session[] = [
    session.fromPartition(NET_PARTITION_NAME, { cache: false }),
    session.fromPartition(partitionForApp(), { cache: true }),
  ];

  const profile = store.getState().profile.profile;
  if (profile) {
    sessionsToApply.push(
      session.fromPartition(partitionForUser(String(profile.user.id)), {
        cache: true,
      })
    );
  }

  for (const ourSession of sessionsToApply) {
    await applyProxySettingsToSession(ourSession, effectiveSettings);
  }

  await runNetworkDiagnostics(store, reason, effectiveSettings);
  return effectiveSettings;
}

export default function (watcher: Watcher) {
  watcher.on(actions.loginSucceeded, async (store, action) => {
    await refreshProxyState(store, "login-succeeded");
  });

  watcher.on(actions.updatePreferences, async (store, action) => {
    const payload = action.payload as Partial<PreferencesState>;
    if (
      !(
        "networkProxyMode" in payload ||
        "networkProxyRules" in payload ||
        "networkProxyBypassRules" in payload
      )
    ) {
      return;
    }

    await refreshProxyState(store, "preferences-updated");

    if (store.getState().butlerd.endpoint) {
      store.dispatch(
        actions.restartButlerd({
          reason: "proxy-settings-updated",
        })
      );
    }
  });

  watcher.on(actions.runNetworkDiagnostics, async (store, action) => {
    await runNetworkDiagnostics(store, action.payload.reason);
  });
}

export async function applyProxySettings(
  ourSession: Session,
  system: ProxySettings
) {
  const mode: NetworkProxyMode =
    system.proxySource === "manual"
      ? "manual"
      : system.proxySource === "env"
      ? "env"
      : system.proxySource === "direct"
      ? "direct"
      : "system";

  await applyProxySettingsToSession(ourSession, {
    mode,
    proxy: system.proxy,
    proxySource: system.proxySource,
    proxyBypassRules: system.proxyBypassRules,
  });
}
