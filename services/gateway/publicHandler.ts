import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { authenticate, digest, outboxKey } from './auth.ts'
import { analyzeFrame, extractIntake } from './model.ts'
import { applyCommand, viewFor } from '../../shared/autonomy/engine.ts'
import { readSide, updateState, writeSide } from '../stateStore.ts'
import { safeError } from '../http.ts'
import type { Actor, Command, Service, State } from '../../shared/autonomy/contracts.ts'

const agent: Actor = { id: 'relayaid-agent', kind: 'agent' }
const allowed = new Set([
  'create_case',
  'set_consent',
  'update_case',
  'volunteer_action',
  'confirm_delivery',
  'dispute_delivery',
  'cancel_case',
  'claim_callback',
  'start_call',
  'answer_call',
  'end_call',
  'decline_call',
  'set_availability',
  'admin_grant',
  'admin_service',
  'admin_policy',
  'delete_account',
])

function ensureSecrets() {
  if (!process.env['OUTBOX_MASTER_KEY']) {
    if (process.env['AWS_LAMBDA_FUNCTION_NAME'] || process.env['NETLIFY']) throw new Error('UNAUTHORIZED')
    process.env.OUTBOX_MASTER_KEY = 'dev-outbox-master-key-not-for-production'
  }
}

function reply(status: number, value: unknown) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function step(state: State, actor: Actor, command: Command, now = Date.now()): State {
  return applyCommand(state, actor, command, now).state
}

function tryStep(state: State, actor: Actor, command: Command, now = Date.now()): State {
  try {
    return step(state, actor, command, now)
  } catch {
    return state
  }
}

function runJobs(state: State, now: number): State {
  let current = state
  for (let index = 0; index < 6; index += 1) {
    const job = Object.values(current.jobs).find((item) => item.state === 'queued' && item.nextAt <= now)
    if (!job) break
    const claimId = `claim-${job.id}-${job.fence + 1}`.slice(0, 180)
    let claimed: { state: State; result: unknown }
    try {
      claimed = applyCommand(current, agent, { name: 'job_claim', operationId: claimId, body: { jobId: job.id } }, now)
    } catch {
      break
    }
    const fence = (claimed.result as { fence?: number } | undefined)?.fence
    if (!fence) break
    current = claimed.state
    current = tryStep(
      current,
      agent,
      {
        name: 'process_case',
        operationId: `process-${job.id}-${fence}`.slice(0, 180),
        expectedVersion: job.caseVersion,
        caseId: job.caseId,
        body: { jobId: job.id, fence },
      },
      now,
    )
    current = tryStep(
      current,
      agent,
      { name: 'job_finish', operationId: `finish-${job.id}-${fence}`.slice(0, 180), body: { jobId: job.id, fence } },
      now,
    )
  }
  return current
}

function advanceReferrals(state: State, now: number): State {
  let current = state
  for (const referral of Object.values(current.referrals)) {
    if (referral.retired) continue
    const service = current.services[referral.serviceId]
    if (!service) continue
    if (referral.state === 'queued') {
      current = tryStep(
        current,
        { id: 'gateway', kind: 'gateway' },
        { name: 'referral_sent', operationId: `send-${referral.id}-${referral.attempts + 1}`, body: { referralId: referral.id } },
        now,
      )
    }
    const latest = current.referrals[referral.id]
    if (!latest || latest.retired || latest.state === 'resolved' || service.mode === 'no_ack') continue
    let seq = latest.seq
    const order = ['acked', 'accepted', 'dispatched', 'en_route', 'arrived', 'resolved'] as const
    for (const next of order) {
      const outcome: Service['mode'] | typeof next =
        next === 'accepted' && service.mode === 'busy' ? 'busy' : next === 'accepted' && service.mode === 'reject' ? 'declined' : next
      seq += 1
      current = tryStep(
        current,
        { id: service.orgId, kind: 'sandbox' },
        {
          name: 'referral_event',
          operationId: `syn-${latest.id}-${seq}-${outcome}`.slice(0, 180),
          body: { referralId: latest.id, seq, state: outcome },
        },
        now,
      )
      if (outcome === 'busy' || outcome === 'declined') break
    }
  }
  for (const referral of Object.values(current.referrals)) {
    const service = current.services[referral.serviceId]
    if (!service || service.mode !== 'no_ack' || referral.retired || referral.attempts >= 3) continue
    current = tryStep(
      current,
      { id: 'gateway', kind: 'gateway' },
      { name: 'referral_sent', operationId: `send-${referral.id}-retry-${referral.attempts + 1}`, body: { referralId: referral.id } },
      now,
    )
  }
  const clock = Object.values(current.referrals).some((item) => current.services[item.serviceId]?.mode === 'no_ack' && item.attempts >= 3)
    ? now + 31_000
    : now
  return tryStep(current, agent, { name: 'tick', operationId: `tick-${now}`, body: {} }, clock)
}

