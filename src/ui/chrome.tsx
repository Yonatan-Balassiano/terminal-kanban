import React from 'react';
import { Text } from 'ink';
import type { SessionActivitySnapshot } from '../types/index.js';

export const UI_CHROME = {
  accent: '#7dd3fc',
  accentMuted: '#164e63',
  blue: '#93c5fd',
  danger: '#f87171',
  line: '#31384a',
  muted: '#94a3b8',
  panel: '#151827',
  panelAlt: '#202637',
  purple: '#d8b4fe',
  success: '#86efac',
  text: '#d7dde8',
  warning: '#fbbf24',
} as const;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const BADGE_TONES = {
  accent: { background: '#182536', foreground: UI_CHROME.accent },
  danger: { background: '#2b1d26', foreground: UI_CHROME.danger },
  info: { background: '#1e2636', foreground: UI_CHROME.blue },
  muted: { background: UI_CHROME.panelAlt, foreground: UI_CHROME.muted },
  neutral: { background: '#252b3a', foreground: UI_CHROME.text },
  purple: { background: '#261f36', foreground: UI_CHROME.purple },
  success: { background: '#18261c', foreground: UI_CHROME.success },
  warning: { background: '#2a2416', foreground: UI_CHROME.warning },
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export interface SessionBadgeModel {
  isSpinning: boolean;
  label: string;
  tone: BadgeTone;
}

export function useSpinnerFrame(active: boolean, intervalMs = 80): string {
  const [spinnerIndex, setSpinnerIndex] = React.useState(0);

  React.useEffect(() => {
    if (!active) {
      setSpinnerIndex(0);
      return;
    }

    const timer = setInterval(() => {
      setSpinnerIndex((index) => (index + 1) % SPINNER_FRAMES.length);
    }, intervalMs);
    timer.unref?.();

    return () => {
      clearInterval(timer);
    };
  }, [active, intervalMs]);

  return SPINNER_FRAMES[spinnerIndex] ?? SPINNER_FRAMES[0] ?? '*';
}

function normalizeActivityLabel(activity?: SessionActivitySnapshot): string {
  const label = activity?.label ?? activity?.command;
  if (!label || label.trim().length === 0) {
    return 'work';
  }

  return label.trim();
}

export function getSessionBadgeModel(
  activity: SessionActivitySnapshot | undefined,
  opts: {
    hasSession: boolean;
    isActiveSession: boolean;
  },
): SessionBadgeModel {
  if (activity?.sessionStatus === 'orphaned') {
    return { isSpinning: false, label: 'orphaned', tone: 'danger' };
  }

  if (activity?.sessionStatus === 'terminated') {
    return { isSpinning: false, label: 'ended', tone: 'muted' };
  }

  if (activity?.isBusy) {
    return {
      isSpinning: true,
      label: normalizeActivityLabel(activity),
      tone: 'warning',
    };
  }

  if (opts.isActiveSession) {
    return { isSpinning: false, label: 'live', tone: 'accent' };
  }

  if (opts.hasSession || activity?.sessionStatus === 'idle') {
    return { isSpinning: false, label: 'idle', tone: 'success' };
  }

  return { isSpinning: false, label: 'shell', tone: 'muted' };
}

export interface BadgeProps {
  icon?: string;
  label: string;
  tone?: BadgeTone;
  emphasis?: 'subtle' | 'strong';
}

export function Badge({
  icon,
  label,
  tone = 'neutral',
  emphasis = 'subtle',
}: BadgeProps): JSX.Element {
  const palette = BADGE_TONES[tone];
  const text = icon ? `${icon} ${label}` : label;

  return (
    <Text
      backgroundColor={palette.background}
      color={palette.foreground}
      bold={emphasis === 'strong'}
    >
      {` ${text} `}
    </Text>
  );
}

export interface SessionActivityBadgeProps {
  activity?: SessionActivitySnapshot;
  hasSession: boolean;
  isActiveSession: boolean;
}

export function SessionActivityBadge({
  activity,
  hasSession,
  isActiveSession,
}: SessionActivityBadgeProps): JSX.Element {
  const model = getSessionBadgeModel(activity, { hasSession, isActiveSession });
  const spinnerFrame = useSpinnerFrame(model.isSpinning);
  const icon =
    model.isSpinning
      ? spinnerFrame
      : model.label === 'live'
        ? '●'
        : model.label === 'idle'
          ? '◦'
          : model.label === 'orphaned'
            ? '!'
            : model.label === 'ended'
              ? '×'
              : '○';

  return <Badge icon={icon} label={model.label} tone={model.tone} />;
}

export function countActiveFilters(filters: {
  repoIds?: string[];
  pillarIds?: string[];
  labelIds?: string[];
  trackIds?: string[];
  prState?: string[];
  ciState?: string[];
  sessionState?: string[];
  searchText?: string;
  includeArchived?: boolean;
}): number {
  let count = 0;

  if (filters.repoIds && filters.repoIds.length > 0) count += filters.repoIds.length;
  if (filters.pillarIds && filters.pillarIds.length > 0) count += filters.pillarIds.length;
  if (filters.labelIds && filters.labelIds.length > 0) count += filters.labelIds.length;
  if (filters.trackIds && filters.trackIds.length > 0) count += filters.trackIds.length;
  if (filters.prState && filters.prState.length > 0) count += filters.prState.length;
  if (filters.ciState && filters.ciState.length > 0) count += filters.ciState.length;
  if (filters.sessionState && filters.sessionState.length > 0) count += filters.sessionState.length;
  if (filters.searchText && filters.searchText.length > 0) count += 1;
  if (filters.includeArchived) count += 1;

  return count;
}
