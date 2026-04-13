// ============================================================
// AgentBoard — Root TUI layout (ink + React)
// ============================================================

import { useEffect, useMemo, useReducer, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { reducer, initialState, AppContext } from '../store/index.js';
import {
  createTerminalBufferStore,
  TerminalBufferContext,
} from '../store/terminal-buffer.js';
import type { AppController } from '../controller/index.js';
import type { AppAction, ModalType, TaskRecord } from '../types/index.js';

// Real sub-components
import { Header, HEADER_HEIGHT } from './Header.js';
import { FilterBar, shouldShowFilterBar } from './FilterBar.js';
import { Board } from './Board.js';
import { TerminalPane } from './TerminalPane.js';
import { StatusBar, STATUS_BAR_HEIGHT } from './StatusBar.js';
import { HelpOverlay } from './HelpOverlay.js';
import { ModalOverlay } from './ModalOverlay.js';
import { CreateTaskModal } from './modals/CreateTask.js';
import { RenameTaskModal } from './modals/RenameTask.js';
import { TaskDescriptionModal } from './modals/TaskDescription.js';
import { DeleteConfirmModal } from './modals/DeleteConfirm.js';
import { CreatePillarModal } from './modals/CreatePillar.js';
import { DeletePillarConfirmModal } from './modals/DeletePillarConfirm.js';
import { PillarPickerModal } from './modals/PillarPicker.js';
import { FilterOptionsModal } from './modals/FilterOptions.js';
import { ViewOptionsModal } from './modals/ViewOptions.js';
import {
  CommandPaletteModal,
  type CommandPaletteItem,
} from './modals/CommandPalette.js';
import {
  canShowTerminalPane,
  TERMINAL_DIVIDER_WIDTH,
  getTerminalContentWidth,
  getTerminalViewportHeight,
} from './terminal-layout.js';
import {
  appendTerminalInput,
  shouldTriggerTerminalPushSync,
} from './terminal-command.js';
import { openExternalUrl } from './open-external.js';
import { openPathInIDE, revealPathInFileManager } from './open-workspace.js';
import { getTaskPRUrl, hasOpenPR } from './pr-link.js';
import { canMergeTask } from './task-card-status.js';
import { getNextActiveRepoId } from './repo-switch.js';
import { useTerminalSize } from './use-terminal-size.js';
import { getHeaderContextTask } from './header-context.js';

// --------------- App component -------------------------------

const TERMINAL_RENDER_INTERVAL_MS = 50;

interface AppProps {
  controller: AppController;
}

export default function App({ controller }: AppProps) {
  const [state, baseDispatch] = useReducer(reducer, initialState);
  const terminalBufferStoreRef = useRef(createTerminalBufferStore());
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const postPushSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalBufferFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTerminalBufferRef = useRef<AppAction | null>(null);
  const lastTerminalBufferFlushRef = useRef(0);
  const terminalCommandRef = useRef('');
  const flushTerminalBufferUpdate = () => {
    if (terminalBufferFlushTimerRef.current) {
      clearTimeout(terminalBufferFlushTimerRef.current);
      terminalBufferFlushTimerRef.current = null;
    }

    const pending = pendingTerminalBufferRef.current;
    if (pending?.type !== 'BUFFER_UPDATE') {
      return;
    }

    pendingTerminalBufferRef.current = null;
    lastTerminalBufferFlushRef.current = Date.now();
    terminalBufferStoreRef.current.setSnapshot(pending.payload);
  };
  const scheduleTerminalBufferUpdate = (action: Extract<AppAction, { type: 'BUFFER_UPDATE' }>) => {
    pendingTerminalBufferRef.current = action;
    const elapsed = Date.now() - lastTerminalBufferFlushRef.current;

    if (elapsed >= TERMINAL_RENDER_INTERVAL_MS && !terminalBufferFlushTimerRef.current) {
      flushTerminalBufferUpdate();
      return;
    }

    if (terminalBufferFlushTimerRef.current) {
      return;
    }

    const delay = Math.max(0, TERMINAL_RENDER_INTERVAL_MS - elapsed);
    const timer = setTimeout(() => {
      flushTerminalBufferUpdate();
    }, delay);
    timer.unref?.();
    terminalBufferFlushTimerRef.current = timer;
  };
  const dispatch = (action: AppAction) => {
    if (action.type === 'BUFFER_UPDATE') {
      scheduleTerminalBufferUpdate(action);
      return;
    }

    baseDispatch(action);
  };
  const appContextValue = useMemo(
    () => ({ state, dispatch: baseDispatch }),
    [state, baseDispatch],
  );

  // Wire up the controller's dispatchRef so it always has the latest dispatch
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any)['dispatchRef'].current = dispatch;
  });

  // Lifecycle: connect on mount, disconnect on unmount
  useEffect(() => {
    void controller.start();
    return () => {
      controller.stop();
    };
  }, [controller]);

  useEffect(() => {
    if (!state.activeTaskId || !state.terminalPaneVisible) {
      return;
    }

    void controller.refreshBuffer(state.activeTaskId).catch(() => {});
  }, [controller, state.activeTaskId, state.terminalPaneVisible]);

  useEffect(() => {
    return () => {
      if (postPushSyncTimerRef.current) {
        clearTimeout(postPushSyncTimerRef.current);
      }
      if (terminalBufferFlushTimerRef.current) {
        clearTimeout(terminalBufferFlushTimerRef.current);
      }
    };
  }, []);

  const focusTerminal = () => {
    dispatch({ type: 'FOCUS_SET', payload: 'terminal' });
  };

  const openTaskSession = (taskId: string) => {
    void controller
      .openSession(taskId)
      .then(() => {
        focusTerminal();
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: 'Opened task shell.',
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to open session';
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: `Failed to open session: ${message}`,
        });
        dispatch({ type: 'FOCUS_SET', payload: 'board' });
      });
  };

  const recreateTaskSession = (taskId: string) => {
    void controller
      .recreateSession(taskId)
      .then(() => {
        focusTerminal();
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: 'Session recreated with the native terminal backend.',
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to recreate session';
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: `Failed to recreate session: ${message}`,
        });
      });
  };

  const prepareTaskWorkspacePath = async (taskId: string): Promise<string> => {
    const workspace = await controller.prepareTaskWorkspace(taskId);
    return workspace.path;
  };

  const sortedTracks = [...state.tracks].sort((a, b) => a.sortOrder - b.sortOrder);
  const backlogTrackIndex = sortedTracks.findIndex((track) => track.id === 'backlog');
  const selectedTrack = sortedTracks[state.selectedTrackIndex];
  const selectedTrackTasks = selectedTrack
    ? state.tasks
        .filter((task) => task.trackId === selectedTrack.id && task.archivedAt === undefined)
        .sort((a, b) => a.sortKey - b.sortKey)
    : [];
  const selectedTask = selectedTrackTasks[state.selectedTaskIndex];
  const contextTask = getHeaderContextTask(state);
  const contextTrackIndex =
    contextTask != null
      ? sortedTracks.findIndex((track) => track.id === contextTask.trackId)
      : -1;

  const openModal = (modal: Exclude<ModalType, null>, data?: unknown) => {
    dispatch({ type: 'MODAL_OPEN', payload: { modal, data } });
  };

  const closeModal = () => {
    dispatch({ type: 'MODAL_CLOSE' });
  };

  const switchRepo = (direction: -1 | 1) => {
    const nextRepoId = getNextActiveRepoId(state.repos, state.activeRepoId, direction);
    dispatch({ type: 'REPO_SWITCH', payload: nextRepoId });
    controller.setUIState({ activeRepoId: nextRepoId }).catch(() => {});
  };

  const openDeletePillarModal = (task: TaskRecord | undefined) => {
    if (!task?.pillarId) {
      dispatch({
        type: 'STATUS_MESSAGE',
        payload: 'Selected task has no pillar to delete.',
      });
      return;
    }

    const pillar = state.pillars.find((candidate) => candidate.id === task.pillarId);
    if (!pillar) {
      dispatch({
        type: 'STATUS_MESSAGE',
        payload: 'Selected task pillar no longer exists.',
      });
      return;
    }

    const taskCount = state.tasks.filter((candidate) => candidate.pillarId === pillar.id).length;
    openModal('delete-pillar-confirm', { pillar, taskCount });
  };

  const openPRForTask = (task: TaskRecord | undefined) => {
    if (!task) {
      return;
    }

    if (!hasOpenPR(task)) {
      dispatch({
        type: 'STATUS_MESSAGE',
        payload: 'Selected task has no open PR.',
      });
      return;
    }

    const repo = state.repos.find((candidate) => candidate.id === task.repoId);
    const prUrl = getTaskPRUrl(task, repo);
    if (!prUrl) {
      dispatch({
        type: 'STATUS_MESSAGE',
        payload: 'PR link is not available for the selected task.',
      });
      return;
    }

    void openExternalUrl(prUrl)
      .then(() => {
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: `Opening PR ${task.prNumber ?? ''}`.trim(),
        });
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Failed to open PR link';
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: message,
        });
      });
  };

  const openChecksForTask = (task: TaskRecord | undefined) => {
    if (!task) {
      return;
    }

    if (!hasOpenPR(task)) {
      dispatch({
        type: 'STATUS_MESSAGE',
        payload: 'Selected task has no open PR.',
      });
      return;
    }

    const repo = state.repos.find((candidate) => candidate.id === task.repoId);
    const prUrl = getTaskPRUrl(task, repo);
    if (!prUrl) {
      dispatch({
        type: 'STATUS_MESSAGE',
        payload: 'Checks link is not available for the selected task.',
      });
      return;
    }

    void openExternalUrl(`${prUrl}/checks`)
      .then(() => {
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: `Opening checks for PR #${task.prNumber ?? ''}`.trim(),
        });
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Failed to open checks link';
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: message,
        });
      });
  };

  const createPRForTask = (task: TaskRecord | undefined) => {
    if (!task) {
      return;
    }

    void controller
      .createTaskPR(task.id)
      .then(() => {
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: `Ensured PR for task ${task.id}`,
        });
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Failed to create PR';
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: message,
        });
      });
  };

  const openTaskInIDE = (task: TaskRecord | undefined) => {
    if (!task) {
      return;
    }

    const repo = state.repos.find((candidate) => candidate.id === task.repoId);
    if (!repo) {
      dispatch({
        type: 'STATUS_MESSAGE',
        payload: 'Repo not found for selected task.',
      });
      return;
    }

    void prepareTaskWorkspacePath(task.id)
      .then((path) => openPathInIDE(path, repo.preferredIde, repo.ideCommand))
      .then(() => {
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: `Opening IDE for ${task.title}`,
        });
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Failed to open IDE';
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: message,
        });
      });
  };

  const revealTaskWorkspace = (task: TaskRecord | undefined) => {
    if (!task) {
      return;
    }

    void prepareTaskWorkspacePath(task.id)
      .then((path) => revealPathInFileManager(path))
      .then(() => {
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: `Opening workspace for ${task.title}`,
        });
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Failed to open workspace';
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: message,
        });
      });
  };

  const mergePRForTask = (task: TaskRecord | undefined) => {
    if (!task) {
      return;
    }

    if (!canMergeTask(task)) {
      dispatch({
        type: 'STATUS_MESSAGE',
        payload: 'Merge requires an open PR, approved review, and passing build.',
      });
      return;
    }

    void controller
      .mergeTaskPR(task.id)
      .then(() => {
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: `Merged PR #${task.prNumber ?? ''}`.trim(),
        });
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : 'Failed to merge PR';
        dispatch({
          type: 'STATUS_MESSAGE',
          payload: message,
        });
      });
  };

  const focusOpenTerminal = () => {
    if (!state.activeTaskId) {
      dispatch({
        type: 'STATUS_MESSAGE',
        payload: 'No session open for the selected task.',
      });
      return;
    }

    dispatch({ type: 'TERMINAL_PANE_SHOW' });
    focusTerminal();
  };

  const fullscreenTerminal = () => {
    if (!state.activeTaskId) {
      dispatch({
        type: 'STATUS_MESSAGE',
        payload: 'No session open to expand.',
      });
      return;
    }

    dispatch({ type: 'TERMINAL_PANE_SHOW' });
    dispatch({ type: 'TERMINAL_FULLSCREEN_SET', payload: true });
    focusTerminal();
  };

  const moveContextTask = (direction: -1 | 1) => {
    if (!contextTask || contextTrackIndex < 0) {
      return;
    }

    const nextTrack = sortedTracks[contextTrackIndex + direction];
    if (!nextTrack) {
      return;
    }

    controller.moveTask({ id: contextTask.id, trackId: nextTrack.id }).catch(() => {});
  };

  const executeCommandPaletteAction = (commandId: string) => {
    switch (commandId) {
      case 'create-task':
        openModal('create-task');
        return;
      case 'rename-task':
        if (contextTask) {
          openModal('rename-task', { task: contextTask });
        }
        return;
      case 'edit-description':
        if (contextTask) {
          openModal('task-description', { task: contextTask });
        }
        return;
      case 'delete-task':
        if (contextTask) {
          openModal('delete-confirm', { task: contextTask });
        }
        return;
      case 'archive-task':
        closeModal();
        if (contextTask) {
          controller.archiveTask(contextTask.id).catch(() => {});
        }
        return;
      case 'assign-pillar':
        if (contextTask) {
          openModal('pillar-picker', { task: contextTask });
        }
        return;
      case 'create-pillar':
        openModal('create-pillar', contextTask ? { task: contextTask } : undefined);
        return;
      case 'delete-pillar':
        openDeletePillarModal(contextTask);
        return;
      case 'move-task-left':
        closeModal();
        moveContextTask(-1);
        return;
      case 'move-task-right':
        closeModal();
        moveContextTask(1);
        return;
      case 'open-shell':
        closeModal();
        if (contextTask) {
          openTaskSession(contextTask.id);
        }
        return;
      case 'recreate-shell':
        closeModal();
        if (contextTask) {
          recreateTaskSession(contextTask.id);
        }
        return;
      case 'focus-terminal':
        closeModal();
        focusOpenTerminal();
        return;
      case 'fullscreen-terminal':
        closeModal();
        fullscreenTerminal();
        return;
      case 'open-ide':
        closeModal();
        openTaskInIDE(contextTask);
        return;
      case 'open-workspace':
        closeModal();
        revealTaskWorkspace(contextTask);
        return;
      case 'create-pr':
        closeModal();
        createPRForTask(contextTask);
        return;
      case 'open-pr':
        closeModal();
        openPRForTask(contextTask);
        return;
      case 'open-checks':
        closeModal();
        openChecksForTask(contextTask);
        return;
      case 'merge-pr':
        closeModal();
        mergePRForTask(contextTask);
        return;
      case 'filters':
        openModal('filter-picker');
        return;
      case 'layout':
        openModal('view-picker');
        return;
      case 'sync':
        closeModal();
        controller.triggerSync().catch(() => {});
        return;
      case 'repo-prev':
        closeModal();
        switchRepo(-1);
        return;
      case 'repo-next':
        closeModal();
        switchRepo(1);
        return;
      case 'help':
        openModal('help');
        return;
      case 'quit':
        closeModal();
        exit();
        return;
      default:
        return;
    }
  };

  const commandPaletteCommands: CommandPaletteItem[] = [
    {
      id: 'create-task',
      title: 'Create task',
      section: 'Task',
      detail: 'Add a new task into the backlog track.',
      shortcut: 'n',
      keywords: ['new', 'backlog', 'add'],
    },
    {
      id: 'rename-task',
      title: 'Rename current task',
      section: 'Task',
      detail: contextTask ? `Rename ${contextTask.title}` : 'Rename the current task.',
      shortcut: 'r',
      keywords: ['title', 'edit'],
      disabled: contextTask == null,
      disabledReason: 'Select a task to rename it.',
    },
    {
      id: 'edit-description',
      title: 'Edit task description',
      section: 'Task',
      detail: 'Open the long-form task description editor.',
      shortcut: 'Ctrl+D',
      keywords: ['notes', 'description'],
      disabled: contextTask == null,
      disabledReason: 'Select a task to edit its description.',
    },
    {
      id: 'delete-task',
      title: 'Delete current task',
      section: 'Task',
      detail: 'Delete the selected task after confirmation.',
      shortcut: 'd',
      keywords: ['remove'],
      disabled: contextTask == null,
      disabledReason: 'Select a task to delete it.',
    },
    {
      id: 'archive-task',
      title: 'Archive current task',
      section: 'Task',
      detail: 'Archive the selected task.',
      shortcut: 'a',
      keywords: ['done', 'hide'],
      disabled: contextTask == null,
      disabledReason: 'Select a task to archive it.',
    },
    {
      id: 'assign-pillar',
      title: 'Assign pillar',
      section: 'Task',
      detail: 'Attach or change the pillar for the current task.',
      shortcut: 'p',
      keywords: ['label', 'pillar'],
      disabled: contextTask == null,
      disabledReason: 'Select a task to assign a pillar.',
    },
    {
      id: 'create-pillar',
      title: 'Create pillar',
      section: 'Task',
      detail: 'Create a new pillar and optionally assign it to the current task.',
      shortcut: 'P',
      keywords: ['new pillar'],
    },
    {
      id: 'delete-pillar',
      title: 'Delete current pillar',
      section: 'Task',
      detail: 'Delete the current pillar and every task attached to it.',
      shortcut: 'D',
      keywords: ['remove pillar'],
      disabled: contextTask?.pillarId == null,
      disabledReason: 'The current task does not have a pillar to delete.',
    },
    {
      id: 'move-task-left',
      title: 'Move task left',
      section: 'Task',
      detail: 'Move the current task to the previous track.',
      shortcut: '[',
      keywords: ['previous track', 'kanban'],
      disabled: contextTask == null || contextTrackIndex <= 0,
      disabledReason: 'The current task is already in the first track.',
    },
    {
      id: 'move-task-right',
      title: 'Move task right',
      section: 'Task',
      detail: 'Move the current task to the next track.',
      shortcut: ']',
      keywords: ['next track', 'kanban'],
      disabled:
        contextTask == null ||
        contextTrackIndex < 0 ||
        contextTrackIndex >= sortedTracks.length - 1,
      disabledReason: 'The current task is already in the last track.',
    },
    {
      id: 'open-shell',
      title: 'Open task shell',
      section: 'Session',
      detail: 'Start or attach the session for the current task.',
      shortcut: 'Enter',
      keywords: ['terminal', 'session', 'shell'],
      disabled: contextTask == null,
      disabledReason: 'Select a task to open its shell.',
    },
    {
      id: 'recreate-shell',
      title: 'Recreate task shell',
      section: 'Session',
      detail: 'Recreate the current task shell with the native backend.',
      shortcut: 'R',
      keywords: ['terminal', 'session', 'restart'],
      disabled: contextTask == null,
      disabledReason: 'Select a task to recreate its shell.',
    },
    {
      id: 'focus-terminal',
      title: 'Focus terminal pane',
      section: 'Session',
      detail: 'Jump into the embedded terminal pane.',
      shortcut: 't',
      keywords: ['terminal', 'pane'],
      disabled: state.activeTaskId == null,
      disabledReason: 'Open a task shell before focusing the terminal pane.',
    },
    {
      id: 'fullscreen-terminal',
      title: 'Expand terminal workspace',
      section: 'Session',
      detail: 'Make the terminal take over the workspace.',
      shortcut: 'z',
      keywords: ['terminal', 'fullscreen', 'expand'],
      disabled: state.activeTaskId == null,
      disabledReason: 'Open a task shell before expanding the terminal.',
    },
    {
      id: 'open-ide',
      title: 'Open workspace in IDE',
      section: 'Workspace',
      detail: 'Open the current task workspace in the configured IDE.',
      shortcut: 'i',
      keywords: ['editor', 'workspace'],
      disabled: contextTask == null,
      disabledReason: 'Select a task to open its workspace.',
    },
    {
      id: 'open-workspace',
      title: 'Reveal workspace',
      section: 'Workspace',
      detail: 'Open the current task workspace in Finder or Explorer.',
      shortcut: 'x',
      keywords: ['finder', 'explorer', 'folder'],
      disabled: contextTask == null,
      disabledReason: 'Select a task to reveal its workspace.',
    },
    {
      id: 'create-pr',
      title: 'Create or ensure pull request',
      section: 'GitHub',
      detail: 'Create the PR flow for the current task branch.',
      shortcut: 'c',
      keywords: ['github', 'pull request'],
      disabled: contextTask == null,
      disabledReason: 'Select a task to create a pull request.',
    },
    {
      id: 'open-pr',
      title: 'Open pull request',
      section: 'GitHub',
      detail: 'Open the current task PR in the browser.',
      shortcut: 'o',
      keywords: ['github', 'browser', 'pr'],
      disabled: contextTask == null || !hasOpenPR(contextTask),
      disabledReason: 'The current task does not have an open pull request.',
    },
    {
      id: 'open-checks',
      title: 'Open pull request checks',
      section: 'GitHub',
      detail: 'Open CI checks for the current task PR.',
      shortcut: 'v',
      keywords: ['github', 'checks', 'ci'],
      disabled: contextTask == null || !hasOpenPR(contextTask),
      disabledReason: 'The current task does not have an open pull request.',
    },
    {
      id: 'merge-pr',
      title: 'Merge pull request',
      section: 'GitHub',
      detail: 'Squash merge the current task PR when it is ready.',
      shortcut: 'm',
      keywords: ['github', 'merge'],
      disabled: contextTask == null || !canMergeTask(contextTask),
      disabledReason: 'Open PR, approved review, and passing build are required.',
    },
    {
      id: 'filters',
      title: 'Open filters',
      section: 'View',
      detail: 'Change repo and pillar filters.',
      shortcut: 'f',
      keywords: ['filter', 'repo', 'pillar'],
    },
    {
      id: 'layout',
      title: 'Change layout',
      section: 'View',
      detail: 'Choose the board and terminal layout.',
      shortcut: 'g',
      keywords: ['view', 'split', 'terminal'],
    },
    {
      id: 'repo-prev',
      title: 'Previous repo',
      section: 'View',
      detail: 'Switch to the previous repo filter.',
      shortcut: ',',
      keywords: ['repo', 'left'],
      disabled: state.repos.length === 0,
      disabledReason: 'Add a repo before switching repo scope.',
    },
    {
      id: 'repo-next',
      title: 'Next repo',
      section: 'View',
      detail: 'Switch to the next repo filter.',
      shortcut: '.',
      keywords: ['repo', 'right'],
      disabled: state.repos.length === 0,
      disabledReason: 'Add a repo before switching repo scope.',
    },
    {
      id: 'sync',
      title: 'Sync now',
      section: 'System',
      detail: 'Refresh PR, CI, and review state from GitHub.',
      shortcut: 's',
      keywords: ['refresh', 'github'],
    },
    {
      id: 'help',
      title: 'Open help',
      section: 'System',
      detail: 'Show the keyboard reference.',
      shortcut: '?',
      keywords: ['shortcuts', 'keys'],
    },
    {
      id: 'quit',
      title: 'Quit AgentBoard',
      section: 'System',
      detail: 'Exit the application.',
      shortcut: 'q',
      keywords: ['exit', 'close'],
    },
  ];

  // --------------- keystroke routing -----------------------

  useInput((input, key) => {
    const { focus, activeTaskId, selectedTrackIndex, selectedTaskIndex, tracks } =
      state;

    if (key.ctrl && input === 'c' && focus !== 'terminal') {
      exit();
      return;
    }

    if (focus === 'terminal') {
      if (key.escape) {
        terminalCommandRef.current = '';
        dispatch({ type: 'TERMINAL_FULLSCREEN_SET', payload: false });
        dispatch({ type: 'FOCUS_SET', payload: 'board' });
        return;
      }
      if (key.pageUp || (key.shift && key.upArrow)) {
        dispatch({
          type: 'TERMINAL_SCROLL_SET',
          payload: state.terminalScrollOffset + (key.pageUp ? 10 : 1),
        });
        return;
      }
      if (key.pageDown || (key.shift && key.downArrow)) {
        dispatch({
          type: 'TERMINAL_SCROLL_SET',
          payload: Math.max(
            0,
            state.terminalScrollOffset - (key.pageDown ? 10 : 1),
          ),
        });
        return;
      }
      // Forward raw input to the active session
      if (activeTaskId) {
        const commandBeforeSubmit = terminalCommandRef.current;
        let data = input;
        if (key.escape) data = '\x1b';
        else if (key.return) data = '\r';
        else if (key.tab) data = '\t';
        else if (key.backspace || key.delete) data = '\x7f';
        else if (key.upArrow) data = '\x1b[A';
        else if (key.downArrow) data = '\x1b[B';
        else if (key.leftArrow) data = '\x1b[D';
        else if (key.rightArrow) data = '\x1b[C';
        else if (key.ctrl && input === 'c') data = '\x03';
        terminalCommandRef.current = appendTerminalInput(terminalCommandRef.current, input, key);
        if (data) {
          if (state.terminalScrollOffset !== 0) {
            dispatch({ type: 'TERMINAL_SCROLL_RESET' });
          }
          const shouldTriggerPushSync =
            shouldTriggerTerminalPushSync(commandBeforeSubmit, key);

          void controller
            .sendInput(activeTaskId, data)
            .then(() => {
              if (shouldTriggerPushSync) {
                if (postPushSyncTimerRef.current) {
                  clearTimeout(postPushSyncTimerRef.current);
                }
                postPushSyncTimerRef.current = setTimeout(() => {
                  void controller.triggerSync().catch(() => {});
                }, 1500);
              }
            })
            .catch(() => {});
        }
      }
      return;
    }

    if (focus === 'modal') {
      if (key.escape) {
        dispatch({ type: 'MODAL_CLOSE' });
      }
      return;
    }

    // ---- Board / filterbar focus ----------------------------
    if (focus === 'board' || focus === 'filterbar') {
      if (key.ctrl && input === 'd') {
        if (selectedTask) {
          openModal('task-description', { task: selectedTask });
        }
        return;
      }

      if (key.ctrl && input === 'p') {
        openModal('command-palette');
        return;
      }

      if (key.ctrl || key.meta) {
        return;
      }

      // Track navigation
      if (key.leftArrow || input === 'h') {
        const next = Math.max(0, selectedTrackIndex - 1);
        dispatch({ type: 'TRACK_SELECT', payload: next });
        return;
      }
      if (key.rightArrow || input === 'l') {
        const next = Math.min(tracks.length - 1, selectedTrackIndex + 1);
        dispatch({ type: 'TRACK_SELECT', payload: next });
        return;
      }

      if (key.upArrow || input === 'k') {
        const next = Math.max(0, selectedTaskIndex - 1);
        dispatch({ type: 'TASK_SELECT', payload: next });
        return;
      }
      if (key.downArrow || input === 'j') {
        const next = Math.min(selectedTrackTasks.length - 1, selectedTaskIndex + 1);
        dispatch({ type: 'TASK_SELECT', payload: next });
        return;
      }

      if (input === ',' || input === '<') {
        switchRepo(-1);
        return;
      }

      if (input === '.' || input === '>') {
        switchRepo(1);
        return;
      }

      if (input === ':') {
        openModal('command-palette');
        return;
      }

      // ---- Actions -------------------------------------------
      if (input === 'n') {
        openModal('create-task');
        return;
      }
      if (input === 'r') {
        if (selectedTask) {
          openModal('rename-task', { task: selectedTask });
        }
        return;
      }
      if (input === 'R') {
        if (selectedTask) {
          recreateTaskSession(selectedTask.id);
        }
        return;
      }
      if (input === 'd') {
        if (selectedTask) {
          openModal('delete-confirm', { task: selectedTask });
        }
        return;
      }
      if (input === 'P') {
        openModal('create-pillar');
        return;
      }
      if (input === 'D') {
        openDeletePillarModal(selectedTask);
        return;
      }
      if (input === '[') {
        if (selectedTask && selectedTrack) {
          const prevTrack = sortedTracks[selectedTrackIndex - 1];
          if (prevTrack) {
            controller.moveTask({ id: selectedTask.id, trackId: prevTrack.id }).catch(() => {});
          }
        }
        return;
      }
      if (input === ']') {
        if (selectedTask && selectedTrack) {
          const nextTrack = sortedTracks[selectedTrackIndex + 1];
          if (nextTrack) {
            controller.moveTask({ id: selectedTask.id, trackId: nextTrack.id }).catch(() => {});
          }
        }
        return;
      }
      if (input === 'p') {
        if (selectedTask) {
          openModal('pillar-picker', { task: selectedTask });
        }
        return;
      }
      if (input === 'o') {
        openPRForTask(selectedTask);
        return;
      }
      if (input === 'v') {
        openChecksForTask(selectedTask);
        return;
      }
      if (input === 'c') {
        createPRForTask(selectedTask);
        return;
      }
      if (input === 'i') {
        openTaskInIDE(selectedTask);
        return;
      }
      if (input === 'x') {
        revealTaskWorkspace(selectedTask);
        return;
      }
      if (input === 'm') {
        mergePRForTask(selectedTask);
        return;
      }
      if (input === 'f') {
        openModal('filter-picker');
        return;
      }
      if (input === 'a') {
        if (selectedTask) {
          controller.archiveTask(selectedTask.id).catch(() => {});
        }
        return;
      }
      if (input === 's') {
        controller.triggerSync().catch(() => {});
        return;
      }
      if (input === 't') {
        focusOpenTerminal();
        return;
      }
      if (input === 'z') {
        fullscreenTerminal();
        return;
      }
      if (key.return) {
        if (selectedTask) {
          openTaskSession(selectedTask.id);
        }
        return;
      }
      if (input === 'g') {
        openModal('view-picker');
        return;
      }
      if (input === 'q') {
        exit();
        return;
      }
      if (input === '?') {
        if (state.modal === null) {
          openModal('help');
        } else {
          closeModal();
        }
        return;
      }
    }
  });

  const filterBarVisible = shouldShowFilterBar(state);
  const contentHeight = Math.max(
    1,
    rows - HEADER_HEIGHT - STATUS_BAR_HEIGHT - (filterBarVisible ? 1 : 0),
  );
  const sessionTaskIds = Array.from(
    new Set(
      [
        ...state.tasks.filter((task) => task.sessionId != null).map((task) => task.id),
        state.activeTaskId,
      ].filter((taskId): taskId is string => taskId != null),
    ),
  );
  const sessionTaskIdsKey = sessionTaskIds.join(',');

  // --------------- render ----------------------------------

  const { terminalPaneVisible, modal, modalPayload } = state;
  const narrowTerminalMode =
    terminalPaneVisible &&
    state.activeTaskId !== undefined &&
    !canShowTerminalPane(columns);
  const terminalSessionVisible =
    terminalPaneVisible &&
    (!narrowTerminalMode || state.focus === 'terminal' || state.terminalFullscreen);
  const terminalTakesOver =
    terminalPaneVisible &&
    state.activeTaskId !== undefined &&
    state.focus === 'terminal' &&
    (narrowTerminalMode || state.terminalFullscreen);
  const splitTerminalVisible =
    terminalPaneVisible &&
    terminalSessionVisible &&
    !terminalTakesOver;
  const stackedTerminalMode =
    splitTerminalVisible && state.terminalLayoutMode === 'top-bottom';
  const showSplitTerminalDivider =
    splitTerminalVisible && !stackedTerminalMode;
  const stackedDividerHeight =
    stackedTerminalMode && contentHeight >= 3 ? 1 : 0;
  const stackedBoardHeight = stackedTerminalMode
    ? Math.max(1, Math.ceil((contentHeight - stackedDividerHeight) / 2))
    : contentHeight;
  const stackedTerminalHeight = stackedTerminalMode
    ? Math.max(1, contentHeight - stackedBoardHeight - stackedDividerHeight)
    : contentHeight;
  const terminalRenderHeight = stackedTerminalMode
    ? stackedTerminalHeight
    : contentHeight;
  const terminalUsesFullWidth = terminalTakesOver || stackedTerminalMode;
  const payload = (modalPayload ?? {}) as Record<string, unknown>;

  useEffect(() => {
    if (!state.activeTaskId || !terminalSessionVisible) {
      return;
    }

    void controller
      .resizeSession({
        taskId: state.activeTaskId,
        cols: Math.max(20, getTerminalContentWidth(columns, terminalUsesFullWidth)),
        rows: Math.max(5, getTerminalViewportHeight(terminalRenderHeight)),
      })
      .catch(() => {});
  }, [
    columns,
    controller,
    state.activeTaskId,
    terminalSessionVisible,
    terminalRenderHeight,
    terminalUsesFullWidth,
  ]);

  useEffect(() => {
    if (sessionTaskIds.length === 0) {
      return;
    }

    let inFlight = false;
    const poll = () => {
      if (inFlight) {
        return;
      }

      inFlight = true;
      void Promise.all(
        sessionTaskIds.map((taskId) => controller.inspectSession(taskId).catch(() => null)),
      ).finally(() => {
        inFlight = false;
      });
    };

    poll();
    const timer = setInterval(poll, 1500);
    timer.unref?.();

    return () => {
      clearInterval(timer);
    };
  }, [controller, sessionTaskIdsKey]);

  const renderModal = () => {
    if (modal === null) return null;

    if (modal === 'command-palette') {
      return (
        <CommandPaletteModal
          commands={commandPaletteCommands}
          onSelect={executeCommandPaletteAction}
          onCancel={closeModal}
        />
      );
    }

    if (modal === 'help') {
      return <HelpOverlay />;
    }

    if (modal === 'create-task') {
      return (
        <CreateTaskModal
          onSubmit={(title, repoId, pillarId) => {
            if (backlogTrackIndex >= 0) {
              dispatch({ type: 'TRACK_SELECT', payload: backlogTrackIndex });
            }
            controller.createTask({ title, repoId, pillarId }).catch(() => {});
            closeModal();
          }}
          onCancel={closeModal}
        />
      );
    }

    if (modal === 'rename-task') {
      const task = payload['task'] as import('../types/index.js').TaskRecord | undefined;
      if (!task) return null;
      return (
        <RenameTaskModal
          task={task}
          onSubmit={(title) => {
            controller.renameTask({ id: task.id, title }).catch(() => {});
            closeModal();
          }}
          onCancel={closeModal}
        />
      );
    }

    if (modal === 'task-description') {
      const task = payload['task'] as import('../types/index.js').TaskRecord | undefined;
      if (!task) return null;
      return (
        <TaskDescriptionModal
          task={task}
          onSubmit={(description) => {
            controller.updateTaskDescription({ id: task.id, description }).catch(() => {});
            closeModal();
          }}
          onCancel={closeModal}
        />
      );
    }

    if (modal === 'create-pillar') {
      const task = payload['task'] as import('../types/index.js').TaskRecord | undefined;
      return (
        <CreatePillarModal
          onSubmit={(label) => {
            controller
              .createPillar({ label })
              .then((pillar) => {
                if (task) {
                  return controller.assignPillar({ id: task.id, pillarId: pillar.id });
                }
                return undefined;
              })
              .catch(() => {});
            closeModal();
          }}
          onCancel={closeModal}
        />
      );
    }

    if (modal === 'delete-pillar-confirm') {
      const pillar = payload['pillar'] as import('../types/index.js').PillarRecord | undefined;
      const taskCount = (payload['taskCount'] as number | undefined) ?? 0;
      if (!pillar) return null;
      return (
        <DeletePillarConfirmModal
          pillar={pillar}
          taskCount={taskCount}
          onConfirm={() => {
            controller.deletePillar({ id: pillar.id }).catch(() => {});
            closeModal();
          }}
          onCancel={closeModal}
        />
      );
    }

    if (modal === 'delete-confirm') {
      const task = payload['task'] as import('../types/index.js').TaskRecord | undefined;
      if (!task) return null;
      return (
        <DeleteConfirmModal
          task={task}
          onConfirm={() => {
            controller.deleteTask(task.id).catch(() => {});
            closeModal();
          }}
          onCancel={closeModal}
        />
      );
    }

    if (modal === 'filter-picker') {
      return (
        <FilterOptionsModal
          onSubmit={(filters) => {
            dispatch({ type: 'FILTER_UPDATE', payload: filters });
            dispatch({ type: 'TRACK_SELECT', payload: 0 });
            controller.setUIState({
              filters,
              activeViewId: undefined,
            }).catch(() => {});
            closeModal();
          }}
          onCancel={closeModal}
        />
      );
    }

    if (modal === 'pillar-picker') {
      const task = payload['task'] as import('../types/index.js').TaskRecord | undefined;
      if (!task) return null;
      return (
        <PillarPickerModal
          pillars={state.pillars}
          currentPillarId={task.pillarId}
          onSelect={(pillarId) => {
            controller.assignPillar({ id: task.id, pillarId }).catch(() => {});
            closeModal();
          }}
          onCreate={() => {
            dispatch({
              type: 'MODAL_OPEN',
              payload: { modal: 'create-pillar', data: { task } },
            });
          }}
          onDelete={(pillar) => {
            const taskCount = state.tasks.filter((candidate) => candidate.pillarId === pillar.id).length;
            dispatch({
              type: 'MODAL_OPEN',
              payload: { modal: 'delete-pillar-confirm', data: { pillar, taskCount } },
            });
          }}
          onCancel={closeModal}
        />
      );
    }

    if (modal === 'view-picker') {
      return (
        <ViewOptionsModal
          currentMode={state.terminalLayoutMode}
          onSelect={(mode) => {
            dispatch({ type: 'TERMINAL_LAYOUT_SET', payload: mode });
            controller.setUIState({
              terminalLayoutMode: mode,
            }).catch(() => {});
            closeModal();
          }}
          onCancel={closeModal}
        />
      );
    }

    return null;
  };

  return (
    <AppContext.Provider value={appContextValue}>
      <TerminalBufferContext.Provider value={terminalBufferStoreRef.current}>
        <Box flexDirection="column" height={rows} overflow="hidden">
          <Header />
          <FilterBar />
          <Box
            flexGrow={1}
            flexDirection={stackedTerminalMode ? 'column' : 'row'}
            overflow="hidden"
            height={contentHeight}
          >
            {(!terminalPaneVisible || !terminalTakesOver) && (
              <Board height={stackedTerminalMode ? stackedBoardHeight : contentHeight} />
            )}
            {stackedTerminalMode && stackedDividerHeight > 0 && (
              <Box height={stackedDividerHeight} overflow="hidden">
                <Text color="cyan">{'─'.repeat(Math.max(1, columns))}</Text>
              </Box>
            )}
            {showSplitTerminalDivider && (
              <Box
                flexDirection="column"
                width={TERMINAL_DIVIDER_WIDTH}
                height={contentHeight}
                overflow="hidden"
              >
                {Array.from({ length: contentHeight }, (_, idx) => (
                  <Box key={idx} width={TERMINAL_DIVIDER_WIDTH}>
                    <Text color="cyan">{'│'}</Text>
                  </Box>
                ))}
              </Box>
            )}
            {terminalPaneVisible &&
              terminalSessionVisible && (
                <TerminalPane
                  fullWidth={terminalUsesFullWidth}
                  height={terminalRenderHeight}
                  columns={columns}
                />
              )}
          </Box>
          <StatusBar />
          {modal !== null && (
            <ModalOverlay width={columns} height={rows}>
              {renderModal()}
            </ModalOverlay>
          )}
        </Box>
      </TerminalBufferContext.Provider>
    </AppContext.Provider>
  );
}
