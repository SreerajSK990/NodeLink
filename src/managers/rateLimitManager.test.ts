import assert from 'node:assert/strict'
import test from 'node:test'
import type { ApiRequest } from '../typings/api/api.types.ts'
import RateLimitManager from './rateLimitManager.ts'

function createMockRequest(ip = '127.0.0.1', userId?: string): ApiRequest {
  return {
    headers: userId ? { 'user-id': userId } : {},
    socket: { remoteAddress: ip }
  } as unknown as ApiRequest
}

test('rateLimitManager - cleanup: does not prune global entries using shorter guild or user windows', () => {
  const manager = new RateLimitManager({
    options: {
      rateLimit: {
        enabled: true,
        global: { maxRequests: 100, timeWindowMs: 60000 },
        perIp: { maxRequests: 500, timeWindowMs: 10000 },
        perUserId: { maxRequests: 500, timeWindowMs: 5000 },
        perGuildId: { maxRequests: 500, timeWindowMs: 5000 }
      }
    }
  })

  const req = createMockRequest('10.0.0.1')
  const url = new URL('http://localhost/v4/loadtracks')

  for (let i = 0; i < 50; i++) {
    manager.check(req, url)
  }

  const initialCheck = manager.check(req, url)
  assert.strictEqual(initialCheck.remaining, 49)

  const originalNow = Date.now
  try {
    Date.now = () => originalNow() + 7000

    const cleanup = (
      manager as unknown as { _cleanup: () => void }
    )._cleanup.bind(manager)
    cleanup()

    const postCleanupCheck = manager.check(req, url)
    assert.strictEqual(
      postCleanupCheck.remaining,
      48,
      'Global rate limit quota must not reset after the shorter 5s window'
    )
  } finally {
    Date.now = originalNow
    manager.destroy()
  }
})

test('rateLimitManager - cleanup: does not prematurely evict global entry before global pruneAfterMs', () => {
  const manager = new RateLimitManager({
    options: {
      rateLimit: {
        enabled: true,
        global: { maxRequests: 100, timeWindowMs: 60000 },
        perIp: { maxRequests: 500, timeWindowMs: 10000 },
        perUserId: { maxRequests: 500, timeWindowMs: 5000 },
        perGuildId: { maxRequests: 500, timeWindowMs: 5000 }
      }
    }
  })

  const req = createMockRequest('10.0.0.2')
  const url = new URL('http://localhost/v4/loadtracks')

  manager.check(req, url)

  const store = (manager as unknown as { store: Map<string, unknown> }).store
  assert.strictEqual(store.has('global:all'), true)

  const originalNow = Date.now
  try {
    // 20 seconds later: longer than 5s * 3 (15s), but shorter than 60s * 3 (180s)
    Date.now = () => originalNow() + 20000

    const cleanup = (
      manager as unknown as { _cleanup: () => void }
    )._cleanup.bind(manager)
    cleanup()

    assert.strictEqual(
      store.has('global:all'),
      true,
      'global:all should not be evicted after 20s when its window is 60s'
    )
  } finally {
    Date.now = originalNow
    manager.destroy()
  }
})

test('rateLimitManager - cleanup: prunes expired entries once scope window actually elapses', () => {
  const manager = new RateLimitManager({
    options: {
      rateLimit: {
        enabled: true,
        global: { maxRequests: 100, timeWindowMs: 60000 },
        perIp: { maxRequests: 500, timeWindowMs: 10000 },
        perUserId: { maxRequests: 500, timeWindowMs: 5000 },
        perGuildId: { maxRequests: 500, timeWindowMs: 5000 }
      }
    }
  })

  const req = createMockRequest('10.0.0.3')
  const url = new URL('http://localhost/v4/loadtracks')

  for (let i = 0; i < 10; i++) {
    manager.check(req, url)
  }

  const originalNow = Date.now
  try {
    // 65 seconds later: past the 60s global window
    Date.now = () => originalNow() + 65000

    const cleanup = (
      manager as unknown as { _cleanup: () => void }
    )._cleanup.bind(manager)
    cleanup()

    const res = manager.check(req, url)
    assert.strictEqual(
      res.remaining,
      99,
      'Quota should reset after the full 60s window has legitimately elapsed'
    )
  } finally {
    Date.now = originalNow
    manager.destroy()
  }
})
