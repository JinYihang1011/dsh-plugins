/**
 * 给独立测试 DSH_HOME 播种：两个位于不同 cwd 的会话日志。
 *
 * 首次启动时注册表会按「会话记录里的 cwd」自动为每个目录建一个工作区，
 * 于是这个测试实例天然就有两个工作区，可以用来验证跨目录搬移。
 *
 * 用法：node seed-test-home.mjs <testHome> <sourceLogFile>
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const [, , testHome, sourceLog] = process.argv
if (!testHome || !sourceLog) {
  console.error('usage: node seed-test-home.mjs <testHome> <sourceLogFile>')
  process.exit(2)
}

/* 抄自 @deepseek-ai/dsh-session-persistence-jsonl 的路径规则 */
function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}
const logPath = (root, cwd, id) => join(root, projectKey(cwd), encodeSegment(id), 'session.v4.jsonl.zstd')

const raw = await readFile(sourceLog)
const base = zstdDecompressSync(raw).toString('utf8')
const newline = base.indexOf('\n')
const baseHeader = JSON.parse(base.slice(0, newline))

const projects = [
  { cwd: join(testHome, 'projA'), id: 'session-a0000000-0000-4000-8000-00000000000a', title: '测试项目 A' },
  { cwd: join(testHome, 'projB'), id: 'session-b0000000-0000-4000-8000-00000000000b', title: '测试项目 B' },
]

for (const project of projects) {
  await mkdir(project.cwd, { recursive: true })
  const path = logPath(join(testHome, 'sessions'), project.cwd, project.id)
  await mkdir(join(path, '..'), { recursive: true })
  const header = { ...baseHeader, id: project.id, cwd: project.cwd, parentSession: undefined }
  delete header.parentSession
  delete header.origin
  const text = `${JSON.stringify(header)}${base.slice(newline)}`
  await writeFile(path, zstdCompressSync(Buffer.from(text, 'utf8'), { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }))
  console.log(`${project.title}: ${project.id} @ ${project.cwd}`)
  console.log(`  log: ${path}`)
}
