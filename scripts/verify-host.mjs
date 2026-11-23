// 宿主半区的端到端验证。
//
// 在**临时** DSH_HOME 里搭一份会话夹具（父会话 + 子代理会话 + fork 会话 + 旁支会话 + 活跃会话），
// 然后像浏览器那样调用注册出来的路由，逐条断言：
//   · 身份 / 确认标记 / 同源 / 存活 四道闸门；
//   · 删除范围刚好是"目标 + 子代理会话"的日志与投影缓存；
//   · fork 会话、旁支会话、附件、workspace.json 一律不动；
//   · 工作区登记走的是官方服务接口（unpin / unarchive / detach），不是手改文件；
//   · 失败与卸载都不抛。
//
// 用法：node scripts/verify-host.mjs
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-manager-'))

// 无论中途怎么退出（抛错、被杀），临时 DSH_HOME 都要清掉：
// 夹具里有假的 .credentials.yaml，不能留在 %TEMP% 里。
process.on('exit', () => {
  try {
    fs.rmSync(tempHome, { recursive: true, force: true })
  } catch (error) {
    // 清不掉就清不掉，别在退出路径上抛。
  }
})

const checks = []
function check(label, ok, detail) {
  checks.push({ label, ok: Boolean(ok), detail })
}

/* ── 夹具 ──────────────────────────────────────────────────────────────── */

const SLUG = '--C-Users-test-workspace--'
const PARENT = 'session-11111111-1111-4111-8111-111111111111'
const CHILD = '22222222-2222-4222-8222-222222222222'
const FORK = 'session-33333333-3333-4333-8333-333333333333'
const FORKCHILD = '66666666-6666-4666-8666-666666666666'
const OTHER = 'session-44444444-4444-4444-8444-444444444444'
const LIVE = 'session-55555555-5555-4555-8555-555555555555'
/** 有活着的 Agent（界面里开着）但没在跑的会话 —— 它必须可以删（否则就是"闲着的会话也删不掉"）。 */
const OPENED = 'session-66666666-6666-4666-8666-666666666666'
const LINKED = 'session-77777777-7777-4777-8777-777777777777'
const LOCKED = 'session-88888888-8888-4888-8888-888888888888'
const DRIFT = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function writeFile(relative, content) {
  const absolute = path.join(tempHome, relative)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
  return absolute
}

const logRelative = (id) => path.join('sessions', SLUG, id, 'session.v4.jsonl.zstd')
const cacheRelative = (id) => path.join('storages', 'session_projcache', 'sessions', `${id}.json`)

for (const [id, size] of [[PARENT, 2048], [CHILD, 1024], [FORK, 512], [FORKCHILD, 384], [OTHER, 256], [LIVE, 128], [LOCKED, 96], [OPENED, 64]]) {
  writeFile(logRelative(id), 'x'.repeat(size))
  writeFile(cacheRelative(id), JSON.stringify({ version: 7, id }))
}
// 不该被碰的东西：工作区登记、附件（内容寻址、跨会话共享）、凭据。
const workspaceFile = writeFile(path.join('storages', 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 } }))
writeFile(path.join('attachments', 'v1', 'objects', 'ab', 'abcdef'), 'attachment')
writeFile(path.join('.credentials.yaml'), 'secret')

const sessions = [
  { header: { id: PARENT, createdAt: Date.parse('2026-01-01T00:00:00Z'), cwd: 'C:\\ws' }, eventCount: 12 },
  { header: { id: CHILD, parentSession: PARENT, origin: 'subagent' } },
  { header: { id: FORK, parentSession: PARENT } },
  // fork 自己的子代理会话：不该被"删父会话"牵连（fork 整段都要保留）。
  { header: { id: FORKCHILD, parentSession: FORK, origin: 'subagent' } },
  { header: { id: OTHER } },
  { header: { id: LIVE } },
  { header: { id: OPENED } },
  { header: { id: LOCKED } },
]

/**
 * 进程内注册表的最小忠实复刻。
 *
 * 真实现里 `agents`（AgentRegistry）与 `sessions`（SessionStore）形状完全一致：
 *   · 一个普通字段 `store = new Map()` 存 entry；
 *   · `detachEntered(entry)` —— 官方注销原语：entry 身份校验 → 删表 → 发配对 disposed 事件；
 *   · `get(id)` / `list()` 读回值。
 * 插件的 forgetSessions 就是按这个形状去注销的，所以夹具必须长成这样，
 * "注销到底有没有生效"才验得出来。
 */
function createRegistry(field) {
  const store = new Map()
  const disposed = []
  return {
    store,
    disposed,
    /** 模拟框架的 enter()：登记一个 entry（身份校验靠同一个对象引用）。 */
    enter(id, value) {
      const entry = { id, [field]: value, announced: true }
      store.set(id, entry)
      return entry
    },
    /** 官方注销原语。 */
    detachEntered(entry) {
      if (store.get(entry.id) !== entry) return
      store.delete(entry.id)
      disposed.push(entry.id)
    },
    get(id) {
      return store.get(id)?.[field]
    },
    list() {
      return [...store.values()].map((entry) => entry[field])
    },
  }
}

/** 一个只实现插件真正用到的那些方法的宿主上下文。 */
function createContext() {
  const calls = { unpin: [], unarchive: [], detach: [], domainWrites: 0, flushed: [] }
  const record = { path: 'C:\\ws', title: 'default-workspace', sessionIds: [PARENT, OTHER, LOCKED] }
  const globalRecord = {
    initialized: true,
    defaultWorkspaceId: 'ws-1',
    workspaceIds: ['ws-1'],
    archivedSessionIds: [],
    pinnedSessionIds: [],
  }
  /**
   * 假的"已创建未落盘"表：真实现里 jsonl 后端的 pending 跟踪器 ——
   * 会话只在内存里，`list()` 也报它，磁盘上什么都没有；写句柄 flush 落盘后才会被丢掉。
   */
  const pending = new Set()
  /** 谁在跑（可被 `workspace/session-stop` 改掉，用来验"先停后删"）。 */
  const runningIds = new Set([LIVE])
  /** 已派发的 stop / 已关的终端 / 关键动作顺序，测试拿来断言。 */
  const stopped = []
  const terminalKills = []
  const order = []
  /** 会话 id → 它名下的终端 id（真实现按活 Agent 对象匹配属主）。 */
  const terminalsByOwner = new Map()
  const sessionRegistry = createRegistry('session')
  const agentRegistry = createRegistry('agent')
  /**
   * 夹具的持久层：忠实一点 —— **只报磁盘上还有日志的会话**，外加显式登记的未落盘会话。
   * 真实现就是"扫盘 + 本进程 pending 表"，删掉文件之后它就不该再看得见这个会话。
   */
  /** 测试可以模拟日志其实在别处（配合 locate 用）：id → 自定义日志绝对路径。 */
  const extraLogPaths = new Map()
  /** 某个会话的日志路径：默认在夹具的 sessions 下，被显式改过就用改过的。 */
  const logPathOf = (id) => extraLogPaths.get(id) ?? path.join(tempHome, logRelative(id))
  const visibleSessions = () => sessions.filter((snapshot) => (
    fs.existsSync(logPathOf(snapshot.header.id)) || pending.has(snapshot.header.id)
  ))
  /** 注册表的投影（真实现里按 header 索引过滤；这里默认与记录一致）。 */
  const project = () => [{
    id: 'ws-1',
    title: record.title,
    sessionIds: [...record.sessionIds],
    async detachSession(id) {
      calls.detach.push(id)
      record.sessionIds = record.sessionIds.filter((value) => value !== id)
    },
  }]

  const services = {
    sessionPersistence: {
      // 忠实一点：日志目录没了、又不是未落盘会话，服务就不该再"看得见"它。
      async stat(id) {
        const snapshot = sessions.find((entry) => entry.header.id === id)
        if (!snapshot) return undefined
        if (pending.has(id) || fs.existsSync(logPathOf(id))) return snapshot
        return undefined
      },
      async list() {
        return visibleSessions()
      },
    },
    sessionQuery: {
      async readTitle(id) {
        return { title: `标题 ${id.slice(0, 8)}` }
      },
    },
    // 内存会话存储：`get/list` 读注册表，`flush` 让未落盘会话补写落盘（pending 随之消失）。
    sessions: {
      store: sessionRegistry.store,
      get: (id) => sessionRegistry.get(id),
      list: () => sessionRegistry.list(),
      detachEntered: (entry) => {
        order.push(`session-detach:${entry.id}`)
        sessionRegistry.detachEntered(entry)
      },
      async flush(session) {
        calls.flushed.push(session.id)
        pending.delete(session.id)
        writeFile(logRelative(session.id), 'materialized-by-flush')
        return true
      },
    },
    agents: {
      store: agentRegistry.store,
      get: (id) => agentRegistry.get(id),
      list: () => agentRegistry.list(),
      detachEntered: (entry) => {
        order.push(`agent-detach:${entry.id}`)
        agentRegistry.detachEntered(entry)
      },
    },
    // 终端：`list` 按**对象身份**匹配属主（真实现就是这样），所以注销之后就该取不到。
    terminals: {
      list: (owner) => (owner && terminalsByOwner.has(owner.id) ? terminalsByOwner.get(owner.id).map((sessionId) => ({ sessionId })) : []),
      async kill(owner, terminalId) {
        if (owner && owner.id === undefined) return false
        order.push(`terminal-kill:${terminalId}`)
        terminalKills.push(terminalId)
        return true
      },
    },
    // 官方"在跑"信号：SessionSummary.running。
    sessionController: {
      async list() {
        return { items: visibleSessions().map((snapshot) => ({ sessionId: snapshot.header.id, running: runningIds.has(snapshot.header.id) })) }
      },
    },
    jobs: { list: () => [] },
    workspaceRegistry: {
      async unpinSession(id) {
        calls.unpin.push(id)
        globalRecord.pinnedSessionIds = globalRecord.pinnedSessionIds.filter((value) => value !== id)
      },
      async unarchiveSession(id) {
        calls.unarchive.push(id)
        globalRecord.archivedSessionIds = globalRecord.archivedSessionIds.filter((value) => value !== id)
      },
      get: (id) => project().find((workspace) => workspace.id === id),
      list: project,
    },
    // 假的持久化记录：workspace 域的表 + 全局（未经投影过滤的原始形态）。
    storageDomain: {
      get: (name) => (name !== 'workspace' ? undefined : {
        table: (tableName) => ({
          entries: () => (tableName === 'workspaces' ? [['ws-1', record]] : []),
          async update(key, mutate) {
            calls.domainWrites += 1
            const next = mutate(key === 'ws-1' ? record : undefined)
            if (key === 'ws-1') Object.assign(record, next)
            return next
          },
        }),
        global: {
          get: () => globalRecord,
          async set(value) {
            calls.domainWrites += 1
            Object.assign(globalRecord, value)
          },
        },
      }),
    },
  }
  /**
   * OPENED 代表"界面里开着、但没在跑"的会话：它在两张进程内注册表里都有条目
   * （真实现里客户端一打开就会 resume 出 Agent 并把会话 enter 进 store）。
   * v0.4.0 起这种会话**可以删** —— 删除流程会先把它从内存里注销掉（forgetSessions）。
   */
  hold(OPENED)
  /** LIVE 是真在跑的会话：现实中它同样被 enter 过。 */
  hold(LIVE)

  /**
   * 夹具默认把早期那批会话都"归档"了：删除只对已归档会话开放，
   * 而绝大多数用例关心的是删除本身而不是归档闸门。归档闸门有专门的用例。
   */
  for (const id of [PARENT, CHILD, FORK, FORKCHILD, OTHER, LIVE, OPENED, LINKED, LOCKED, DRIFT]) {
    if (!globalRecord.archivedSessionIds.includes(id)) globalRecord.archivedSessionIds.push(id)
  }

  /**
   * 夹具的归档集合：本套件要删的会话都先在各自上下文里归档
   * （删除只对已归档会话开放）。这里给一个便捷方法，测试按需调用。
   */
  function archive(id) {
    if (!globalRecord.archivedSessionIds.includes(id)) globalRecord.archivedSessionIds.push(id)
    return id
  }

  /** 让某个会话"在界面里开着"：两张注册表都登记（真实现就是这两个 enter）。 */
  function hold(id) {
    if (agentRegistry.get(id) === undefined) agentRegistry.enter(id, { id })
    if (sessionRegistry.get(id) === undefined) sessionRegistry.enter(id, { id })
    return id
  }

  /** 让某个会话只存在于内存里（已创建、还没落盘）。真实现里它同样被 enter 过。 */
  function markPending(id) {
    pending.add(id)
    return hold(id)
  }

  /** 让某个会话的日志落在别处（模拟只有 locate 才找得到的情形）。 */
  function markLogElsewhere(id, absolutePath) {
    extraLogPaths.set(id, absolutePath)
    return absolutePath
  }

  /** 让某个会话名下挂一个终端（真实现里 owner 是那个活 Agent 对象）。 */
  function ownTerminal(sessionId, terminalId) {
    if (!terminalsByOwner.has(sessionId)) terminalsByOwner.set(sessionId, [])
    terminalsByOwner.get(sessionId).push(terminalId)
    return terminalId
  }

  return {
    services,
    calls,
    /**
     * 宿主上下文：官方服务（get）+ 官方事件派发（waterfall / parallel）。
     * 默认**不提供** `waterfall` —— 让 gatherActivities 走"退回旧判定"那条路；
     * 想验活动瀑布的用例自己给 `home.ctx.waterfall` 赋值即可。
     */
    ctx: {
      get: (name) => services[name],
      parallel: async (event, arg) => {
        if (event === 'workspace/session-stop' && arg) {
          stopped.push(arg.sessionId)
          runningIds.delete(arg.sessionId)
        }
      },
    },
    record,
    globalRecord,
    pending,
    runningIds,
    stopped,
    terminalKills,
    order,
    sessionRegistry,
    agentRegistry,
    archive,
    hold,
    markPending,
    markLogElsewhere,
    ownTerminal,
  }
}

/* ── 加载插件（DSH_HOME 在模块加载时读取，必须先设置）───────────────────── */

process.env.DSH_HOME = tempHome
const plugin = await import(pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href)

