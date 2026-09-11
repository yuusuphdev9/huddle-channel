import React, { useState, useEffect, useCallback } from 'react';
import { AppState, Channel, ChannelStatus, Message, avatarColorFor, initialsFrom, formatTimestamp } from './types';
import { getChannels, getMessages, sendMessage, ApiMessage } from './api/client';
import WorkspaceSwitcher from './components/WorkspaceSwitcher/WorkspaceSwitcher';
import Sidebar from './components/Sidebar/Sidebar';
import ChatPane from './components/ChatPane/ChatPane';
import styles from './App.module.css';

// ── Token + user handoff from login app ──────────────────
// Login app redirects here with ?token=xxx&name=xxx&email=xxx
const LOGIN_URL = import.meta.env.VITE_LOGIN_URL ?? 'https://huddle-one-psi.vercel.app';

const params = new URLSearchParams(window.location.search);
const urlToken = params.get('token');
const urlName  = params.get('name');
const urlEmail = params.get('email');

if (urlToken) {
  localStorage.setItem('huddle_token', urlToken);
  if (urlName)  localStorage.setItem('huddle_user_name', urlName);
  if (urlEmail) localStorage.setItem('huddle_user_email', urlEmail);
  // Remove credentials from URL bar
  params.delete('token');
  params.delete('name');
  params.delete('email');
  const clean = window.location.pathname + (params.toString() ? `?${params}` : '');
  window.history.replaceState({}, '', clean);
}

function redirectToLogin() {
  localStorage.removeItem('huddle_token');
  localStorage.removeItem('huddle_user_name');
  localStorage.removeItem('huddle_user_email');
  if (LOGIN_URL) {
    try {
      const target = new URL(LOGIN_URL, window.location.origin);
      if (window.location.href !== target.href) {
        window.location.href = target.href;
      }
    } catch {
      window.location.href = LOGIN_URL;
    }
  }
}

// If no token at all → redirect to login
if (!localStorage.getItem('huddle_token')) {
  if (LOGIN_URL && !window.location.href.startsWith(LOGIN_URL)) {
    redirectToLogin();
  }
}

const storedName  = localStorage.getItem('huddle_user_name') ?? '';
const storedEmail = localStorage.getItem('huddle_user_email') ?? '';
const displayName = storedName || storedEmail.split('@')[0] || 'You';

const DM_STORAGE_KEY = `huddle_dms_${storedEmail || storedName || 'guest'}`;