function settle(state: State): State {
  const now = Date.now()
  return advanceReferrals(runJobs(state, now), now)
}

async function notify(ownerId: string, body: string) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return
  const raw = await readSide('push-subs')
  const subs = raw ? (JSON.parse(raw) as { ownerId: string; subscription: object }[]) : []
  const webpush = createRequire(import.meta.url)('web-push') as {
    setVapidDetails: (subject: string, publicKey: string, privateKey: string) => void
    sendNotification: (subscription: object, payload: string) => Promise<unknown>
  }
  webpush.setVapidDetails('mailto:desk@relayaid.us', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY)
  await Promise.all(
    subs
      .filter((item) => item.ownerId === ownerId)
      .map((item) =>
        webpush
          .sendNotification(item.subscription as never, JSON.stringify({ title: 'RelayAid', body, url: '/' }))
          .catch(() => undefined),
      ),
  )
}

export async function handlePublicRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (!url.pathname.startsWith('/api/')) return reply(404, { error: 'NOT_FOUND' })
  try {
    ensureSecrets()
    if (url.pathname === '/api/push/key' && req.method === 'GET') {
      return reply(200, process.env.VAPID_PUBLIC_KEY ? { enabled: true, publicKey: process.env.VAPID_PUBLIC_KEY } : { enabled: false })
    }
    if (url.pathname === '/api/guest' && req.method === 'POST') {
      const id = randomBytes(32).toString('hex')
      const secret = randomBytes(32).toString('base64url')
      const actor: Actor = { id, kind: 'user', verified: false }
      await updateState((state) =>
        settle(
          step(state, actor, {
            name: 'register',
            operationId: randomUUID(),
            expectedVersion: 0,
            body: { label: 'Guest', capabilityHash: digest(secret) },
          }),
        ),
      )
      return reply(201, { capability: `guest.${id}.${secret}`, expiresAt: Date.now() + 86_400_000 })
    }

    const peeked = await updateState(async (state) => settle(state))
    const actor = await authenticate({ headers: { authorization: req.headers.get('authorization') || undefined, 'x-guest-capability': req.headers.get('x-guest-capability') || undefined } } as never, peeked)
    if (!peeked.profiles[actor.id]) {
      await updateState((state) =>
        step(state, actor, { name: 'register', operationId: randomUUID(), expectedVersion: 0, body: { label: 'Resident' } }),
      )
    }
    const state = await updateState(async (current) => current)

    if (url.pathname === '/api/session' || url.pathname === '/api/state' || url.pathname === '/api/export') {
      return reply(200, viewFor(state, actor))
    }
    if (url.pathname === '/api/outbox-key') return reply(200, { ownerIdentity: actor.id, key: outboxKey(actor.id) })
    if (url.pathname === '/api/photo' && req.method === 'GET') {
      const caseId = url.searchParams.get('caseId') || ''
      const row = state.cases[caseId]
      if (!row || row.ownerId !== actor.id) return reply(404, { error: 'NOT_FOUND' })
      const image = await readSide(`photo-${caseId}`)
      return reply(200, { image: image || '' })
    }
    if (url.pathname === '/api/photo' && req.method === 'POST') {
      const input = (await req.json()) as { caseId?: string; image?: string }
      const row = state.cases[input.caseId || '']
      if (!row || row.ownerId !== actor.id) return reply(404, { error: 'NOT_FOUND' })
      if (!input.image || !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(input.image) || input.image.length > 900_000) {
        return reply(400, { error: 'INVALID_INPUT' })
      }
      await writeSide(`photo-${input.caseId}`, input.image)
      return reply(200, { ok: true })
    }
    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
      const subscription = await req.json()
      const raw = await readSide('push-subs')
      const subs = raw ? (JSON.parse(raw) as { ownerId: string; subscription: object }[]) : []
      subs.push({ ownerId: actor.id, subscription })
      await writeSide('push-subs', JSON.stringify(subs.slice(-40)))
      return reply(200, { ok: true })
    }
    if (url.pathname === '/api/guest/upgrade' && req.method === 'POST') {
      if (!actor.verified) return reply(401, { error: 'UNAUTHORIZED' })
      const guest = await authenticate(
        { headers: { authorization: `Bearer ${req.headers.get('x-guest-capability') || ''}` } } as never,
        state,
      )
      const next = await updateState((current) =>
        settle(
          step(current, { id: 'gateway', kind: 'gateway' }, {
            name: 'upgrade_guest',
            operationId: randomUUID(),
            body: { oldId: guest.id, newId: actor.id, verified: true },
          }),
        ),
      )
      return reply(200, viewFor(next, actor))
    }
    if (url.pathname === '/api/intake/analyze' && req.method === 'POST') {
      const input = (await req.json()) as { text?: string; language?: string }
      if (typeof input.text !== 'string' || input.text.length > 2000) return reply(400, { error: 'INVALID_INPUT' })
      return reply(200, await extractIntake(input.text, input.language === 'es' ? 'es' : 'en'))
    }
    if (url.pathname === '/api/command' && req.method === 'POST') {
      const input = (await req.json()) as Command
      if (!allowed.has(input.name)) return reply(400, { error: 'UNKNOWN_COMMAND' })
      const next = await updateState((current) => settle(step(current, actor, input)))
      const view = viewFor(next, actor)
      if (view.messages.length) await notify(actor.id, view.messages[view.messages.length - 1]?.text || 'A follow-up about your case')
      return reply(200, { result: next.receipts[`${actor.kind}:${actor.id}:${input.operationId}`]?.result, view })
    }
    if (url.pathname === '/api/talk' && req.method === 'POST') {
      const input = (await req.json()) as { callId?: string; text?: string }
      const call = state.calls[input.callId || '']
      if (!call || call.ownerId !== actor.id || !input.text || input.text.length > 2000) return reply(400, { error: 'INVALID_INPUT' })
      const heard = await extractIntake(input.text, 'en')
      const readback = heard.live && heard.drafts[0]
        ? `I heard: ${heard.drafts.map((item: { summary: string }) => item.summary).join(' ')} Confirm the place and quantity on your case. This is not an arrival time, and nobody has been dispatched.`
        : 'AI unavailable. Your words stay on this case. This is a text conversation, not a voice agent, and it does not dispatch anyone.'
      const next = await updateState((current) => {
        let updated = tryStep(current, agent, {
          name: 'transcript',
          operationId: randomUUID(),
          body: { callId: call.id, role: 'user', text: input.text },
        })
        updated = tryStep(updated, agent, {
          name: 'transcript',
          operationId: randomUUID(),
          body: { callId: call.id, role: 'assistant', text: readback },
        })
        return settle(updated)
      })
      return reply(200, { view: viewFor(next, actor), live: heard.live, caption: readback })
    }
    if (url.pathname === '/api/media/token' && req.method === 'POST') {
      const input = (await req.json()) as { callId?: string; deviceId?: string }
      const call = state.calls[input.callId || '']
      if (!call || call.ownerId !== actor.id || call.deviceId !== input.deviceId) return reply(401, { error: 'UNAUTHORIZED' })
      if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
        return reply(200, { mode: 'text', recording: false, speechLanguages: [] })
      }
      return reply(200, { mode: 'text', recording: false, speechLanguages: [], note: 'Voice transport is not enabled for this site.' })
    }
    if (url.pathname === '/api/media/frame' && req.method === 'POST') {
      if (!process.env.NVIDIA_API_KEY) return reply(200, { live: false, observation: 'Camera analysis is not configured. Describe the scene in text.' })
      const input = (await req.json()) as { callId?: string; image?: string }
      const call = state.calls[input.callId || '']
      if (!call || call.ownerId !== actor.id) return reply(401, { error: 'UNAUTHORIZED' })
      const controller = new AbortController()
      const result = await analyzeFrame(String(input.image || ''), controller.signal)
      return reply(200, result)
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const next = await updateState((current) => {
        let updated = current
        for (const call of Object.values(current.calls).filter((item) => item.ownerId === actor.id && !['ended', 'failed'].includes(item.state))) {
          updated = tryStep(updated, actor, {
            name: 'end_call',
            operationId: randomUUID(),
            body: { callId: call.id, deviceId: call.deviceId },
          })
        }
        return updated
      })
      return reply(200, { ok: true, view: viewFor(next, actor) })
    }
    return reply(404, { error: 'NOT_FOUND' })
  } catch (error) {
    const code = safeError(error)
    return reply(code === 'UNAUTHORIZED' ? 401 : 400, { error: code })
  }
}