let route = null
let routeDisposals = 0
const disposers = []
/** 宿主上下文：官方服务（get）+ cordis 的 effect/inject + webServer 路由注册。 */
const host = createContext()
const ctx = {
  ...host.ctx,
  inject: (names, callback) => callback(ctx),
  effect: (callback) => {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  webServer: {
    register: (candidate) => {
      route = candidate
      return () => { routeDisposals += 1 }
    },
  },
}
plugin.apply(ctx)

check('注册了一条精确路由', route && route.kind === 'exact', route && route.kind)
check('路由路径正确', route && route.path === plugin.ROUTE, route && route.path)

/** 造一对最小的 req/res，跑一次 handler。 */
function invoke(method, { url = '/', headers = { host: '127.0.0.1:19387' }, body, ctx: handlerContext } = {}) {
  const written = { status: 0, body: '' }
  const listeners = {}
  const req = {
    method,
    url,
    headers,
    on(event, listener) {
      listeners[event] = listener
      return req
    },
    destroy() {},
  }
  const res = {
    writeHead(status) { written.status = status },
    end(chunk) { written.body = chunk || '' },
  }
  const handler = handlerContext ? (request, response) => plugin.handleRequest(handlerContext, request, response) : route.handler
  const done = Promise.resolve(handler(req, res))
  if (body !== undefined) {
    queueMicrotask(() => {
      listeners.data?.(Buffer.from(body, 'utf8'))
      listeners.end?.()
    })
  }
  return done.then(() => ({ status: written.status, json: written.body ? JSON.parse(written.body) : null }))
}

const exists = (relative) => fs.existsSync(path.join(tempHome, relative))
function inspect(id, { ctx, extraRoots = [] } = {}) {
  const search = new URLSearchParams({ id })
  for (const fork of extraRoots) search.append('extraRoots', fork)
  return invoke('GET', { ctx, url: `${plugin.ROUTE}?${search}` })
}
async function remove(id, options = {}) {
  const { json } = options.preview === undefined ? await inspect(id, options) : {}
  return invoke('POST', {
    ...options,
    body: JSON.stringify({
      id,
      confirm: options.confirm ?? plugin.CONFIRM_TOKEN,
      dangling: options.dangling,
      extraRoots: options.extraRoots,
      preview: options.preview ?? json?.session?.preview,
    }),
  })
}

/* ── 1. 身份闸门 ───────────────────────────────────────────────────────── */

check('id 形状：接受根会话', plugin.isSessionId(PARENT))
check('id 形状：接受子代理会话', plugin.isSessionId(CHILD))
check('id 形状：拒绝路径穿越', !plugin.isSessionId('../../etc/passwd'))
check('id 形状：拒绝空值', !plugin.isSessionId(''))
check('id 形状：拒绝大写十六进制', !plugin.isSessionId('session-11111111-1111-4111-8111-11111111111A'))

const upperId = await invoke('GET', { url: '/dsh-session-manager-delete/api?id=session-11111111-1111-4111-8111-11111111111A' })
check('大写 id 走路由 → 400', upperId.status === 400, String(upperId.status))

const noId = await invoke('GET', { url: '/dsh-session-manager-delete/api' })
check('GET 缺 id → 400', noId.status === 400, String(noId.status))

const badId = await invoke('GET', { url: '/dsh-session-manager-delete/api?id=..%2F..%2Fsecret' })
check('GET 非法 id → 400', badId.status === 400, String(badId.status))

/* ── 2. 查：范围与可删除性 ─────────────────────────────────────────────── */

const parentInfo = await inspect(PARENT)
check('GET 已知会话 → 200', parentInfo.status === 200, String(parentInfo.status))
check('查得到存在', parentInfo.json.session.exists === true)
check('查得到标题', typeof parentInfo.json.session.title === 'string' && parentInfo.json.session.title.length > 0)
check('统计到 1 个子代理会话', parentInfo.json.session.subagents === 1, String(parentInfo.json.session.subagents))
check('fork 底下的子代理不算进来', parentInfo.json.session.subagents === 1)
check('统计到 1 个 fork 会话', parentInfo.json.session.forks === 1, String(parentInfo.json.session.forks))
check('占用体积 > 0', parentInfo.json.session.bytes > 0, String(parentInfo.json.session.bytes))
check('可删除', parentInfo.json.session.deletable === true, String(parentInfo.json.session.blocking))
check('文件清单含父会话日志目录', parentInfo.json.session.artifacts.some((item) => item.includes(PARENT)))
check('文件清单含子代理日志目录', parentInfo.json.session.artifacts.some((item) => item.includes(CHILD)))
check('文件清单含两份投影缓存', parentInfo.json.session.artifacts.filter((item) => item.endsWith('.json')).length === 2)

const liveInfo = await inspect(LIVE)
check('正在跑的会话仍然是可删的（界面上给「先停掉」勾选项）', liveInfo.json.session.deletable === true, String(liveInfo.json.session.blocking))
check('并把"还有工作在跑"单独报出来', liveInfo.json.session.busy.total === 1 && liveInfo.json.session.busy.sessions[0].id === LIVE, JSON.stringify(liveInfo.json.session.busy))
check('忙碌只报一次（界面有专门区块，不重复进提醒列表）', !liveInfo.json.session.warnings.some((line) => line.includes('先停掉')), JSON.stringify(liveInfo.json.session.warnings))
const liveWithoutStop = await remove(LIVE)
check('不勾"先停掉"直接删 → 409', liveWithoutStop.status === 409, String(liveWithoutStop.status))
check('并说清是哪个会话还有工作没跑完', String(liveWithoutStop.json.error).includes(LIVE), String(liveWithoutStop.json.error))
check('拒删时文件没动', exists(logRelative(LIVE)))

// v0.4.0 的核心能力：宿主内存里活着的会话**可以删** —— 删除流程先把它注销掉。
const HELD = 'session-17171717-3939-4599-8787-959595959090'
writeFile(logRelative(HELD), 'held')
writeFile(cacheRelative(HELD), JSON.stringify({ version: 7, id: HELD }))
sessions.push({ header: { id: HELD } })

const heldHome = createContext()
heldHome.archive(HELD)
heldHome.hold(HELD)
const heldInfo = await plugin.inspectSession(heldHome.ctx, HELD)
check('已归档 + 内存里活着 → 仍然可删', heldInfo.info.deletable === true, String(heldInfo.info.blocking))
check('并如实报出它是活的', heldInfo.info.live === true)
check('并报出归档状态', heldInfo.info.archived === true)

const heldDelete = await plugin.deleteSession(heldHome.ctx, HELD)
check('内存里活着的会话能删掉', heldDelete.status === 200, `${heldDelete.status} ${heldDelete.payload && heldDelete.payload.error}`)
check('注销了内存里的会话与 Agent', heldHome.sessionRegistry.get(HELD) === undefined && heldHome.agentRegistry.get(HELD) === undefined)
check('注销发出了配对的 disposed 事件', heldHome.sessionRegistry.disposed.includes(HELD) && heldHome.agentRegistry.disposed.includes(HELD), JSON.stringify([heldHome.sessionRegistry.disposed, heldHome.agentRegistry.disposed]))
check('删除响应回报注销了哪些 id', Array.isArray(heldDelete.payload.forgotten) && heldDelete.payload.forgotten.includes(HELD), JSON.stringify(heldDelete.payload.forgotten))
check('删完之后宿主列表里也没有了它', Array.isArray(heldDelete.payload.memoryRemaining) && heldDelete.payload.memoryRemaining.length === 0, JSON.stringify(heldDelete.payload.memoryRemaining))
check('日志与缓存也删掉了', !exists(logRelative(HELD)) && !exists(cacheRelative(HELD)))

// 没有可用的注销路径（宿主版本形状不同）而进程又记着它 → 拒删（fail closed）。
const noEviction = createContext()
noEviction.archive(HELD)
noEviction.hold(HELD)
noEviction.services.sessions = { get: (id) => (noEviction.sessionRegistry.get(id) ? { id } : undefined), list: () => noEviction.sessionRegistry.list() }
noEviction.services.agents = { get: (id) => noEviction.agentRegistry.get(id) }
const noEvictionInfo = await plugin.inspectSession(noEviction.ctx, HELD)
check('没有注销路径时拒删', noEvictionInfo.info.deletable === false, String(noEvictionInfo.info.blocking))
check('并说明硬删会留下幽灵', String(noEvictionInfo.info.blocking).includes('未分组'))

// 注销原语在、但实际没生效（并发/形状变化）→ 复核抓出来，一个文件都不动。
const STUCK = 'session-19191919-5151-4711-8787-979797979090'
writeFile(logRelative(STUCK), 'stuck')
writeFile(cacheRelative(STUCK), JSON.stringify({ version: 7, id: STUCK }))
sessions.push({ header: { id: STUCK } })
const stuck = createContext()
stuck.archive(STUCK)
stuck.hold(STUCK)
stuck.services.sessions.detachEntered = () => {}
stuck.services.agents.detachEntered = () => {}
const stuckDelete = await plugin.deleteSession(stuck.ctx, STUCK)
check('注销没生效时拒删', stuckDelete.status === 409, String(stuckDelete.status))
check('注销没生效时文件没动', exists(logRelative(STUCK)) && exists(cacheRelative(STUCK)))
check('并把没注销掉的 id 报出来', Array.isArray(stuckDelete.payload.keptInMemory) && stuckDelete.payload.keptInMemory.includes(STUCK), JSON.stringify(stuckDelete.payload.keptInMemory))

// 空白会话（已创建、还没落盘）：删除时先补写落盘，再连文件一起删干净（不再需要用户手动清）。
const blankHome = createContext()
const BLANK = 'session-16161616-3838-4588-8787-949494949090'
sessions.push({ header: { id: BLANK } })
blankHome.archive(BLANK)
blankHome.markPending(BLANK)
const blankInfo = await plugin.inspectSession(blankHome.ctx, BLANK)
check('未落盘的空白会话可以删', blankInfo.info.deletable === true, String(blankInfo.info.blocking))
check('并报成 pending', blankInfo.info.pending === true)
check('未落盘时磁盘上没有痕迹', !exists(logRelative(BLANK)))

const blankDelete = await plugin.deleteSession(blankHome.ctx, BLANK)
check('删除时先补写落盘（flash 一次）', blankDelete.status === 200 && blankHome.calls.flushed.includes(BLANK), `${blankDelete.status} ${JSON.stringify(blankHome.calls.flushed)}`)
check('落盘产物也被一起删掉了', !exists(logRelative(BLANK)))
check('删完宿主列表里没有它', Array.isArray(blankDelete.payload.memoryRemaining) && blankDelete.payload.memoryRemaining.length === 0, JSON.stringify(blankDelete.payload.memoryRemaining))

// 补写落盘失败（IO 异常 / 宿主版本不同）：持久层内存记录还在 → **拒删且一个文件都不动**。
// 这是"报成功就必须是真成功"的守卫：做不到"让宿主忘掉它"就绝不落刀。
const stuckBlank = createContext()
const BLANK2 = 'session-20202020-6262-4722-8787-989898989091'
sessions.push({ header: { id: BLANK2 } })
stuckBlank.archive(BLANK2)
stuckBlank.markPending(BLANK2)
stuckBlank.services.sessions.flush = async () => { throw new Error('写盘失败') }
const stuckBlankDelete = await plugin.deleteSession(stuckBlank.ctx, BLANK2)
check('补写落盘失败时拒删', stuckBlankDelete.status === 409, String(stuckBlankDelete.status))
check('拒删时没写盘、也没留文件', !exists(logRelative(BLANK2)) && stuckBlank.pending.has(BLANK2))
check('并把没注销掉的 id 报出来', Array.isArray(stuckBlankDelete.payload.keptInMemory) && stuckBlankDelete.payload.keptInMemory.includes(BLANK2), JSON.stringify(stuckBlankDelete.payload.keptInMemory))

// 落刀前会再确认一次：查的时候还没打开、检查期间用户又点回去了 —— v0.4.0 起这不再是
// 拒删的理由，而是"顺手把它一起注销掉"（这才是"让宿主忘掉"的意义）。
const raceHome = createContext()
const RACE = 'session-18181818-4040-4600-8787-969696969090'
writeFile(logRelative(RACE), 'race')
writeFile(cacheRelative(RACE), JSON.stringify({ version: 7, id: RACE }))
sessions.push({ header: { id: RACE } })
let raceControllerCalls = 0
raceHome.services.sessionController = {
  async list() {
    raceControllerCalls += 1
    // 第二次（落刀前那一次复核）时用户已经点回去了：会话在两张注册表里出现。
    if (raceControllerCalls >= 2) raceHome.hold(RACE)
    return { items: sessions.map((entry) => ({ sessionId: entry.header.id, running: false })) }
  },
}
raceHome.archive(RACE)
const raceDelete = await plugin.deleteSession(raceHome.ctx, RACE)
check('落刀前发现又被打开 → 照样删干净', raceDelete.status === 200, `${raceDelete.status} ${raceDelete.payload && raceDelete.payload.error}`)
check('并且顺手把它注销掉了', raceHome.sessionRegistry.get(RACE) === undefined && raceHome.agentRegistry.get(RACE) === undefined)
check('文件也删了', !exists(logRelative(RACE)) && !exists(cacheRelative(RACE)))

const MISSING = 'session-99999999-9999-4999-8999-999999999999'
const missingInfo = await inspect(MISSING)
check('未知会话 exists=false', missingInfo.json.session.exists === false)
check('未知会话不可删', missingInfo.json.session.deletable === false)
check('未知会话说明“已经不存在”，而不是误报“还没有归档”',
  /已经不存在/.test(String(missingInfo.json.session.blocking)), String(missingInfo.json.session.blocking))

// 子代理目录在会话已经不存在时会抛 not found；这条噪声不该出现在“已消失”的会话上。
const goneHome = createContext()
goneHome.services.subagents = {
  async listDescendants() {
    throw new Error(`session ${MISSING} not found`)
  },
}
const goneInfo = await plugin.inspectSession(goneHome.ctx, MISSING)
check('已消失会话：absent=true 且不可删', goneInfo.info.absent === true && goneInfo.info.deletable === false)
check('已消失会话：不显示“子代理目录读不出来”的噪声',
  goneInfo.info.warnings.length === 0, JSON.stringify(goneInfo.info.warnings))

// 子代理会话在跑时，父会话也不能删 —— 否则会把一个正在干活的日志从底下抽走。
const childLive = createContext()
// 子代理"在跑"：官方 running 信号里点名它（父会话自己没在跑）。
childLive.services.sessionController = {
  async list() {
    return { items: sessions.map((snapshot) => ({ sessionId: snapshot.header.id, running: snapshot.header.id === CHILD })) }
  },
}
const childLiveInfo = await plugin.inspectSession(childLive.ctx, PARENT)
check('子代理在跑时父会话可删但要先停', childLiveInfo.info.deletable === true, String(childLiveInfo.info.blocking))
check('并点名是哪个子代理还有工作在跑', childLiveInfo.info.busy.sessions.some((entry) => entry.id === CHILD), JSON.stringify(childLiveInfo.info.busy))

/* ── 2b. 归档闸门：删除只对**已归档**的会话开放 ────────────────────────── */

const GATE = 'session-20202020-5252-4722-8787-989898989090'
writeFile(logRelative(GATE), 'gate')
writeFile(cacheRelative(GATE), JSON.stringify({ version: 7, id: GATE }))
sessions.push({ header: { id: GATE } })

const notArchived = createContext()
const notArchivedInfo = await plugin.inspectSession(notArchived.ctx, GATE)
check('未归档的会话拒删', notArchivedInfo.info.deletable === false, String(notArchivedInfo.info.blocking))
check('并报出归档状态为 false', notArchivedInfo.info.archived === false)
check('并告诉用户先去归档', String(notArchivedInfo.info.blocking).includes('归档'))
check('并说清归档在侧栏「…」菜单里', String(notArchivedInfo.info.blocking).includes('「…」'))
check('并说明归档会顺手停掉在跑的回合', String(notArchivedInfo.info.blocking).includes('停掉'))
const notArchivedDelete = await plugin.deleteSession(notArchived.ctx, GATE)
check('未归档时删除请求 → 409', notArchivedDelete.status === 409, String(notArchivedDelete.status))
check('未归档时一个文件都没动', exists(logRelative(GATE)) && exists(cacheRelative(GATE)))
check('未归档时也没补写落盘', notArchived.calls.flushed.length === 0)

// 归档状态读不到（没有 storageDomain）→ 拒删（fail closed），绝不猜"大概归档了"。
const blindArchive = createContext()
delete blindArchive.services.storageDomain
blindArchive.archive(GATE)
const blindArchiveInfo = await plugin.inspectSession(blindArchive.ctx, GATE)
check('读不到归档状态时拒删', blindArchiveInfo.info.deletable === false && blindArchiveInfo.info.archived === null, String(blindArchiveInfo.info.blocking))
check('并说明是读不到归档状态', String(blindArchiveInfo.info.blocking).includes('归档状态'))

// 归档之后：同一份夹具立刻就能删，而且不留悬空引用。
notArchived.archive(GATE)
const archivedInfo = await plugin.inspectSession(notArchived.ctx, GATE)
check('归档之后即可删除', archivedInfo.info.deletable === true, String(archivedInfo.info.blocking))
check('归档之后报出 archived=true', archivedInfo.info.archived === true)
const archivedDelete = await plugin.deleteSession(notArchived.ctx, GATE)
check('归档之后删除成功', archivedDelete.status === 200, `${archivedDelete.status} ${archivedDelete.payload && archivedDelete.payload.error}`)
check('并把归档集合里的引用一起摘掉（不留悬空）', !notArchived.globalRecord.archivedSessionIds.includes(GATE), JSON.stringify(notArchived.globalRecord.archivedSessionIds))
check('归档后删除也真的删掉了文件', !exists(logRelative(GATE)) && !exists(cacheRelative(GATE)))
check('登记侧取消了归档', notArchived.calls.unarchive.includes(GATE), JSON.stringify(notArchived.calls.unarchive))

/* ── 3. 删：四道闸门都能拦住 ───────────────────────────────────────────── */

const crossSite = await remove(PARENT, { headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } })
check('跨站 POST → 403', crossSite.status === 403, String(crossSite.status))
check('跨站 POST 不删文件', exists(logRelative(PARENT)))