function loadSavedDms(): Channel[] {
  try {
    const raw = localStorage.getItem(DM_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* ignore */ }
  return [];
}

function saveDms(dms: Channel[]) {
  try {
    localStorage.setItem(DM_STORAGE_KEY, JSON.stringify(dms));
  } catch { /* ignore */ }
}

// Build workspace from real user info instead of mock data
const userWorkspace: AppState['workspace'] = {
  id: 'user',
  name: displayName,
  initials: initialsFrom(displayName),
  avatarColor: avatarColorFor(storedEmail || displayName),
};

const mapApiMessage = (m: ApiMessage): Message => {
  const authorName = m.author?.name || m.userName || m.author?.email || 'User';
  const authorId = m.author?.id || m.userId || authorName;
  return {
    id: m.id,
    author: authorName,
    authorId: m.author?.id || m.userId,
    authorInitials: initialsFrom(authorName),
    avatarColor: avatarColorFor(authorId),
    timestamp: formatTimestamp(m.createdAt),
    content: m.content,
  };
};

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>({
    workspace: userWorkspace,
    channels: [],
    directMessages: loadSavedDms(), // real saved DMs, no mock Jordan Tate
    activeChannelId: '',
    channelStatus: 'loading',
  });
  const [channelStatus, setChannelStatus] = useState<ChannelStatus>('loading');
  const [mobileView, setMobileView] = useState<'sidebar' | 'chat'>('sidebar');

  const allChannels: Channel[] = [...appState.channels, ...appState.directMessages];
  const activeChannel = allChannels.find(c => c.id === appState.activeChannelId) ?? allChannels[0];

  // Load channels from API on mount
  useEffect(() => {
    getChannels()
      .then(({ channels }) => {
        if (!channels || !channels.length) {
          setChannelStatus('empty');
          return;
        }
        const mapped: Channel[] = channels.map(c => ({
          id: c.id,
          name: c.name,
          type: 'channel' as const,
          messages: [],
        }));
        setAppState(prev => ({
          ...prev,
          channels: mapped,
          activeChannelId: prev.activeChannelId || mapped[0].id,
        }));
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('401') || msg.includes('403')) {
          redirectToLogin();
        } else {
          setChannelStatus('error');
        }
      });
  }, []);

  // Fetch messages for a channel
  const fetchChannelMessages = useCallback(async (channelId: string, isInitial: boolean = false) => {
    if (!channelId) return;
    if (isInitial) {
      setChannelStatus('loading');
    }
    try {
      const { messages } = await getMessages(channelId);
      const mapped = (messages || []).map(mapApiMessage);
      setAppState(prev => ({
        ...prev,
        channels: prev.channels.map(ch =>
          ch.id === channelId ? { ...ch, messages: mapped } : ch
        ),
      }));
      setChannelStatus(mapped.length === 0 ? 'empty' : 'loaded');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('401') || msg.includes('403')) {
        redirectToLogin();
      } else if (isInitial) {
        setChannelStatus('error');
      }
    }
  }, []);

  // Handle active channel change and auto-polling
  useEffect(() => {
    if (!appState.activeChannelId) return;

    const isDm = appState.directMessages.some(dm => dm.id === appState.activeChannelId);
    if (isDm) {
      const dm = appState.directMessages.find(d => d.id === appState.activeChannelId);
      setChannelStatus(dm && dm.messages.length > 0 ? 'loaded' : 'empty');
      return;
    }

    // Initial load for channel
    fetchChannelMessages(appState.activeChannelId, true);

    // Auto-poll every 3 seconds for real-time updates between multiple users
    const pollInterval = setInterval(() => {
      fetchChannelMessages(appState.activeChannelId, false);
    }, 3000);

    return () => clearInterval(pollInterval);
  }, [appState.activeChannelId, appState.directMessages, fetchChannelMessages]);

  // Select channel or DM
  const handleSelectChannel = (id: string) => {
    setAppState(prev => ({ ...prev, activeChannelId: id }));
    setMobileView('chat');
  };

  // Start a direct message with another user
  const handleStartDm = (authorName: string, authorId?: string) => {
    if (!authorName || authorName.toLowerCase() === displayName.toLowerCase()) return;
    const dmId = `dm-${authorId || authorName.toLowerCase().replace(/\s+/g, '-')}`;

    setAppState(prev => {
      const existing = prev.directMessages.find(d => d.id === dmId);
      if (existing) {
        return { ...prev, activeChannelId: dmId };
      }
      const newDm: Channel = {
        id: dmId,
        name: authorName,
        type: 'dm',
        messages: [],
      };
      const nextDms = [...prev.directMessages, newDm];
      saveDms(nextDms);
      return {
        ...prev,
        directMessages: nextDms,
        activeChannelId: dmId,
      };
    });
    setMobileView('chat');
  };

  // Send message — handles both channels and direct messages
  const handleSend = async (text: string) => {
    if (!text.trim() || !appState.activeChannelId) return;

    const isDm = appState.directMessages.some(dm => dm.id === appState.activeChannelId);
    const now = new Date().toISOString();
    const optimisticId = `local-${Date.now()}`;
    const optimistic: Message = {
      id: optimisticId,
      author: displayName,
      authorInitials: initialsFrom(displayName),
      avatarColor: avatarColorFor(storedEmail || displayName),
      timestamp: formatTimestamp(now),
      content: text,
    };

    if (isDm) {
      setAppState(prev => {
        const nextDms = prev.directMessages.map(dm =>
          dm.id === prev.activeChannelId
            ? { ...dm, messages: [...dm.messages, optimistic] }
            : dm
        );
        saveDms(nextDms);
        return { ...prev, directMessages: nextDms };
      });
      setChannelStatus('loaded');
      return;
    }

    // Channel message: optimistic addition
    setAppState(prev => ({
      ...prev,
      channels: prev.channels.map(ch =>
        ch.id === prev.activeChannelId
          ? { ...ch, messages: [...ch.messages, optimistic] }
          : ch
      ),
    }));
    setChannelStatus('loaded');

    try {
      const saved = await sendMessage(appState.activeChannelId, text);
      const real = mapApiMessage(saved);
      setAppState(prev => ({
        ...prev,
        channels: prev.channels.map(ch =>
          ch.id === prev.activeChannelId
            ? {
                ...ch,
                messages: ch.messages.map(m => (m.id === optimisticId ? real : m)),
              }
            : ch
        ),
      }));
    } catch (err: unknown) {
      console.error('Failed to send message:', err);
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('401') || msg.includes('403')) {
        redirectToLogin();
      }
    }
  };

  // Retry loading messages
  const handleRetry = () => {
    fetchChannelMessages(appState.activeChannelId, true);
  };

  return (
    <div className={styles.app}>
      <div className={styles.shell}>
        <WorkspaceSwitcher workspace={appState.workspace} />
        <Sidebar
          workspace={appState.workspace}
          channels={appState.channels}
          directMessages={appState.directMessages}
          activeChannelId={appState.activeChannelId}
          onSelectChannel={handleSelectChannel}
          onSignOut={redirectToLogin}
          hidden={mobileView === 'chat'}
        />
        {activeChannel && (
          <ChatPane
            channel={activeChannel}
            status={channelStatus}
            onSend={handleSend}
            onRetry={handleRetry}
            onBack={() => setMobileView('sidebar')}
            hidden={mobileView === 'sidebar'}
            currentUserName={displayName}
            onStartDm={handleStartDm}
          />
        )}
      </div>
    </div>
  );
};

export default App;
