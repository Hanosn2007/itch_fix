import { actions } from "common/actions";
import * as messages from "common/butlerd/messages";
import { Profile } from "common/butlerd/messages";
import { Dispatch } from "common/types";
import React from "react";
import LoadingCircle from "renderer/basics/LoadingCircle";
import Link from "renderer/basics/Link";
import { rcall } from "renderer/butlerd/rcall";
import { doAsync } from "renderer/helpers/doAsync";
import { hook } from "renderer/hocs/hook";
import ProxySettings from "renderer/pages/PreferencesPage/ProxySettings";
import { Links } from "renderer/scenes/GateScene/styles";
import watching, { Watcher } from "renderer/hocs/watching";
import styled from "renderer/styles";
import { isEmpty } from "underscore";
import LoginForm from "renderer/scenes/GateScene/LoginForm";
import RememberedProfiles from "renderer/scenes/GateScene/RememberedProfiles";

const DiagnosticsPanel = styled.div`
  width: min(680px, calc(100vw - 48px));
  margin-top: 16px;
  padding: 14px 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  overflow-y: auto;
  max-height: 45vh;
`;

@watching
class LoginScreen extends React.PureComponent<Props, State> {
  constructor(props: LoginScreen["props"], context: any) {
    super(props, context);
    this.state = {
      loading: true,
      showingSaved: true,
      showingDiagnostics: false,
      profiles: [],
    };
  }

  componentDidMount() {
    this.refresh();
  }

  subscribe(watcher: Watcher) {
    watcher.on(actions.profilesUpdated, async (store, action) => {
      this.refresh();
    });
    watcher.on(actions.loginFailed, async (store, action) => {
      this.showForm();
    });
  }

  refresh() {
    doAsync(async () => {
      const { profiles } = await rcall(messages.ProfileList, {});
      this.setState({ loading: false, profiles });

      if (isEmpty(profiles)) {
        this.setState({ showingSaved: false });
      }
    });
  }

  render() {
    const { loading, showingSaved, showingDiagnostics, profiles } = this.state;
    if (loading) {
      return <LoadingCircle progress={-1} wide />;
    }

    return (
      <>
        {showingSaved ? (
          <RememberedProfiles profiles={profiles} showForm={this.showForm} />
        ) : (
          <LoginForm showSaved={this.showSaved} />
        )}

        <Links>
          <Link
            id="toggle-network-diagnostics"
            label={
              showingDiagnostics
                ? "Hide network diagnostics"
                : "Network & proxy diagnostics"
            }
            onClick={this.toggleDiagnostics}
          />
        </Links>

        {showingDiagnostics ? (
          <DiagnosticsPanel>
            <ProxySettings />
          </DiagnosticsPanel>
        ) : null}
      </>
    );
  }

  showForm = () => {
    this.setState({ showingSaved: false });
  };
  showSaved = () => {
    this.setState({ showingSaved: true });
  };

  toggleDiagnostics = () => {
    this.setState((state) => ({
      showingDiagnostics: !state.showingDiagnostics,
    }));
  };
}

interface Props {
  dispatch: Dispatch;
}

interface State {
  loading: boolean;
  showingSaved: boolean;
  showingDiagnostics: boolean;
  profiles: Profile[];
}

export default hook()(LoginScreen);