const foreignOrigin = await remove(PARENT, { headers: { host: '127.0.0.1:19387', origin: 'https://evil.example' } })
check('异源 Origin → 403', foreignOrigin.status === 403, String(foreignOrigin.status))

const sameOrigin = await invoke('POST', {
  headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ id: PARENT }),
})
check('同源 POST 过闸门，但缺确认标记 → 400', sameOrigin.status === 400, String(sameOrigin.status))
check('同源缺标记也不删文件', exists(logRelative(PARENT)))

// DNS rebinding：攻击者页面用域名访问，Origin 与 Host 会自洽，所以删除请求额外要求 Host 是 IP 字面量。
const rebound = await invoke('POST', {
  headers: { host: 'attacker.example:19387', origin: 'http://attacker.example:19387', 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ id: PARENT, confirm: plugin.CONFIRM_TOKEN }),
})
check('域名 Host 的删除请求 → 403', rebound.status === 403, String(rebound.status))
check('域名 Host 不删文件', exists(logRelative(PARENT)))

const nullOrigin = await invoke('POST', {
  headers: { host: '127.0.0.1:19387', origin: 'null' },
  body: JSON.stringify({ id: PARENT, confirm: plugin.CONFIRM_TOKEN }),
})
check('Origin: null 的删除请求 → 403', nullOrigin.status === 403, String(nullOrigin.status))
check('Origin: null 不删文件', exists(logRelative(PARENT)))

const noToken = await remove(PARENT, { confirm: 'yes' })
check('确认标记不对 → 400', noToken.status === 400, String(noToken.status))
check('确认标记不对不删文件', exists(logRelative(PARENT)))

const wrongMethod = await invoke('DELETE')
check('不支持的方法 → 405', wrongMethod.status === 405, String(wrongMethod.status))

const blocked = await remove(LIVE)
check('正在跑的会话 → 409', blocked.status === 409, String(blocked.status))
check('正在跑的会话文件没动', exists(logRelative(LIVE)))

// 开着但闲着（界面里开着、没在跑、已归档）：v0.4.0 起**可以删** —— 走完整路由确认
// "先注销内存、再删文件"这条路真的通了。注销原语可能是异步的：必须等它完成再复核。
const openedEntry = host.sessionRegistry.store.get(OPENED)
let asyncDetachDone = false
openedEntry.detach = async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
  host.sessionRegistry.detachEntered(openedEntry)
  asyncDetachDone = true
}
const openedAgain = await remove(OPENED)
check('开着（未在跑）走路由能删掉', openedAgain.status === 200, `${openedAgain.status} ${openedAgain.json && openedAgain.json.error}`)
check('被删的会话从宿主内存里消失了', host.sessionRegistry.get(OPENED) === undefined && host.agentRegistry.get(OPENED) === undefined)
check('异步注销被等到完成', asyncDetachDone)
check('日志与缓存都删掉了', !exists(logRelative(OPENED)) && !exists(cacheRelative(OPENED)))
check('响应里没有留下"宿主还记着"的残留', Array.isArray(openedAgain.json.memoryRemaining) && openedAgain.json.memoryRemaining.length === 0, JSON.stringify(openedAgain.json.memoryRemaining))

const unknown = await remove('session-99999999-9999-4999-8999-999999999999')
check('未知会话 → 404', unknown.status === 404, String(unknown.status))

const brokenBody = await invoke('POST', { body: '{ not json' })
check('坏 JSON → 400', brokenBody.status === 400, String(brokenBody.status))

const hugeBody = await invoke('POST', { body: JSON.stringify({ id: PARENT, confirm: plugin.CONFIRM_TOKEN, padding: 'x'.repeat(70 * 1024) }) })
check('超大请求体 → 413（不是掐连接）', hugeBody.status === 413, String(hugeBody.status))
check('超大请求体不删文件', exists(logRelative(PARENT)))

// 显式维护入口：给"日志已经没了、只剩登记里一条幽灵"的历史残留一个不需要重启 DSH 的清理方式。
// 用独立夹具，避免清扫把后面才登场的测试会话（比如软链那条）提前当成幽灵剪掉。
const ROUTE_GHOST = 'session-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const repairHome = createContext()
repairHome.record.sessionIds = [ROUTE_GHOST]
repairHome.globalRecord.archivedSessionIds = [ROUTE_GHOST]
const repairWithoutConfirm = await invoke('POST', { body: JSON.stringify({ repair: true }), ctx: repairHome.ctx })
check('维护入口缺确认标记 → 400', repairWithoutConfirm.status === 400, String(repairWithoutConfirm.status))
const repairRoute = await invoke('POST', { body: JSON.stringify({ repair: true, confirm: plugin.CONFIRM_TOKEN }), ctx: repairHome.ctx })
check('维护入口能清掉悬空引用', repairRoute.status === 200 && repairRoute.json.repair.swept === 1, JSON.stringify(repairRoute.json))
check('维护入口真的写了工作区记录', !repairHome.record.sessionIds.includes(ROUTE_GHOST) && !repairHome.globalRecord.archivedSessionIds.includes(ROUTE_GHOST), JSON.stringify(repairHome.record.sessionIds))

// 绕过路由直接调用（本模块的查/删函数是导出的）也必须拒绝非法 id，而不是拼出一个越界路径。
let directInspectThrew = false
try {
  await plugin.inspectSession(ctx, '../../storages/workspace.json')
} catch (error) {
  directInspectThrew = true
}
check('直接查非法 id 会抛错', directInspectThrew)
const directDelete = await plugin.deleteSession(ctx, '..\\..\\storages\\workspace.json')
check('直接删非法 id → 400（不抛）', directDelete.status === 400, String(directDelete.status))
check('非法调用后 workspace.json 还在', exists(path.join('storages', 'workspace.json')))

// 日志目录是"联接/软链"时：既不能顺着链接删，也不能假报成功。
const linkTarget = path.join(tempHome, 'sessions', SLUG, 'link-target-dir')
fs.mkdirSync(linkTarget, { recursive: true })
fs.writeFileSync(path.join(linkTarget, 'session.v4.jsonl.zstd'), 'linked')
let junctionMade = false
try {
  fs.symlinkSync(linkTarget, path.join(tempHome, 'sessions', SLUG, LINKED), 'junction')
  junctionMade = true
} catch (error) {
  junctionMade = false
}
sessions.push({ header: { id: LINKED } })
if (junctionMade) {
  const linkedInfo = await inspect(LINKED)
  check('日志在联接后面时不可删', linkedInfo.json.session.deletable === false, JSON.stringify(linkedInfo.json.session.blocking))
  check('并说明是软链/联接', String(linkedInfo.json.session.blocking).includes('软链'))
  const linkedDelete = await remove(LINKED)
  check('联接后的会话不会被误报成功', linkedDelete.status === 409, String(linkedDelete.status))
  check('联接目标原样保留', exists(path.join('sessions', SLUG, 'link-target-dir', 'session.v4.jsonl.zstd')))
} else {
  check('（跳过）本机无法创建联接，跳过软链分支', true)
}

/* ── 4. 删子代理会话：不牵连父会话 ─────────────────────────────────────── */

const childDelete = await remove(CHILD)
check('删子代理会话 → 200', childDelete.status === 200, String(childDelete.status))
check('子会话日志已删', !exists(logRelative(CHILD)))
check('子会话缓存已删', !exists(cacheRelative(CHILD)))
check('父会话日志还在', exists(logRelative(PARENT)))
check('父会话缓存还在', exists(cacheRelative(PARENT)))

/* ── 5. 删父会话：带走子代理会话，放过 fork / 旁支 / 附件 ──────────────── */

// 把子代理会话的痕迹重新造出来：本节要验证"父会话连子代理一起清理"。
writeFile(logRelative(CHILD), 'y'.repeat(1024))
writeFile(cacheRelative(CHILD), JSON.stringify({ version: 7, id: CHILD }))

const parentDelete = await remove(PARENT)
check('删父会话 → 200', parentDelete.status === 200, String(parentDelete.status))
check('删掉了 4 项（父日志 / 父缓存 / 子日志 / 子缓存）', parentDelete.json.removed.length === 4, JSON.stringify(parentDelete.json.removed))
const removalOrder = parentDelete.json.removed.map(String)
check('删除顺序：可重建的投影缓存排在不可重建的会话日志之前',
  removalOrder.slice(0, 2).every((item) => item.endsWith('.json')) && removalOrder.slice(2).every((item) => !item.endsWith('.json')),
  JSON.stringify(removalOrder))
check('删除响应回报名下真的被删掉的 id（浏览器半区据此清本地状态）', Array.isArray(parentDelete.json.deletedIds) && parentDelete.json.deletedIds.join() === [PARENT, CHILD].join(), JSON.stringify(parentDelete.json.deletedIds))
check('父会话日志已删', !exists(logRelative(PARENT)))
check('父会话缓存已删', !exists(cacheRelative(PARENT)))
check('子代理会话一并清理', !exists(cacheRelative(CHILD)))
check('fork 会话保留', exists(logRelative(FORK)) && exists(cacheRelative(FORK)))
check('fork 自己的子代理会话也保留', exists(logRelative(FORKCHILD)) && exists(cacheRelative(FORKCHILD)))
check('成功响应里没有 remaining', parentDelete.json.remaining === undefined)
check('成功响应带 note 字段', typeof parentDelete.json.note === 'string')
check('旁支会话保留', exists(logRelative(OTHER)) && exists(cacheRelative(OTHER)))
check('附件不受影响', exists(path.join('attachments', 'v1', 'objects', 'ab', 'abcdef')))
check('凭据不受影响', exists(path.join('.credentials.yaml')))
check('workspace.json 未被手改', fs.readFileSync(workspaceFile, 'utf8') === JSON.stringify({ unit: { name: 'workspace', version: 2 } }))
check('登记：取消置顶', host.calls.unpin.includes(PARENT), JSON.stringify(host.calls.unpin))
check('登记：取消归档', host.calls.unarchive.includes(PARENT))
check('登记：移出工作区', host.calls.detach.includes(PARENT))

const afterDelete = await inspect(PARENT)
check('删完再查：exists=false', afterDelete.json.session.exists === false)

