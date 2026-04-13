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
import type { AppAction } from '../types/index.js';

// Real sub-components
import { Header } from './Header.js';
import { FilterBar, shouldShowFilterBar } from './FilterBar.js';
import { Board } from './Board.js';
import { TerminalPane } from './TerminalPane.js';
import { StatusBar } from './StatusBar.js';
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
  canShowTerminalPane,
  TERMINAL_DIVIDER_WIDTH,
  getTerminalContentWidth,
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

  // --------------- keystroke routing -----------------------

  useInput((input, key) => {
    const { focus, activeTaskId, selectedTrackIndex, selectedTaskIndex, tracks, tasks } =
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
        const sortedTracks = [...tracks].sort((a, b) => a.sortOrder - b.sortOrder);
        const currentTrack = sortedTracks[selectedTrackIndex];
        const trackTasks = currentTrack
          ? tasks
              .filter((t) => t.trackId === currentTrack.id && t.archivedAt === undefined)
              .sort((a, b) => a.sortKey - b.sortKey)
          : [];
        const task = trackTasks[selectedTaskIndex];

        if (task) {
          dispatch({
            type: 'MODAL_OPEN',
            payload: { modal: 'task-description', data: { task } },
          });
          dispatch({ type: 'FOCUS_SET', payload: 'modal' });
        }
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

      // Task navigation within the current track
      const sortedTracks = [...tracks].sort((a, b) => a.sortOrder - b.sortOrder);
      const currentTrack = sortedTracks[selectedTrackIndex];
      const trackTasks = currentTrack
        ? tasks
            .filter((t) => t.trackId === currentTrack.id && t.archivedAt === undefined)
            .sort((a, b) => a.sortKey - b.sortKey)
        : [];
      const task = trackTasks[selectedTaskIndex];

      if (key.upArrow || input === 'k') {
        const next = Math.max(0, selectedTaskIndex - 1);
        dispatch({ type: 'TASK_SELECT', payload: next });
        return;
      }
      if (key.downArrow || input === 'j') {
        const next = Math.min(trackTasks.length - 1, selectedTaskIndex + 1);
        dispatch({ type: 'TASK_SELECT', payload: next });
        return;
      }

      if (input === ',' || input === '<') {
        const nextRepoId = getNextActiveRepoId(state.repos, state.activeRepoId, -1);
        dispatch({ type: 'REPO_SWITCH', payload: nextRepoId });
        controller.setUIState({ activeRepoId: nextRepoId }).catch(() => {});
        return;
      }

      if (input === '.' || input === '>') {
        const nextRepoId = getNextActiveRepoId(state.repos, state.activeRepoId, 1);
        dispatch({ type: 'REPO_SWITCH', payload: nextRepoId });
        controller.setUIState({ activeRepoId: nextRepoId }).catch(() => {});
        return;
      }

      // ---- Actions -------------------------------------------
      if (input === 'n') {
        dispatch({ type: 'MODAL_OPEN', payload: { modal: 'create-task' } });
        dispatch({ type: 'FOCUS_SET', payload: 'modal' });
        return;
      }
      if (input === 'r') {
        if (task) {
          dispatch({
            type: 'MODAL_OPEN',
            payload: { modal: 'rename-task', data: { task } },
          });
          dispatch({ type: 'FOCUS_SET', payload: 'modal' });
        }
        return;
      }
      if (input === 'R') {
        if (task) {
          recreateTaskSession(task.id);
        }
        return;
      }
      if (input === 'd') {
        if (task) {
          dispatch({
            type: 'MODAL_OPEN',
            payload: { modal: 'delete-confirm', data: { task } },
          });
          dispatch({ type: 'FOCUS_SET', payload: 'modal' });
        }
        return;
      }
      if (input === 'P') {
        dispatch({
          type: 'MODAL_OPEN',
          payload: { modal: 'create-pillar' },
        });
        dispatch({ type: 'FOCUS_SET', payload: 'modal' });
        return;
      }
      if (input === 'D') {
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
        dispatch({
          type: 'MODAL_OPEN',
          payload: { modal: 'delete-pillar-confirm', data: { pillar, taskCount } },
        });
        dispatch({ type: 'FOCUS_SET', payload: 'modal' });
        return;
      }
      if (input === '[') {
        if (task && currentTrack) {
          const prevTrack = sortedTracks[selectedTrackIndex - 1];
          if (prevTrack) {
            controller.moveTask({ id: task.id, trackId: prevTrack.id }).catch(() => {});
          }
        }
        return;
      }
      if (input === ']') {
        if (task && currentTrack) {
          const nextTrack = sortedTracks[selectedTrackIndex + 1];
          if (nextTrack) {
            controller.moveTask({ id: task.id, trackId: nextTrack.id }).catch(() => {});
          }
        }
        return;
      }
      if (input === 'p') {
        if (task) {
          dispatch({
            type: 'MODAL_OPEN',
            payload: { modal: 'pillar-picker', data: { task } },
          });
          dispatch({ type: 'FOCUS_SET', payload: 'modal' });
        }
        return;
      }
      if (input === 'o') {
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
        return;
      }
      if (input === 'v') {
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
        return;
      }
      if (input === 'c') {
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
        return;
      }
      if (input === 'i') {
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
        return;
      }
      if (input === 'x') {
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
        return;
      }
      if (input === 'm') {
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
        return;
      }
      if (input === 'f') {
        dispatch({
          type: 'MODAL_OPEN',
          payload: { modal: 'filter-picker' },
        });
        dispatch({ type: 'FOCUS_SET', payload: 'modal' });
        return;
      }
      if (input === 'a') {
        if (task) {
          controller.archiveTask(task.id).catch(() => {});
        }
        return;
      }
      if (input === 's') {
        controller.triggerSync().catch(() => {});
        return;
      }
      if (input === 't') {
        if (!state.activeTaskId) {
          dispatch({
            type: 'STATUS_MESSAGE',
            payload: 'No session open for the selected task.',
          });
          return;
        }

        dispatch({ type: 'TERMINAL_PANE_SHOW' });
        focusTerminal();
        return;
      }
      if (input === 'z') {
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
        return;
      }
      if (key.return) {
        if (task) {
          openTaskSession(task.id);
        }
        return;
      }
      if (input === 'g') {
        dispatch({
          type: 'MODAL_OPEN',
          payload: { modal: 'view-picker' },
        });
        dispatch({ type: 'FOCUS_SET', payload: 'modal' });
        return;
      }
      if (input === 'q') {
        exit();
        return;
      }
      if (input === '?') {
        if (state.modal === null) {
          dispatch({ type: 'MODAL_OPEN', payload: { modal: 'help' } });
          dispatch({ type: 'FOCUS_SET', payload: 'modal' });
        } else {
          dispatch({ type: 'MODAL_CLOSE' });
          dispatch({ type: 'FOCUS_SET', payload: 'board' });
        }
        return;
      }
    }
  });

  // --------------- modal callbacks -------------------------

  const closeModal = () => {
    dispatch({ type: 'MODAL_CLOSE' });
    dispatch({ type: 'FOCUS_SET', payload: 'board' });
  };

  const sortedTracks = [...state.tracks].sort((a, b) => a.sortOrder - b.sortOrder);
  const backlogTrackIndex = sortedTracks.findIndex((track) => track.id === 'backlog');
  const filterBarVisible = shouldShowFilterBar(state);
  const contentHeight = Math.max(1, rows - 2 - (filterBarVisible ? 1 : 0));

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
        rows: Math.max(5, terminalRenderHeight),
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

  const renderModal = () => {
    if (modal === null) return null;

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
