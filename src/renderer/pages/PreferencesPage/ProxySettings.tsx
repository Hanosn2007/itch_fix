import { actions } from "common/actions";
import urls from "common/constants/urls";
import {
  Dispatch,
  NetworkDiagnostics,
  NetworkProxyMode,
  ProxySource,
} from "common/types";
import React from "react";
import Button from "renderer/basics/Button";
import Icon from "renderer/basics/Icon";
import SimpleSelect, { BaseOptionType } from "renderer/basics/SimpleSelect";
import { hook } from "renderer/hocs/hook";
import {
  SettingsGroup,
  SettingsGroupRow,
} from "renderer/pages/PreferencesPage/SettingsGroup";
import styled from "renderer/styles";

const MODE_OPTIONS: BaseOptionType[] = [
  { label: "System", value: "system" },
  { label: "Environment", value: "env" },
  { label: "Direct", value: "direct" },
  { label: "Manual", value: "manual" },
];

const ProxySettingsDiv = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;

  .headline {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .small {
    color: ${(props) => props.theme.secondaryText};
    font-size: 13px;
    line-height: 1.5;
  }

  .mono {
    font-family: monospace;
    user-select: text;
    word-break: break-all;
  }
`;

const ProxyInput = styled.input`
  width: 100%;
  background: ${(props) => props.theme.inputBackground};
  border: 1px solid ${(props) => props.theme.inputBorder};
  border-radius: 2px;
  color: ${(props) => props.theme.baseText};
  padding: 6px 8px;
`;

const ProxySelect = styled(SimpleSelect)`
  flex-grow: 0;
  flex-basis: 220px;
`;

const DiagnosticsGrid = styled.div`
  display: grid;
  grid-template-columns: minmax(140px, 180px) 1fr;
  gap: 6px 12px;
  font-size: 13px;

  .label {
    color: ${(props) => props.theme.secondaryText};
  }
`;

class ProxySettings extends React.PureComponent<Props> {
  render() {
    const {
      proxy,
      proxySource,
      diagnostics,
      networkProxyMode,
      networkProxyRules,
      networkProxyBypassRules,
    } = this.props;

    return (
      <ProxySettingsDiv>
        <div className="headline">
          <Icon icon="earth" />
          <strong>Network & Proxy Diagnostics</strong>
        </div>

        <SettingsGroup>
          <SettingsGroupRow active>
            <span>Proxy mode</span>
            <ProxySelect
              onChange={this.onModeChange}
              options={MODE_OPTIONS}
              value={
                MODE_OPTIONS.find((option) => option.value === networkProxyMode) ||
                MODE_OPTIONS[0]
              }
            />
          </SettingsGroupRow>

          {networkProxyMode === "manual" ? (
            <>
              <SettingsGroupRow active>
                <span>Manual proxy rules</span>
              </SettingsGroupRow>
              <ProxyInput
                type="text"
                placeholder="http://127.0.0.1:7890"
                value={networkProxyRules || ""}
                onChange={this.onProxyRulesChange}
              />

              <SettingsGroupRow active={!!networkProxyBypassRules}>
                <span>Bypass rules</span>
              </SettingsGroupRow>
              <ProxyInput
                type="text"
                placeholder="localhost,127.0.0.1,*.local"
                value={networkProxyBypassRules || ""}
                onChange={this.onBypassRulesChange}
              />
            </>
          ) : null}
        </SettingsGroup>

        <div className="small">
          Use this override when system proxy auto-detection behaves differently
          from browsers or from VPN / TUN / Network Extension traffic.{" "}
          <a href={urls.proxyDocs}>Learn more</a>
        </div>

        <Button
          icon="repeat"
          label="Run diagnostics"
          onClick={this.runDiagnostics}
        />

        <DiagnosticsGrid>
          <div className="label">Detected system proxy</div>
          <div className="mono">
            {diagnostics.detectedProxy || "DIRECT"}{" "}
            {this.renderSource(diagnostics.detectedProxySource)}
          </div>

          <div className="label">Effective mode</div>
          <div className="mono">
            {diagnostics.effectiveMode || networkProxyMode}{" "}
            {this.renderSource(diagnostics.effectiveProxySource)}
          </div>

          <div className="label">Effective proxy</div>
          <div className="mono">
            {diagnostics.effectiveProxy || proxy || "DIRECT"}{" "}
            {this.renderSource(diagnostics.effectiveProxySource || proxySource)}
          </div>

          <div className="label">NO_PROXY / bypass</div>
          <div className="mono">
            {diagnostics.effectiveProxyBypassRules || diagnostics.envNoProxy || "none"}
          </div>

          <div className="label">API ping</div>
          <div className="mono">
            {diagnostics.apiPingStatus || "unknown"}
            {diagnostics.apiPingDetail ? ` (${diagnostics.apiPingDetail})` : ""}
          </div>

          <div className="label">OAuth callback</div>
          <div className="mono">{diagnostics.oauthStatus || "idle"}</div>

          <div className="label">butlerd</div>
          <div className="mono">
            {diagnostics.butlerConnectionStatus || "unknown"}
            {diagnostics.butlerLastError
              ? ` (${diagnostics.butlerLastError})`
              : ""}
          </div>

          <div className="label">DNS itch.io</div>
          <div className="mono">{diagnostics.dnsItchio || "unknown"}</div>

          <div className="label">DNS broth.itch.zone</div>
          <div className="mono">{diagnostics.dnsBroth || "unknown"}</div>

          <div className="label">Environment proxy</div>
          <div className="mono">
            {diagnostics.envHttpsProxy ||
              diagnostics.envHttpProxy ||
              diagnostics.envAllProxy ||
              "DIRECT"}
          </div>
        </DiagnosticsGrid>
      </ProxySettingsDiv>
    );
  }

  renderSource(source?: ProxySource) {
    return source ? `[${source}]` : "";
  }

  runDiagnostics = () => {
    const { dispatch } = this.props;
    dispatch(actions.runNetworkDiagnostics({ reason: "preferences-panel" }));
  };

  onModeChange = (option: BaseOptionType) => {
    if (!option) {
      return;
    }

    const { dispatch } = this.props;
    dispatch(
      actions.updatePreferences({
        networkProxyMode: option.value as NetworkProxyMode,
      })
    );
  };

  onProxyRulesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { dispatch } = this.props;
    dispatch(
      actions.updatePreferences({
        networkProxyRules: e.currentTarget.value,
      })
    );
  };

  onBypassRulesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { dispatch } = this.props;
    dispatch(
      actions.updatePreferences({
        networkProxyBypassRules: e.currentTarget.value,
      })
    );
  };
}

interface Props {
  dispatch: Dispatch;
  proxy?: string;
  proxySource?: ProxySource;
  diagnostics: NetworkDiagnostics;
  networkProxyMode: NetworkProxyMode;
  networkProxyRules?: string;
  networkProxyBypassRules?: string;
}

export default hook((map) => ({
  proxy: map((rs) => rs.system.proxy),
  proxySource: map((rs) => rs.system.proxySource),
  diagnostics: map((rs) => rs.system.networkDiagnostics || {}),
  networkProxyMode: map((rs) => rs.preferences.networkProxyMode),
  networkProxyRules: map((rs) => rs.preferences.networkProxyRules),
  networkProxyBypassRules: map((rs) => rs.preferences.networkProxyBypassRules),
}))(ProxySettings);
