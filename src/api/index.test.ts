import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiRouteModule
} from '../typings/api/api.types.ts'
import requestHandler from './index.ts'

class MockResponse extends EventEmitter {
  statusCode = 200
  headersSent = false
  headers: Record<string, string | number> = {}
  body = ''

  writeHead(
    status: number,
    headers?: Record<string, string | string[] | number>
  ): void {
    this.statusCode = status
    this.headersSent = true
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === 'string' || typeof v === 'number') {
          this.headers[k.toLowerCase()] = v
        }
      }
    }
  }

  setHeader(name: string, value: string | string[] | number): void {
    if (typeof value === 'string' || typeof value === 'number') {
      this.headers[name.toLowerCase()] = value
    }
  }

  getHeader(name: string): string | string[] | number | undefined {
    return this.headers[name.toLowerCase()]
  }

  end(data?: string | Buffer): void {
    this.headersSent = true
    if (data) {
      this.body += typeof data === 'string' ? data : data.toString('utf8')
    }
    this.emit('finish')
  }

  write(data: string | Buffer): void {
    this.body += typeof data === 'string' ? data : data.toString('utf8')
  }
}

class MockRequest extends EventEmitter {
  method = 'POST'
  url = '/v4/test-echo'
  headers: Record<string, string | string[] | undefined> = {
    host: 'localhost',
    authorization: 'test-secret',
    'content-type': 'application/json'
  }
  socket = { remoteAddress: '127.0.0.1', remotePort: 12345 }
  body?: unknown
  destroyed = false

  destroy(): void {
    this.destroyed = true
  }
}

interface MockServerOptions {
  maxBodySize?: number
  bodyTimeout?: number
  onRouteCalled?: (req: ApiRequest) => void
}

function createMockNodelink(options?: MockServerOptions): ApiNodelinkServer {
  const routes: Array<ApiRouteModule & { path: string; method?: string }> = [
    {
      path: '/v4/test-echo',
      method: 'POST',
      handler: (_nl, req, res) => {
        options?.onRouteCalled?.(req)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ received: req.body }))
      }
    }
  ]

  return {
    options: {
      server: {
        host: '0.0.0.0',
        port: 2333,
        password: 'test-secret',
        useBunServer: false,
        maxBodySize: options?.maxBodySize ?? 1024,
        bodyTimeout: options?.bodyTimeout ?? 30_000
      },
      api: {
        metrics: { enabled: false }
      }
    },
    extensions: {
      routes
    },
    statsManager: {
      incrementApiRequest: () => {},
      recordHttpRequestDuration: () => {},
      incrementDosProtectionBlock: () => {},
      incrementRateLimitHit: () => {}
    },
    dosProtectionManager: {
      check: () => ({ allowed: true })
    },
    rateLimitManager: {
      check: () => ({ allowed: true })
    }
  } as unknown as ApiNodelinkServer
}

test('api body reader - parses valid JSON and passes body to route handler', async () => {
  let routeCalled = false
  const nodelink = createMockNodelink({
    onRouteCalled: () => {
      routeCalled = true
    }
  })
  const req = new MockRequest()
  const res = new MockResponse()

  const promise = requestHandler(
    nodelink,
    req as unknown as ApiRequest,
    res as unknown as ApiResponse
  )

  req.emit('data', Buffer.from('{"track": "foo", "volume": 80}'))
  req.emit('end')

  await promise

  assert.strictEqual(routeCalled, true)
  assert.strictEqual(res.statusCode, 200)
  assert.deepStrictEqual(req.body, { track: 'foo', volume: 80 })
})

test('api body reader - malformed JSON resolves with 400 and does not execute route', async () => {
  let routeCalled = false
  const nodelink = createMockNodelink({
    onRouteCalled: () => {
      routeCalled = true
    }
  })
  const req = new MockRequest()
  const res = new MockResponse()

  const promise = requestHandler(
    nodelink,
    req as unknown as ApiRequest,
    res as unknown as ApiResponse
  )

  req.emit('data', Buffer.from('{"broken_json": '))
  req.emit('end')

  await promise

  assert.strictEqual(
    routeCalled,
    false,
    'Route handler must not execute on invalid JSON'
  )
  assert.strictEqual(res.statusCode, 400)
  assert.ok(res.body.includes('Invalid JSON'))
})

test('api body reader - payload exceeding maxBodySize sends 413 and aborts route', async () => {
  let routeCalled = false
  const nodelink = createMockNodelink({
    maxBodySize: 50,
    onRouteCalled: () => {
      routeCalled = true
    }
  })
  const req = new MockRequest()
  const res = new MockResponse()

  const promise = requestHandler(
    nodelink,
    req as unknown as ApiRequest,
    res as unknown as ApiResponse
  )

  req.emit('data', Buffer.alloc(100, 'x'))

  await promise

  assert.strictEqual(
    routeCalled,
    false,
    'Route handler must not execute on payload exceeding maxBodySize'
  )
  assert.strictEqual(res.statusCode, 413)
  assert.strictEqual(req.destroyed, true)
})

test('api body reader - socket error terminates request gracefully without route execution', async () => {
  let routeCalled = false
  const nodelink = createMockNodelink({
    onRouteCalled: () => {
      routeCalled = true
    }
  })
  const req = new MockRequest()
  const res = new MockResponse()

  const promise = requestHandler(
    nodelink,
    req as unknown as ApiRequest,
    res as unknown as ApiResponse
  )

  req.emit('error', new Error('ECONNRESET'))

  await promise

  assert.strictEqual(
    routeCalled,
    false,
    'Route handler must not execute when stream emits error'
  )
  assert.strictEqual(req.destroyed, true)
})

test('api body reader - body read timeout triggers 408 and halts request', async () => {
  let routeCalled = false
  const nodelink = createMockNodelink({
    bodyTimeout: 30,
    onRouteCalled: () => {
      routeCalled = true
    }
  })
  const req = new MockRequest()
  const res = new MockResponse()

  const promise = requestHandler(
    nodelink,
    req as unknown as ApiRequest,
    res as unknown as ApiResponse
  )

  await promise

  assert.strictEqual(
    routeCalled,
    false,
    'Route handler must not execute when body reading times out'
  )
  assert.strictEqual(res.statusCode, 408)
  assert.strictEqual(req.destroyed, true)
})
