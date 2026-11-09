import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import sharp from 'sharp'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { readConfig } from './config.ts'
import { ChatError, parseChatRequest, type ChatRequest } from './protocol.ts'
import { createHarnessRunner, type ChatRunner } from './harness.ts'
import { createNihaoServer } from './http.ts'
import { IMAGE_LIMITS, prepareChatImages, type ChatImage } from './images.ts'

const config = { ...readConfig({}), configured: true }
const headers = { 'Content-Type': 'application/json' }

async function picture(format: 'png' | 'jpeg' | 'webp' = 'png', width = 8, height = 6): Promise<ChatImage> {
  const data = await sharp({ create: { width, height, channels: 3, background: '#cc5533' } }).toFormat(format).toBuffer()
  return { name: `menu.${format}`, dataUrl: `data:image/${format};base64,${data.toString('base64')}` }
}

function requestWith(images: ChatImage[], content = ''): ChatRequest {
  return parseChatRequest({ messages: [{ role: 'user', content, images }] })
}

async function localApp(run: ChatRunner) {
  const app = createNihaoServer(config, run)
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  return { ...app, url: `http://127.0.0.1:${address.port}` }
}

test('JPEG, PNG and WebP image-only input is decoded; ordinary text stays valid', async () => {
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const request = requestWith([await picture(format)])
    await prepareChatImages(request)
    assert.equal(request.messages[0]!.content, '')
    assert.equal(request.messages[0]!.images?.length, 1)
  }
  assert.equal(parseChatRequest({ messages: [{ role: 'user', content: 'Hello' }] }).messages[0]!.images, undefined)
  assert.throws(() => requestWith([]), ChatError)
})

