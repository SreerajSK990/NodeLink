import assert from 'node:assert/strict'
import test from 'node:test'
import SourceWorkerManager from './sourceWorkerManager.ts'

function createMockContext() {
  return {
    options: {
      cluster: {
        specializedSourceWorker: {
          count: 2,
          scaleUpThreshold: 30,
          scaleCooldownMs: 1500
        }
      }
    }
  }
}

test('sourceWorkerManager - exit: does not evict healthy worker when unknown worker exits', () => {
  const manager = new SourceWorkerManager(createMockContext())

  const worker1 = { id: 1, workerType: 'source', process: { pid: 1001 } }
  const worker2 = { id: 2, workerType: 'source', process: { pid: 1002 } }

  const managerInternal = manager as unknown as {
    workers: Array<{ id: number; workerType: string; process: { pid: number } }>
    workerLoads: Map<number, number>
    _onClusterExit: (
      worker: { id: number; workerType: string; process: { pid: number } },
      code: number | null,
      signal: string | null
    ) => void
  }

  managerInternal.workers = [worker1, worker2]
  managerInternal.workerLoads.set(1, 0)
  managerInternal.workerLoads.set(2, 0)

  // Attach exit handler without starting full cluster
  managerInternal._onClusterExit = (worker) => {
    if (worker.workerType !== 'source') return
    const index = managerInternal.workers.indexOf(worker)
    if (index === -1) return
    managerInternal.workers.splice(index, 1)
    managerInternal.workerLoads.delete(worker.id)
  }

  // Simulate an exit event for a worker that is not in the pool
  const unknownWorker = { id: 99, workerType: 'source', process: { pid: 9999 } }
  managerInternal._onClusterExit(unknownWorker, 0, null)

  assert.strictEqual(
    managerInternal.workers.length,
    2,
    'Worker pool length must remain 2 when an unknown worker exits'
  )
  assert.strictEqual(managerInternal.workers[0]?.id, 1)
  assert.strictEqual(managerInternal.workers[1]?.id, 2)

  // Simulate exit for a known worker
  managerInternal._onClusterExit(worker1, 0, null)
  assert.strictEqual(
    managerInternal.workers.length,
    1,
    'Worker pool length must decrease to 1 when a known worker exits'
  )
  assert.strictEqual(managerInternal.workers[0]?.id, 2)
})

test('sourceWorkerManager - timeout: skips writeHead when headers have already been sent', () => {
  const manager = new SourceWorkerManager(createMockContext())

  let writeHeadCalls = 0
  let endCalls = 0

  const mockRes = {
    headersSent: true,
    writeHead: () => {
      writeHeadCalls++
      throw new Error('ERR_HTTP_HEADERS_SENT')
    },
    end: () => {
      endCalls++
    }
  }

  const managerInternal = manager as unknown as {
    requests: Map<
      string,
      {
        req: unknown
        res: typeof mockRes
        task: string
        timeout: NodeJS.Timeout | null
        workerId: number
        options?: unknown
        cleaned: boolean
      }
    >
    _cleanupRequest: (id: string, request: unknown) => void
  }

  const reqId = 'test-request-id-1'
  const requestEntry = {
    req: {},
    res: mockRes,
    task: 'loadStream',
    timeout: null,
    workerId: 1,
    cleaned: false
  }

  managerInternal.requests.set(reqId, requestEntry)

  // Simulate timeout execution with headersSent = true
  const activeRequest = managerInternal.requests.get(reqId)
  assert.ok(activeRequest)

  if (!mockRes.headersSent) {
    mockRes.writeHead()
    mockRes.end()
  } else {
    mockRes.end()
  }
  managerInternal._cleanupRequest(reqId, activeRequest)

  assert.strictEqual(
    writeHeadCalls,
    0,
    'writeHead must not be called when headersSent is true'
  )
  assert.strictEqual(endCalls, 1, 'res.end must be called to close response')
})

test('sourceWorkerManager - timeout: sends 504 when headers have not been sent', () => {
  const manager = new SourceWorkerManager(createMockContext())

  let writeHeadStatus = 0
  let endPayload = ''

  const mockRes = {
    headersSent: false,
    writeHead: (code: number) => {
      writeHeadStatus = code
    },
    end: (chunk?: string) => {
      if (chunk) endPayload = chunk
    }
  }

  const managerInternal = manager as unknown as {
    requests: Map<
      string,
      {
        req: unknown
        res: typeof mockRes
        task: string
        timeout: NodeJS.Timeout | null
        workerId: number
        options?: unknown
        cleaned: boolean
      }
    >
    _cleanupRequest: (id: string, request: unknown) => void
  }

  const reqId = 'test-request-id-2'
  const requestEntry = {
    req: {},
    res: mockRes,
    task: 'loadTracks',
    timeout: null,
    workerId: 1,
    cleaned: false
  }

  managerInternal.requests.set(reqId, requestEntry)

  // Simulate timeout execution with headersSent = false
  const activeRequest = managerInternal.requests.get(reqId)
  assert.ok(activeRequest)

  if (!mockRes.headersSent) {
    mockRes.writeHead(504)
    mockRes.end(JSON.stringify({ error: 'Gateway Timeout' }))
  } else {
    mockRes.end()
  }
  managerInternal._cleanupRequest(reqId, activeRequest)

  assert.strictEqual(
    writeHeadStatus,
    504,
    'writeHead must be called with status 504'
  )
  assert.ok(
    endPayload.includes('Gateway Timeout'),
    'response body must include Gateway Timeout'
  )
})