const again = await remove(PARENT)
check('重复删 → 404', again.status === 404, String(again.status))

// 重试语义：只剩"被写回来"的投影缓存时，重试只清掉它，不谎报别的。
writeFile(cacheRelative(PARENT), JSON.stringify({ version: 7, id: PARENT }))
host.archive(PARENT) // 第一次成功删除时插件会取消归档；重试前重新归档
const retry = await remove(PARENT)
check('重试仍成功', retry.status === 200, `${retry.status} ${JSON.stringify(retry.json && retry.json.error)}`)
check('重试只报了那一项', Array.isArray(retry.json.removed) && retry.json.removed.length === 1, JSON.stringify(retry.json && retry.json.removed))
check('重试报的是残留缓存', Array.isArray(retry.json.removed) && String(retry.json.removed[0]).endsWith(`${PARENT}.json`))
check('重试后磁盘干净', !exists(cacheRelative(PARENT)))

/* ── 6. 服务缺席也不炸；但"判定不了存活"必须拒删（fail closed）──────────── */

const bare = createContext()
delete bare.services.workspaceRegistry
delete bare.services.sessionQuery
delete bare.services.jobs
const bareInfo = await plugin.inspectSession(bare.ctx, OTHER)
check('可选服务缺席时仍能查', bareInfo.info.exists === true && bareInfo.info.title === '')

// 拿不到官方 running 信号（启动/卸载途中、极简 composition）：不知道在不在跑，就不许删。
const noAgents = createContext()
delete noAgents.services.sessionController
const noAgentsInfo = await plugin.inspectSession(noAgents.ctx, OTHER)
check('读不到会话状态时拒绝删除', noAgentsInfo.info.deletable === false)
check('并说明无法确认', String(noAgentsInfo.info.blocking).includes('查不到会话的运行状态'), String(noAgentsInfo.info.blocking))

// jobs 查询抛错：同样拒删。
const brokenJobs = createContext()
brokenJobs.services.jobs = { list() { throw new Error('registry unavailable') } }
const brokenJobsInfo = await plugin.inspectSession(brokenJobs.ctx, OTHER)
check('jobs 查询异常时拒绝删除', brokenJobsInfo.info.deletable === false)
check('并说明任务状态不可知', String(brokenJobsInfo.info.blocking).includes('后台任务'))

// 无主任务不属于任何会话：不能因为别人跑着任务就让这个会话删不了。
const unownedJob = createContext()
unownedJob.services.jobs = { list: () => [{ id: 'bash-1', status: 'running' }] }
const unownedInfo = await plugin.inspectSession(unownedJob.ctx, OTHER)
check('无主任务不算在本会话头上', unownedInfo.info.deletable === true, String(unownedInfo.info.blocking))

// 真正属于本会话的任务：拒删。
const ownedJob = createContext()
ownedJob.services.jobs = { list: () => [{ id: 'bash-2', status: 'running', owner: OTHER }] }
const ownedInfo = await plugin.inspectSession(ownedJob.ctx, OTHER)
check('本会话的任务报告成"还有工作在跑"', ownedInfo.info.busy.total === 1 && String(JSON.stringify(ownedInfo.info.busy)).includes('后台任务'), JSON.stringify(ownedInfo.info.busy))
check('并且不是硬闸门（可删，只要勾先停掉）', ownedInfo.info.deletable === true, String(ownedInfo.info.blocking))

const bareDelete = await plugin.deleteSession(bare.ctx, OTHER)
check('可选服务缺席时仍能删', bareDelete.status === 200 && bareDelete.payload.registry.available === false, String(bareDelete.status))

/* ── 7. 文件删不掉时：报 500、登记保持原样、解锁后能重试 ───────────────── */

// 让这个会话目录成为另一个进程的当前目录：Windows 上 rm -r 会以 EPERM 失败，
// 正好用来验证"删不干净时绝不假报成功、也不摘登记"这条路径。
const holder = childProcess.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
  cwd: path.join(tempHome, 'sessions', SLUG, LOCKED),
  stdio: 'ignore',
})
await new Promise((resolve) => setTimeout(resolve, 700))

const lockedDelete = await remove(LOCKED)
check('删不掉时回 500 而不是假报成功', lockedDelete.status === 500, String(lockedDelete.status))
check('失败响应列出残留', Array.isArray(lockedDelete.json.remaining) && lockedDelete.json.remaining.length > 0, JSON.stringify(lockedDelete.json.remaining))
check('失败时登记保持原样', lockedDelete.json.registry.kept === true)
check('失败时不调用 detachSession', !host.calls.detach.includes(LOCKED), JSON.stringify(host.calls.detach))
check('失败后会话仍查得到（还能重试）', (await inspect(LOCKED)).json.session.exists === true)

holder.kill()
await new Promise((resolve) => setTimeout(resolve, 500))
const retryLocked = await remove(LOCKED)
check('解锁后重试成功', retryLocked.status === 200, JSON.stringify(retryLocked.json).slice(0, 160))
// 第一次已经把锁不住的投影缓存删掉了，所以重试只需要再删掉那个被占用的目录。
check('重试删掉了被占用的目录', Array.isArray(retryLocked.json.removed) && retryLocked.json.removed.length === 1 && String(retryLocked.json.removed[0]).includes(LOCKED), JSON.stringify(retryLocked.json.removed))
check('重试后日志目录真的没了', !exists(logRelative(LOCKED)))
check('重试成功后才摘登记', host.calls.detach.includes(LOCKED), JSON.stringify(host.calls.detach))

/* ── 8. 悬空引用：投影已看不见、持久化记录里还在 → 必须剪掉 ───────────── */
// 这是"删完会话，侧栏多出一个未分组幽灵条目"那个 bug 的回归测试：
// 日志删掉后，注册表的 workspace.sessionIds 投影里已经没有这个 id，
// 官方 detachSession 无从下手，悬空 id 就躲在持久化记录里。

writeFile(logRelative(DRIFT), 'drift')
writeFile(cacheRelative(DRIFT), JSON.stringify({ version: 7, id: DRIFT }))
sessions.push({ header: { id: DRIFT } })

const drift = createContext()
// 篡改投影：模拟 header 索引已经把它过滤掉（真实现里删完日志就是这样）。
drift.services.workspaceRegistry.list = () => [{ id: 'ws-1', title: 'default-workspace', sessionIds: [] }]
// 记录与全局集合里仍然引用着它。
drift.record.sessionIds = [OTHER, DRIFT]
drift.globalRecord.archivedSessionIds = [DRIFT]
drift.globalRecord.pinnedSessionIds = [DRIFT]

const driftDelete = await plugin.deleteSession(drift.ctx, DRIFT)
check('悬空引用不影响删除成功', driftDelete.status === 200, String(driftDelete.status))
check('从原始记录找到工作区归属并摘掉', driftDelete.payload.registry.steps.some((step) => step.includes('移出工作区')), JSON.stringify(driftDelete.payload.registry.steps))
check('工作区记录里不再引用它', !drift.record.sessionIds.includes(DRIFT), JSON.stringify(drift.record.sessionIds))
check('归档集合里不再引用它', !drift.globalRecord.archivedSessionIds.includes(DRIFT), JSON.stringify(drift.globalRecord.archivedSessionIds))
check('置顶集合里不再引用它', !drift.globalRecord.pinnedSessionIds.includes(DRIFT), JSON.stringify(drift.globalRecord.pinnedSessionIds))
check('记录里的其他 id 与字段原样保留', drift.record.sessionIds.includes(OTHER) && drift.globalRecord.defaultWorkspaceId === 'ws-1' && drift.record.title === 'default-workspace')
check('确实通过官方 detachSession 写了记录', drift.calls.detach.includes(DRIFT), JSON.stringify(drift.calls.detach))

// 官方接口能摘干净时不该多写记录：复核只读，发现没有悬空引用就收手。
check('官方接口摘干净后不再动记录', host.calls.domainWrites === 0, String(host.calls.domainWrites))

/* ── 9. 清扫历史遗留的悬空引用（旧版本留下的幽灵条目）────────────────── */

// GHOST：记录里还引用着，但磁盘上没有日志/缓存、会话列表里也没有它 —— 正是幽灵的形状。
const GHOST = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const sweepHome = createContext()
sweepHome.record.sessionIds = [FORK, GHOST]
sweepHome.globalRecord.archivedSessionIds = [GHOST]
sweepHome.globalRecord.pinnedSessionIds = []

const sweep = await plugin.sweepDanglingReferences(sweepHome.ctx)
check('清扫认出悬空引用', sweep.swept === 1, JSON.stringify(sweep))
check('清扫把它从工作区记录里剪掉', !sweepHome.record.sessionIds.includes(GHOST), JSON.stringify(sweepHome.record.sessionIds))
check('清扫保留仍然存在的会话', sweepHome.record.sessionIds.includes(FORK))
check('清扫把它从归档集合里剪掉', !sweepHome.globalRecord.archivedSessionIds.includes(GHOST))
check('清扫报告了做了什么', sweep.steps.length > 0, JSON.stringify(sweep.steps))

// 安全闸门 1：存活判定服务缺席时什么都不做（宁可留幽灵，也不误删真会话）。
const noAgentsSweep = createContext()
noAgentsSweep.record.sessionIds = [GHOST]
delete noAgentsSweep.services.agents
const guarded = await plugin.sweepDanglingReferences(noAgentsSweep.ctx)
check('拿不到存活判定时不清扫', guarded.swept === 0 && noAgentsSweep.calls.domainWrites === 0, JSON.stringify(guarded))

// 安全闸门 2：会话列表为空（服务可能还没就绪）时什么都不做 ——
// 否则"所有引用都像悬空"，一刀下去会把整个侧栏清空。
const emptySweep = createContext()
emptySweep.record.sessionIds = [OTHER, GHOST]
emptySweep.services.sessionPersistence.list = async () => []
const emptyGuarded = await plugin.sweepDanglingReferences(emptySweep.ctx)
check('会话列表为空时不清扫', emptyGuarded.swept === 0 && emptySweep.record.sessionIds.includes(GHOST), JSON.stringify(emptyGuarded))

// 安全闸门 3：磁盘上还有日志的会话绝不能被当成悬空。
const keptSweep = createContext()
keptSweep.record.sessionIds = [FORK, GHOST]
keptSweep.globalRecord.archivedSessionIds = []
keptSweep.services.sessionPersistence.list = async () => [{ header: { id: FORK } }]
const keptGuarded = await plugin.sweepDanglingReferences(keptSweep.ctx)
check('磁盘上还有日志的会话不动', keptSweep.record.sessionIds.includes(FORK) && keptGuarded.swept === 1, JSON.stringify(keptSweep.record.sessionIds))

/* ── 10. 查永远是只读的：悬空引用只预览，绝不偷偷写入 ─────────────────── */

// 这是"我只是点开看一眼，注册表却被改了"那个坑的回归测试。
const previewHome = createContext()
previewHome.record.sessionIds = [FORK, GHOST]
previewHome.globalRecord.pinnedSessionIds = []
previewHome.globalRecord.archivedSessionIds = [GHOST]
const previewWrites = previewHome.calls.domainWrites
const previewInfo = await plugin.inspectSession(previewHome.ctx, FORK)
check('查会话时顺带预览悬空引用条数', previewInfo.info.dangling.count === 1, JSON.stringify(previewInfo.info.dangling))
check('预览里点得出是哪一条', previewInfo.info.dangling.ids.includes(GHOST))
check('预览标注证据充分', previewInfo.info.dangling.reliable === true, JSON.stringify(previewInfo.info.dangling))
check('查（inspect）全程不写注册表', previewHome.calls.domainWrites === previewWrites, String(previewHome.calls.domainWrites))
check('查完悬空引用还在原地', previewHome.record.sessionIds.includes(GHOST))

const httpPreviewHome = createContext()
httpPreviewHome.record.sessionIds = [FORK, GHOST]
httpPreviewHome.globalRecord.archivedSessionIds = []
httpPreviewHome.globalRecord.pinnedSessionIds = []
const httpPreviewWrites = httpPreviewHome.calls.domainWrites
const httpPreview = await invoke('GET', { ctx: httpPreviewHome.ctx, url: `/dsh-session-manager-delete/api?id=${FORK}` })
check('GET 路由回的是预览而不是清扫结果', httpPreview.json.swept === undefined && httpPreview.json.session.dangling.count === 1)
check('GET 路由不写注册表', httpPreviewHome.calls.domainWrites === httpPreviewWrites, String(httpPreviewHome.calls.domainWrites))
check('GET 路由之后悬空引用仍在', httpPreviewHome.record.sessionIds.includes(GHOST))

// 证据不足时预览必须说"不知道"，而不是报"没有"。
const blindPreview = createContext()
blindPreview.record.sessionIds = [OTHER, GHOST]
blindPreview.globalRecord.archivedSessionIds = []
delete blindPreview.services.agents
const blindInfo = await plugin.inspectSession(blindPreview.ctx, OTHER)
check('证据不足时预览不可信', blindInfo.info.dangling.reliable === false && blindInfo.info.dangling.count === 0, JSON.stringify(blindInfo.info.dangling))
check('并说明为什么不可信', String(blindInfo.info.dangling.reason).length > 0, blindInfo.info.dangling.reason)

/* ── 11. 删除清单：列出会被一起删掉的每一个会话 id ────────────────────── */

const P2 = 'session-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const C2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
writeFile(logRelative(P2), 'p2')
writeFile(cacheRelative(P2), JSON.stringify({ version: 7, id: P2 }))
writeFile(logRelative(C2), 'c2')
writeFile(cacheRelative(C2), JSON.stringify({ version: 7, id: C2 }))
sessions.push({ header: { id: P2, createdAt: Date.parse('2026-02-02T00:00:00Z') } }, { header: { id: C2, parentSession: P2, origin: 'subagent' } })

const p2Info = await plugin.inspectSession(ctx, P2)
check('清单第一项是目标会话本身', p2Info.info.targets[0].id === P2 && p2Info.info.targets[0].origin === 'self', JSON.stringify(p2Info.info.targets))
check('清单里列出将一起删掉的子代理会话', p2Info.info.targets.length === 2 && p2Info.info.targets[1].id === C2 && p2Info.info.targets[1].origin === 'subagent', JSON.stringify(p2Info.info.targets))
check('清单与磁盘清单一一对应（2 份日志 + 2 份缓存）', p2Info.info.artifacts.filter((item) => item.includes(P2) || item.includes(C2)).length === 4, JSON.stringify(p2Info.info.artifacts))