test('image parser rejects external URLs, SVG, GIF, invalid base64 and MIME substitution', async () => {
  const png = await picture()
  for (const dataUrl of [
    'https://example.com/menu.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/gif;base64,R0lGODlh',
    'data:image/png;base64,@@@@', png.dataUrl.replace('image/png', 'image/jpeg'), png.dataUrl + '\n',
  ]) {
    assert.throws(() => requestWith([{ name: 'upload', dataUrl }]), (error: unknown) => error instanceof ChatError && error.status === 400)
  }
  assert.throws(() => parseChatRequest({ messages: [
    { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hello', images: [png] }, { role: 'user', content: 'Next' },
  ] }), (error: unknown) => error instanceof ChatError && error.code === 'INVALID_IMAGE')
})

test('per-image, per-message, history count and aggregate-byte limits reject excess uploads', async () => {
  const png = await picture()
  assert.throws(() => requestWith(Array(5).fill(png)), (error: unknown) => error instanceof ChatError && error.code === 'TOO_MANY_IMAGES')
  const messages = [4, 4, 4, 1].flatMap((count, index) => [
    ...(index ? [{ role: 'assistant', content: 'Received' }] : []), { role: 'user', content: '', images: Array(count).fill(png) },
  ])
  assert.throws(() => parseChatRequest({ messages }), (error: unknown) => error instanceof ChatError && error.code === 'TOO_MANY_IMAGES')
  const bytes = Buffer.alloc(IMAGE_LIMITS.maxImageBytes + 1)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  const huge = { name: 'large.png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }
  assert.throws(() => requestWith([huge]), (error: unknown) => error instanceof ChatError && error.code === 'IMAGE_TOO_LARGE')
  const withinFileLimit = { name: 'large.png', dataUrl: `data:image/png;base64,${bytes.subarray(0, IMAGE_LIMITS.maxImageBytes).toString('base64')}` }
  assert.throws(() => parseChatRequest({ messages: [
    { role: 'user', content: '', images: Array(4).fill(withinFileLimit) },
    { role: 'assistant', content: 'Received' }, { role: 'user', content: '', images: [withinFileLimit] },
  ] }), (error: unknown) => error instanceof ChatError && error.code === 'IMAGES_TOO_LARGE')
})

test('full image decoding rejects corrupt data and oversized dimensions before model dispatch', async () => {
  const png = await picture()
  const corrupt = { name: 'broken.png', dataUrl: `data:image/png;base64,${Buffer.from(png.dataUrl.split(',')[1]!, 'base64').subarray(0, 30).toString('base64')}` }
  await assert.rejects(prepareChatImages(requestWith([corrupt])), (error: unknown) => error instanceof ChatError && error.status === 400)
  await assert.rejects(prepareChatImages(requestWith([await picture('png', 8193, 1)])), (error: unknown) => error instanceof ChatError && error.code === 'IMAGE_DIMENSIONS')
  let dispatched = false
  const app = await localApp(async () => { dispatched = true })
  try {
    const response = await fetch(`${app.url}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: '', images: [corrupt] }] }) })
    assert.equal(response.status, 400)
    assert.match(await response.text(), /INVALID_IMAGE/)
    assert.equal(dispatched, false)
  } finally { await app.shutdown() }
})

class VisionAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Menu received' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Menu received' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('Harness admits image-only messages and preserves image references in followup history', async () => {
  const image = await picture()
  const adapter = new VisionAdapter()
  const run = createHarnessRunner(config, adapter)
  await run(requestWith([image]), () => {}, new AbortController().signal)
  await run(parseChatRequest({ messages: [
    { role: 'user', content: '', images: [image] }, { role: 'assistant', content: 'A menu' }, { role: 'user', content: 'Translate it' },
  ] }), () => {}, new AbortController().signal)
  for (const request of adapter.requests) {
    const user = request.messages.find(message => message.role === 'user')!
    const block = user.content.find(part => part.type === 'image')
    assert.ok(block && block.type === 'image')
    assert.match(block.attachment.attachmentId, /^nihao-image:/)
    assert.equal(block.attachment.width, 8)
    assert.equal(block.attachment.height, 6)
    assert.deepEqual(request.tools || [], [])
  }
  assert.equal(adapter.requests[1]!.messages.at(-1)!.content[0]?.type, 'text')
})

test('image bodies larger than the old 256 KiB text limit still stream a reply', async () => {
  const pixels = Buffer.alloc(450 * 450 * 3)
  let value = 123456
  for (let index = 0; index < pixels.length; index += 1) {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5
    pixels[index] = value & 255
  }
  const data = await sharp(pixels, { raw: { width: 450, height: 450, channels: 3 } }).png().toBuffer()
  const image = { name: 'photo.png', dataUrl: `data:image/png;base64,${data.toString('base64')}` }
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'Describe this', images: [image] }] })
  assert.ok(Buffer.byteLength(body) > 256 * 1024)
  const app = await localApp(async (request, onText) => { assert.equal(request.messages[0]!.images?.length, 1); onText('Photo received') })
  try {
    const response = await fetch(`${app.url}/api/chat`, { method: 'POST', headers, body })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /"type":"done"/)
  } finally { await app.shutdown() }
})

test('the upload body cap rejects oversized declarations, and shutdown stops an unfinished upload', async () => {
  let modelCalls = 0
  const app = await localApp(async () => { modelCalls += 1 })
  const overLimit = await new Promise<number>((resolve, reject) => {
    const upload = httpRequest(`${app.url}/api/chat`, { method: 'POST', headers: { ...headers, 'Content-Length': 31 * 1024 * 1024 } }, response => {
      response.resume()
      resolve(response.statusCode!)
    })
    upload.on('error', reject)
    upload.end()
  })
  assert.equal(overLimit, 413)
  const received = Promise.withResolvers<void>()
  app.server.once('request', () => received.resolve())
  const unfinished = httpRequest(`${app.url}/api/chat`, { method: 'POST', headers: { ...headers, 'Content-Length': 1024 * 1024 } })
  unfinished.on('error', () => { /* The server deliberately closes incomplete uploads during shutdown. */ })
  unfinished.write('{"messages":')
  await received.promise
  await app.shutdown()
  unfinished.destroy()
  assert.equal(modelCalls, 0)
})

test('the real PiAi adapter sends uploaded image data to an OpenAI-compatible provider', async () => {
  let providerBody: Record<string, unknown> | undefined
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    providerBody = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const event = (delta: object, finishReason: string | null): string => `data: ${JSON.stringify({ id: 'local-image-test', object: 'chat.completion.chunk', created: 1, model: 'gpt-5.4-mini', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
    response.write(event({ role: 'assistant', content: 'Image received' }, null))
    response.write(event({}, 'stop'))
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address()
  assert.ok(address && typeof address === 'object')
  const previous = process.env.POE_API_KEY
  process.env.POE_API_KEY = 'local-test-credential'
  try {
    const image = await picture('jpeg')
    const chunks: string[] = []
    await createHarnessRunner({ ...config, baseURL: `http://127.0.0.1:${address.port}/v1` })(requestWith([image]), text => chunks.push(text), new AbortController().signal)
    assert.equal(chunks.join(''), 'Image received')
    assert.ok(providerBody)
    assert.equal(providerBody.model, 'gpt-5.4-mini')
    assert.equal(providerBody.stream, true)
    const serialized = JSON.stringify(providerBody.messages)
    assert.match(serialized, /image_url/)
    assert.ok(serialized.includes(image.dataUrl))
    assert.doesNotMatch(serialized, /image omitted/)
  } finally {
    if (previous === undefined) delete process.env.POE_API_KEY
    else process.env.POE_API_KEY = previous
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()))
  }
})
