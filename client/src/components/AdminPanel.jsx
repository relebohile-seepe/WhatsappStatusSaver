import { useState, useEffect, useRef, useCallback } from 'react'
import socket from '../socket'
import { apiFetch } from '../api'
import WaStream from './WaStream'
import './AdminPanel.css'

export default function AdminPanel() {
  const [token,        setToken]        = useState(null)
  const [password,     setPassword]     = useState('')
  const [loginError,   setLoginError]   = useState(null)
  const [loggingIn,    setLoggingIn]    = useState(false)

  const [accounts,     setAccounts]     = useState([])
  const [loadingAccts, setLoadingAccts] = useState(false)
  const [selectedAcct, setSelectedAcct] = useState(null)

  const [chats,        setChats]        = useState([])
  const [loadingChats, setLoadingChats] = useState(false)
  const [selectedChat, setSelectedChat] = useState(null)
  const [unreadCounts, setUnreadCounts] = useState({}) // chatId -> live unread count

  const [messages,     setMessages]     = useState([])
  const [loadingMsgs,  setLoadingMsgs]  = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [hasMore,      setHasMore]      = useState(false)

  const [view,         setView]         = useState('chats') // 'chats' | 'stream'

  const messagesEndRef = useRef(null)
  const selectedChatRef = useRef(null)

  // Keep ref in sync so socket handlers always see the latest selected chat
  useEffect(() => { selectedChatRef.current = selectedChat }, [selectedChat])

  // ── Login ────────────────────────────────────────────────────────────────────
  const login = async (e) => {
    e.preventDefault()
    setLoggingIn(true)
    setLoginError(null)
    try {
      const { res, data } = await apiFetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`)
      if (!data.token) throw new Error('No token returned — check ADMIN_PASSWORD on Render')
      setToken(data.token)
      loadAccounts(data.token)
    } catch (e) {
      setLoginError(e.message)
    } finally {
      setLoggingIn(false)
    }
  }

  // ── Load accounts ─────────────────────────────────────────────────────────────
  const loadAccounts = async (t) => {
    setLoadingAccts(true)
    try {
      const { data } = await apiFetch('/api/admin/accounts', {
        headers: { 'x-admin-token': t },
      })
      const list = Array.isArray(data) ? data.filter(a => a.id) : []
      setAccounts(list)
      if (list.length === 1) setSelectedAcct(list[0])
    } catch (e) {
      console.error('Failed to load accounts', e)
    } finally {
      setLoadingAccts(false)
    }
  }

  // ── Load chats ────────────────────────────────────────────────────────────────
  const loadChats = useCallback(async (t) => {
    if (!t) return
    setLoadingChats(true)
    try {
      const { data } = await apiFetch('/api/admin/chats', {
        headers: { 'x-admin-token': t },
      })
      setChats(data)
      // Seed unread counts from the initial API response
      const counts = {}
      for (const c of data) counts[c.id] = c.unreadCount || 0
      setUnreadCounts(counts)
    } catch (e) {
      console.error('Failed to load chats', e)
    } finally {
      setLoadingChats(false)
    }
  }, [])

  // Load chats when an account is selected
  useEffect(() => {
    if (selectedAcct && token) loadChats(token)
  }, [selectedAcct, token, loadChats])

  // ── Real-time unread count updates via socket ─────────────────────────────────
  useEffect(() => {
    const onMsg = (msg) => {
      if (msg.fromMe) return
      // If this chat is already open, don't increment — messages are shown live
      if (selectedChatRef.current?.id === msg.chatId) return
      setUnreadCounts(prev => ({
        ...prev,
        [msg.chatId]: (prev[msg.chatId] || 0) + 1,
      }))
    }
    socket.on('chat_message', onMsg)
    return () => socket.off('chat_message', onMsg)
  }, [])

  // ── Load messages for selected chat ──────────────────────────────────────────
  const loadMessages = useCallback(async (chatId, t) => {
    if (!chatId || !t) return
    setLoadingMsgs(true)
    setHasMore(false)
    try {
      const { data } = await apiFetch(`/api/admin/messages/${encodeURIComponent(chatId)}`, {
        headers: { 'x-admin-token': t },
      })
      setMessages(data)
      setHasMore(data.length >= 100)
      // Clear unread badge for this chat when opened
      setUnreadCounts(prev => ({ ...prev, [chatId]: 0 }))
    } catch (e) {
      console.error('Failed to load messages', e)
    } finally {
      setLoadingMsgs(false)
    }
  }, [])

  useEffect(() => {
    if (selectedChat && token) loadMessages(selectedChat.id, token)
  }, [selectedChat, token, loadMessages])

  // ── Load earlier messages (prepend) ──────────────────────────────────────────
  const loadEarlier = useCallback(async () => {
    if (!selectedChat || !token || loadingEarlier) return
    setLoadingEarlier(true)
    try {
      const oldest = messages[0]?.timestamp
      if (!oldest) return
      const url = `/api/admin/messages/${encodeURIComponent(selectedChat.id)}?before=${oldest}`
      const { data } = await apiFetch(url, { headers: { 'x-admin-token': token } })
      if (data.length > 0) {
        setMessages(prev => [...data, ...prev])
        setHasMore(data.length >= 100)
      } else {
        setHasMore(false)
      }
    } catch (e) {
      console.error('Failed to load earlier messages', e)
    } finally {
      setLoadingEarlier(false)
    }
  }, [selectedChat, token, messages, loadingEarlier])

  // Append live incoming messages to open chat
  useEffect(() => {
    const onMsg = (msg) => {
      if (selectedChatRef.current?.id === msg.chatId) {
        setMessages(prev => [...prev, msg])
      }
    }
    socket.on('chat_message', onMsg)
    return () => socket.off('chat_message', onMsg)
  }, [])

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ── Login gate ────────────────────────────────────────────────────────────────
  if (!token) {
    return (
      <div className="admin-login">
        <div className="admin-login-card">
          <div className="admin-login-icon">🔐</div>
          <h2>Admin Access</h2>
          <p>Enter your admin password to manage linked accounts and view their WhatsApp sessions live.</p>
          <form onSubmit={login} className="admin-login-form">
            <input
              type="password"
              placeholder="Admin password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="admin-input"
              autoFocus
            />
            {loginError && <div className="admin-error">{loginError}</div>}
            <button
              type="submit"
              className="btn-admin-login"
              disabled={loggingIn || !password}
            >
              {loggingIn ? 'Verifying…' : 'Access Admin Panel'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  // ── Authenticated ─────────────────────────────────────────────────────────────
  const totalUnread = Object.values(unreadCounts).reduce((a, b) => a + b, 0)

  return (
    <div className="admin-layout">

      {/* Account sidebar */}
      <aside className="admin-sidebar">
        <div className="admin-sidebar-header">
          <span className="admin-sidebar-title">Linked Accounts</span>
          <button
            className="admin-refresh-btn"
            onClick={() => loadAccounts(token)}
            title="Refresh"
          >
            🔄
          </button>
        </div>

        <div className="admin-account-list">
          {loadingAccts ? (
            <div className="admin-state"><div className="admin-spinner" /> Loading…</div>
          ) : accounts.length === 0 ? (
            <div className="admin-state">No accounts connected</div>
          ) : accounts.map(acc => (
            <button
              key={acc.id}
              className={`admin-account-item ${selectedAcct?.id === acc.id ? 'active' : ''}`}
              onClick={() => setSelectedAcct(acc)}
            >
              <div className="acct-avatar">
                {acc.name?.[0]?.toUpperCase() || acc.phone?.[0] || '?'}
              </div>
              <div className="acct-info">
                <div className="acct-name">{acc.name || 'Unknown'}</div>
                <div className="acct-phone">+{acc.phone}</div>
                <div className={`acct-status ${acc.status === 'ready' ? 'online' : 'offline'}`}>
                  ● {acc.status}
                </div>
              </div>
            </button>
          ))}
        </div>

        {selectedAcct && (
          <div className="admin-acct-detail">
            <div className="detail-row">
              <span className="detail-label">Platform</span>
              <span className="detail-value">{selectedAcct.platform || '—'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Phone</span>
              <span className="detail-value">+{selectedAcct.phone}</span>
            </div>
            <div className="admin-badge">👁 Live admin view</div>
          </div>
        )}
      </aside>

      {/* Main content */}
      {!selectedAcct ? (
        <main className="admin-main">
          <div className="admin-welcome">
            <span>👤</span>
            <h3>Select an account</h3>
            <p>Choose a linked account from the sidebar to open its live WhatsApp session.</p>
          </div>
        </main>
      ) : (
        <div className="admin-content">

          {/* View tab bar */}
          <div className="admin-tab-bar">
            <button
              className={`admin-tab ${view === 'chats' ? 'active' : ''}`}
              onClick={() => setView('chats')}
            >
              Chats
              {totalUnread > 0 && (
                <span className="admin-tab-badge">{totalUnread > 99 ? '99+' : totalUnread}</span>
              )}
            </button>
            <button
              className={`admin-tab ${view === 'stream' ? 'active' : ''}`}
              onClick={() => setView('stream')}
            >
              Live Stream
            </button>
          </div>

          {view === 'stream' ? (
            <div className="admin-stream-wrap">
              <WaStream key={selectedAcct.id} />
            </div>
          ) : (
            <div className="admin-chat-view">

              {/* Chat list */}
              <div className="admin-chat-list">
                <div className="admin-chat-list-header">
                  <span className="admin-chat-list-title">Conversations</span>
                  <button
                    className="admin-refresh-btn"
                    onClick={() => loadChats(token)}
                    title="Refresh chats"
                  >
                    🔄
                  </button>
                </div>

                {loadingChats ? (
                  <div className="admin-state"><div className="admin-spinner" /> Loading…</div>
                ) : chats.length === 0 ? (
                  <div className="admin-state">No chats found</div>
                ) : chats.map(chat => {
                  const unread = unreadCounts[chat.id] || 0
                  return (
                    <button
                      key={chat.id}
                      className={`admin-chat-item ${selectedChat?.id === chat.id ? 'active' : ''}`}
                      onClick={() => setSelectedChat(chat)}
                    >
                      <div className="chat-avatar">
                        {(chat.name?.[0] || '?').toUpperCase()}
                      </div>
                      <div className="chat-item-info">
                        <div className="chat-item-top">
                          <span className="chat-item-name">{chat.name || chat.id}</span>
                          {chat.lastMessage?.timestamp && (
                            <span className="chat-item-time">
                              {new Date(chat.lastMessage.timestamp * 1000).toLocaleTimeString([], {
                                hour: '2-digit', minute: '2-digit',
                              })}
                            </span>
                          )}
                        </div>
                        <div className="chat-item-bottom">
                          <span className="chat-item-preview">
                            {chat.lastMessage?.body || (chat.lastMessage ? `[${chat.lastMessage.type}]` : '')}
                          </span>
                          {unread > 0 && (
                            <span className="chat-unread-badge">
                              {unread > 99 ? '99+' : unread}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>

              {/* Message view */}
              <main className="admin-main admin-msg-view">
                {!selectedChat ? (
                  <div className="admin-welcome">
                    <span>💬</span>
                    <h3>Select a chat</h3>
                    <p>Choose a conversation from the list to view messages.</p>
                  </div>
                ) : (
                  <>
                    <div className="admin-msg-header">
                      <div className="chat-avatar sm">
                        {(selectedChat.name?.[0] || '?').toUpperCase()}
                      </div>
                      <div className="admin-msg-header-info">
                        <div className="admin-msg-name">{selectedChat.name || selectedChat.id}</div>
                        {selectedChat.isGroup && (
                          <div className="admin-msg-group-label">Group</div>
                        )}
                      </div>
                    </div>

                    <div className="admin-msg-list">
                      {loadingMsgs ? (
                        <div className="admin-state"><div className="admin-spinner" /> Loading messages…</div>
                      ) : messages.length === 0 ? (
                        <div className="admin-state">No messages to display</div>
                      ) : (
                      <>
                        {hasMore && (
                          <button
                            className="load-earlier-btn"
                            onClick={loadEarlier}
                            disabled={loadingEarlier}
                          >
                            {loadingEarlier
                              ? <><div className="admin-spinner" /> Loading…</>
                              : '↑ Load earlier messages'}
                          </button>
                        )}
                        {messages.map(m => (
                          <div
                            key={m.id}
                            className={`admin-msg-bubble ${m.fromMe ? 'from-me' : 'from-them'}`}
                          >
                            {m.author && !m.fromMe && (
                              <div className="msg-author">{m.author}</div>
                            )}
                            <div className="msg-body">
                              {m.body || (m.type && m.type !== 'chat' ? `[${m.type}]` : '—')}
                            </div>
                            <div className="msg-time">
                              {new Date(m.timestamp * 1000).toLocaleTimeString([], {
                                hour: '2-digit', minute: '2-digit',
                              })}
                            </div>
                          </div>
                        ))}
                      </>
                      )}
                      <div ref={messagesEndRef} />
                    </div>
                  </>
                )}
              </main>

            </div>
          )}
        </div>
      )}

    </div>
  )
}