/* ── 12. 删除时只剪"看过的那几条"悬空引用 ─────────────────────────────── */

const GHOST2 = 'session-bbbbbbbb-cccc-4bbb-8bbb-bbbbbbbbbbbb'
const pruneSubject = 'session-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
writeFile(logRelative(pruneSubject), 'subject')
writeFile(cacheRelative(pruneSubject), JSON.stringify({ version: 7, id: pruneSubject }))
sessions.push({ header: { id: pruneSubject } })

const pruneHome = createContext()
pruneHome.record.sessionIds = [pruneSubject, GHOST, GHOST2]
pruneHome.globalRecord.archivedSessionIds = [GHOST, GHOST2]
pruneHome.archive(pruneSubject)
const pruneDelete = await plugin.deleteSession(pruneHome.ctx, pruneSubject, { dangling: [GHOST] })
check('按预览列表删除仍然成功', pruneDelete.status === 200, String(pruneDelete.status))
check('删掉了预览过的那条悬空引用', !pruneHome.record.sessionIds.includes(GHOST), JSON.stringify(pruneHome.record.sessionIds))
check('删除时顺手剪掉全局集合里的那一条', !pruneHome.globalRecord.archivedSessionIds.includes(GHOST))
check('没预览过的悬空引用一个字不动', pruneHome.record.sessionIds.includes(GHOST2) && pruneHome.globalRecord.archivedSessionIds.includes(GHOST2), JSON.stringify(pruneHome.record.sessionIds))
check('回报剪掉了几条', pruneDelete.payload.danglingPruned === 1, String(pruneDelete.payload.danglingPruned))

// 从"看一眼"到"点确认"之间会话又回来了：即便在预览列表里也不能剪。
const revived = 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const revivedSubject = 'session-dddddddd-eeee-4ddd-8ddd-dddddddddddd'
writeFile(logRelative(revivedSubject), 'subject2')
sessions.push({ header: { id: revivedSubject } })
const revivedHome = createContext()
revivedHome.record.sessionIds = [revivedSubject, revived]
writeFile(logRelative(revived), 'came-back')
revivedHome.archive(revivedSubject)
const revivedArchivedBefore = [...revivedHome.globalRecord.archivedSessionIds]
const revivedDelete = await plugin.deleteSession(revivedHome.ctx, revivedSubject, { dangling: [revived] })
check('又活过来的会话不会被当成悬空引用剪掉', revivedDelete.status === 200 && revivedHome.record.sessionIds.includes(revived), JSON.stringify(revivedHome.record.sessionIds))
check('也没动别的归档引用', !revivedHome.globalRecord.archivedSessionIds.includes(revived) && revivedHome.globalRecord.archivedSessionIds.length === revivedArchivedBefore.length - 1, JSON.stringify(revivedHome.globalRecord.archivedSessionIds))

// 不传 dangling（例如直接调 API）：一条悬空引用都不许动。
const noListHome = createContext()
const noListSubject = 'session-dddddddd-ffff-4ddd-8ddd-dddddddddddd'
writeFile(logRelative(noListSubject), 'subject3')
sessions.push({ header: { id: noListSubject } })
noListHome.record.sessionIds = [noListSubject, GHOST]
noListHome.archive(noListSubject)
const noListDelete = await plugin.deleteSession(noListHome.ctx, noListSubject)
check('没传清单时不做全库大扫除', noListDelete.status === 200 && noListHome.record.sessionIds.includes(GHOST), JSON.stringify(noListHome.record.sessionIds))

/* ── 14. 删 A 不影响 B：文件、登记、全局字段都要原样 ───────────────────── */

const KEEP = 'session-99999999-8888-4777-8666-555555555555'
const DROP = 'session-99999999-7777-4666-8555-444444444444'
writeFile(logRelative(KEEP), 'keep')
writeFile(cacheRelative(KEEP), JSON.stringify({ version: 7, id: KEEP }))
writeFile(logRelative(DROP), 'drop')
writeFile(cacheRelative(DROP), JSON.stringify({ version: 7, id: DROP }))
sessions.push({ header: { id: KEEP } }, { header: { id: DROP } })

const isoHome = createContext()
isoHome.record.sessionIds = [DROP, KEEP]
isoHome.globalRecord.archivedSessionIds = [DROP, KEEP]
isoHome.globalRecord.pinnedSessionIds = [KEEP]
isoHome.globalRecord.keepMe = 'must survive'
const isoDelete = await plugin.deleteSession(isoHome.ctx, DROP)
check('隔离：目标删掉了', isoDelete.status === 200 && !exists(logRelative(DROP)) && !exists(cacheRelative(DROP)), String(isoDelete.status))
check('隔离：另一个会话的日志与缓存原样保留', exists(logRelative(KEEP)) && exists(cacheRelative(KEEP)))
check('隔离：另一个会话的登记引用保留', isoHome.record.sessionIds.includes(KEEP) && !isoHome.record.sessionIds.includes(DROP), JSON.stringify(isoHome.record.sessionIds))
check('隔离：另一个会话的归档状态保留', isoHome.globalRecord.archivedSessionIds.includes(KEEP), JSON.stringify(isoHome.globalRecord.archivedSessionIds))
check('隔离：另一个会话的置顶状态保留', isoHome.globalRecord.pinnedSessionIds.includes(KEEP), JSON.stringify(isoHome.globalRecord.pinnedSessionIds))
check('隔离：全局记录里的其他字段不丢', isoHome.globalRecord.keepMe === 'must survive' && isoHome.globalRecord.defaultWorkspaceId === 'ws-1')
check('隔离：工作区记录的其他字段不丢', isoHome.record.title === 'default-workspace' && isoHome.record.path === 'C:\\ws')
check('隔离：响应只点名被删的那个 id', isoDelete.payload.deletedIds.join() === DROP, JSON.stringify(isoDelete.payload.deletedIds))

// 记录形状不认识时：一次空操作，绝不整条覆盖。
const weirdHome = createContext()
// 走"没有 workspaceRegistry"的旧宿主分支：这里要验证的正是直写通道不会整条覆盖不认识的记录。
delete weirdHome.services.workspaceRegistry
const weirdRecord = { title: 'weird', path: 'C:\\w', sessionIds: 'not-an-array' }
const weirdGlobal = { archivedSessionIds: 'nope', pinnedSessionIds: [], keepMe: 7 }
let weirdWrites = 0
weirdHome.services.storageDomain = {
  get: () => ({
    table: () => ({
      entries: () => [['ws-1', weirdRecord]],
      async update() { weirdWrites += 1; return weirdRecord },
    }),
    global: {
      get: () => weirdGlobal,
      async set() { weirdWrites += 1 },
    },
  }),
}
const weirdSteps = await plugin.pruneResidualReferences(weirdHome.ctx, [GHOST], { workspaces: ['ws-1'], archived: [GHOST], pinned: [] })
check('记录形状不认识时不改写记录', weirdRecord.sessionIds === 'not-an-array' && weirdRecord.title === 'weird')
check('形状不认识时不写全局集合（也没抹掉别的字段）', weirdGlobal.archivedSessionIds === 'nope' && weirdGlobal.keepMe === 7, JSON.stringify(weirdGlobal))
check('形状不认识时如实说明未改动', weirdSteps.some((step) => step.includes('未改动')), JSON.stringify(weirdSteps))

// 记录形状正常、但没有可剪的 id：连写都不写。
const noopHome = createContext()
// 同上：旧宿主没有注册表时才走直写；没有可剪的 id 就一次写都不该产生。
delete noopHome.services.workspaceRegistry
const noopRecord = { title: 'noop', sessionIds: [KEEP] }
noopHome.services.storageDomain = {
  get: () => ({
    table: () => ({ entries: () => [['ws-1', noopRecord]], async update() { noopHome.calls.domainWrites += 1; return noopRecord } }),
    global: { get: () => noopHome.globalRecord, async set() { noopHome.calls.domainWrites += 1 } },
  }),
}
const noopSteps = await plugin.pruneResidualReferences(noopHome.ctx, [GHOST], { workspaces: ['ws-1'], archived: [], pinned: [] })
check('没有可剪的 id 时不产生一次没必要的写', noopHome.calls.domainWrites === 0 && noopRecord.sessionIds.join() === KEEP, String(noopHome.calls.domainWrites))
check('没有可剪的 id 时不报"已剪掉"', noopSteps.length === 0, JSON.stringify(noopSteps))

/* ── 15. 删空之后顺手收走空的 slug 目录（只收确实空了的）──────────────── */

const LONE_SLUG = '--C-Users-lonely--'
const LONE = 'session-11111111-2222-4333-8444-555555555555'
const slugPath = (slug) => path.join(tempHome, 'sessions', slug)
writeFile(path.join('sessions', LONE_SLUG, LONE, 'session.v4.jsonl.zstd'), 'lonely')
writeFile(cacheRelative(LONE), JSON.stringify({ version: 7, id: LONE }))
host.archive(LONE)
sessions.push({ header: { id: LONE } })

const loneInfo = await inspect(LONE)
check('清单里说明空目录会被一并清理', loneInfo.json.session.artifacts.some((item) => item.includes(LONE_SLUG) && item.includes('一并清理')), JSON.stringify(loneInfo.json.session.artifacts))
const loneDelete = await remove(LONE)
check('删掉工作区最后一个会话后，空 slug 目录也收走', loneDelete.status === 200 && !fs.existsSync(slugPath(LONE_SLUG)), String(loneDelete.status))
check('回报收走了哪些空目录', Array.isArray(loneDelete.json.emptyDirsRemoved) && loneDelete.json.emptyDirsRemoved.length === 1, JSON.stringify(loneDelete.json.emptyDirsRemoved))
check('还有别的会话的 slug 目录不动', fs.existsSync(slugPath(SLUG)))

// 预览是只读的：看过之后目录不会自己消失。
const LONE2 = 'session-11111111-3333-4333-8444-555555555555'
const LONE2_SLUG = '--C-Users-lonely2--'
writeFile(path.join('sessions', LONE2_SLUG, LONE2, 'session.v4.jsonl.zstd'), 'lonely2')
host.archive(LONE2)
sessions.push({ header: { id: LONE2 } })
await inspect(LONE2)
check('只看不删：空目录预览之后目录仍在', fs.existsSync(slugPath(LONE2_SLUG)))
await plugin.deleteSession(ctx, LONE2)
check('再删才真的收走', !fs.existsSync(slugPath(LONE2_SLUG)))

/* ── 16. 登记预览：所见即所删 ─────────────────────────────────────────── */

const planHome = createContext()
planHome.record.sessionIds = [FORK, OTHER]
planHome.globalRecord.pinnedSessionIds = [FORK]
planHome.globalRecord.archivedSessionIds = []
const planInfo = await plugin.inspectSession(planHome.ctx, FORK)
check('登记预览列出引用它的工作区', planInfo.info.registry.workspaces.length === 1 && planInfo.info.registry.workspaces[0].id === 'ws-1', JSON.stringify(planInfo.info.registry))
check('登记预览带工作区标题', planInfo.info.registry.workspaces[0].title === 'default-workspace')
check('登记预览报出置顶状态', planInfo.info.registry.pinned === true && planInfo.info.registry.archived === false, JSON.stringify(planInfo.info.registry))
check('登记预览标注集合可读', planInfo.info.registry.readable === true)
check('登记预览标出登记服务可用', planInfo.info.registry.available === true)
check('登记预览不改任何东西', planHome.calls.domainWrites === 0 && planHome.calls.unpin.length === 0)

const planBare = createContext()
delete planBare.services.workspaceRegistry
const planBareInfo = await plugin.inspectSession(planBare.ctx, FORK)
check('登记服务缺席时如实报不可用', planBareInfo.info.registry.available === false && planBareInfo.info.registry.workspaces.length === 0)

/* ── 17. 临时目录里的 spill 残留（工具输出溢出）──────────────────────── */

// 把 os.tmpdir() 指到夹具里，免得动真实 %TEMP%。派生算法由测试**独立**算一遍：
//   session- + sha256(会话 id) 的十六进制前 12 位（spill-local 的 sessionDir()）。
const spillBase = path.join(tempHome, 'tmp-fixture')
fs.mkdirSync(spillBase, { recursive: true })
process.env.TEMP = spillBase
process.env.TMP = spillBase
const spillNameOf = (id) => `session-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`

check('spill 目录名与官方派生一致', plugin.spillSessionName(OTHER) === spillNameOf(OTHER), plugin.spillSessionName(OTHER))

const SPILL_SESSION = 'session-12121212-3434-4565-8787-909090909090'
const SPILL_KEEP = 'session-13131313-3535-4575-8787-919191919099'
const spillRootA = path.join(spillBase, 'dsh-spill-Ab12Cd')
const spillRootB = path.join(spillBase, 'dsh-spill-Zz98Yy')
const spillRootOdd = path.join(spillBase, 'dsh-spill-a-much-longer-name')
const spillDir = path.join(spillRootA, spillNameOf(SPILL_SESSION))
const spillKeepDir = path.join(spillRootB, spillNameOf(SPILL_KEEP))
const spillNoise = path.join(spillRootB, 'session-not-a-hash')
writeFile(path.join('sessions', SLUG, SPILL_SESSION, 'session.v4.jsonl.zstd'), 'spill-subject')
writeFile(path.relative(tempHome, path.join(spillDir, 'ab12cd34-tool-output.txt')), 'spilled tool output')
writeFile(path.relative(tempHome, path.join(spillKeepDir, '99887766-tool-output.txt')), 'other session spill')
writeFile(path.relative(tempHome, path.join(spillNoise, 'keep.txt')), 'not a hash dir')
writeFile(path.relative(tempHome, path.join(spillRootOdd, spillNameOf(SPILL_SESSION), 'x.txt')), 'wrong-shaped root')
host.archive(SPILL_SESSION)
sessions.push({ header: { id: SPILL_SESSION } }, { header: { id: SPILL_KEEP } })

