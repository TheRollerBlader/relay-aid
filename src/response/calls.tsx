import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Room, RoomEvent } from 'livekit-client'
import { api } from '../lib/gateway.ts'
import { useResponse } from './context.tsx'

function deviceId() {
  let id = sessionStorage.getItem('relayaid-device')
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem('relayaid-device', id)
  }
  return id
}

export function CallPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { view, mutate } = useResponse()
  const roomRef = useRef<Room | null>(null)
  const [joined, setJoined] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const call = view?.calls.find((item) => item.id === id)
  const mine = call && view?.profile.id === call.ownerId
  const micAllowed = view?.consents.some((item) => item.type === 'microphone' && item.caseId === call?.caseId && item.granted)

  async function leave(endOnServer: boolean) {
    const room = roomRef.current
    roomRef.current = null
    if (room) {
      await room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined)
      await room.localParticipant.setCameraEnabled(false).catch(() => undefined)
      room.disconnect()
    }
    setJoined(false)
    if (endOnServer && call && mine) {
      await mutate('end_call', { callId: call.id, deviceId: deviceId() }, call.caseId, view?.cases.find((item) => item.id === call.caseId)?.version)
    }
  }

  useEffect(() => {
    const stop = () => {
      void leave(false)
    }
    window.addEventListener('relayaid-stop-media', stop)
    const withdrawn = (event: Event) => {
      const type = (event as CustomEvent<string>).detail
      if (type === 'microphone' || type === 'camera') void leave(true)
    }
    window.addEventListener('relayaid-consent-withdrawn', withdrawn)
    return () => {
      window.removeEventListener('relayaid-stop-media', stop)
      window.removeEventListener('relayaid-consent-withdrawn', withdrawn)
      void leave(false)
    }
  }, [id])

  async function join() {
    if (!call || !mine) return
    setBusy(true)
    setError('')
    try {
      const device = deviceId()
      if (call.state === 'connecting' || call.state === 'ringing') {
        await mutate('answer_call', { callId: call.id, deviceId: device }, call.caseId)
      }
      const media = await api<{ token: string; url: string; recording: boolean }>('/api/media/token', {
        callId: call.id,
        deviceId: device,
      })
      if (media.recording) throw new Error('This demo does not record calls.')
      const room = new Room()
      roomRef.current = room
      room.on(RoomEvent.Disconnected, () => setJoined(false))
      await room.connect(media.url, media.token)
      await room.localParticipant.setMicrophoneEnabled(true)
      setJoined(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The call did not connect.')
      await leave(false)
    } finally {
      setBusy(false)
    }
  }

  if (!call || !mine) {
    return (
      <p>
        That call is not on this device. <Link to="/">Back to your cases</Link>
      </p>
    )
  }

  return (
    <div>
      <p className="eyebrow">AI ASSISTANT · NOT A PERSON</p>
      <h1>Talk to RelayAid</h1>
      <p className="muted">This call is with an automated assistant. It is not recorded. Your microphone stays off until you join.</p>
      <p>Status: {call.state.replaceAll('_', ' ')}</p>
      {error && <p role="alert">{error}</p>}
      {!micAllowed && <p>Microphone consent is off for this case. Turn it on from the case page before joining.</p>}
      <div className="button-row">
        {!joined && (
          <button type="button" className="primary" disabled={busy || !micAllowed || call.state === 'ended' || call.state === 'failed'} onClick={() => void join()}>
            {busy ? 'Joining…' : 'Join call'}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void leave(true).then(() => navigate(`/cases/${call.caseId}`))
          }}
        >
          End call
        </button>
        <Link className="button" to={`/cases/${call.caseId}`}>
          Back to the case
        </Link>
      </div>
      <section className="panel">
        <h2>Transcript</h2>
        {call.transcript.length === 0 && <p className="muted">Nothing has been said yet.</p>}
        <ol>
          {call.transcript.map((line, index) => (
            <li key={`${line.at}-${index}`}>
              <strong>{line.role === 'assistant' ? 'RelayAid assistant' : 'You'}</strong>
              <p>{line.text}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
