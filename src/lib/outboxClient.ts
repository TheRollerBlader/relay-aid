import { useSyncExternalStore } from 'react'
import {
  applyServerVersion,
  beginSend,
  enqueue,
  expireUndelivered,
  markDelivered,
  noteChecking,
  noteConflict,
  noteRefused,
  openIndexedDbOutbox,
  pendingFor,
  type OutboxItem,
  type OutboxStore,
} from '../../client/outbox.ts'

class MemoryMirror implements OutboxStore {
  private readonly rows = new Map<string, OutboxItem>()

  get(clientRequestId: string): OutboxItem | undefined {
    const row = this.rows.get(clientRequestId)
    return row ? { ...row, needs: [...row.needs] } : undefined
  }

  put(item: OutboxItem) {
    this.rows.set(item.clientRequestId, { ...item, needs: [...item.needs] })
  }

  all(): OutboxItem[] {
    return [...this.rows.values()].map((item) => ({ ...item, needs: [...item.needs] }))
  }

  clear() {
    this.rows.clear()
  }
}

const SCOPE_KEY = 'relayaid-outbox-scope'
const memory = new MemoryMirror()
let durable: Awaited<ReturnType<typeof openIndexedDbOutbox>> | null = null
let scope = ''
let ownerIdentity = ''
let switchScope = ''
let view: { ready: boolean; items: OutboxItem[]; heldCount: number; heldLabel: string } = {
  ready: false,
  items: [],
  heldCount: 0,
  heldLabel: '',
}
const listeners = new Set<() => void>()

export function outboxScope(identity: string, shelterId: string) {
  return `relayaid-outbox:${identity}:${shelterId}`
}

function publish(ready: boolean) {
  view = {
    ready,
    items: memory.all(),
    heldCount: switchScope ? view.heldCount : 0,
    heldLabel: switchScope ? view.heldLabel : '',
  }
  listeners.forEach((listener) => listener())
}

async function loadScope(next: string, identity: string) {
  memory.clear()
  durable = await openIndexedDbOutbox(next)
  scope = next
  ownerIdentity = identity
  localStorage.setItem(SCOPE_KEY, next)
  for (const item of await durable.all()) {
    memory.put(item.ownerIdentity ? item : { ...item, ownerIdentity: identity })
  }
  expireUndelivered(memory, Date.now(), 12 * 60 * 60 * 1000)
  for (const item of memory.all()) await durable.put(item)
  publish(true)
}

export async function bindOutbox(identity: string, shelterId: string) {
  if (!identity) return
  const next = outboxScope(identity, shelterId)
  if (scope === next) return
  const previous = scope || localStorage.getItem(SCOPE_KEY) || ''
  const previousIdentity = previous.split(':')[1] ?? ''
  const unowned = previousIdentity === '' || previousIdentity === 'device'
  if (previous && previous !== next && !unowned && previousIdentity !== identity) {
    const old = await openIndexedDbOutbox(previous)
    const held = (await old.all()).filter((item) => item.status === 'saved_on_device' || item.status === 'sending')
    if (held.length > 0) {
      switchScope = previous
      view = { ...view, heldCount: held.length, heldLabel: previousIdentity.slice(0, 8) }
    }
  } else if (previous && previous !== next && unowned) {
    const old = await openIndexedDbOutbox(previous)
    const carried = await old.all()
    await loadScope(next, identity)
    for (const item of carried) await persist({ ...item, ownerIdentity: item.ownerIdentity || identity })
    await old.clear()
    return
  }
  await loadScope(next, identity)
}

export function startOutbox() {
  if (scope) return
  const shelter = localStorage.getItem('relayaid-shelter') || 'shelter-a'
  void bindOutbox(localStorage.getItem('relayaid-owner') || 'device', shelter)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  startOutbox()
  return () => listeners.delete(listener)
}

export function useOutbox(): { ready: boolean; items: OutboxItem[]; heldCount: number; heldLabel: string } {
  return useSyncExternalStore(subscribe, () => view, () => view)
}

export async function keepHeldOutbox() {
  switchScope = ''
  view = { ...view, heldCount: 0, heldLabel: '' }
  publish(view.ready)
}

export async function eraseHeldOutbox() {
  if (switchScope) {
    const old = await openIndexedDbOutbox(switchScope)
    await old.clear()
  }
  switchScope = ''
  view = { ...view, heldCount: 0, heldLabel: '' }
  publish(view.ready)
}

async function persist(item: OutboxItem) {
  memory.put(item)
  const stored = memory.get(item.clientRequestId)
  if (stored) await durable?.put(stored)
  publish(view.ready)
}

export async function saveRequest(
  input: Omit<OutboxItem, 'status' | 'confirmedStateVersion' | 'notice' | 'ownerIdentity'> & { ownerIdentity?: string },
): Promise<OutboxItem> {
  const item = enqueue(memory, { ...input, ownerIdentity: input.ownerIdentity || ownerIdentity || 'device' })
  await persist(item)
  return memory.get(item.clientRequestId) ?? item
}

export async function markSending(clientRequestId: string) {
  await persist(beginSend(memory, clientRequestId))
}

export async function markChecking(clientRequestId: string) {
  await persist(noteChecking(memory, clientRequestId))
}

export async function markConflict(clientRequestId: string) {
  await persist(noteConflict(memory, clientRequestId))
}

export async function markRefused(clientRequestId: string, code: string) {
  await persist(noteRefused(memory, clientRequestId, code))
}

export async function expireNow() {
  const expired = expireUndelivered(memory, Date.now(), 12 * 60 * 60 * 1000)
  for (const item of expired) await persist(item)
}

export async function markServer(clientRequestId: string, stateVersion: number, notice: string) {
  const current = memory.get(clientRequestId)
  if (!current) return
  const next =
    current.status === 'delivered'
      ? applyServerVersion(memory, clientRequestId, stateVersion, notice)
      : markDelivered(memory, clientRequestId, stateVersion)
  if (!next) return
  await persist({ ...next, notice })
}

export function unsent(): OutboxItem[] {
  return pendingFor(memory, ownerIdentity).filter(
    (item) =>
      item.notice !== 'IDEMPOTENCY_CONFLICT' &&
      item.notice !== 'CHECKING' &&
      !item.notice.startsWith('REFUSED:'),
  )
}

export async function retryRequest(clientRequestId: string) {
  const current = memory.get(clientRequestId)
  if (!current || current.status === 'delivered') return
  await persist({
    ...current,
    status: 'saved_on_device',
    notice: 'Saved on this device. Not delivered yet.',
  })
}

export async function clearOutbox() {
  memory.clear()
  await durable?.clear()
  publish(true)
}