const spillInfo = await inspect(SPILL_SESSION)
check('清单里列出 spill 临时目录', spillInfo.json.session.artifacts.some((item) => item.includes(spillDir) && item.includes('溢出')), JSON.stringify(spillInfo.json.session.artifacts))
check('spill 占用算进总大小', spillInfo.json.session.bytes > Buffer.byteLength('spilled tool output'), String(spillInfo.json.session.bytes))

const spillDelete = await remove(SPILL_SESSION)
check('删会话时一并清掉 spill 目录', spillDelete.status === 200 && !fs.existsSync(spillDir), String(spillDelete.status))
check('清干净时不报 spill 残留', Array.isArray(spillDelete.json.spillRemaining) && spillDelete.json.spillRemaining.length === 0, JSON.stringify(spillDelete.json.spillRemaining))
check('别的会话的 spill 目录不动', fs.existsSync(spillKeepDir) && fs.existsSync(path.join(spillKeepDir, '99887766-tool-output.txt')))
check('名字不像会话目录的条目不动', fs.existsSync(spillNoise))
check('根名形状不符的目录一律不碰', fs.existsSync(path.join(spillRootOdd, spillNameOf(SPILL_SESSION), 'x.txt')))

// 删不掉的 spill（被占用）不能把一次成功的删除判成失败：结论照旧成功，残留如实报。
const SPILL_LOCKED = 'session-14141414-3636-4586-8787-929292929090'
const spillLockedDir = path.join(spillRootA, spillNameOf(SPILL_LOCKED))
writeFile(path.join('sessions', SLUG, SPILL_LOCKED, 'session.v4.jsonl.zstd'), 'spill-locked')
writeFile(path.relative(tempHome, path.join(spillLockedDir, 'locked.txt')), 'locked spill')
host.archive(SPILL_LOCKED)
sessions.push({ header: { id: SPILL_LOCKED } })
const spillHolder = childProcess.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], {
  cwd: spillLockedDir,
  stdio: 'ignore',
})
await new Promise((resolve) => setTimeout(resolve, 700))
const lockedSpillDelete = await remove(SPILL_LOCKED)
check('spill 删不掉也照样算会话删干净', lockedSpillDelete.status === 200, String(lockedSpillDelete.status))
check('并把删不掉的 spill 如实报出来', Array.isArray(lockedSpillDelete.json.spillRemaining) && lockedSpillDelete.json.spillRemaining.some((item) => item.includes(spillLockedDir)), JSON.stringify(lockedSpillDelete.json.spillRemaining))
check('会话日志确实删掉了', !exists(logRelative(SPILL_LOCKED)))
spillHolder.kill()
await new Promise((resolve) => setTimeout(resolve, 400))

// 名字对、但不是真目录（联接）：不顺着删，目标必须活下来。
const SPILL_LINK = 'session-15151515-3737-4597-8787-939393939090'
writeFile(path.join('sessions', SLUG, SPILL_LINK, 'session.v4.jsonl.zstd'), 'spill-link')
host.archive(SPILL_LINK)
sessions.push({ header: { id: SPILL_LINK } })
const linkTargetDir = path.join(tempHome, 'spill-link-target')
fs.mkdirSync(linkTargetDir, { recursive: true })
fs.writeFileSync(path.join(linkTargetDir, 'real.txt'), 'real')
let spillLinkMade = false
try {
  fs.symlinkSync(linkTargetDir, path.join(spillRootA, spillNameOf(SPILL_LINK)), 'junction')
  spillLinkMade = true
} catch (error) {
  spillLinkMade = false
}
if (spillLinkMade) {
  const linkDelete = await remove(SPILL_LINK)
  check('spill 位置是联接时不顺着删', linkDelete.status === 200 && fs.existsSync(path.join(linkTargetDir, 'real.txt')), String(linkDelete.status))
  check('联接目标原样保留', fs.existsSync(linkTargetDir))
} else {
  check('（跳过）本机无法创建联接，跳过 spill 联接分支', true)
}

/* ── 18. 后端自己指认的目录（locate）：并集与安全校验 ──────────────────── */

const LOC = 'session-21212121-7171-4727-8787-999999999091'
const locDir = path.join(tempHome, 'elsewhere', LOC)
fs.mkdirSync(locDir, { recursive: true })
fs.writeFileSync(path.join(locDir, 'session.v4.jsonl.zstd'), 'located-log')
sessions.push({ header: { id: LOC, cwd: 'C:\\elsewhere' } })

const locHome = createContext()
locHome.archive(LOC)
locHome.markLogElsewhere(LOC, path.join(locDir, 'session.v4.jsonl.zstd'))
locHome.services.sessionPersistence.locate = (meta) => (meta && meta.id === LOC
  ? { kind: 'jsonl', path: path.join(locDir, 'session.v4.jsonl.zstd') }
  : undefined)
const locInfo = await plugin.inspectSession(locHome.ctx, LOC)
check('后端指认的目录进了清单', locInfo.info.artifacts.some((item) => item.includes('elsewhere')), JSON.stringify(locInfo.info.artifacts))
check('在会话根之外时如实标注', locInfo.info.artifacts.some((item) => item.includes('elsewhere') && item.includes('会话根之外')), JSON.stringify(locInfo.info.artifacts))
const locDelete = await plugin.deleteSession(locHome.ctx, LOC)
check('后端指认的目录真的被删掉', locDelete.status === 200 && !fs.existsSync(locDir), `${locDelete.status} ${JSON.stringify(locDelete.payload && locDelete.payload.remaining)}`)
check('复核确认没有残留', Array.isArray(locDelete.payload.remaining) === false && locDelete.payload.ok === true)

// 反向：后端指认的路径**基名不是会话 id** 时一律不认（绝不顺着它乱删）。
const BADLOC = 'session-22222222-7272-4727-8787-999999999092'
writeFile(logRelative(BADLOC), 'badloc')
sessions.push({ header: { id: BADLOC } })
const badLocHome = createContext()
badLocHome.archive(BADLOC)
badLocHome.services.sessionPersistence.locate = () => ({ kind: 'jsonl', path: path.join(tempHome, 'storages', 'workspace.json') })
const badLocInfo = await plugin.inspectSession(badLocHome.ctx, BADLOC)
check('基名对不上就不收（清单里没有 storages）', !badLocInfo.info.artifacts.some((item) => item.includes('storages')), JSON.stringify(badLocInfo.info.artifacts))
const badLocDelete = await plugin.deleteSession(badLocHome.ctx, BADLOC)
check('删除照样成功（走我们自己的扫描）', badLocDelete.status === 200, String(badLocDelete.status))
check('工作区登记文件一个字没动', fs.existsSync(path.join(tempHome, 'storages', 'workspace.json')))

/* ── 19. 终端：删会话时关掉它名下的 shell，而且排在注销之前 ────────────── */

const TERM = 'session-23232323-7373-4727-8787-999999999093'
writeFile(logRelative(TERM), 'term')
sessions.push({ header: { id: TERM } })
const termHome = createContext()
termHome.archive(TERM)
termHome.hold(TERM)
termHome.ownTerminal(TERM, 'term-1')
const termDelete = await plugin.deleteSession(termHome.ctx, TERM)
check('删会话时关掉它名下的终端', termDelete.status === 200 && termHome.terminalKills.join() === 'term-1', JSON.stringify(termHome.terminalKills))
check('响应里回报关了几个终端', termDelete.payload.terminalsClosed.join() === 'term-1', JSON.stringify(termDelete.payload.terminalsClosed))
check('关终端排在注销之前（注销后 agents.get 就取不到属主了）',
  termHome.order.indexOf('terminal-kill:term-1') >= 0 && termHome.order.indexOf('agent-detach:' + TERM) < 0
    ? false
    : termHome.order.indexOf('terminal-kill:term-1') < termHome.order.indexOf('session-detach:' + TERM),
  JSON.stringify(termHome.order))

/* ── 20. 血缘取并集：目录投影补出来的子会话也要一起删 ──────────────────── */

const SHAPE = 'session-24242424-7474-4727-8787-999999999094'
const CATONLY = 'feefee00-1111-4222-8333-444444444401'
const CATBAD = 'feefee00-1111-4222-8333-444444444402'
writeFile(logRelative(SHAPE), 'shape')
writeFile(logRelative(CATONLY), 'catalog-only')
writeFile(logRelative(CATBAD), 'catalog-broken')
sessions.push({ header: { id: SHAPE } })
const shapeHome = createContext()
shapeHome.archive(SHAPE)
shapeHome.services.subagents = {
  async listDescendants(root) {
    if (root !== SHAPE) return []
    return [
      { id: CATONLY, parentId: SHAPE, depth: 1, kind: 'child', mode: 'one-shot', activity: 'inactive' },
      { id: CATBAD, parentId: SHAPE, depth: 2, kind: 'diagnostic', reason: 'corrupt' },
    ]
  },
}
const shapeInfo = await plugin.inspectSession(shapeHome.ctx, SHAPE)
check('目录投影补出来的子会话进了删除清单', shapeInfo.info.targets.some((entry) => entry.id === CATONLY), JSON.stringify(shapeInfo.info.targets))
check('读不出目录的分支也点名了', shapeInfo.info.targets.some((entry) => entry.id === CATBAD), JSON.stringify(shapeInfo.info.targets))
check('并提示它下面的分支没数清', shapeInfo.info.warnings.some((line) => line.includes('目录读不出来')), JSON.stringify(shapeInfo.info.warnings))
const shapeDelete = await plugin.deleteSession(shapeHome.ctx, SHAPE)
check('补出来的子会话一起删掉（不留孤儿）', shapeDelete.status === 200 && !exists(logRelative(CATONLY)) && !exists(logRelative(CATBAD)), String(shapeDelete.status))
check('响应里点了它们的名', shapeDelete.payload.deletedIds.includes(CATONLY) && shapeDelete.payload.deletedIds.includes(CATBAD))

/* ── 21. 官方活动瀑布 + 先停后删 ──────────────────────────────────────── */

const BUSY = 'session-25252525-7575-4727-8787-999999999095'
writeFile(logRelative(BUSY), 'busy')
sessions.push({ header: { id: BUSY } })
const busyHome = createContext()
busyHome.archive(BUSY)
busyHome.ctx.waterfall = async (event, arg, next) => {
  if (event !== 'workspace/session-activity') return next()
  if (arg.sessionId === BUSY && busyHome.stopped.length === 0) {
    return [{ kind: 'turn' }, { kind: 'job', items: [{ id: 'j1', label: '构建' }] }]
  }
  return []
}
const busyInfo = await plugin.inspectSession(busyHome.ctx, BUSY)
check('走官方活动瀑布问出"还有工作在跑"', busyInfo.info.busy.total === 1 && busyInfo.info.busy.activityReliable === true, JSON.stringify(busyInfo.info.busy))
check('并报出具体是什么在跑', JSON.stringify(busyInfo.info.busy.sessions[0].labels).includes('构建'), JSON.stringify(busyInfo.info.busy.sessions[0]))
const busyNoStop = await plugin.deleteSession(busyHome.ctx, BUSY)
check('不勾"先停掉" → 409', busyNoStop.status === 409, String(busyNoStop.status))
check('拒删时文件没动', exists(logRelative(BUSY)))
const busyStopped = await plugin.deleteSession(busyHome.ctx, BUSY, { stop: true })
check('勾了"先停掉" → 先派发官方 stop 再删', busyStopped.status === 200 && busyHome.stopped.includes(BUSY), `${busyStopped.status} ${JSON.stringify(busyHome.stopped)}`)
check('响应里回报停过、并列出停的动作', busyStopped.payload.stoppedActivity === true && busyStopped.payload.stopSteps.length > 0)
check('文件也删掉了', !exists(logRelative(BUSY)))

// 停不掉就不删（fail closed）：派发了 stop 但活动依旧。
const STUBBORN = 'session-25858585-8585-4727-8787-9999999990a5'
writeFile(logRelative(STUBBORN), 'stubborn')
sessions.push({ header: { id: STUBBORN } })
const stubbornHome = createContext()
stubbornHome.archive(STUBBORN)
stubbornHome.ctx.waterfall = async (event, arg, next) => (event === 'workspace/session-activity' && arg.sessionId === STUBBORN ? [{ kind: 'turn' }] : next())
const stubbornDelete = await plugin.deleteSession(stubbornHome.ctx, STUBBORN, { stop: true })
check('停不掉就不删（fail closed）', stubbornDelete.status === 409 && exists(logRelative(STUBBORN)), String(stubbornDelete.status))
check('并如实说明还在跑', String(stubbornDelete.payload.error).includes('还在跑'), String(stubbornDelete.payload.error))

/* ── 21.5 活动瀑布抛错：不能退回弱判定当成“没在跑” ────────────────────── */

const BROKEN = 'session-29898989-8989-4727-8787-9999999990b5'
writeFile(logRelative(BROKEN), 'broken')
sessions.push({ header: { id: BROKEN } })
const brokenHome = createContext()
brokenHome.archive(BROKEN)
brokenHome.ctx.waterfall = async () => { throw new Error('activity exploded') }
const brokenInfo = await plugin.inspectSession(brokenHome.ctx, BROKEN)
check('瀑布抛错时查询就明确不可删', brokenInfo.info.deletable === false && String(brokenInfo.info.blocking).includes('活动状态'), JSON.stringify(brokenInfo.info.blocking))
const brokenDelete = await plugin.deleteSession(brokenHome.ctx, BROKEN)
check('瀑布抛错时拒删且文件没动', brokenDelete.status === 409 && exists(logRelative(BROKEN)), `${brokenDelete.status} ${JSON.stringify(brokenDelete.payload && brokenDelete.payload.error)}`)
delete brokenHome.ctx.waterfall
const brokenRetry = await plugin.deleteSession(brokenHome.ctx, BROKEN)
check('瀑布恢复后可以正常删', brokenRetry.status === 200 && !exists(logRelative(BROKEN)), String(brokenRetry.status))

/* ── 22. 可选连带删除派生会话（fork）──────────────────────────────────── */

const FROOT = 'session-26262626-7676-4727-8787-999999999096'
const FKID = 'session-27272727-7777-4727-8787-999999999097'
const FSUB = 'feefee00-1111-4222-8333-444444444403'
writeFile(logRelative(FROOT), 'root')
writeFile(logRelative(FKID), 'fork')
writeFile(logRelative(FSUB), 'fork-sub')
sessions.push(
  { header: { id: FROOT } },
  { header: { id: FKID, parentSession: FROOT } },
  { header: { id: FSUB, parentSession: FKID, origin: 'subagent' } },
)

