// ============================================================
// AgentBoard — AppState store (useReducer + Context)
// ============================================================

import React from 'react';
import type {
  AppState,
  AppAction,
  AppFocus,
} from '../types/index.js';

// --------------- initialState --------------------------------

export const initialState: AppState = {
  focus: 'board' as AppFocus,
  modal: null,
  modalPayload: undefined,
  repos: [],
  pillars: [],
  labels: [],
  tracks: [],
  tasks: [],
  savedViews: [],
  activeRepoId: undefined,
  activeViewId: undefined,
  filters: {},
  selectedTrackIndex: 0,
  selectedTaskIndex: 0,
  terminalPaneVisible: false,
  terminalLayoutMode: 'side-by-side',
  activeTaskId: undefined,
  activeSessionBranch: undefined,
  activeSessionBackendType: undefined,
  sessionActivityByTaskId: {},
  terminalFullscreen: false,
  terminalScrollOffset: 0,
  syncInProgress: false,
  statusMessage: undefined,
  daemonConnected: false,
  themeMode: 'truecolor',
};

// --------------- reducer -------------------------------------

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'BOARD_LOADED': {
      const { repos, pillars, labels, tracks, tasks, savedViews, uiState } =
        action.payload;
      const sessionTaskIds = new Set(
        tasks.filter((task) => task.sessionId != null).map((task) => task.id),
      );
      const sessionActivityByTaskId = Object.fromEntries(
        Object.entries(state.sessionActivityByTaskId).filter(([taskId]) =>
          sessionTaskIds.has(taskId),
        ),
      );
      return {
        ...state,
        repos,
        pillars,
        labels,
        tracks,
        tasks,
        savedViews,
        // Merge uiState fields without clobbering existing selection indexes
        activeRepoId: uiState.activeRepoId ?? state.activeRepoId,
        activeViewId: uiState.activeViewId ?? state.activeViewId,
        filters: uiState.filters ?? state.filters,
        terminalPaneVisible:
          uiState.terminalPaneVisible ?? state.terminalPaneVisible,
        terminalLayoutMode:
          uiState.terminalLayoutMode ?? state.terminalLayoutMode,
        sessionActivityByTaskId,
        themeMode: uiState.themeMode ?? state.themeMode,
        // selectedTrackIndex and selectedTaskIndex are intentionally NOT reset
      };
    }

    case 'TRACK_SELECT':
      return {
        ...state,
        selectedTrackIndex: action.payload,
        selectedTaskIndex: 0,
      };

    case 'TASK_SELECT':
      return {
        ...state,
        selectedTaskIndex: action.payload,
      };

    case 'REPO_SWITCH':
      return {
        ...state,
        activeRepoId: action.payload,
        selectedTrackIndex: 0,
        selectedTaskIndex: 0,
      };

    case 'FILTER_UPDATE':
      return {
        ...state,
        filters: action.payload,
      };

    case 'FOCUS_SET':
      if (state.focus === action.payload) {
        return state;
      }
      return {
        ...state,
        focus: action.payload,
      };

    case 'MODAL_OPEN':
      return {
        ...state,
        modal: action.payload.modal,
        modalPayload: action.payload.data,
        focus: 'modal',
      };

    case 'MODAL_CLOSE':
      return {
        ...state,
        modal: null,
        modalPayload: undefined,
        focus: 'board',
      };

    case 'TERMINAL_PANE_TOGGLE':
      return {
        ...state,
        terminalPaneVisible: !state.terminalPaneVisible,
      };

    case 'TERMINAL_PANE_SHOW':
      return {
        ...state,
        terminalPaneVisible: true,
      };

    case 'TERMINAL_LAYOUT_SET':
      if (state.terminalLayoutMode === action.payload) {
        return state;
      }
      return {
        ...state,
        terminalLayoutMode: action.payload,
      };

    case 'TERMINAL_FULLSCREEN_SET':
      return {
        ...state,
        terminalFullscreen: action.payload,
      };

    case 'TERMINAL_SCROLL_SET':
      if (state.terminalScrollOffset === Math.max(0, action.payload)) {
        return state;
      }
      return {
        ...state,
        terminalScrollOffset: Math.max(0, action.payload),
      };

    case 'TERMINAL_SCROLL_RESET':
      if (state.terminalScrollOffset === 0) {
        return state;
      }
      return {
        ...state,
        terminalScrollOffset: 0,
      };

    case 'SESSION_OPENED':
      return {
        ...state,
        activeTaskId: action.payload.taskId,
        activeSessionBranch: action.payload.session.branch,
        activeSessionBackendType: action.payload.session.backendType,
        sessionActivityByTaskId: {
          ...state.sessionActivityByTaskId,
          [action.payload.taskId]:
            state.sessionActivityByTaskId[action.payload.taskId],
        },
        terminalPaneVisible: true,
        terminalFullscreen: false,
        terminalScrollOffset: 0,
      };

    case 'SESSION_ACTIVITY_UPDATED': {
      const existing = state.sessionActivityByTaskId[action.payload.taskId];
      if (action.payload.activity === null) {
        if (existing === undefined) {
          return state;
        }

        const next = { ...state.sessionActivityByTaskId };
        delete next[action.payload.taskId];
        return {
          ...state,
          sessionActivityByTaskId: next,
        };
      }

      const nextActivity = action.payload.activity;
      if (
        existing?.isBusy === nextActivity.isBusy &&
        existing?.kind === nextActivity.kind &&
        existing?.command === nextActivity.command &&
        existing?.label === nextActivity.label &&
        existing?.pid === nextActivity.pid &&
        existing?.sessionStatus === nextActivity.sessionStatus
      ) {
        return state;
      }

      return {
        ...state,
        sessionActivityByTaskId: {
          ...state.sessionActivityByTaskId,
          [action.payload.taskId]: nextActivity,
        },
      };
    }

    case 'SYNC_START':
      if (state.syncInProgress) {
        return state;
      }
      return {
        ...state,
        syncInProgress: true,
      };

    case 'SYNC_DONE':
      if (!state.syncInProgress) {
        return state;
      }
      return {
        ...state,
        syncInProgress: false,
      };

    case 'STATUS_MESSAGE':
      return {
        ...state,
        statusMessage: action.payload,
      };

    case 'DAEMON_CONNECTED':
      return {
        ...state,
        daemonConnected: true,
      };

    case 'DAEMON_DISCONNECTED':
      return {
        ...state,
        daemonConnected: false,
      };

    default:
      return state;
  }
}

// --------------- Context -------------------------------------

export const AppContext = React.createContext<{
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
}>({
  state: initialState,
  dispatch: () => {
    // no-op default; replaced by Provider
  },
});

// --------------- Hooks ---------------------------------------

export function useAppState(): AppState {
  return React.useContext(AppContext).state;
}

export function useAppDispatch(): React.Dispatch<AppAction> {
  return React.useContext(AppContext).dispatch;
}
