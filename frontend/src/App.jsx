import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'
import {
  DEMO_CURVE,
  buildSignatureEnvelope,
  decryptFromSender,
  encryptForRecipient,
  generateDemoKeyPair,
  signEnvelope,
  verifyEnvelopeSignature,
} from './cryptoDemo'

const SESSION_STORAGE_KEY = 'quantum-chat-session-v1'

function publicKeyLabel(publicKey) {
  return `(${publicKey.x}, ${publicKey.y})`
}

function loadStoredIdentity() {
  try {
    const stored = window.localStorage.getItem(SESSION_STORAGE_KEY)
    if (!stored) return null

    const identity = JSON.parse(stored)
    if (
      !identity?.name ||
      !identity?.user?.id ||
      typeof identity.privateKey !== 'number' ||
      typeof identity.signingPrivateKey !== 'number'
    ) {
      return null
    }

    return identity
  } catch {
    return null
  }
}

function saveStoredIdentity(identity) {
  if (!identity) return
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(identity))
}

function clearStoredIdentity() {
  window.localStorage.removeItem(SESSION_STORAGE_KEY)
}

function emitSocketWithAck(socket, eventName, data) {
  return new Promise((resolve, reject) => {
    socket.timeout(6000).emit(eventName, data, (error, response) => {
      if (error) {
        reject(new Error('Realtime request timed out.'))
        return
      }

      if (!response?.ok) {
        reject(new Error(response?.error || 'Realtime request failed.'))
        return
      }

      resolve(response)
    })
  })
}

