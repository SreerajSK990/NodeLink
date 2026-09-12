import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type {
  TrackInfo,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import LocalSource from './local.ts'

function createMockNodeLink(basePath: string): WorkerNodeLink {
  return {
    options: {
      sources: {
        local: {
          enabled: true,
          basePath
        }
      }
    }
  } as unknown as WorkerNodeLink
}

function createWavHeader(): Buffer {
  const buf = Buffer.alloc(44)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(44100, 24)
  buf.writeUInt32LE(176400, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(0, 40)
  return buf
}

test('local source - blocks absolute path outside basePath', async () => {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelink-test-base-'))
  const outsideFile = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nodelink-test-outside-')
  )
  const outsideFilePath = path.join(outsideFile, 'secret.wav')
  fs.writeFileSync(outsideFilePath, createWavHeader())

  try {
    const source = new LocalSource(createMockNodeLink(tempBase))
    const result = await source.search(outsideFilePath)

    assert.strictEqual(result.loadType, 'error')
    if (result.loadType === 'error') {
      assert.strictEqual(
        result.exception?.message,
        'Path traversal is not allowed.'
      )
    }
  } finally {
    fs.rmSync(tempBase, { recursive: true, force: true })
    fs.rmSync(outsideFile, { recursive: true, force: true })
  }
})

test('local source - blocks relative path traversal escaping basePath', async () => {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelink-test-base-'))

  try {
    const source = new LocalSource(createMockNodeLink(tempBase))
    const result = await source.search('../../etc/passwd')

    assert.strictEqual(result.loadType, 'error')
    if (result.loadType === 'error') {
      assert.strictEqual(
        result.exception?.message,
        'Path traversal is not allowed.'
      )
    }
  } finally {
    fs.rmSync(tempBase, { recursive: true, force: true })
  }
})

test('local source - returns empty result when requested path is a directory', async () => {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelink-test-base-'))
  const subDir = path.join(tempBase, 'subfolder')
  fs.mkdirSync(subDir)

  try {
    const source = new LocalSource(createMockNodeLink(tempBase))
    const result = await source.search('subfolder')

    assert.strictEqual(result.loadType, 'empty')
  } finally {
    fs.rmSync(tempBase, { recursive: true, force: true })
  }
})

test('local source - returns empty result for non-existent file inside basePath', async () => {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelink-test-base-'))

  try {
    const source = new LocalSource(createMockNodeLink(tempBase))
    const result = await source.search('missing-track.wav')

    assert.strictEqual(result.loadType, 'empty')
  } finally {
    fs.rmSync(tempBase, { recursive: true, force: true })
  }
})

test('local source - resolves and builds track for valid file inside basePath', async () => {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelink-test-base-'))
  const validFile = path.join(tempBase, 'valid-track.wav')
  fs.writeFileSync(validFile, createWavHeader())

  try {
    const source = new LocalSource(createMockNodeLink(tempBase))
    const result = await source.search('valid-track.wav')

    assert.strictEqual(result.loadType, 'track')
    if (result.loadType === 'track') {
      assert.strictEqual(result.data.info.title, 'valid-track.wav')
      assert.strictEqual(result.data.info.sourceName, 'local')
    }
  } finally {
    fs.rmSync(tempBase, { recursive: true, force: true })
  }
})

test('local source - loadStream throws when track URI escapes basePath', async () => {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelink-test-base-'))
  const outsideFile = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nodelink-test-outside-')
  )
  const outsideFilePath = path.join(outsideFile, 'secret.wav')
  fs.writeFileSync(outsideFilePath, createWavHeader())

  try {
    const source = new LocalSource(createMockNodeLink(tempBase))
    const mockTrack: TrackInfo = {
      title: 'secret.wav',
      author: 'unknown',
      length: 1000,
      identifier: outsideFilePath,
      isSeekable: false,
      isStream: false,
      uri: outsideFilePath,
      artworkUrl: null,
      isrc: null,
      sourceName: 'local',
      position: 0
    }

    await assert.rejects(
      async () => {
        await source.loadStream(mockTrack, '')
      },
      {
        message: 'Path traversal is not allowed.'
      }
    )
  } finally {
    fs.rmSync(tempBase, { recursive: true, force: true })
    fs.rmSync(outsideFile, { recursive: true, force: true })
  }
})

test('local source - loadStream streams valid file inside basePath', async () => {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelink-test-base-'))
  const validFile = path.join(tempBase, 'playable.wav')
  fs.writeFileSync(validFile, createWavHeader())

  try {
    const source = new LocalSource(createMockNodeLink(tempBase))
    const mockTrack: TrackInfo = {
      title: 'playable.wav',
      author: 'unknown',
      length: 1000,
      identifier: validFile,
      isSeekable: false,
      isStream: false,
      uri: validFile,
      artworkUrl: null,
      isrc: null,
      sourceName: 'local',
      position: 0
    }

    const streamResult = await source.loadStream(mockTrack, '')
    assert.ok(streamResult.stream)
    assert.strictEqual(streamResult.type, 'audio/wav')
    streamResult.stream.destroy()
  } finally {
    fs.rmSync(tempBase, { recursive: true, force: true })
  }
})
