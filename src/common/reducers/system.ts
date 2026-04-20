import { actions } from "common/actions";
import reducer from "common/reducers/reducer";

import { SystemState } from "common/types";

const initialState = {
  locationScanProgress: null,
} as SystemState;

export default reducer<SystemState>(initialState, (on) => {
  on(actions.systemAssessed, (state, action) => {
    const { system } = action.payload;
    return {
      ...state,
      ...system,
    };
  });

  on(actions.proxySettingsDetected, (state, action) => {
    const { proxy, source, proxyBypassRules } = action.payload;
    return {
      ...state,
      proxy,
      proxySource: source,
      proxyBypassRules,
    };
  });

  on(actions.networkDiagnosticsUpdated, (state, action) => {
    return {
      ...state,
      networkDiagnostics: {
        ...(state.networkDiagnostics || {}),
        ...action.payload,
      },
    };
  });

  on(actions.quit, (state, action) => {
    return {
      ...state,
      quitting: true,
    };
  });

  on(actions.cancelQuit, (state, action) => {
    return {
      ...state,
      quitting: false,
    };
  });

  on(actions.silentlyScanInstallLocations, (state, action) => {
    return {
      ...state,
      locationScanProgress: 0,
    };
  });

  on(actions.locationScanProgress, (state, action) => {
    const { progress } = action.payload;
    return {
      ...state,
      locationScanProgress: progress,
    };
  });

  on(actions.locationScanDone, (state, action) => {
    return {
      ...state,
      locationScanProgress: null,
    };
  });

  on(actions.spinningUpButlerd, (state, action) => {
    return {
      ...state,
      networkDiagnostics: {
        ...(state.networkDiagnostics || {}),
        butlerConnectionStatus: "starting",
      },
    };
  });

  on(actions.gotButlerdEndpoint, (state, action) => {
    return {
      ...state,
      networkDiagnostics: {
        ...(state.networkDiagnostics || {}),
        butlerConnectionStatus: "connected",
      },
    };
  });
});