function App() {
  const [nameInput, setNameInput] = useState('')
  const [identity, setIdentity] = useState(() => loadStoredIdentity())
  const [participants, setParticipants] = useState([])
  const [encryptedMessages, setEncryptedMessages] = useState([])
  const [visibleMessages, setVisibleMessages] = useState([])
  const [hiddenMessageCount, setHiddenMessageCount] = useState(0)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  const [lastDebug, setLastDebug] = useState(null)
  const messagesRef = useRef(null)
  const messagesEndRef = useRef(null)
  const shouldScrollAfterRenderRef = useRef(false)
  const socketRef = useRef(null)
  const identityRef = useRef(identity)

  const hasFullName = nameInput.trim().split(/\s+/).length >= 2

  useEffect(() => {
    identityRef.current = identity
    saveStoredIdentity(identity)
  }, [identity])

  function shouldStickToBottom() {
    const messageList = messagesRef.current
    return (
      !messageList ||
      messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80
    )
  }

  useEffect(() => {
    const socket = io({
      path: '/socket.io',
      transports: ['polling', 'websocket'],
    })
    socketRef.current = socket

    socket.on('users_updated', (users) => {
      setParticipants(users)
    })

    socket.on('messages_snapshot', (messages) => {
      shouldScrollAfterRenderRef.current = shouldStickToBottom()
      setEncryptedMessages(messages)
    })

    socket.on('message_created', (incomingMessage) => {
      shouldScrollAfterRenderRef.current = shouldStickToBottom()
      setEncryptedMessages((current) => {
        if (current.some((item) => item.id === incomingMessage.id)) return current
        return [...current, incomingMessage]
      })
    })

    socket.on('connect_error', () => {
      setError('Realtime connection failed. Refresh and try again.')
    })

    socket.on('connect', async () => {
      const savedIdentity = identityRef.current
      if (!savedIdentity) return

      try {
        const result = await emitSocketWithAck(socket, 'join_chat', {
          name: savedIdentity.name,
          publicKey: savedIdentity.publicKey,
          signingPublicKey: savedIdentity.signingPublicKey,
        })
        setIdentity((current) =>
          current
            ? {
                ...current,
                user: result.user,
              }
            : current,
        )
        setError('')
      } catch {
        setError('Could not restore chat session. Refresh and try again.')
      }
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [])

  function emitWithAck(eventName, data) {
    const socket = socketRef.current
    if (!socket) return Promise.reject(new Error('Realtime connection is not ready.'))

    return emitSocketWithAck(socket, eventName, data)
  }

  useEffect(() => {
    function handleDeveloperShortcut(event) {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        setDebugOpen((open) => !open)
      }
    }

    window.addEventListener('keydown', handleDeveloperShortcut)
    return () => window.removeEventListener('keydown', handleDeveloperShortcut)
  }, [])

  useEffect(() => {
    if (!identity) return

    let cancelled = false

    async function decryptVisibleMessages() {
      const decrypted = await Promise.all(
        encryptedMessages.map(async (item) => {
          const payload = item.payloads.find(
            (candidate) => candidate.recipientId === identity.user.id,
          )

          if (!payload) {
            return null
          }

          try {
            const signatureEnvelope = buildSignatureEnvelope({
              senderId: item.senderId,
              senderName: item.senderName,
              senderPublicKey: item.senderPublicKey,
              senderSigningPublicKey: item.senderSigningPublicKey,
              payloads: item.payloads,
            })
            const verified = await verifyEnvelopeSignature(
              item.senderSigningPublicKey,
              signatureEnvelope,
              item.signature,
            )

            if (!verified) {
              return null
            }

            const result = await decryptFromSender(
              payload,
              identity.privateKey,
              item.senderPublicKey,
            )

            return {
              ...item,
              text: result.plaintext,
              decryptDebug: result.debug,
              verified,
            }
          } catch {
            return null
          }
        }),
      )

      if (!cancelled) {
        const visible = decrypted.filter(Boolean)
        setVisibleMessages(visible)
        setHiddenMessageCount(encryptedMessages.length - visible.length)
      }
    }

    decryptVisibleMessages()
    return () => {
      cancelled = true
    }
  }, [encryptedMessages, identity])

  useLayoutEffect(() => {
    if (!shouldScrollAfterRenderRef.current) return

    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    shouldScrollAfterRenderRef.current = false
  }, [visibleMessages])

  function logout() {
    clearStoredIdentity()
    identityRef.current = null
    setIdentity(null)
    setNameInput('')
    setMessage('')
    setVisibleMessages([])
    setLastDebug(null)
    setDebugOpen(false)
    setError('')
  }

  async function enterChat(event) {
    event.preventDefault()
    const cleanName = nameInput.trim().replace(/\s+/g, ' ')

    if (cleanName.split(' ').length < 2) {
      setError('Enter your full name to join.')
      return
    }

    setError('')

    try {
      const keyPair = generateDemoKeyPair()
      const signingKeyPair = generateDemoKeyPair()
      const result = await emitWithAck('join_chat', {
          name: cleanName,
          publicKey: keyPair.publicKey,
          signingPublicKey: signingKeyPair.publicKey,
      })
      const user = result.user

      setIdentity({
        name: cleanName,
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
        signingPrivateKey: signingKeyPair.privateKey,
        signingPublicKey: signingKeyPair.publicKey,
        user,
      })
      setLastDebug({
        event: 'join',
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
        signingPrivateKey: signingKeyPair.privateKey,
        signingPublicKey: signingKeyPair.publicKey,
        curve: DEMO_CURVE,
      })
    } catch (caughtError) {
      setError(caughtError.message || 'Could not reach the chat server.')
    }
  }

  async function sendMessage(event) {
    event.preventDefault()
    const text = message.trim()

    if (!text || sending || !identity) return

    setSending(true)
    setError('')

    try {
      const recipients = participants.length ? participants : [identity.user]
      const encryptedForRecipients = await Promise.all(
        recipients.map((recipient) =>
          encryptForRecipient(text, identity.privateKey, recipient),
        ),
      )
      const payloads = encryptedForRecipients.map((item) => item.payload)
      const signatureEnvelope = buildSignatureEnvelope({
        senderId: identity.user.id,
        senderName: identity.name,
        senderPublicKey: identity.publicKey,
        senderSigningPublicKey: identity.signingPublicKey,
        payloads,
      })
      const signature = await signEnvelope(identity.signingPrivateKey, signatureEnvelope)

      const result = await emitWithAck('send_encrypted_message', {
          senderId: identity.user.id,
          senderName: identity.name,
          senderPublicKey: identity.publicKey,
          senderSigningPublicKey: identity.signingPublicKey,
          payloads,
          signature,
      })

      setLastDebug({
        event: 'encrypt-send',
        plaintext: text,
        senderPrivateKey: identity.privateKey,
        senderPublicKey: identity.publicKey,
        senderSigningPrivateKey: identity.signingPrivateKey,
        senderSigningPublicKey: identity.signingPublicKey,
        signature,
        recipients: encryptedForRecipients.map((item) => item.debug),
        storedMessage: result.message,
      })
      shouldScrollAfterRenderRef.current = true
      setMessage('')
    } catch (caughtError) {
      setError(caughtError.message || 'Could not encrypt or send the message.')
    } finally {
      setSending(false)
    }
  }

  if (!identity) {
    return (
      <main className="join-screen">
        <form className="join-box" onSubmit={enterChat}>
          <h1>Quantum Chat</h1>
          <p>Chat for quantum engineers</p>
          <label htmlFor="full-name">Full name</label>
          <input
            id="full-name"
            value={nameInput}
            onChange={(event) => {
              setNameInput(event.target.value)
              setError('')
            }}
            placeholder="First name Last name"
            autoComplete="name"
            autoFocus
          />
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={!hasFullName}>
            Enter chat
          </button>
        </form>
      </main>
    )
  }

  return (
    <main className="messenger">
      <header className="messenger-header">
        <div>
          <h1>Quantum Chat</h1>
          <p>{identity.name}</p>
        </div>
        <button className="logout-button" type="button" onClick={logout}>
          Logout
        </button>
      </header>

      <section className="messages" aria-live="polite" ref={messagesRef}>
        {visibleMessages.length === 0 && hiddenMessageCount === 0 && (
          <p className="empty">No messages yet. Start the chat.</p>
        )}
        {visibleMessages.map((item) => (
          <article
            className={item.senderId === identity.user.id ? 'message own' : 'message'}
            key={item.id}
          >
            <strong>{item.senderName}</strong>
            <p>{item.text}</p>
          </article>
        ))}
        <div ref={messagesEndRef} />
      </section>

      {debugOpen && (
        <aside className="debug-panel">
          <div>
            <strong>Educational Crypto Debug</strong>
            <button type="button" onClick={() => setDebugOpen(false)}>
              Hide
            </button>
          </div>
          <dl>
            <dt>Curve</dt>
            <dd>
              y^2 = x^3 + {DEMO_CURVE.a}x + {DEMO_CURVE.b} mod {DEMO_CURVE.p}
            </dd>
            <dt>Private key</dt>
            <dd>{identity.privateKey}</dd>
            <dt>Public key</dt>
            <dd>{publicKeyLabel(identity.publicKey)}</dd>
            <dt>Participants</dt>
            <dd>{participants.length}</dd>
            <dt>Last operation</dt>
            <dd>
              <pre>{JSON.stringify(lastDebug, null, 2)}</pre>
            </dd>
          </dl>
        </aside>
      )}

      {error && <p className="chat-error">{error}</p>}

      <form className="composer" onSubmit={sendMessage}>
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Message"
          autoFocus
        />
        <button type="submit" disabled={!message.trim() || sending}>
          Send
        </button>
      </form>
    </main>
  )
}

export default App