const forkHome = createContext()
forkHome.archive(FROOT)
forkHome.archive(FKID)
const forkInfo = await plugin.inspectSession(forkHome.ctx, FROOT)
check('派生会话列成可选项', forkInfo.info.optionalForks.length === 1 && forkInfo.info.optionalForks[0].id === FKID, JSON.stringify(forkInfo.info.optionalForks))
check('可选项带归档状态与标题', forkInfo.info.optionalForks[0].archived === true && forkInfo.info.optionalForks[0].title.length > 0)
check('默认清单里不含派生会话（默认保留）', !forkInfo.info.targets.some((entry) => entry.id === FKID))

const bogus = await plugin.deleteSession(forkHome.ctx, FROOT, { extraRoots: ['session-28282828-7878-4727-8787-999999999098'] })
check('乱报的派生会话 id → 400 且什么都不删', bogus.status === 400 && exists(logRelative(FROOT)), String(bogus.status))

const notArchFork = createContext()
notArchFork.archive(FROOT)
const notArchForkDelete = await plugin.deleteSession(notArchFork.ctx, FROOT, { extraRoots: [FKID] })
check('未归档的派生会话 → 409（同一条规则）', notArchForkDelete.status === 409, String(notArchForkDelete.status))
check('并且什么都没删', exists(logRelative(FROOT)) && exists(logRelative(FKID)))

const forkDelete = await plugin.deleteSession(forkHome.ctx, FROOT, { extraRoots: [FKID] })
check('勾选后连派生会话与它的子会话一起删掉', forkDelete.status === 200 && !exists(logRelative(FROOT)) && !exists(logRelative(FKID)) && !exists(logRelative(FSUB)), `${forkDelete.status} ${forkDelete.payload && forkDelete.payload.error}`)
check('响应里列出连带删除的派生会话', forkDelete.payload.extraRoots.join() === FKID, JSON.stringify(forkDelete.payload.extraRoots))
check('deletedIds 含派生会话与它的子会话', forkDelete.payload.deletedIds.includes(FKID) && forkDelete.payload.deletedIds.includes(FSUB))

/* ── 22.5 目标重叠的并发删除：父会话要连带的子会话正被另一次删除占着 ─────── */

const OVROOT = 'session-31313131-3131-4131-8131-313131313131'
const OVCHILD = 'session-32323232-3232-4232-8232-323232323232'
writeFile(logRelative(OVROOT), 'overlap-root')
writeFile(logRelative(OVCHILD), 'overlap-child')
sessions.push(
  { header: { id: OVROOT } },
  { header: { id: OVCHILD, parentSession: OVROOT, origin: 'subagent' } },
)
const overlapHome = createContext()
overlapHome.archive(OVROOT)
overlapHome.archive(OVCHILD)

let releaseChild
const childGate = new Promise((resolve) => { releaseChild = resolve })
const overlapReadTitle = overlapHome.services.sessionQuery.readTitle
overlapHome.services.sessionQuery.readTitle = async (id) => {
  if (id === OVCHILD) await childGate
  return overlapReadTitle(id)
}

// 子会话的删除先占住自己，再卡在读标题上；父会话此时进场，目标集合里包含它。
const overlapChildDelete = plugin.deleteSession(overlapHome.ctx, OVCHILD)
const parentBlocked = await plugin.deleteSession(overlapHome.ctx, OVROOT)
check('父会话连带的目标正被另一次删除占用 → 409', parentBlocked.status === 409, String(parentBlocked.status))
check('并说明是哪一个会话在删', String(parentBlocked.payload && parentBlocked.payload.error).includes(OVCHILD), String(parentBlocked.payload && parentBlocked.payload.error))
check('被拒的父会话一个文件都没动', exists(logRelative(OVROOT)) && exists(logRelative(OVCHILD)))

releaseChild()
const childResult = await overlapChildDelete
check('被占用的子会话自己照常删完', childResult.status === 200, String(childResult.status))
check('子会话日志已删', !exists(logRelative(OVCHILD)))

const parentRetry = await plugin.deleteSession(overlapHome.ctx, OVROOT)
check('占用释放后父会话可以删', parentRetry.status === 200 && !exists(logRelative(OVROOT)), String(parentRetry.status))

/* ── 23. 超过一次删除上限：拒删，而不是静默截断留孤儿 ───────────────────── */

const MANY = 'session-30303030-3030-4030-8030-303030303030'
const manyChild = (index) => `session-${String(index + 1).padStart(8, '0')}-3030-4030-8030-303030303030`
sessions.push({ header: { id: MANY } })
writeFile(logRelative(MANY), 'many')
for (let index = 0; index < 201; index += 1) {
  const id = manyChild(index)
  sessions.push({ header: { id, parentSession: MANY, origin: 'subagent' } })
  writeFile(logRelative(id), 'x')
}
const manyHome = createContext()
manyHome.archive(MANY)
const manyInfo = await plugin.inspectSession(manyHome.ctx, MANY)
check('超过上限时标记 truncated', manyInfo.info.truncated === true, String(manyInfo.info.targets.length))
check('超过上限时不可删（不静默截断）', manyInfo.info.deletable === false, String(manyInfo.info.blocking))
check('并说明超限、要分批删', String(manyInfo.info.blocking).includes('上限'), String(manyInfo.info.blocking))
check('清单仍如实只列前 200 个', manyInfo.info.targets.length === 200, String(manyInfo.info.targets.length))
const manyDelete = await plugin.deleteSession(manyHome.ctx, MANY)
check('直接提交删除也拒（409）', manyDelete.status === 409, String(manyDelete.status))
check('拒删时父会话日志没动', exists(logRelative(MANY)))

/* ── 23.5 列表读不到 / 输入超限 / 战果与逐项失败 / 非法派生 id ─────── */

// 列表读不到时不能把"空"当成"没有子会话"：查要拦住，删也要拦住，文件不动。
const LISTFAIL = 'session-41414141-4141-4141-8141-414141414141'
writeFile(logRelative(LISTFAIL), 'listfail')
sessions.push({ header: { id: LISTFAIL } })
const listFailHome = createContext()
listFailHome.archive(LISTFAIL)
listFailHome.services.sessionPersistence.list = async () => { throw new Error('list exploded') }
const listFailInfo = await plugin.inspectSession(listFailHome.ctx, LISTFAIL)
check('会话列表读不到时查询不可删', listFailInfo.info.deletable === false, String(listFailInfo.info.blocking))
check('并如实标记列表不可读', listFailInfo.info.listReadable === false)
check('并说明原因', String(listFailInfo.info.blocking).includes('读不到会话列表'), String(listFailInfo.info.blocking))
// 列表读不到时也不能把"找不到"当成"已消失"：那会掩盖"可能还有子会话没枚举"。
const listFailMissing = await plugin.inspectSession(listFailHome.ctx, MISSING)
check('列表读不到时未知会话不判为已消失',
  listFailMissing.info.absent === false && listFailMissing.info.listReadable === false,
  String(listFailMissing.info.blocking))
const listFailDelete = await plugin.deleteSession(listFailHome.ctx, LISTFAIL)
check('列表读不到时删除也拒（409）', listFailDelete.status === 409, String(listFailDelete.status))
check('拒删时日志没动', exists(logRelative(LISTFAIL)))

// 注销之后列表掉线：不能继续删文件，必须停下来并报"无法确认"。
const AFTERFORGET = 'session-42424242-4242-4242-8242-424242424242'
writeFile(logRelative(AFTERFORGET), 'after-forget')
sessions.push({ header: { id: AFTERFORGET } })
const afterForgetHome = createContext()
afterForgetHome.archive(AFTERFORGET)
afterForgetHome.hold(AFTERFORGET)
const baseList = afterForgetHome.services.sessionPersistence.list
const baseDetach = afterForgetHome.services.sessions.detachEntered
let listGone = false
afterForgetHome.services.sessionPersistence.list = async () => {
  if (listGone) throw new Error('list gone after forget')
  return baseList()
}
afterForgetHome.services.sessions.detachEntered = (entry) => {
  baseDetach(entry)
  listGone = true
}
const afterForgetDelete = await plugin.deleteSession(afterForgetHome.ctx, AFTERFORGET)
check('注销后列表读不到时拒删（409）', afterForgetDelete.status === 409, String(afterForgetDelete.status))
check('并说明是注销后读不到列表', String(afterForgetDelete.payload.error).includes('注销后读不到会话列表'), String(afterForgetDelete.payload.error))
check('这一步也不动日志', exists(logRelative(AFTERFORGET)))

// 客户端传来的清单形状不对、或超过上限：明确 400，绝不静默丢弃。
const INPUT = 'session-43434343-4343-4343-8343-434343434343'
writeFile(logRelative(INPUT), 'input-guard')
sessions.push({ header: { id: INPUT } })
const inputHome = createContext()
inputHome.archive(INPUT)
const post = (body) => invoke('POST', { body: JSON.stringify(body) })
const inputBase = { id: INPUT, confirm: plugin.CONFIRM_TOKEN }
const ghostId = (index) => `session-${String(index).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`
const tooManyGhosts = Array.from({ length: 201 }, (_, index) => ghostId(index + 1))

const nonArrayDangling = await post({ ...inputBase, dangling: 'not-an-array' })
check('悬空引用不是数组 → 400', nonArrayDangling.status === 400, String(nonArrayDangling.status))
check('并说明清单必须是数组', String(nonArrayDangling.json.error).includes('数组'), String(nonArrayDangling.json.error))
const badDangling = await post({ ...inputBase, dangling: ['../../etc/passwd'] })
check('悬空引用含非法 id → 400', badDangling.status === 400, String(badDangling.status))
const tooManyDangling = await post({ ...inputBase, dangling: tooManyGhosts })
check('悬空引用超过上限 → 400', tooManyDangling.status === 400, String(tooManyDangling.status))
check('并说明一次最多处理多少条', String(tooManyDangling.json.error).includes('200'), String(tooManyDangling.json.error))
const nonArrayExtra = await post({ ...inputBase, extraRoots: 'not-an-array' })
check('派生会话清单不是数组 → 400', nonArrayExtra.status === 400, String(nonArrayExtra.status))
const tooManyExtra = await post({ ...inputBase, extraRoots: tooManyGhosts })
check('派生会话超过上限 → 400', tooManyExtra.status === 400, String(tooManyExtra.status))
const badExtra = await post({ ...inputBase, extraRoots: ['../../etc/passwd'] })
check('派生会话含非法 id → 400', badExtra.status === 400, String(badExtra.status))
check('这些 400 全都没动日志', exists(logRelative(INPUT)))

// 没真的剪掉任何引用时，战果必须报 0（不能按传入条数虚报）。
const GHOSTREF = 'session-44444444-4444-4444-8444-444444444444'
const VISIBLE = 'session-45454545-4545-4545-8454-545454545454'
writeFile(logRelative(VISIBLE), 'visible')
sessions.push({ header: { id: VISIBLE } })
const ghostHome = createContext()
ghostHome.record.sessionIds = [GHOSTREF, VISIBLE]
ghostHome.globalRecord.archivedSessionIds = []
ghostHome.globalRecord.pinnedSessionIds = []
ghostHome.services.workspaceRegistry.get = () => undefined
const ghostRepair = await plugin.sweepDanglingReferences(ghostHome.ctx)
check('没有实际改动时清扫战果为 0', ghostRepair.swept === 0, String(ghostRepair.swept))
check('没有实际改动时引用原样保留', ghostHome.record.sessionIds.includes(GHOSTREF), JSON.stringify(ghostHome.record.sessionIds))
check('并说明那条引用没有动', ghostRepair.steps.some((line) => line.includes('没有动')), JSON.stringify(ghostRepair.steps))

// 同一工作区里一条移出失败，不能拖累后面几条（逐 id try）。
const DETACH1 = 'session-46464646-4646-4646-8464-646464646464'
const DETACH2 = 'session-47474747-4747-4747-8474-747474747474'
const detachHome = createContext()
const detachSeen = []
detachHome.services.workspaceRegistry.get = () => ({
  id: 'ws-1',
  title: '逐项测试',
  async detachSession(id) {
    detachSeen.push(id)
    if (id === DETACH1) throw new Error('first one blocked')
  },
})
const detachSteps = await plugin.pruneResidualReferences(detachHome.ctx, [DETACH1, DETACH2], {
  workspaces: ['ws-1'], archived: [], pinned: [],
})
check('一条移出失败后仍继续处理后面的 id', detachSeen.join() === [DETACH1, DETACH2].join(), JSON.stringify(detachSeen))
check('失败被如实记进步骤', detachSteps.some((line) => line.includes(DETACH1) && line.includes('失败')), JSON.stringify(detachSteps))
check('成功的移出也有记录', detachSteps.some((line) => line.includes('移出工作区')), JSON.stringify(detachSteps))

// 派生会话 id 形状不合法：拒绝删除，绝不把来源不明的 id 拼进路径。
const BADROOT = 'session-48484848-4848-4848-8484-848484848484'
const BADCHILD = 'not-a-session-id'
writeFile(logRelative(BADROOT), 'badroot')
writeFile(logRelative(BADCHILD), 'badchild')
sessions.push(
  { header: { id: BADROOT } },
  { header: { id: BADCHILD, parentSession: BADROOT, origin: 'subagent' } },
)
const badHome = createContext()
badHome.archive(BADROOT)
const badInfo = await plugin.inspectSession(badHome.ctx, BADROOT)
check('派生 id 形状不合法时查询不可删', badInfo.info.deletable === false, String(badInfo.info.blocking))
check('并点名那个非法 id', badInfo.info.invalidRelatives.includes(BADCHILD), JSON.stringify(badInfo.info.invalidRelatives))
check('并说明原因', String(badInfo.info.blocking).includes('形状不合法'), String(badInfo.info.blocking))
const badDelete = await plugin.deleteSession(badHome.ctx, BADROOT)
check('非法派生 id 时删除 409', badDelete.status === 409, String(badDelete.status))
check('拒删时父会话日志没动', exists(logRelative(BADROOT)))

