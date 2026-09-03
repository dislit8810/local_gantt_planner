import { createServer } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const dataDirectory = join(root, 'data')
const dataFile = join(dataDirectory, 'schedule-data.json')
const temporaryDataFile = join(dataDirectory, 'schedule-data.tmp')
const production = process.argv.includes('--production')

await mkdir(dataDirectory, { recursive: true })

const sendJson = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(value === undefined ? '' : JSON.stringify(value))
}

const readBody = (request) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  request.on('data', (chunk) => {
    size += chunk.length
    if (size > 5 * 1024 * 1024) {
      reject(new Error('データが大きすぎます。'))
      request.destroy()
      return
    }
    chunks.push(chunk)
  })
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  request.on('error', reject)
})

const handleApi = async (request, response) => {
  if (request.url !== '/api/state') return false
  if (request.method === 'GET') {
    try {
      const stored = await readFile(dataFile, 'utf8')
      sendJson(response, 200, JSON.parse(stored))
    } catch (error) {
      if (error?.code === 'ENOENT') sendJson(response, 204)
      else sendJson(response, 500, { error: '共通データを読み込めませんでした。' })
    }
    return true
  }
  if (request.method === 'PUT') {
    try {
      const payload = JSON.parse(await readBody(request))
      if (payload?.schemaVersion !== 1 || !Array.isArray(payload.tasks) || typeof payload.settings !== 'object') {
        sendJson(response, 400, { error: '保存データの形式が正しくありません。' })
        return true
      }
      const next = { ...payload, exportedAt: new Date().toISOString() }
      await writeFile(temporaryDataFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      await rename(temporaryDataFile, dataFile)
      sendJson(response, 200, { saved: true })
    } catch {
      sendJson(response, 500, { error: '共通データを保存できませんでした。' })
    }
    return true
  }
  sendJson(response, 405, { error: '対応していない操作です。' })
  return true
}

let vite
if (!production) {
  const { createServer: createViteServer } = await import('vite')
  vite = await createViteServer({ root, server: { middlewareMode: true }, appType: 'spa' })
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
const server = createServer(async (request, response) => {
  try {
    if (await handleApi(request, response)) return
    if (vite) {
      vite.middlewares(request, response, () => {
        response.writeHead(404)
        response.end('Not found')
      })
      return
    }
    const requested = request.url === '/' ? '/index.html' : request.url.split('?')[0]
    const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, '')
    const filePath = join(root, 'dist', safePath)
    try {
      const contents = await readFile(filePath)
      response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream' })
      response.end(contents)
    } catch {
      const contents = await readFile(join(root, 'dist', 'index.html'))
      response.writeHead(200, { 'content-type': contentTypes['.html'] })
      response.end(contents)
    }
  } catch {
    sendJson(response, 500, { error: 'サーバーでエラーが発生しました。' })
  }
})

server.listen(5173, '127.0.0.1', () => {
  console.log('Schedule App: http://localhost:5173/')
})