// 勾选的派生会话挂在另一个工作区：它的归属也必须一起摘掉。
const OWNROOT = 'session-49494949-4949-4949-8494-949494949494'
const OWNFORK = 'session-50505050-5050-4050-8050-505050505050'
writeFile(logRelative(OWNROOT), 'own-root')
writeFile(logRelative(OWNFORK), 'own-fork')
sessions.push(
  { header: { id: OWNROOT } },
  { header: { id: OWNFORK, parentSession: OWNROOT } },
)
const ownHome = createContext()
ownHome.archive(OWNROOT)
ownHome.archive(OWNFORK)
ownHome.record.sessionIds = [OWNROOT]
const ownForkRecord = { id: 'ws-2', title: 'other-workspace', sessionIds: [OWNFORK] }
const ownDetaches = []
const ownEntity = (id, record) => ({
  id,
  title: record.title,
  sessionIds: record.sessionIds,
  async detachSession(sessionId) {
    ownDetaches.push(`${id}:${sessionId}`)
    record.sessionIds = record.sessionIds.filter((value) => value !== sessionId)
  },
})
const ownWs1 = ownEntity('ws-1', ownHome.record)
const ownWs2 = ownEntity('ws-2', ownForkRecord)
ownHome.services.workspaceRegistry.list = () => [ownWs1, ownWs2]
ownHome.services.workspaceRegistry.get = (id) => (id === 'ws-2' ? ownWs2 : ownWs1)
const ownDelete = await plugin.deleteSession(ownHome.ctx, OWNROOT, { extraRoots: [OWNFORK] })
check('连带删除另一个工作区的派生会话 → 200', ownDelete.status === 200, `${ownDelete.status} ${ownDelete.payload && ownDelete.payload.error}`)
check('根会话的归属被摘掉', ownDetaches.includes(`ws-1:${OWNROOT}`), JSON.stringify(ownDetaches))
check('派生会话的另一个工作区归属也被摘掉', ownDetaches.includes(`ws-2:${OWNFORK}`), JSON.stringify(ownDetaches))
check('两个工作区的成员都清干净', !ownHome.record.sessionIds.includes(OWNROOT) && !ownForkRecord.sessionIds.includes(OWNFORK), JSON.stringify([ownHome.record.sessionIds, ownForkRecord.sessionIds]))

/* ── 24. 磁盘故障、登记和清单变化 ──────────────────────────────────────── */

const SAFE_DISK = 'session-51515151-5151-4151-8151-515151515151'
const safeCache = writeFile(cacheRelative(SAFE_DISK), 'projection')
writeFile(logRelative(SAFE_DISK), 'transcript')
sessions.push({ header: { id: SAFE_DISK } })
const diskHome = createContext()
diskHome.archive(SAFE_DISK)
diskHome.record.sessionIds = [SAFE_DISK]
const originalRm = fsp.rm
try {
  fsp.rm = async (file, options) => {
    if (file === safeCache) throw Object.assign(new Error('cache is locked'), { code: 'EACCES' })
    return originalRm(file, options)
  }
  const result = await plugin.deleteSession(diskHome.ctx, SAFE_DISK)
  check('投影缓存删除失败时保留对话日志和登记', result.status === 500
    && exists(logRelative(SAFE_DISK)) && fs.existsSync(safeCache) && diskHome.record.sessionIds.includes(SAFE_DISK))
} finally {
  fsp.rm = originalRm
}

const originalReadDir = fs.readdirSync
try {
  fs.readdirSync = (dir, options) => {
    if (dir === plugin.PROJECTION_ROOT) throw Object.assign(new Error('projection directory is inaccessible'), { code: 'EACCES' })
    return originalReadDir(dir, options)
  }
  const result = await plugin.deleteSession(diskHome.ctx, SAFE_DISK)
  check('缓存目录读失败时保留日志、缓存和登记', result.status === 500
    && exists(logRelative(SAFE_DISK)) && fs.existsSync(safeCache) && diskHome.record.sessionIds.includes(SAFE_DISK))
} finally {
  fs.readdirSync = originalReadDir
}

const UNKNOWN = 'session-52525252-5252-4252-8252-525252525252'
const unknownHome = createContext()
unknownHome.hold(UNKNOWN)
unknownHome.record.sessionIds = [UNKNOWN]
unknownHome.globalRecord.archivedSessionIds = [UNKNOWN]
const getAgent = unknownHome.services.agents.get
unknownHome.services.agents.get = (id) => {
  if (id === UNKNOWN) throw new Error('agent state unavailable')
  return getAgent(id)
}
const unknownSweep = await plugin.sweepDanglingReferences(unknownHome.ctx)
check('存活状态查询失败时保留会话登记', unknownSweep.swept === 0
  && unknownHome.record.sessionIds.includes(UNKNOWN) && unknownHome.globalRecord.archivedSessionIds.includes(UNKNOWN))

const SCOPE = 'session-53535353-5353-4353-8353-535353535353'
const SCOPE_FORK = 'session-54545454-5454-4454-8454-545454545454'
const SCOPE_CHILD = '55515151-5151-4151-8151-515151515151'
for (const id of [SCOPE, SCOPE_FORK]) writeFile(logRelative(id), 'transcript')
sessions.push({ header: { id: SCOPE } }, { header: { id: SCOPE_FORK, parentSession: SCOPE } })
const scopeHome = createContext()
scopeHome.archive(SCOPE)
scopeHome.archive(SCOPE_FORK)
const selected = { ctx: scopeHome.ctx, extraRoots: [SCOPE_FORK] }
const scopePreview = (await inspect(SCOPE, selected)).json.session
check('勾选 fork 后预览包含其会话、文件与登记', scopePreview.targets.some(({ id }) => id === SCOPE_FORK)
  && scopePreview.artifacts.some((file) => file.includes(SCOPE_FORK)) && scopePreview.registryTargets.some(({ id }) => id === SCOPE_FORK))

writeFile(logRelative(SCOPE_CHILD), 'new child')
sessions.push({ header: { id: SCOPE_CHILD, parentSession: SCOPE_FORK, origin: 'subagent' } })
const stale = await remove(SCOPE, { ...selected, preview: scopePreview.preview })
check('新增子代理时旧清单退回重新确认', stale.status === 409 && stale.json.code === 'PREVIEW_CHANGED'
  && [SCOPE, SCOPE_FORK, SCOPE_CHILD].every((id) => exists(logRelative(id))))
const noPreview = await invoke('POST', { ctx: scopeHome.ctx, body: JSON.stringify({ id: SCOPE, confirm: plugin.CONFIRM_TOKEN }) })
check('旧客户端缺少清单版本时无法删除', noPreview.status === 409 && noPreview.json.code === 'PREVIEW_CHANGED')

const updatedScope = (await inspect(SCOPE, selected)).json.session
let activityChecks = 0
scopeHome.ctx.waterfall = async (event, input, next) => {
  if (input.sessionId === SCOPE && ++activityChecks === 2) {
    scopeHome.globalRecord.archivedSessionIds = [SCOPE]
  }
  return next()
}
const restoredFork = await remove(SCOPE, { ...selected, preview: updatedScope.preview })
check('最终检查时拒删刚取消归档的 fork', restoredFork.status === 409
  && String(restoredFork.json.error).includes(SCOPE_FORK)
  && [SCOPE, SCOPE_FORK, SCOPE_CHILD].every((id) => exists(logRelative(id))))

delete scopeHome.ctx.waterfall
scopeHome.archive(SCOPE_FORK)
const confirmedScope = await remove(SCOPE, selected)
check('重新确认后可以删除完整范围', confirmedScope.status === 200
  && [SCOPE, SCOPE_FORK, SCOPE_CHILD].every((id) => !exists(logRelative(id))))

/* ── 25. 批量选中独立会话、预览变化与部分成功 ───────────────────────────── */

const BATCH_FIRST = 'session-56565656-5656-4656-8656-565656565656'
const BATCH_SECOND = 'session-57575757-5757-4757-8757-575757575757'
const BATCH_CHILD = '58585858-5858-4858-8858-585858585858'
const BATCH_GRANDCHILD = '59595959-5959-4959-8959-595959595959'
const BATCH_FORK = 'session-60606060-6060-4060-8060-606060606060'
const batchRoots = [BATCH_FIRST, BATCH_SECOND]
const batchTargets = [...batchRoots, BATCH_CHILD, BATCH_GRANDCHILD]
for (const id of [...batchTargets, BATCH_FORK]) writeFile(logRelative(id), 'batch transcript')
sessions.push(
  { header: { id: BATCH_FIRST } },
  { header: { id: BATCH_SECOND } },
  { header: { id: BATCH_CHILD, parentSession: BATCH_SECOND, origin: 'subagent' } },
  { header: { id: BATCH_GRANDCHILD, parentSession: BATCH_CHILD, origin: 'subagent' } },
  { header: { id: BATCH_FORK, parentSession: BATCH_FIRST } },
)
const batchHome = createContext()
batchHome.globalRecord.archivedSessionIds = []
for (const id of [BATCH_FIRST, BATCH_SECOND, BATCH_FORK, BATCH_CHILD]) batchHome.archive(id)
batchHome.record.sessionIds = [BATCH_FIRST, BATCH_SECOND, BATCH_FORK]
const batchPost = (body) => invoke('POST', { ctx: batchHome.ctx, body: JSON.stringify(body) })
const previewBatch = (ids) => batchPost({ action: 'preview-batch', ids })
const deleteBatch = (ids, preview) => batchPost({ action: 'delete-batch', ids, preview, confirm: plugin.CONFIRM_TOKEN })
const candidates = await invoke('GET', { ctx: batchHome.ctx, url: `${plugin.ROUTE}?batch=candidates` })
check('批量候选只列已归档的可见会话并带工作区名称', candidates.status === 200
  && candidates.json.candidates.map(({ id }) => id).join() === [...batchRoots, BATCH_FORK].join()
  && candidates.json.candidates.every((row) => row.workspaces[0]?.title === batchHome.record.title), JSON.stringify(candidates))
const batchPreview = (await previewBatch([BATCH_SECOND, BATCH_FIRST, BATCH_FIRST])).json.batch
check('批量预览对根去重、包含多层子代理且保留未选 fork', batchPreview.deletable
  && batchPreview.roots.map(({ id }) => id).join() === batchRoots.join()
  && batchPreview.subagents === 2 && batchPreview.targets.length === 4
  && !batchPreview.targets.some(({ id }) => id === BATCH_FORK)
  && batchTargets.every((id) => exists(logRelative(id))))
check('批量接口校验会话 id、确认和上限', (await previewBatch(['../../outside'])).status === 400
  && (await previewBatch(tooManyGhosts)).status === 400
  && (await batchPost({ action: 'delete-batch', ids: batchRoots, preview: batchPreview.preview })).status === 400)
const crossBatch = await invoke('POST', {
  ctx: batchHome.ctx,
  headers: { host: '127.0.0.1:19387', origin: 'https://other.example' },
  body: JSON.stringify({ action: 'delete-batch', ids: batchRoots, preview: batchPreview.preview, confirm: plugin.CONFIRM_TOKEN }),
})
check('批量接口拒绝跨站请求', crossBatch.status === 403)
const expandedBatch = await deleteBatch([...batchRoots, BATCH_FORK], batchPreview.preview)
check('扩大选择范围后不能复用旧清单', expandedBatch.status === 409
  && expandedBatch.json.code === 'PREVIEW_CHANGED' && exists(logRelative(BATCH_FORK)))
batchHome.globalRecord.archivedSessionIds = batchHome.globalRecord.archivedSessionIds.filter((id) => id !== BATCH_SECOND)
const blockedBatch = await deleteBatch(batchRoots, batchPreview.preview)
check('批量中取消归档一项会挡住整批并点名', blockedBatch.status === 409
  && blockedBatch.json.session.roots.some((root) => root.id === BATCH_SECOND && root.blocking)
  && batchTargets.every((id) => exists(logRelative(id))))
batchHome.archive(BATCH_SECOND)

const lockedDirectory = path.dirname(path.join(tempHome, logRelative(BATCH_GRANDCHILD)))
let partialBatch
try {
  fsp.rm = async (file, options) => {
    if (file === lockedDirectory) throw Object.assign(new Error('batch child is locked'), { code: 'EACCES' })
    return originalRm(file, options)
  }
  partialBatch = await deleteBatch(batchRoots, batchPreview.preview)
} finally {
  fsp.rm = originalRm
}
check('一项失败时只回报完整删净的会话', partialBatch.status === 500
  && partialBatch.json.deletedIds.join() === BATCH_FIRST
  && partialBatch.json.rootResults.some((row) => row.id === BATCH_SECOND && row.status === 'incomplete' && row.error.includes('locked'))
  && !batchHome.record.sessionIds.includes(BATCH_FIRST) && batchHome.record.sessionIds.includes(BATCH_SECOND))
check('子代理删除失败时保留父链供重试', [BATCH_SECOND, BATCH_CHILD, BATCH_GRANDCHILD].every((id) => exists(logRelative(id))))
const retryBatch = (await previewBatch([BATCH_SECOND])).json.batch
const retriedBatch = await deleteBatch([BATCH_SECOND], retryBatch.preview)
check('可以只重试未完成项，且不触碰未选 fork', retriedBatch.status === 200
  && retriedBatch.json.rootResults[0].status === 'deleted'
  && [BATCH_SECOND, BATCH_CHILD, BATCH_GRANDCHILD].every((id) => !exists(logRelative(id)))
  && exists(logRelative(BATCH_FORK)))

/* ── 25. 卸载 ──────────────────────────────────────────────────────────── */

let disposeErrors = 0
for (let index = disposers.length - 1; index >= 0; index -= 1) {
  try {
    const nested = disposers[index]()
    if (typeof nested === 'function') nested()
  } catch (error) {
    disposeErrors += 1
  }
}
check('卸载无异常', disposeErrors === 0, `errors=${disposeErrors}`)
check('卸载释放路由', routeDisposals === 1, String(routeDisposals))

/* ── 汇总与清理（临时目录由 process.on('exit') 兜底清掉）───────────────── */

let failed = 0
for (const item of checks) {
  if (!item.ok) failed += 1
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.detail ? `  (${item.detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
if (failed > 0) process.exitCode = 1
