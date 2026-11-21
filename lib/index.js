/**
 * dsh-session-manager-delete —— 宿主半区（Host half）。
 *
 * 只有两件事：
 *   1. 查：一个会话现在能不能删（**归档了吗**、在跑吗、占多大、会删掉哪些文件、会注销什么）；
 *   2. 删：确认标记正确、所有安全闸门都通过之后，
 *      **先把会话从宿主内存里注销（让宿主忘掉它）**，再删磁盘痕迹，最后摘工作区登记。
 *
 * 浏览器半区没有文件系统权限，所以两边只通过一条同源路由对话：
 *   GET  /dsh-session-manager-delete/api?id=<sessionId>     查（**真正无副作用**，可随便调）
 *   POST /dsh-session-manager-delete/api {id, confirm, dangling?}
 *                                                    删（confirm 必须等于 CONFIRM_TOKEN）
 *
 * **GET 一定不改任何东西**：历史遗留悬空引用的清理不再挂在"打开对话框"上，
 * 而是变成"查的时候预览、删的时候按预览列表执行"（见下面的 dangling）。
 * 查一次就动一次注册表，会让"我只是看一眼"变成一次没人确认过的写入。
 *
 * 一个会话在磁盘上只有两处痕迹（已核实）：
 *   · $DSH_HOME/sessions/<工作区 slug>/<会话 id>/session.v4.jsonl.zstd   对话日志本体
 *   · $DSH_HOME/storages/session_projcache/sessions/<会话 id>.json       投影缓存（可从日志重建）
 * 附件是内容寻址、跨会话共享的，不属于任何单个会话，所以绝不碰（见 README「不删什么」）。
 *
 * 删除要清的是**四层**痕迹：
 *   1. 宿主内存：`ctx.sessions` 与 `ctx.agents` 两张进程内注册表里的条目
 *      （不注销掉它们，删完磁盘它照样出现在侧栏里 —— 见 forgetSessions）；
 *   2. 磁盘：日志目录 + 投影缓存（+ 删空之后那个空的工作区 slug 目录）+ 临时目录里的 spill；
 *   3. 宿主登记：workspace.json 里的引用（官方接口 + 持久化记录复核）；
 *   4. 浏览器本地状态：由浏览器半区按本模块返回的 `targets` / `deletedIds` 精确清理 ——
 *      宿主看不到 localStorage，所以这里只负责"如实告诉前端到底删了哪几个 id"。
 *
 * 设计原则（对应"简洁、可读、无 bug、无兼容性问题"）：
 *   1. **安全闸门全在宿主侧**：客户端传来的 confirm 标记只防误触，真正的判断在这里做。
 *   2. **不猜状态**：能不能删、是不是在跑、归档没有，一律问官方服务（sessionPersistence /
 *      agents / sessions / jobs / workspaceRegistry / storageDomain）；只有"删文件"没有服务
 *      接口，才自己动手。查不到存活状态就**拒删**（fail closed），绝不当成"没在跑"。
 *   3. **只删自己确认过的东西**：路径必须位于受管目录之内、是真目录（不是软链/联接），
 *      解析真实位置后仍在根内；删完还复核一遍，还剩东西就如实报失败。
 *   4. **不留下看不见的孤儿**：子代理会话（origin: 'subagent'）在侧栏里不可见，
 *      删父会话时一并删掉；fork 出来的可见会话保留（连同它自己的子代理会话）。
 *      工作区登记只在**确认删干净**之后才摘 —— 否则失败会变成没有入口可重试的孤儿。
 *   5. **可选服务缺席不致命**：ctx.get 拿不到就少一条信息，绝不抛。
 *   6. **所删即所告**：查出来的清单就是删的清单 —— 删之前把"要删哪几个会话 id、
 *      动哪几个工作区登记、剪哪几条悬空引用"全列出来，删除时只按这份清单动手。
 *      GET 不产生任何写入，所以"看一眼"永远不会变成一次没人确认过的改动。
 *   7. **对其他会话零影响**：所有写入都按 id 精确过滤（登记只摘目标 id，
 *      其他 id、其他字段、其他记录一字不动），删完还要复核别的会话没被牵连。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/* ── 受管位置 ──────────────────────────────────────────────────────────── */

/** DSH_HOME 与其下两块真正属于"某个会话"的位置。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
/** 会话日志：$DSH_HOME/sessions/<工作区 slug>/<会话 id>/ */
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')
/** 投影缓存：$DSH_HOME/storages/session_projcache/sessions/<会话 id>.json */
const PROJECTION_ROOT = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')

/* ── 受管位置：临时目录里的工具输出溢出（spill）────────────────────────── */

/**
 * 一个会话在磁盘上还有**第三处**痕迹，不在 DSH_HOME 下：工具输出的溢出文件。
 *
 *   <系统临时目录>/dsh-spill-<6 位随机>/session-<sha256(会话 id)[0:12]>/<随机名>-<名字>
 *
 * 目录名是会话 id 的 sha256 前缀（spill-local 的 `sessionDir()`：不带盐、可计算），
 * 所以"这个会话的溢出文件"可以精确指认。而官方的清理**只按文件年龄**回收
 * （`cleanupPeriodDays`，默认 30 天），会话删掉之后它就留在临时目录里 ——
 * 对"删了就一点不剩"来说，这是真正的残留。
 *
 * 判定用官方自己写死的那两条形状正则，再叠上三条更紧的：
 *   · 根名必须正好是 `dsh-spill-` + 6 位（官方 `DEFAULT_ROOT_RE`，不模糊匹配）；
 *   · 会话目录名必须正好等于**目标会话算出来的那一个**（`session-` + 12 位小写十六进制）；
 *   · lstat 必须是真的目录（软链一律不碰），且只删目标会话自己的那一个目录 ——
 *     spill 根本身留给官方启动清扫去收。
 */
const SPILL_ROOT_PATTERN = /^dsh-spill-[A-Za-z0-9]{6}$/
const SPILL_SESSION_PATTERN = /^session-[0-9a-f]{12}$/

/** 会话在 spill 根里的目录名（与 spill-local 的 `sessionDir()` 逐字一致）。 */
function spillSessionName(sessionId) {
  return `session-${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`
}

/** 目标会话在系统临时目录里的 spill 目录（绝对路径，去重、保序）。 */
function spillDirsFor(targets) {
  const found = []
  const wanted = new Set(targets.map((id) => spillSessionName(id)))
  let base = ''
  try {
    base = os.tmpdir()
  } catch (error) {
    return found
  }
  if (!base) return found

  let roots
  try {
    roots = fs.readdirSync(base, { withFileTypes: true })
  } catch (error) {
    return found
  }
  for (const root of roots) {
    if (!root.isDirectory() || !SPILL_ROOT_PATTERN.test(root.name)) continue
    const rootPath = path.join(base, root.name)
    let children
    try {
      children = fs.readdirSync(rootPath, { withFileTypes: true })
    } catch (error) {
      continue
    }
    for (const child of children) {
      if (!SPILL_SESSION_PATTERN.test(child.name) || !wanted.has(child.name)) continue
      const dir = path.join(rootPath, child.name)
      try {
        const stats = fs.lstatSync(dir)
        if (!stats.isDirectory() || stats.isSymbolicLink()) continue
      } catch (error) {
        continue
      }
      found.push(dir)
    }
  }
  return found
}

/** spill 目录不在 DSH_HOME 下：展示时直接给绝对路径，并说清这是什么。 */
function displaySpill(absolute) {
  return `${absolute}（工具输出溢出临时目录）`
}

/* ── 对外契约 ──────────────────────────────────────────────────────────── */

const ROUTE = '/dsh-session-manager-delete/api'
/** 删除请求必须携带的确认标记：把"点错了"和"真要删"分开。 */
const CONFIRM_TOKEN = 'delete-session'

/**
 * 会话 id 形状：`<uuid>`（子代理会话）或 `session-<uuid>`（根会话）。
 *
 * 只收**小写**十六进制：文件系统大小写不敏感（Windows / macOS），而登记表里的比较是精确的，
 * 放进来一个大小写变体就会出现"文件删掉了、登记引用还在"的鬼状态，所以直接在入口拒掉。
 * 这条正则同时是路径闸门的第一道：斜杠、`..`、盘符、空格一律进不来。
 */
const SESSION_ID_PATTERN = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const MAX_BODY_BYTES = 1 << 16
/** 一次最多剪多少条悬空引用（预览里列过、删除时只按这份列表动手）。 */
const MAX_DANGLING_IDS = 200
/** 一次最多删多少个子会话（含目录投影补出来的）：防着血缘异常时无限扩张。 */
const MAX_TARGETS = 200
/** 一次最多真实读几个会话的标题（读标题要折整份日志，得设个上限）。 */
const MAX_TITLE_READS = 8
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/* ── 小工具 ────────────────────────────────────────────────────────────── */

/** 会话 id 是否可信。 */
function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/** Windows / macOS 的文件系统不区分大小写：比较目录名时也要跟着不区分。 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

/** 目录名比较用的规范形式（"这是不是同一个会话的目录"）。 */
function comparableId(value) {
  return CASE_INSENSITIVE_FS ? String(value).toLowerCase() : String(value)
}

/** Host 头里的主机名（去掉端口，IPv6 去掉方括号）。 */
function hostNameOf(host) {
  let name = String(host || '').trim().toLowerCase()
  if (name.startsWith('[')) {
    const end = name.indexOf(']')
    return end > 0 ? name.slice(1, end) : ''
  }
  const colon = name.indexOf(':')
  return colon >= 0 ? name.slice(0, colon) : name
}

/**
 * Host 是不是 IP 字面量或 localhost。
 * 删除请求要求这一点，是为了挡 DNS rebinding：攻击者的域名永远不是 IP 字面量。
 * 代价是请用 `http://127.0.0.1:端口` / `http://192.168.x.x:端口` 访问，而不是自定义域名。
 */
function isIpLiteralHost(host) {
  const name = hostNameOf(host)
  if (name === '') return false
  if (name === 'localhost') return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return name.split('.').every((part) => Number(part) <= 255)
  return name.includes(':') && /^[0-9a-f:]+$/.test(name)
}

/**
 * 同源闸门。只读请求挡"别的网页偷看"，删除请求（strict）挡得更紧：
 *   · Sec-Fetch-Site（现代浏览器必带）：只接受 same-origin（页面自己的 fetch）与 none（地址栏直开）；
 *   · Origin：删除请求里只要出现就必须与 Host 同源，且不接受 `null`（沙箱 iframe 的形态）；
 *   · 删除请求还要求 Host 是 IP 字面量或 localhost（见 isIpLiteralHost）。
 * 两个头都没有的调用方（curl、本机脚本、测试）本来就握有本机文件权限，不算跨站。
 */
function isSameOrigin(req, strict = false) {
  const headers = (req && req.headers) || {}
  const host = String(headers.host || '')
  const site = typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'] : ''
  if (site !== '' && site !== 'same-origin' && site !== 'none') return false

  const origin = typeof headers.origin === 'string' ? headers.origin : ''
  if (origin === 'null') return !strict
  if (origin !== '') {
    // 非 strict 路径上，浏览器已经自己判定同源时不必再比一遍；strict 路径一律比。
    const browserAlreadySaidSameOrigin = !strict && site !== ''
    if (!browserAlreadySaidSameOrigin) {
      try {
        if (new URL(origin).host !== host) return false
      } catch (error) {
        return false
      }
    }
  }
  return strict ? isIpLiteralHost(host) : true
}

/** target 是否严格位于 root 之内（第二道路径闸门）。 */
function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** 错误 → 一行可读文案。 */
function reasonOf(error) {
  const message = error && error.message ? error.message : String(error)
  return message.slice(0, 200)
}

/** 相对 DSH_HOME 的展示用路径（拿不到就退回绝对路径）。 */
function displayPath(absolute) {
  return path.relative(DSH_HOME, absolute) || absolute
}

/** 只有 ENOENT 证明路径不存在，权限和 I/O 错误必须交给调用方。 */
function artifactStat(target) {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function artifactEntries(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' && artifactStat(root) === null) return []
    throw error
  }
}

/**
 * 找到会话日志目录，并分清"能删的真目录"与"存在但不敢碰的"。
 *
 * 判定顺序，缺一不可：
 *   1. 拼出来的路径在字符串意义上仍位于会话根之内（挡住 `..` / 盘符 / 分隔符）；
 *   2. lstat 说它是**真目录**、不是软链/联接 —— 我们只删自己拼出来并且确认是真目录的东西；
 *   3. 解析真实位置后仍在会话根的真实位置之内 —— 既允许 sessions 根本身是联接
 *      （换盘搬目录的常见做法），也挡住"某个 slug 目录指向别处"。
 * 过了 1、3 但没过 2、或干脆解析到根外的，进 skipped：那是"存在但不敢删"，
 * 调用方必须把它当阻塞条件报出来，绝不能因为"没找到可删的东西"就宣称删干净了。
 */
function discoverSessionDirs(sessionId) {
  const dirs = []
  const skipped = []
  const entries = artifactEntries(SESSIONS_ROOT)
  if (entries.length === 0) return { dirs, skipped }
  const root = fs.realpathSync(SESSIONS_ROOT)
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
  const same = (left, right) => (caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right)

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const candidate = path.join(SESSIONS_ROOT, entry.name, sessionId)
    if (!isInside(SESSIONS_ROOT, candidate)) continue
    const stats = artifactStat(candidate)
    if (!stats) continue
    if (stats.isSymbolicLink() || entry.isSymbolicLink() || !stats.isDirectory()) {
      skipped.push(candidate)
      continue
    }
    const resolved = fs.realpathSync(candidate)
    // "最后一段不是链接"的等价判定：解析结果必须正好是 <该 slug 目录的真实位置>/<会话 id>。
    // 这样无论 Node 把 Windows 联接报成目录还是链接，都只放行真目录。
    const expected = path.join(root, entry.name, sessionId)
    if (same(resolved, expected) && isInside(root, resolved)) dirs.push(candidate)
    else skipped.push(candidate)
  }
  return { dirs, skipped }
}

/**
 * 会话的投影缓存文件：`<id>.json`，以及存储域可能留下的 `<id>.json.bak.<stamp>` 备份。
 * 只认普通文件（软链一律不碰），并且再验一次路径仍在缓存目录之内。
 */
function projectionCacheFiles(sessionId) {
  const found = []
  const entries = artifactEntries(PROJECTION_ROOT)
  for (const entry of entries) {
    const name = entry.name
    if (name !== `${sessionId}.json` && !name.startsWith(`${sessionId}.json.bak.`)) continue
    const candidate = path.join(PROJECTION_ROOT, name)
    if (!isInside(PROJECTION_ROOT, candidate)) continue
    if (!entry.isFile()) throw new Error(`投影缓存不是普通文件：${displayPath(candidate)}`)
    found.push(candidate)
  }
  return found
}

/**
 * 工作区 slug 目录（`sessions/<工作区 slug>/`）里，删完之后会变空的那几个。
 *
 * slug 目录按工作区分的容器，本身不是某个会话的东西；但它一旦空掉，
 * 留在磁盘上就是"看着像残留"的空壳。这里只是**盘点**（只读），
 * 真正删除在删完之后由 pruneEmptySlugDirs 做，判定条件也是同一个：
 * 目录里剩下的条目必须全部属于本次要删的会话。
 */
function emptySlugDirsAfter(slugDirs, targets) {
  const wanted = new Set(targets.map((id) => comparableId(id)))
  const result = []
  for (const slugDir of slugDirs) {
    let entries
    try {
      entries = fs.readdirSync(slugDir)
    } catch (error) {
      continue
    }
    if (entries.length === 0) continue
    if (entries.every((name) => wanted.has(comparableId(name)))) result.push(slugDir)
  }
  return result
}

/**
 * 收走空掉的 slug 目录。只删**此刻确实为空**的目录，绝不递归：
 * 只要里面还有任何东西（别的会话、别的会话的临时文件、竞争写入），
 * 或者根本不是 sessions 根下面的一层目录，就原样留着。
 */
function pruneEmptySlugDirs(slugDirs) {
  const removed = []
  for (const slugDir of slugDirs) {
    if (!isInside(SESSIONS_ROOT, slugDir)) continue
    try {
      if (fs.readdirSync(slugDir).length !== 0) continue
      fs.rmdirSync(slugDir)
      removed.push(displayPath(slugDir))
    } catch (error) {
      // 目录非空 / 被占用 / 正好被别人删了：当没这回事，绝不上报失败。
    }
  }
  return removed
}

/** 目录占用：字节数 + 文件数。算不动了就照实报已经数到的部分，绝不抛。 */
async function measure(dir) {
  let bytes = 0
  let files = 0
  const walk = async (current) => {
    const entries = await fsp.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) {
        files += 1
        bytes += (await fsp.stat(child)).size
      }
    }
  }
  try {
    await walk(dir)
  } catch (error) {
    // 目录刚被别的进程删掉之类：按 0 报。
  }
  return { bytes, files }
}

/* ── 官方服务的安全包装（拿不到 / 抛错都只当作"没有这条信息"）──────────── */

/** 返回 `{ header, eventCount, … }`；会话不存在时返回 undefined。 */
async function statSession(ctx, sessionId) {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.stat !== 'function') return undefined
  try {
    return await persistence.stat(sessionId)
  } catch (error) {
    return undefined
  }
}

/**
 * 全部已登记会话的 header 快照；**读不到时返回 null**（而不是空数组）。
 *
 * 空数组的意思是"确实一条都没有"，null 的意思是"不知道"。
 * 删除流程必须能区分这两者：把"读不到"当成"没有子会话"，就会漏删子会话日志。
 */
async function listSessions(ctx) {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.list !== 'function') return null
  try {
    const value = await persistence.list()
    return Array.isArray(value) ? value : null
  } catch (error) {
    return null
  }
}

async function readTitle(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (!query || typeof query.readTitle !== 'function') return ''
  try {
    const snapshot = await query.readTitle(sessionId)
    return snapshot && typeof snapshot.title === 'string' ? snapshot.title : ''
  } catch (error) {
    return ''
  }
}

/**
 * 存活判定：'live' | 'idle' | 'unknown'。
 *
 * **拿不到 agents 服务就是 unknown，绝不当成 idle**：删除不可撤销，而"查不到"和"没在跑"
 * 是两件事（启动/卸载途中、极简 composition、服务 fiber 未激活时都会查不到）。
 * 注意：这只覆盖**当前进程**。同机另一个进程共享 DSH_HOME 时这里看不到（README 已注明）。
 */
function livenessOf(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') return 'unknown'
  try {
    return agents.get(sessionId) ? 'live' : 'idle'
  } catch (error) {
    return 'unknown'
  }
}

/**
 * 本进程是不是还**记着**这个会话（内存里的活会话）。
 *
 * 为什么这条判定决定了"能不能删"：侧栏的会话列表是
 *   `sessionController.list()` → `sessionQuery.listSessions()`
 *   = 持久层记录 ∪ **`ctx.sessions.list()`（内存里的活会话，live 优先）**。
 * 只要本进程还持有这个会话，删掉磁盘上的文件它**照样**会出现在侧栏里；
 * 而我们又把工作区登记摘了，于是它变成一条「未分组」条目 —— 刷新页面清不掉
 * （数据源在宿主内存里），只有重启 DSH 才会消失。
 *
 * 更麻烦的是：客户端打开的会话挂在 **`agents` 服务自己的 ctx** 上
 * （`agents.resume()` 里 `const ownerCtx = this.ctx`），所以它活到进程结束 ——
 * 这就是"删了还在、只有重启才消失"的根。
 *
 * 本插件不认命：能注销就注销（见 forgetSessions），注销不了才拒删。
 *
 * @returns {boolean|null} true=还记着，false=不在（含服务缺席），null=查询抛错（判定不了）
 */
function processHoldsSession(ctx, sessionId, requireBoth = false) {
  // 两张表**都要问**：只看 sessions 会漏掉"session 已注销、Agent 还活着"的版本错配，
  // 反过来也一样。只要有一张表明确还拿着它，就是 true。
  // @returns {boolean|null} true=还记着，false=不在（含服务缺席），null=查询抛错（判定不了）
  for (const name of ['sessions', 'agents']) {
    const service = ctx.get(name)
    if (typeof service?.get !== 'function') {
      if (requireBoth) return null
      continue
    }
    try {
      if (service.get(sessionId) !== undefined) return true
    } catch (error) {
      return null
    }
  }
  return false
}

/** 活会话对象本身（未落盘的会话要先拿它 flush 一次，见 forgetSessions）。 */
function liveSessionOf(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function') return undefined
  try {
    return sessions.get(sessionId)
  } catch (error) {
    return undefined
  }
}

/** 磁盘上没有任何属于这个会话的痕迹（日志目录 / 缓存文件都算）。 */
function hasNoArtifacts(sessionId) {
  return !hasArtifacts(sessionId)
}

/* ── 让宿主忘掉一个会话（进程内注销）──────────────────────────────────── */

/**
 * 进程内注册表的注销原语。
 *
 * `agents`（AgentRegistry）与 `sessions`（SessionStore）有一模一样的形状：
 *   · 一个 `store = new Map()` 存 entry；
 *   · `detachEntered(entry)` —— **官方自己的注销路径**：先做 entry 身份校验，
 *     再从表里删掉，然后发出配对的 `agent/disposed` / `session/disposed`。
 * 正常注销由属主的作用域（Agent 发布句柄的 `dispose`）触发；而客户端打开的会话挂在
 * `agents` 服务自己的 ctx 上（活到进程结束），插件又拿不到那个句柄 ——
 * 能用的就是这两个原语。它们幂等（entry 身份校验 + 属主之后自己的 detach 变成空操作），
 * 发出的也是真事件：按 disposed 收尾的订阅者（例如 workspace-changes 清临时目录）会正常清理。
 *
 * 形状守卫：两个成员都必须是预期形状才动手；否则返回 null，
 * 调用方必须**拒删**（fail closed），而不是删完留一个幽灵。
 */
function evictionPrimitive(service) {
  if (!service || typeof service.detachEntered !== 'function') return null
  const store = service.store
  if (!store || typeof store.get !== 'function' || typeof store.delete !== 'function') return null
  return {
    entryOf: (id) => store.get(id),
    evict: (entry) => service.detachEntered(entry),
  }
}

/**
 * 把目标会话从本进程"忘掉"：先从 session store 注销（侧栏列表的来源），
 * 再从 agent registry 注销（属主）。
 *
 * 顺序有讲究：先摘掉列表的来源，最要紧的目标就达成了；随后注销 Agent 若触发级联，
 * 里面的 detach 也只会是空操作。
 *
 * 未落盘的会话（只在持久层内存记录里的空白会话）先 `sessions.flush(session)` 落一次盘 ——
 * 那是官方接口：写完 header 之后 pending 记录才会被丢掉（`tracker.materialized(id)`），
 * 否则删掉之后它还会以"未落盘会话"的形式留在列表里。落盘产物会跟其它文件一起删掉。
 *
 * @returns {Promise<{ available: boolean, forgotten: string[], flushed: string[], steps: string[] }>}
 */
async function forgetSessions(ctx, targets) {
  const result = { available: false, forgotten: [], flushed: [], steps: [] }
  const sessions = ctx.get('sessions')
  const sessionStore = evictionPrimitive(sessions)
  const agentStore = evictionPrimitive(ctx.get('agents'))
  result.available = Boolean(sessionStore || agentStore)
  if (!result.available) return result

  for (const id of targets) {
    const live = liveSessionOf(ctx, id)
    if (live !== undefined && hasNoArtifacts(id) && sessions && typeof sessions.flush === 'function') {
      // 只在"还没落盘"时落一次盘：把它变成磁盘上真有的一份，好让它能被删干净。
      try {
        await sessions.flush(live)
        result.flushed.push(id)
      } catch (error) {
        result.steps.push(`会话 ${id} 落盘失败：${reasonOf(error)}`)
      }
    }

    /** 官方 entry 自带 detach 时优先用它（属主自己的注销路径）；否则退回注册表原语。 */
    // 两者都可能是异步的：不 await 会在注销完成前就去复核，还会把 rejection 丢成未处理异常。
    const evict = async (primitive, target) => {
      const entry = primitive.entryOf(target)
      if (entry === undefined) return false
      if (typeof entry.detach === 'function') await entry.detach()
      else await primitive.evict(entry)
      return true
    }
    let evicted = false
    if (sessionStore) {
      try {
        if (await evict(sessionStore, id)) evicted = true
      } catch (error) {
        result.steps.push(`注销内存会话 ${id} 失败：${reasonOf(error)}`)
      }
    }
    if (agentStore) {
      try {
        if (await evict(agentStore, id)) evicted = true
      } catch (error) {
        result.steps.push(`注销 Agent ${id} 失败：${reasonOf(error)}`)
      }
    }
    if (evicted) result.forgotten.push(id)
  }
  return result
}

/** 注销之后复核：本进程还记着哪些目标（还记得就不许动文件，见 deleteSession）。 */
async function stillRemembered(ctx, targets) {
  const kept = []
  for (const id of targets) {
    // null=查询抛错：判定不了就当它还记得 —— 宁可拒删，也不留幽灵。
    if (processHoldsSession(ctx, id) !== false) kept.push(id)
  }
  return kept
}

/**
 * 删完之后复核：宿主的会话列表里**还看得见**哪些目标。
 *
 * 这是"注销到底做干净没有"的最终检查 —— 覆盖未落盘会话那种"活实例没了、但持久层
 * 内存记录还在"的情况。非空就如实报给界面，绝不假报"删干净了"。
 */
async function stillListing(ctx, targets) {
  const snapshots = await listSessions(ctx)
  // null = 列表读不到，不是"没有残留"；原样把"不知道"交给界面。
  if (snapshots === null) return null
  const known = new Set()
  for (const snapshot of snapshots) {
    const id = snapshot && snapshot.header ? snapshot.header.id : undefined
    if (typeof id === 'string') known.add(id)
  }
  return targets.filter((id) => known.has(id))
}

/**
 * 官方"正在跑"信号：`sessionController.list()` 里每个 SessionSummary 都带 `running`。
 *
 * 注意**不要**用 `agents.get(id)` 当"在跑"：`Agent` 只有一个 `{ id }` 字段，
 * 它只说明"这个会话在本进程里有活着的 Agent"（= 被打开/恢复过），
 * 界面上刚打开、闲着的会话同样满足 —— 拿它当闸门会把正常删除全挡住。
 *
 * @returns {Promise<Set<string>|null>} 正在跑的会话 id；判定不了返回 null（调用方 fail closed）
 */
async function runningSessionIds(ctx) {
  const controller = ctx.get('sessionController')
  if (!controller || typeof controller.list !== 'function') return null
  try {
    const value = await controller.list({}, new AbortController().signal)
    const items = value && Array.isArray(value.items) ? value.items : null
    if (items === null) return null
    return new Set(items.filter((item) => item && item.running === true).map((item) => item.sessionId))
  } catch (error) {
    return null
  }
}

/**
 * 该会话名下还在跑的后台任务数；判定不了返回 null。
 *
 * jobs.list(caller) 返回"调用者名下的 + 无主的"任务，所以必须自己按 owner 过滤：
 * 一个无主任务不属于任何会话，不该让所有会话都变成不可删。
 * jobs 服务缺席不是 unknown —— 任务只能经这个注册表存在，没有注册表就是没有任务。
 */
function countActiveJobs(ctx, sessionId) {
  const jobs = ctx.get('jobs')
  if (!jobs || typeof jobs.list !== 'function') return 0
  try {
    return jobs.list(sessionId).filter((job) => job && job.owner === sessionId && (job.status === 'running' || job.status === 'stopping')).length
  } catch (error) {
    return null
  }
}

/**
 * 只在持久层的**内存记录**里、磁盘上还没有痕迹的那些目标 id（刚建的空白会话）。
 * 它们和活会话一样会进侧栏列表 —— 注销前先 `sessions.flush()` 让它落盘，就能一起删掉。
 */
function pendingTargetsOf(ctx, snapshots, targets) {
  const byId = snapshotMapOf(snapshots)
  return targets.filter((target) => byId.has(target) && !hasArtifactsEverywhere(ctx, byId, target))
}

/**
 * 归档闸门：**只删已归档的会话**。
 *
 * 归档是官方"把它收起来"的动作（`workspaceRegistry.archiveSession`）：它会把会话移出
 * 正常工作区、顺手取消正在跑的回合（`agent.cancel({kind:'user'})`）并杀掉它的后台任务。
 * 把删除限定在这个状态之后，删除就只可能作用在用户明确收起来过的东西上。
 *
 * 归档状态从持久化记录里读（`global.archivedSessionIds`）——注册表服务只给了
 * 写接口，没有读接口。读不到就拒删（fail closed），绝不猜"大概归档了吧"。
 */
function archivedBlockers(ctx, sessionId) {
  const archived = archivedStateOf(ctx, sessionId)
  if (archived === null) return ['读不到这个会话的归档状态（注册表服务不可用），为安全起见拒绝删除']
  if (!archived) {
    return ['这个会话还没有归档。删除只对**已归档**的会话开放 —— 请先在侧栏用它「…」菜单里的「归档」把它收起来（归档还会顺手停掉正在跑的回合与后台任务），然后再回来删。']
  }
  return []
}

/**
 * 内存闸门：进程还记着它时，必须**确认我们能把它注销掉**，否则拒删。
 *
 * 注销走 forgetSessions（官方 `detachEntered` 路径）。这里只做前置检查：
 *   · 进程记得它，且两个注册表都没有可用的注销原语 → 拒删（删了必留幽灵）；
 *   · 只在持久层内存记录里、而且已经没有活实例可以 flush 落盘 → 拒删。
 * 两种情况都是 fail closed：宁可不让删，也不留下一颗刷新去不掉的幽灵。
 */
function memoryBlockers(ctx, targets, sessionId, snapshots) {
  const remembered = targets.filter((target) => processHoldsSession(ctx, target) === true)
  if (remembered.length > 0 && !evictionAvailable(ctx)) {
    const held = remembered[0]
    const gaps = evictionGaps(ctx)
    const detail = gaps.length > 0 ? `（缺少注销原语：${gaps.join('、')}）` : ''
    return [held === sessionId
      ? `这个会话还在宿主进程的内存里，而这个宿主版本没有完整的注销路径${detail} —— 硬删会在侧栏留下一条「未分组」条目（刷新页面去不掉，只能重启 DSH）。为安全起见拒绝删除。`
      : `子代理会话「${held}」还在宿主内存里，而这个宿主版本没有完整的注销路径${detail}；为安全起见拒绝删除。`]
  }

  const orphans = pendingTargetsOf(ctx, snapshots, targets).filter((id) => !remembered.includes(id))
  if (orphans.length > 0) {
    return ['这个会话还没有落盘，而且本进程里已经没有它的活实例可以补写落盘了 —— 现在删会留下一条「未分组」条目。请重启 DSH 后再删，或先给它发一条消息让它落盘。']
  }
  return []
}

/**
 * 在册的进程内注册表里，哪张表**没法注销**。
 * 只看"至少有一个原语"是不够的：sessions 能注销、agents 不能时，Agent 仍会留在宿主
 * 内存里（见 forgetSessions），所以只要有一张在册的表缺原语，就必须拒删。
 */
function evictionGaps(ctx) {
  const gaps = []
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  if (sessions && typeof sessions.get === 'function' && !evictionPrimitive(sessions)) gaps.push('活会话表')
  if (agents && typeof agents.get === 'function' && !evictionPrimitive(agents)) gaps.push('Agent 表')
  return gaps
}

/** 能注销**所有在册的**进程内注册表，并且至少有一张表可注销。 */
function evictionAvailable(ctx) {
  if (evictionGaps(ctx).length > 0) return false
  return Boolean(evictionPrimitive(ctx.get('sessions')) || evictionPrimitive(ctx.get('agents')))
}

/* ── 官方服务的额外能力（都有守卫：拿不到就少一条信息，绝不抛）──────────── */

/** `ctx.agents.get(id)` —— 那个**活 Agent 对象**（终端属主、运行状态都要用它）。 */
function liveAgentOf(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') return undefined
  try {
    return agents.get(sessionId)
  } catch (error) {
    return undefined
  }
}

/**
 * 让持久化后端**自己**说出会话工件目录（`sessionPersistence.locate(header)`）。
 *
 * jsonl 后端的实现是 `{ kind: 'jsonl', path: logPath(root, cwd, id, compression) }` ——
 * 路径由后端自己推导，比我们扫 slug 反查更权威。但它不在抽象 Service 契约里，
 * 所以要特征探测（拿不到就返回 undefined，退回我们自己的扫描）。
 */
function locateArtifactDir(persistence, header) {
  if (!persistence || typeof persistence.locate !== 'function' || !header) return undefined
  try {
    const location = persistence.locate(header)
    const file = location && typeof location.path === 'string' ? location.path : ''
    return file === '' ? undefined : path.dirname(file)
  } catch (error) {
    return undefined
  }
}

/**
 * 后端指认的目录能不能删：绝对路径 → 基名就是这个会话 id → lstat 确认是真目录、不是软链。
 * 三道都过才收下；任何一道不过就当成"没这回事"，退回我们自己的扫描。
 */
function acceptableArtifactDir(dir, sessionId) {
  if (typeof dir !== 'string' || dir === '' || !path.isAbsolute(dir)) return false
  if (comparableId(path.basename(dir)) !== comparableId(sessionId)) return false
  const stats = artifactStat(dir)
  return Boolean(stats && stats.isDirectory() && !stats.isSymbolicLink())
}

/**
 * 官方"还有工作在跑"的准入瀑布：`workspace/session-activity`。
 *
 * 官方归档用的就是这一条（`dsh-agent` 报进行中的回合、`dsh-jobs` 报后台任务、
 * 子智能体运行时报运行中的子会话、`dsh-schedule` 报生效中的任务），
 * 而且要**对集合里每个会话各问一次** —— 这条准入只对被问的那个会话作答。
 *
 * @returns {Promise<Map<string, object[]>|null>} null = 这条瀑布不可用（调用方退回旧判定）
 */
async function gatherActivities(ctx, ids) {
  if (typeof ctx.waterfall !== 'function') return null
  const found = new Map()
  for (const id of ids) {
    let items
    try {
      items = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]))
    } catch (error) {
      return null
    }
    if (Array.isArray(items) && items.length > 0) found.set(id, items)
  }
  return found
}

/** 把准入瀑布报出来的东西翻成人话（一行一条）。 */
function describeActivities(items) {
  const labels = []
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue
    const kind = typeof item.kind === 'string' ? item.kind : 'activity'
    const named = Array.isArray(item.items)
      ? item.items.map((entry) => (entry && typeof entry.label === 'string' ? entry.label : '')).filter(Boolean)
      : []
    labels.push(named.length > 0 ? `${kind}（${named.join('、')}）` : kind)
  }
  return labels
}

/** 停掉这些会话正在跑的工作：官方 `workspace/session-stop`，与 `archiveSession({stopActivity:true})` 同一条。 */
async function stopActivities(ctx, ids) {
  const steps = []
  if (typeof ctx.parallel !== 'function') return steps
  for (const id of ids) {
    try {
      await ctx.parallel('workspace/session-stop', { sessionId: id })
      steps.push(`已请求停止 ${id} 的工作`)
    } catch (error) {
      steps.push(`停止 ${id} 的工作失败：${reasonOf(error)}`)
    }
  }
  return steps
}

/**
 * 关掉这些会话名下的终端。
 *
 * 终端不属于任何准入族，服务自己的属主回收要等 Agent 释放 —— 那时日志早就没了，
 * shell 会一直挂着。`terminals.list` 按**对象身份**匹配属主，所以 owner 必须是
 * `agents.get(id)` 返回的那个活对象，这一步也就**必须排在"注销 Agent"之前**。
 */
async function closeOwnedTerminals(ctx, ids) {
  const closed = []
  const steps = []
  const terminals = ctx.get('terminals')
  if (!terminals || typeof terminals.list !== 'function' || typeof terminals.kill !== 'function') return { closed, steps }
  for (const id of ids) {
    const owner = liveAgentOf(ctx, id)
    if (owner === undefined) continue
    let snapshots
    try {
      snapshots = terminals.list(owner)
    } catch (error) {
      steps.push(`读取 ${id} 的终端列表失败：${reasonOf(error)}`)
      continue
    }
    for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
      const terminalId = snapshot && typeof snapshot.sessionId === 'string' ? snapshot.sessionId : ''
      if (terminalId === '') continue
      try {
        if (await terminals.kill(owner, terminalId, 'session deleted')) closed.push(terminalId)
      } catch (error) {
        steps.push(`关闭终端 ${terminalId} 失败：${reasonOf(error)}`)
      }
    }
  }
  return { closed, steps }
}

/**
 * 子代理目录投影（`subagents.listDescendants`）：血缘的**第二个意见**。
 *
 * 我们的父指针遍历读不出某些子会话（目录损坏、模式不认识），这条投影能点名它们 ——
 * 不补上，那些日志就会变成磁盘上的孤儿。每条还带 `depth`，方便按"从最深往下"排。
 *
 * @returns {Promise<{ entries: Array<{id: string, depth: number, diagnostic: boolean}>, warning: string }>}
 */
async function catalogDescendants(ctx, rootId) {
  const subagents = ctx.get('subagents')
  if (!subagents || typeof subagents.listDescendants !== 'function') return { entries: [], warning: '' }
  try {
    const listed = await subagents.listDescendants(rootId)
    const entries = []
    for (const entry of Array.isArray(listed) ? listed : []) {
      const id = entry && typeof entry.id === 'string' ? entry.id : ''
      if (!isSessionId(id) || id === rootId) continue
      entries.push({
        id,
        depth: typeof entry.depth === 'number' && Number.isFinite(entry.depth) ? entry.depth : 1,
        diagnostic: entry.kind === 'diagnostic',
      })
    }
    return { entries, warning: '' }
  } catch (error) {
    return { entries: [], warning: `子代理目录读不出来（${reasonOf(error)}），本次血缘只按日志里的父指针算` }
  }
}

/* ── 会话关系：谁会被一起删掉 ──────────────────────────────────────────── */

/**
 * 会话谱系拆分（父指针只存在于子会话自己的 header 里，所以按 parentSession 反查）：
 *   · subagents —— `origin: 'subagent'` 的内部子会话：侧栏里看不见，必须跟着父会话一起删，
 *                  否则就是磁盘上永远无人认领的孤儿；
 *   · forks     —— fork 出来的可见会话：那是用户自己的另一段对话，默认不删（可选），
 *                  **而且不再往下走** —— fork 自己的子代理会话属于那段会话。
 *
 * 再与子代理目录投影（`subagents.listDescendants`）取并集：父指针读不出来的子会话
 * 由目录点名（`extra`），目录也读不出来的分支单独报成 `diagnostics`（照样删，但要告诉用户
 * 它下面的分支没数清）。
 *
 * `snapshots` 由调用方传入（一次 `sessionPersistence.list()` 供多处复用，别重复扫盘）。
 */
async function relativesOf(ctx, snapshots, sessionId) {
  const children = new Map()
  for (const snapshot of snapshots) {
    const parent = snapshot?.header?.parentSession
    if (typeof parent !== 'string' || parent === '') continue
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(snapshot)
  }

  const subagents = []
  const forks = []
  const invalid = new Set()
  const queue = [sessionId]
  const seen = new Set([sessionId])
  while (queue.length > 0) {
    const current = queue.shift()
    for (const child of children.get(current) || []) {
      const id = child?.header?.id
      if (typeof id !== 'string' || seen.has(id)) continue
      if (!isSessionId(id)) {
        // 损坏的快照不能变成"待删目录"：没有合法 id 就无法安全枚举它下面的分支。
        invalid.add(id)
        continue
      }
      seen.add(id)
      if (child.header.origin === 'subagent') {
        subagents.push(child)
        queue.push(id)
      } else {
        forks.push(child)
      }
    }
  }

  const catalog = await catalogDescendants(ctx, sessionId)
  const extra = []
  const diagnostics = []
  const warnings = catalog.warning === '' ? [] : [catalog.warning]
  for (const entry of catalog.entries) {
    if (typeof entry.id !== 'string' || !isSessionId(entry.id)) {
      invalid.add(String(entry.id))
      continue
    }
    if (entry.id === sessionId) continue
    if (entry.diagnostic) diagnostics.push(entry.id)
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    extra.push(entry.id)
  }
  if (diagnostics.length > 0) {
    warnings.push(`有 ${diagnostics.length} 个子会话的目录读不出来：它们会一起删掉，但它们自己带出的下一层没法枚举`)
  }
  if (invalid.size > 0) {
    warnings.push(`有 ${invalid.size} 个派生会话的 id 形状不合法；为安全起见这个会话不会删除`)
  }

  return { subagents, forks, extra, diagnostics, invalid: [...invalid], warnings }
}

/**
 * 注册表全局集合（置顶 / 归档）的**只读**快照；读不到返回 null。
 *
 * 官方 `workspaceRegistry` 只给了 pin/unpin/archive/unarchive 四个写接口，
 * **没有读接口**，所以只能读持久化记录（只读，绝不写）。三个数组读不出形状时
 * 对应字段给 null —— 调用方据此说"这一项不知道"，而不是猜。
 */
function registryMembership(ctx) {
  const domain = ctx.get('storageDomain')
  if (!domain || typeof domain.get !== 'function') return null
  try {
    const live = domain.get('workspace')
    const global = live && live.global && typeof live.global.get === 'function' ? live.global.get() : null
    if (!global || typeof global !== 'object') return null
    return {
      pinned: Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds : null,
      archived: Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : null,
    }
  } catch (error) {
    return null
  }
}

/** 会话的归档状态：`true` / `false` / `null`（读不到）。 */
function archivedStateOf(ctx, sessionId) {
  const membership = registryMembership(ctx)
  if (membership === null || membership.archived === null) return null
  return membership.archived.includes(sessionId)
}

/**
 * 这次删除会从工作区登记里摘掉什么（**只读盘点**，所见即所删）。
 *
 * 引用方 `owners` 来自删除前抓下的投影；置顶 / 归档是注册表的全局集合，
 * 而官方 `workspaceRegistry` 只给了写接口（pin/unpin/archive/unarchive），
 * 没有读接口，所以从持久化记录里读 —— 同样是只读，读完什么都写。
 * 读不到就如实报"看不到"，绝不猜一条出来吓人。
 */
function registryPlan(ctx, sessionId, owners, registry) {
  const workspaces = []
  for (const ownerId of owners) {
    let title = ''
    try {
      const workspace = registry && typeof registry.get === 'function' ? registry.get(ownerId) : undefined
      if (workspace && typeof workspace.title === 'string') title = workspace.title
    } catch (error) {
      title = ''
    }
    workspaces.push({ id: ownerId, title })
  }

  const membership = { pinned: false, archived: false, readable: false }
  const known = registryMembership(ctx)
  if (known !== null) {
    membership.readable = true
    membership.pinned = known.pinned === null ? false : known.pinned.includes(sessionId)
    membership.archived = known.archived === null ? false : known.archived.includes(sessionId)
  }
  return { available: Boolean(registry), workspaces, ...membership }
}

/* ── 查：可删除性 ──────────────────────────────────────────────────────── */

/**
 * 汇总一个会话的可删除性。
 * @returns {Promise<{ info: object, targets: string[], paths: string[] }>}
 *   info 可以直接发给浏览器半区；targets 是要一起删的会话 id；paths 是要删的绝对路径。
 */
async function inspectSession(ctx, sessionId) {
  // 硬前置：即便有调用方绕过了路由（本模块的几个函数是导出的），
  // 也绝不允许拼出来的路径离开受管目录。
  if (!isSessionId(sessionId)) throw new Error('非法的会话 id')

  const listed = await listSessions(ctx)
  const snapshots = listed ?? []
  const listReadable = listed !== null
  const snapshotsById = new Map()
  for (const entry of snapshots) {
    const id = entry?.header?.id
    if (isSessionId(id)) snapshotsById.set(id, entry)
  }

  const { subagents, forks, extra, invalid, warnings } = await relativesOf(ctx, snapshots, sessionId)
  /**
   * 这次删除会动到的全部会话：目标自身在前，子代理会话其次，随后是勾选的派生族。
   * 超过上限时**不静默截断**：只删前 200 个会把其余子会话留成孤儿，
   * 所以标记 truncated，并让 deletable 直接为 false —— 请用户分批删除。
   */
  const family = [
    { id: sessionId, origin: 'self' },
    ...subagents.map((entry) => ({ id: entry.header.id, origin: entry.header.origin || 'subagent' })),
    ...extra.map((id) => ({ id, origin: 'subagent' })),
  ].filter((entry) => isSessionId(entry.id))
  const truncated = family.length > MAX_TARGETS
  const targetEntries = truncated ? family.slice(0, MAX_TARGETS) : family
  const targetIds = targetEntries.map((entry) => entry.id)

  // 待删清单：查与删共用同一份规则，删除前还会再算一次（见 collectRemovalPlan）。
  // 目录来源两个取并集：持久化后端自己指认的（locate）+ 我们扫 sessions 根反查的。
  const plan = await collectRemovalPlan(ctx, targetIds, snapshotsById)
  const { paths, artifacts, skipped, slugDirs, spillPaths, bytes, fileCount } = plan

  // 先做可能慢的事（读标题要折整份日志），再做"在不在跑"的判断：
  // 判定必须尽量贴近真正动手的时刻，绝不能拿着几百毫秒前的答案去删一个已经跑起来的会话。
  const snapshot = await statSession(ctx, sessionId)
  const title = await readTitle(ctx, sessionId)
  const exists = paths.length > 0 || skipped.length > 0 || snapshot !== undefined
  /**
   * 文件已经不在、宿主也不再记得它 —— 这通常发生在"刚删完又点了一次"，
   * 或旧版本留下的幽灵条目还在侧栏。此时再报"还没有归档"是误导：
   * 它没有可归档的东西，也没有可删的东西。只在确实没有任何派生会话、
   * 且存活探测明确回答"不记得"时才走这条文案（探测抛错仍按未知处理）。
   */
  const absent = !exists
    && listReadable
    && !snapshotsById.has(sessionId)
    && family.length === 1
    && processHoldsSession(ctx, sessionId) === false

  // 引用方也要在**删文件之前**抓：注册表的 workspace.sessionIds 是投影，
  // 日志一删它就看不见这个会话了，届时再问"谁引用了它"只会得到空答案 ——
  // 那样 workspace.json 里就会留下悬空 id，界面上表现为"未分组"的幽灵条目。
  const registry = ctx.get('workspaceRegistry')
  const owners = []
  if (registry && typeof registry.list === 'function') {
    try {
      for (const workspace of registry.list()) {
        if (workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) owners.push(workspace.id)
      }
    } catch (error) {
      owners.length = 0
    }
  }

  /**
   * 安全闸门，顺序即界面显示的优先级：
   *   1. 归档（只删已归档的会话）
   *   2. 宿主内存（进程还记着它时，先确认我们能把它注销掉）
   *   3. 路径（日志在软链/联接之后不动手）
   * "还有工作在跑"**不再是硬闸门**：单独报出来，界面上给一个「先停掉再删除」的勾选项，
   * 提交时带上 `stop` 才放行（见 deleteSession）。
   */
  const archived = archivedStateOf(ctx, sessionId)
  const blockers = absent ? [] : [
    ...archivedBlockers(ctx, sessionId),
    ...(listReadable
      ? []
      : ['读不到会话列表，无法确认这个会话下面还有没有子代理会话；为安全起见拒绝删除']),
    ...(invalid.length > 0
      ? [`有 ${invalid.length} 个派生会话的 id 形状不合法，无法安全枚举它们；为安全起见这次不删，请手动处理损坏的会话记录`]
      : []),
    ...(truncated
      ? [`这次要一起删的会话有 ${family.length} 个，超过一次 ${MAX_TARGETS} 个的上限；请分批删除。父会话这次不会动 —— 只删一部分会让超出的子会话变成孤儿。`]
      : []),
    ...memoryBlockers(ctx, targetIds, sessionId, snapshots),
  ]
  if (skipped.length > 0) {
    blockers.push('会话的日志目录位于软链/联接之后（解析位置不在会话根内），为安全起见不删除，请手动处理')
  }

  // 活动与状态：优先问官方 waterfall（覆盖面最广），拿不到就退回旧判定（旧判定本身 fail closed）。
  // 已经确认不存在的会话不查这些：它没有可跑的东西，再问只会得到"服务异常"之类的噪声。
  let activities = null
  const busySessions = []
  if (!absent) {
    activities = await gatherActivities(ctx, targetIds)
    if (activities !== null) {
      for (const id of targetIds) {
        const labels = describeActivities(activities.get(id))
        if (labels.length > 0) busySessions.push({ id, labels })
      }
    } else if (typeof ctx.waterfall === 'function') {
      // 宿主有这条瀑布，它却抛错了：不能退回更弱的旧判定当成"没在跑"。
      // 完全拿不到 waterfall 的旧宿主仍走下面的兜底（那是设计内的降级）。
      blockers.push('查不到会话的活动状态（活动瀑布异常），为安全起见拒绝删除')
    } else {
      const running = await runningSessionIds(ctx)
      if (running === null) {
        blockers.push('查不到会话的运行状态（会话控制器不可用），为安全起见拒绝删除')
      } else {
        for (const id of targetIds) {
          const labels = []
          if (running.has(id)) labels.push('有回合在跑')
          const jobs = countActiveJobs(ctx, id)
          if (jobs === null) {
            blockers.push('查不到后台任务状态（jobs 服务异常），为安全起见拒绝删除')
            break
          }
          if (jobs > 0) labels.push(`${jobs} 个后台任务在跑`)
          if (labels.length > 0) busySessions.push({ id, labels })
        }
      }
    }
  }
  // "还有工作在跑"不进 warnings：界面有专门的区块（列出在跑什么 + 「先停掉」勾选项），
  // 这里只给数据；重复两遍同一件事只会让用户以为出了两个问题。

  // 可选的连带删除对象：派生会话（fork）。默认保留，想删就勾上；
  // 但**每个被勾的 fork 自己也得是已归档的**（同一条规则，不因为是"顺带"就放宽）。
  const optionalForks = []
  let forkIndex = 0
  for (const entry of forks) {
    const id = entry.header.id
    optionalForks.push({
      id,
      title: forkIndex < MAX_TITLE_READS ? await readTitle(ctx, id) : '',
      archived: archivedStateOf(ctx, id) === true,
      live: processHoldsSession(ctx, id) === true,
    })
    forkIndex += 1
  }

  const info = {
    id: sessionId,
    title,
    exists,
    /** 文件与宿主内存都不在了；侧栏可能还留着刷新前的旧行。 */
    absent,
    /** 归档状态（删除的**前置条件**）：true / false / null（读不到）。 */
    archived,
    /** 会话在本进程里有活着的 Agent —— 只表示"打开着"，不表示"在跑"。 */
    open: livenessOf(ctx, sessionId) === 'live',
    /** 本进程还持有它的内存实例 —— 删除时会先把它注销掉（见 forgetSessions）。 */
    live: targetIds.some((target) => processHoldsSession(ctx, target) === true),
    /** 只在持久层的内存记录里、磁盘上还没有痕迹（刚建的空白会话）—— 删除时会先落盘再删。 */
    pending: pendingTargetsOf(ctx, snapshots, targetIds).length > 0,
    activeJobs: targetIds.reduce((sum, target) => sum + (countActiveJobs(ctx, target) || 0), 0),
    subagents: subagents.length + extra.length,
    forks: forks.length,
    bytes,
    files: fileCount,
    events: typeof snapshot?.eventCount === 'number' ? snapshot.eventCount : null,
    createdAt: typeof snapshot?.header?.createdAt === 'number' ? snapshot.header.createdAt : null,
    cwd: typeof snapshot?.header?.cwd === 'string' ? snapshot.header.cwd : '',
    materialized: paths.length > 0,
    blocking: absent
      ? '这个会话已经不存在了：磁盘上没有它的文件，宿主也不再记得它。如果侧栏还看得到，刷新页面就会消失。'
      : blockers[0] || null,
    deletable: exists && blockers.length === 0,
    artifacts,
    /** 超过一次删除上限（见 blockers）：true 时 deletable 一定为 false。 */
    truncated,
    /** 会话列表读不读得到（false 时上面的 blocker 会拦住删除）。 */
    listReadable,
    /** 形状不合法、因此没有纳入删除范围的派生会话 id。 */
    invalidRelatives: invalid,
    /** 需要用户知道、但不足以拦住删除的事（血缘读不全、有工作在跑……）。 */
    warnings: absent ? [] : warnings,
    /** 还有工作在跑的会话：可以勾「先停掉它」再删。 */
    busy: { total: busySessions.length, sessions: busySessions, activityReliable: absent || activities !== null },
    /** 可选连带删除的派生会话（默认不删）。 */
    optionalForks,
    /**
     * 这次删除会动到的**全部会话 id**（目标在前，子代理会话在后）。
     * 浏览器半区按这份清单清理本地状态：不多清一个，也不少清一个。
     */
    targets: targetEntries,
    /** 这次删除会从工作区登记里摘掉什么（只读盘点，所见即所删）。 */
    registry: registryPlan(ctx, sessionId, owners, registry),
    /** 历史遗留的悬空引用：预览（只读），确认删除时按 `ids` 原样执行。 */
    dangling: await danglingPreview(ctx),
  }
  return { info, targets: targetIds, paths, owners, slugDirs, spillPaths, snapshots, plan }
}

/** GET 和 POST 共用同一份完整预览。只在所有选中的根会话通过闸门后签出清单版本。 */
async function inspectDeletion(ctx, sessionId, extraRoots) {
  const primary = await inspectSession(ctx, sessionId)
  const blocked = (status, error) => ({
    status,
    error,
    info: { ...primary.info, deletable: false, blocking: error },
  })
  if (!primary.info.exists) return blocked(404, primary.info.blocking || '会话不存在，可能已经被删除')
  if (!primary.info.deletable) return blocked(409, primary.info.blocking)

  const selectable = new Map(primary.info.optionalForks.map((fork) => [fork.id, fork]))
  const entries = new Map(primary.info.targets.map((entry) => [entry.id, entry]))
  const snapshotsById = snapshotMapOf(primary.snapshots)
  const warnings = new Set(primary.info.warnings)
  const busy = new Map(primary.info.busy.sessions.map((session) => [session.id, session]))
  for (const id of extraRoots) {
    const fork = selectable.get(id)
    if (!fork) return blocked(400, `${id} 不是这个会话的派生会话`)
    if (!fork.archived) return blocked(409, `派生会话「${id}」还没有归档`)
    const extra = await inspectSession(ctx, id)
    if (!extra.info.deletable) return blocked(409, `派生会话「${id}」现在删不了：${extra.info.blocking}`)
    for (const entry of extra.info.targets) {
      if (!entries.has(entry.id)) entries.set(entry.id, entry.id === id ? { id, origin: 'fork' } : entry)
    }
    for (const [id, snapshot] of snapshotMapOf(extra.snapshots)) snapshotsById.set(id, snapshot)
    for (const session of extra.info.busy.sessions) busy.set(session.id, session)
    for (const warning of extra.info.warnings) warnings.add(warning)
  }
  const targets = [...entries.keys()]
  if (targets.length > MAX_TARGETS) {
    return blocked(409, `这次要删的会话有 ${targets.length} 个，超过一次 ${MAX_TARGETS} 个的上限；请少勾几个派生会话`)
  }
  const plan = extraRoots.length === 0 ? primary.plan : await collectRemovalPlan(ctx, targets, snapshotsById)
  if (plan.skipped.length > 0) return blocked(409, '会话日志位置已变化，无法安全删除')

  const registry = ctx.get('workspaceRegistry')
  const ownersByTarget = registryOwners(ctx, targets, registry)
  const registryTargets = targets.map((id) => ({ id, ...registryPlan(ctx, id, ownersByTarget.get(id), registry) }))
  const pending = pendingTargetsOf(ctx, [...snapshotsById.values()], targets)
  const info = {
    ...primary.info,
    subagents: [...entries.values()].filter((entry) => entry.origin === 'subagent').length,
    targets: [...entries.values()],
    artifacts: plan.artifacts,
    bytes: plan.bytes,
    files: plan.fileCount,
    warnings: [...warnings],
    busy: { ...primary.info.busy, total: busy.size, sessions: [...busy.values()] },
    registryTargets,
    pendingTargets: pending,
  }
  const sorted = (items) => [...items].sort()
  info.preview = crypto.createHash('sha256').update(JSON.stringify({
    sessionId,
    extraRoots: sorted(extraRoots),
    targets: sorted(targets),
    paths: sorted(plan.paths),
    emptyDirs: sorted(plan.emptyDirs),
    spillPaths: sorted(plan.spillPaths),
    pending: sorted(pending),
    registry: registryTargets.map(({ id, workspaces, pinned, archived, readable, available }) => [
      id, sorted(workspaces.map((workspace) => workspace.id)), pinned, archived, readable, available,
    ]).sort(([left], [right]) => left.localeCompare(right)),
    dangling: sorted(info.dangling.ids),
  })).digest('hex')
  return { status: 200, info, targets, snapshotsById, ownersByTarget, plan }
}

/** 日志删除前同时抓取工作区投影和原始成员记录。 */
function registryOwners(ctx, targets, registry) {
  const owners = new Map(targets.map((id) => [id, new Set()]))
  const record = (key, workspace) => {
    if (typeof key !== 'string' || !Array.isArray(workspace?.sessionIds)) return
    for (const id of workspace.sessionIds) owners.get(id)?.add(key)
  }
  try {
    for (const workspace of registry?.list?.() ?? []) record(workspace?.id, workspace)
  } catch (error) {
    // 原始记录可补齐投影不可见的归属。
  }
  try {
    const table = ctx.get('storageDomain')?.get?.('workspace')?.table?.('workspaces')
    for (const [key, workspace] of table?.entries?.() ?? []) record(key, workspace)
  } catch (error) {
    // 仍可使用投影中已确认的归属。
  }
  return owners
}

/**
 * 目标会话的待删清单：日志目录、投影缓存、spill 临时目录，
 * 以及"删完之后会空掉"的工作区容器目录。
 *
 * 目录来源**两个取并集**，谁也别漏：
 *   1. 持久化后端自己指认的 `sessionPersistence.locate(header)` —— 最权威；
 *   2. 我们扫 `sessions/` 反查出来的（cwd 漂移、历史副本、后端不提供 locate 时兜底）。
 *
 * 查与删共用同一份规则 —— 而且删除前会**重新算一次**：注销未落盘会话时会补写出一份
 * 新日志（`sessions.flush()`），那份文件必须也在清单里，否则复核会报"删不干净"。
 *
 * @param {object} ctx 宿主上下文（只为拿 sessionPersistence.locate）
 * @param {string[]} targets 要删的会话 id
 * @param {Map<string, object>} [snapshotsById] 已知的持久化快照（用于 locate）
 * @returns {Promise<{ paths: string[], cachePaths: Set<string>, pathOwners: Map<string, string>,
 *   artifacts: string[], skipped: string[], slugDirs: string[], spillPaths: string[], emptyDirs: string[],
 *   bytes: number, fileCount: number }>}
 */
async function collectRemovalPlan(ctx, targets, snapshotsById = new Map()) {
  const paths = []
  const cachePaths = new Set()
  const pathOwners = new Map()
  const artifacts = []
  const skipped = []
  const slugDirs = new Set()
  const seen = new Set()
  let bytes = 0
  let fileCount = 0

  /** 收一个目录：去重 + 记账 + 记录它是不是"空掉要收走"的容器成员。 */
  const take = async (dir, note, sessionId) => {
    const key = comparableId(dir)
    if (seen.has(key)) return
    seen.add(key)
    paths.push(dir)
    pathOwners.set(dir, sessionId)
    artifacts.push(note === '' ? displayPath(dir) : `${displayPath(dir)}${note}`)
    if (isInside(SESSIONS_ROOT, dir)) slugDirs.add(path.dirname(dir))
    const part = await measure(dir)
    bytes += part.bytes
    fileCount += part.files
  }

  for (const target of targets) {
    // 防御性校验：调用方已经过滤过，这里再挡一次，绝不让拼出来的路径进入删除清单。
    if (!isSessionId(target)) continue
    // ① 后端自己指认的目录（最权威）。在会话根之外也收下，但在清单里如实标注。
    const located = locateArtifactDir(ctx.get('sessionPersistence'), snapshotsById.get(target)?.header)
    if (located !== undefined && acceptableArtifactDir(located, target)) {
      await take(located, isInside(SESSIONS_ROOT, located) ? '' : '（由持久化服务指认，位于会话根之外）', target)
    }
    // ② 我们扫出来的目录（并集；cwd 漂移与历史副本靠它兜底）。
    const { dirs, skipped: unsafe } = discoverSessionDirs(target)
    for (const dir of dirs) await take(dir, '', target)
    for (const path_ of unsafe) {
      skipped.push(path_)
      artifacts.push(`${displayPath(path_)}（位于软链/联接之后，未处理）`)
    }
    for (const cacheFile of projectionCacheFiles(target)) {
      const key = comparableId(cacheFile)
      if (seen.has(key)) continue
      seen.add(key)
      paths.push(cacheFile)
      cachePaths.add(cacheFile)
      pathOwners.set(cacheFile, target)
      artifacts.push(displayPath(cacheFile))
    }
  }

  // 第三处痕迹：系统临时目录里的工具输出溢出目录（不在 DSH_HOME 下）。
  // 单独放一条通道：它删不掉**不能**把"会话删干净"判成失败（见 remainingSpill）。
  const spillPaths = spillDirsFor(targets)
  for (const spillDir of spillPaths) {
    artifacts.push(displaySpill(spillDir))
    const part = await measure(spillDir)
    bytes += part.bytes
    fileCount += part.files
  }

  // 删完之后会空掉的工作区容器目录：列出来，删完再收走（只收确实空了的）。
  const emptyDirs = emptySlugDirsAfter(slugDirs, targets)
  for (const dir of emptyDirs) artifacts.push(`${displayPath(dir)}（删除后已空，一并清理）`)

  return { paths, cachePaths, pathOwners, artifacts, skipped, slugDirs: [...slugDirs], spillPaths, emptyDirs, bytes, fileCount }
}

/* ── 删：工作区登记摘除 ────────────────────────────────────────────────── */

/**
 * 把会话从工作区登记里摘干净。
 *
 * 只用官方服务接口而不去改 workspace.json：注册表在宿主进程里是活对象，
 * 直接改文件会被它的下一次整文件写覆盖掉；下面三个接口走的正是它自己的写路径。
 *   · unpinSession / unarchiveSession 对不存在的 id 是幂等的（官方文档明确保证）；
 *   · detachSession 摘掉工作区归属（归档/置顶两个全局集合不会被自动清理，所以要显式调）。
 *
 * `owners` 是**删文件之前**抓下来的引用方（那时注册表的投影还看得见这个会话）。
 * 这一点很关键：`workspace.sessionIds` 是按 header 索引过滤的投影，日志一删，
 * 投影里就没有这个 id 了，事后再问"谁引用了它"只会得到空答案。
 */
async function detachFromRegistry(ctx, sessionId, owners) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry) return { available: false, steps: [] }

  const steps = []
  const attempt = async (label, operation) => {
    try {
      await operation()
      steps.push(label)
    } catch (error) {
      steps.push(`${label}失败：${reasonOf(error)}`)
    }
  }

  if (typeof registry.unpinSession === 'function') await attempt('取消置顶', () => registry.unpinSession(sessionId))
  if (typeof registry.unarchiveSession === 'function') await attempt('取消归档', () => registry.unarchiveSession(sessionId))

  for (const ownerId of owners) {
    let workspace
    try {
      workspace = typeof registry.get === 'function' ? registry.get(ownerId) : undefined
    } catch (error) {
      workspace = undefined
    }
    if (!workspace || typeof workspace.detachSession !== 'function') continue
    await attempt(`移出工作区「${workspace.title || ownerId}」`, () => workspace.detachSession(sessionId))
  }
  return { available: true, steps }
}

/* ── 删：登记复核 ──────────────────────────────────────────────────────── */

/**
 * 注册表里"还引用着这些会话"的位置（读持久化记录，不做任何修改）。
 *
 * 为什么要复核：官方接口只能摘掉**投影看得见**的引用，而投影按 header 索引过滤 ——
 * 日志删掉后，悬空 id 就躲在持久化记录里，界面上表现为一个"未分组"的幽灵会话。
 * 拿不到 storageDomain / 域没打开时返回 null（不知道，不猜）。
 */
function residualReferences(ctx, ids) {
  const domain = ctx.get('storageDomain')
  if (!domain || typeof domain.get !== 'function') return null
  let live
  try {
    live = domain.get('workspace')
  } catch (error) {
    return null
  }
  if (!live || typeof live.table !== 'function') return null

  const wanted = new Set(ids)
  const found = { workspaces: [], archived: [], pinned: [] }
  try {
    for (const [key, value] of live.table('workspaces').entries()) {
      const list = value && Array.isArray(value.sessionIds) ? value.sessionIds : []
      if (list.some((id) => wanted.has(id))) found.workspaces.push(key)
    }
    const global = live.global && typeof live.global.get === 'function' ? live.global.get() : null
    for (const [field, bucket] of [['archivedSessionIds', 'archived'], ['pinnedSessionIds', 'pinned']]) {
      const list = global && Array.isArray(global[field]) ? global[field] : []
      for (const id of list) if (wanted.has(id)) found[bucket].push(id)
    }
  } catch (error) {
    return null
  }
  return found
}

/**
 * 把复核出来的悬空引用剪掉。
 *
 * **优先走注册表自己的接口**（unarchiveSession / unpinSession / 工作区实体的
 * detachSession）：注册表在宿主进程里是活对象，全局归档/置顶集合还额外有一份
 * 内存状态（setState 先写域、再换内存）。绕过它直写 storageDomain 会让两份状态
 * 分叉，之后注册表任意一次写入都可能用旧内存把刚剪掉的 id 写回来 —— 这正是
 * "删完会话又从归档集合里冒出来"的成因。
 *
 * 只有在宿主根本没有 workspaceRegistry（旧版/裁剪版）时，才退回直写域运行时；
 * 注册表在、但接口不认这条记录时宁可不动并如实说明，也不制造分叉。
 */
async function pruneResidualReferences(ctx, ids, residual) {
  const steps = []
  if (!residual) return steps

  const wanted = new Set(ids)
  const strip = (list) => list.filter((id) => !wanted.has(id))
  const registry = ctx.get('workspaceRegistry')

  /** 老宿主才用的直写通道：只按 id 过滤，形状不认识就原样返回。 */
  const domain = ctx.get('storageDomain')
  let live
  try {
    live = domain && typeof domain.get === 'function' ? domain.get('workspace') : undefined
  } catch (error) {
    live = undefined
  }
  const directTable = !registry && live && typeof live.table === 'function' ? live.table('workspaces') : null
  const directGlobal = !registry && live && live.global && typeof live.global.get === 'function' ? live.global : null
  // 旧宿主直写通道：先读一遍，确实有可剪的 id 才 update —— 与官方路径"没东西就不写"的语义一致。
  let directEntries = null
  if (directTable) {
    try {
      directEntries = new Map(directTable.entries())
    } catch (error) {
      directEntries = null
    }
  }

  if (registry && typeof registry.get !== 'function') {
    return ['宿主的工作区登记接口不完整，悬空引用一条也没动']
  }

  // 1. 工作区成员：实体自己知道记录里到底有没有这个 id（不依赖已被日志删除影响的投影）。
  for (const key of residual.workspaces) {
    const entity = registry ? registry.get(key) : undefined
    if (entity && typeof entity.detachSession === 'function') {
      let moved = 0
      for (const id of ids) {
        if (!wanted.has(id)) continue
        try {
          await entity.detachSession(id)
          moved += 1
        } catch (error) {
          // 一条失败不拖累其余：最后还有 residualReferences 复核。
          steps.push(`从工作区「${entity.title || key}」移出 ${id} 失败：${reasonOf(error)}`)
        }
      }
      if (moved > 0) steps.push(`移出工作区「${entity.title || key}」的悬空引用`)
      continue
    }
    if (registry) {
      steps.push(`注册表里找不到工作区 ${key}，它的悬空引用没有动`)
      continue
    }
    if (!directTable) {
      steps.push(`宿主既没有工作区登记接口，也读不到工作区表，${key} 的悬空引用没有动`)
      continue
    }
    if (directEntries !== null) {
      const value = directEntries.get(key)
      const list = value && Array.isArray(value.sessionIds) ? value.sessionIds : null
      if (list === null || !list.some((id) => wanted.has(id))) continue
    }
    try {
      let changed = false
      await directTable.update(key, (record) => {
        const list = record && Array.isArray(record.sessionIds) ? record.sessionIds : null
        if (list === null) return record
        const next = strip(list)
        changed = next.length !== list.length
        return changed ? { ...record, sessionIds: next } : record
      })
      if (changed) steps.push('剪掉工作区记录里的悬空引用')
    } catch (error) {
      steps.push(`剪除工作区 ${key} 的悬空引用失败：${reasonOf(error)}`)
    }
  }

  // 2. 全局归档/置顶集合：优先官方接口（幂等，且会同时更新注册表内存）。
  const pruneGlobal = async (bucket, field, method, label) => {
    if (residual[bucket].length === 0) return
    if (registry) {
      if (typeof registry[method] !== 'function') {
        steps.push(`宿主的工作区登记接口没有 ${method}，${label}里的悬空引用没有动`)
        return
      }
      let moved = 0
      for (const id of residual[bucket]) {
        try {
          await registry[method](id)
          moved += 1
        } catch (error) {
          steps.push(`清理${label}里的 ${id} 失败：${reasonOf(error)}`)
        }
      }
      if (moved > 0) steps.push(`${label}里的悬空引用已清掉`)
      return
    }
    if (!directGlobal) {
      steps.push(`宿主没有工作区登记接口，${label}里的悬空引用没有动`)
      return
    }
    try {
      const current = directGlobal.get()
      const list = current && Array.isArray(current[field]) ? current[field] : null
      if (list === null) {
        steps.push(`${label}集合的形状不认识，未改动`)
        return
      }
      const next = strip(list)
      if (next.length === list.length) {
        steps.push(`${label}里没有可剪的引用，未改动`)
        return
      }
      await directGlobal.set({ ...current, [field]: next })
      steps.push(`${label}里的悬空引用已清掉`)
    } catch (error) {
      steps.push(`清理${label}里的悬空引用失败：${reasonOf(error)}`)
    }
  }
  await pruneGlobal('archived', 'archivedSessionIds', 'unarchiveSession', '归档')
  await pruneGlobal('pinned', 'pinnedSessionIds', 'unpinSession', '置顶')
  return steps
}

/** 登记记录里引用着的全部会话 id（读持久化记录，不改）。 */
function referencedSessionIds(ctx) {
  const domain = ctx.get('storageDomain')
  if (!domain || typeof domain.get !== 'function') return null
  let live
  try {
    live = domain.get('workspace')
  } catch (error) {
    return null
  }
  if (!live || typeof live.table !== 'function') return null

  const ids = new Set()
  try {
    for (const [, value] of live.table('workspaces').entries()) {
      const list = value && Array.isArray(value.sessionIds) ? value.sessionIds : []
      for (const id of list) if (typeof id === 'string') ids.add(id)
    }
    const global = live.global && typeof live.global.get === 'function' ? live.global.get() : null
    for (const field of ['archivedSessionIds', 'pinnedSessionIds']) {
      const list = global && Array.isArray(global[field]) ? global[field] : []
      for (const id of list) if (typeof id === 'string') ids.add(id)
    }
  } catch (error) {
    return null
  }
  return [...ids]
}

/** 磁盘上还有没有这个会话的东西（日志目录，或软链后面那个"不敢碰"的目录，或缓存）。 */
function hasArtifacts(sessionId) {
  const { dirs, skipped } = discoverSessionDirs(sessionId)
  return dirs.length > 0 || skipped.length > 0 || projectionCacheFiles(sessionId).length > 0
}

/**
 * "磁盘上有它的痕迹" —— 把持久化后端**自己指认的位置**也算进来。
 *
 * 只扫 `sessions/` 不够：后端可能把日志放在别的根下（配置不同、或将来换布局），
 * 那时 `hasArtifacts` 会误判成"这个会话还没落盘"，把一次正常删除当成"未落盘会话"处理 ——
 * 这正是要用 locate 兜住的那类漏判。
 */
function hasArtifactsEverywhere(ctx, snapshotsById, sessionId) {
  if (hasArtifacts(sessionId)) return true
  const located = locateArtifactDir(ctx.get('sessionPersistence'), snapshotsById.get(sessionId)?.header)
  return located !== undefined && acceptableArtifactDir(located, sessionId)
}

/** snapshot 列表 → id 索引（多处要按 id 找 header）。 */
function snapshotMapOf(snapshots) {
  const map = new Map()
  for (const entry of snapshots) {
    const id = entry?.header?.id
    if (typeof id === 'string') map.set(id, entry)
  }
  return map
}

/**
 * "这个会话 DSH 到处都看不见"的证据链（只读）。
 *
 * 删除、清扫、浏览器缓存清理三条路径共用同一份判定，避免三处逻辑各写一遍然后慢慢漂移。
 * 判定极度保守，凑不齐证据就 `reliable: false` —— 调用方必须把它当"不知道"：
 *   · 会话服务与存活判定服务都在，且会话列表**非空**（空列表多半是服务还没就绪，
 *     那时候"所有 id 都像不存在"，一刀切下去会把整个侧栏清空）；
 *   · 候选 id 必须是认识的形状，且不在会话列表里、不在跑、磁盘上没有日志目录或缓存。
 *
 * @returns {Promise<{ reliable: boolean, reason: string, isInvisible: (id: string) => boolean }>}
 */
async function invisibilityEvidence(ctx) {
  const none = (reason) => ({ reliable: false, reason, isInvisible: () => false })
  const persistence = ctx.get('sessionPersistence')
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  if (!persistence || typeof persistence.list !== 'function') return none('会话服务不可用')
  if (typeof agents?.get !== 'function' || typeof sessions?.get !== 'function') return none('无法判断宿主是否仍持有会话')
  const known = await listSessions(ctx)
  if (known === null) return none('读不到会话列表，无法安全判断')
  if (known.length === 0) return none('会话列表为空，无法安全判断')
  const byId = snapshotMapOf(known)
  const listed = new Set(byId.keys())
  return {
    reliable: true,
    reason: '',
    isInvisible(id) {
      if (!isSessionId(id) || listed.has(id) || processHoldsSession(ctx, id, true) !== false) return false
      try {
        return !hasArtifactsEverywhere(ctx, byId, id)
      } catch (error) {
        return false
      }
    },
  }
}

/**
 * 注册表里引用着、但 DSH 到处都看不见的会话 id —— 也就是界面上的"未分组"幽灵条目。
 * 只读：只盘点，不写任何东西。
 */
async function danglingCandidates(ctx) {
  const evidence = await invisibilityEvidence(ctx)
  if (!evidence.reliable) return { reliable: false, reason: evidence.reason, ids: [], total: 0, truncated: false }
  const referenced = referencedSessionIds(ctx)
  if (referenced === null) return { reliable: false, reason: '拿不到注册表记录', ids: [], total: 0, truncated: false }
  const all = referenced.filter((id) => evidence.isInvisible(id))
  const ids = all.slice(0, MAX_DANGLING_IDS)
  return { reliable: true, reason: '', ids, total: all.length, truncated: all.length > ids.length }
}

/**
 * 给浏览器半区看的悬空引用预览（只读）。
 * 对话框把 `count` 与 `ids` 摆出来，用户确认删除时再把这些 id 原样回传 ——
 * "查的时候预览、删的时候按列表执行"，中间不会有谁被悄悄剪掉。
 */
async function danglingPreview(ctx) {
  const candidates = await danglingCandidates(ctx)
  return {
    reliable: candidates.reliable,
    reason: candidates.reason,
    count: candidates.ids.length,
    ids: candidates.ids,
    total: candidates.total,
    truncated: candidates.truncated,
  }
}

/**
 * 剪掉悬空引用（被旧版本删掉的会话，日志早就没了，但 `workspace.json` 里还挂着它的 id）。
 * 只动登记，绝不碰任何文件；调用方必须先拿到证据（invisibilityEvidence）与残留清单。
 */
async function pruneDanglingReferences(ctx, ids) {
  if (ids.length === 0) return { pruned: 0, steps: [] }
  const residual = residualReferences(ctx, ids)
  if (!residual) return { pruned: 0, steps: [] }
  const before = referencedSessionIds(ctx)
  const steps = await pruneResidualReferences(ctx, ids, residual)
  const after = referencedSessionIds(ctx)
  // 只把"剪之前确实被引用、剪之后确实不再被引用"的 id 计入战果；
  // 官方接口幂等、并发写回、另一个 bucket 还引用着，都不能算清理成功。
  const beforeSet = new Set(before || [])
  const afterSet = new Set(after || [])
  const pruned = before === null || after === null
    ? 0
    : ids.filter((id) => beforeSet.has(id) && !afterSet.has(id)).length
  return { pruned, steps }
}

/**
 * 清扫历史遗留的悬空引用（导出给显式调用与测试；**不再挂在 GET 上**）。
 *
 * 为什么不再"顺手"扫：那样一次只读的查看就变成了没人确认过的写入，
 * 而且"改了哪些东西"是在用户点开对话框之后才告诉他的。现在改成：
 * 查的时候只预览（danglingPreview），删除确认时才按预览列表剪（pruneDanglingReferences）。
 * 这个函数保留下来，供运维/测试显式调用，语义与过去一致。
 */
async function sweepDanglingReferences(ctx) {
  const result = { swept: 0, steps: [], skipped: '' }
  const candidates = await danglingCandidates(ctx)
  if (!candidates.reliable) {
    result.skipped = candidates.reason
    return result
  }
  const pruned = await pruneDanglingReferences(ctx, candidates.ids)
  result.steps = pruned.steps
  result.swept = pruned.pruned
  result.total = candidates.total
  result.truncated = candidates.truncated === true
  return result
}

/* ── 删：本体 ──────────────────────────────────────────────────────────── */

/**
 * 删除后的复核：磁盘上还看得见的痕迹。
 *
 * 两条来源都要看：我们扫出来的目录，以及持久化服务**自己指认**的目录
 * （后者可能不在会话根下，只扫根就会漏掉它 —— 那就成了"假报删干净"）。
 */
function remainingArtifacts(ctx, targets, snapshotsById = new Map()) {
  const remaining = []
  for (const target of targets) {
    // 用"能删的真目录"这一支：删不掉的、以及本来就不敢碰的（软链/联接后面那些）都算残留。
    const { dirs, skipped } = discoverSessionDirs(target)
    for (const dir of [...dirs, ...skipped]) remaining.push(displayPath(dir))
    const located = locateArtifactDir(ctx.get('sessionPersistence'), snapshotsById.get(target)?.header)
    if (located !== undefined && acceptableArtifactDir(located, target)) remaining.push(displayPath(located))
    for (const cacheFile of projectionCacheFiles(target)) remaining.push(displayPath(cacheFile))
  }
  return [...new Set(remaining)]
}

/**
 * 临时目录里的 spill 残留。
 *
 * 单独一条通道，故意**不参与**"删没删干净"的判定：spill 是临时缓存，
 * 官方本来就会按年龄回收，而且别的进程可能正在往里写（写完会重新建目录）。
 * 让它把一次成功的删除判成失败、进而把工作区登记也留在那儿，代价远大于收益。
 * 所以这里只如实报出来，让用户知道"临时目录里还剩这些"。
 */
function remainingSpill(targets) {
  return spillDirsFor(targets).map(displaySpill)
}

/**
 * 删一个工件路径。Windows 上杀软/索引器会短暂占用目录：只对"占用类"错误做
 * 有限次退避重试，仍失败才交给调用方如实上报。
 */
async function removeArtifact(target, recursive, archiveBlocker) {
  let lastError
  for (const delay of [0, 60, 180]) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      const blocker = archiveBlocker?.()
      if (blocker) throw new Error(blocker)
      const stats = artifactStat(target)
      if (!stats) return false
      const correctType = recursive ? stats.isDirectory() && !stats.isSymbolicLink() : stats.isFile()
      if (!correctType) throw new Error('工件类型已变化，拒绝删除')
      await fsp.rm(target, { recursive, force: true })
      return true
    } catch (error) {
      lastError = error
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE'].includes(error && error.code)) break
    }
  }
  throw lastError
}

/** 正在删除中的会话 id：同一会话（或同一批目标里的任意一个）只允许一个删除在跑。 */
const deletesInFlight = new Set()

/**
 * 删除一个会话（可选连带它派生出来的可见会话）。
 *
 * @param {object} [options]
 * @param {string[]} [options.dangling] 对话框里**预览过**的悬空引用 id。
 *   只剪这几个（而且要重新过一遍"确实看不见"的证据）—— 用户确认的是他看过的那份清单，
 *   不是在删除瞬间重新扫出来的另一份。没传就一条都不剪。
 * @param {string[]} [options.extraRoots] 用户在对话框里**勾选的派生会话（fork）** id。
 *   每个都必须在宿主自己走出来的血缘里（见 inspectSession 的 `optionalForks`），
 *   而且自己也得是已归档的 —— 否则 400，什么都不删。
 * @param {boolean} [options.stop] 为 true 时允许"先停掉正在跑的工作再删"
 *   （派发官方 `workspace/session-stop`，停完**重新验一次**，还忙就拒删）。
 * @returns {Promise<{ status: number, payload: object }>} status 即 HTTP 状态码。
 */
async function deleteSession(ctx, sessionId, options = {}) {
  if (!isSessionId(sessionId)) {
    return { status: 400, payload: { ok: false, error: '缺少或非法的会话 id' } }
  }
  if (deletesInFlight.has(sessionId)) {
    return { status: 409, payload: { ok: false, error: '这个会话正在删除中，请等上一次删除结束后再试' } }
  }
  const reserved = new Set([sessionId])
  deletesInFlight.add(sessionId)
  try {
    return await deleteSessionLocked(ctx, sessionId, options, reserved)
  } catch (error) {
    return { status: 500, payload: { ok: false, error: reasonOf(error) } }
  } finally {
    for (const id of reserved) deletesInFlight.delete(id)
  }
}

/** 真正的删除流程；并发闸门与 id 校验由 deleteSession 负责。 */
async function deleteSessionLocked(ctx, sessionId, options = {}, reserved = new Set([sessionId])) {
  // 形状不对就拒绝，不静默丢弃：用户以为剪了，其实没剪，比报错更糟。
  if (options.dangling !== undefined && !Array.isArray(options.dangling)) {
    return { status: 400, payload: { ok: false, error: '悬空引用清单必须是数组' } }
  }
  if (options.extraRoots !== undefined && !Array.isArray(options.extraRoots)) {
    return { status: 400, payload: { ok: false, error: '派生会话清单必须是数组' } }
  }
  const badDangling = (options.dangling || []).find((id) => !isSessionId(id))
  if (badDangling !== undefined) {
    return { status: 400, payload: { ok: false, error: `悬空引用清单里有非法的会话 id：${String(badDangling)}` } }
  }
  const badExtra = (options.extraRoots || []).find((id) => !isSessionId(id))
  if (badExtra !== undefined) {
    return { status: 400, payload: { ok: false, error: `派生会话清单里有非法的会话 id：${String(badExtra)}` } }
  }
  const previewedDangling = [...new Set(options.dangling || [])]
  if (previewedDangling.length > MAX_DANGLING_IDS) {
    return { status: 400, payload: { ok: false, error: `一次最多处理 ${MAX_DANGLING_IDS} 条悬空引用，请清理后再试` } }
  }
  const requestedExtras = [...new Set(options.extraRoots || [])]
  if (requestedExtras.length > MAX_TARGETS) {
    return { status: 400, payload: { ok: false, error: `一次最多勾选 ${MAX_TARGETS} 个派生会话` } }
  }
  const inspected = await inspectDeletion(ctx, sessionId, requestedExtras)
  const { info, targets, snapshotsById, ownersByTarget, plan: previewPlan } = inspected
  if (inspected.status !== 200) {
    return { status: inspected.status, payload: { ok: false, error: inspected.error, session: info } }
  }
  const previewChanged = () => ({
    status: 409,
    payload: { ok: false, code: 'PREVIEW_CHANGED', error: '删除清单已变化，请重新预览并确认' },
  })
  if (options.requirePreview && options.preview !== info.preview) return previewChanged()
  if (options.requirePreview && previewedDangling.some((id) => !info.dangling.ids.includes(id))) return previewChanged()
  const roots = [sessionId, ...requestedExtras]
  const archiveBlocker = () => {
    for (const id of roots) {
      const [blocker] = archivedBlockers(ctx, id)
      if (blocker) return id === sessionId ? blocker : `派生会话「${id}」：${blocker}`
    }
    return null
  }
  const ownersOf = (id) => [...(ownersByTarget.get(id) || [])]

  // 把整批目标原子地占住：只占根会话不够 —— 两次删除的根不同、目标集合却可能重叠
  // （删父会话时连带删子会话，同时有人直接删那个子会话），最后会互相删对方的文件。
  const conflicts = targets.filter((id) => deletesInFlight.has(id) && !reserved.has(id))
  if (conflicts.length > 0) {
    return { status: 409, payload: { ok: false, error: `会话「${conflicts[0]}」正在另一次删除里，请等它结束后再试`, session: info } }
  }
  for (const id of targets) {
    if (reserved.has(id)) continue
    deletesInFlight.add(id)
    reserved.add(id)
  }

  // 检查与动手之间隔了读标题、探目录这些活，可能已经过去几百毫秒：
  // 真正落刀之前把内容闸门再确认一次 —— 归档状态可能被取消，注销能力也可能变了。
  const rejected = (error) => ({ status: 409, payload: { ok: false, error, session: info } })
  const blocker = archiveBlocker() || memoryBlockers(ctx, targets, sessionId, [...snapshotsById.values()])[0]
  if (blocker) return rejected(blocker)

  // "还有工作在跑"：不带 stop 就拒（把清单摆给用户看）；带了 stop 就先停、再复核一次。
  let stoppedActivity = false
  let stopSteps = []
  /** "还有工作在跑"的快照；返回 null 表示**查不到**（调用方 fail closed）。 */
  const busyNow = async () => {
    const activities = await gatherActivities(ctx, targets)
    if (activities === null) {
      // 有瀑布却问不出来（handler 抛错）时不能退回弱判定：那可能漏掉调度任务。
      if (typeof ctx.waterfall === 'function') return null
      const running = await runningSessionIds(ctx)
      if (running === null) return null
      const busy = new Set(targets.filter((id) => running.has(id)))
      for (const id of targets) {
        const jobs = countActiveJobs(ctx, id)
        if (jobs === null) return null
        if (jobs > 0) busy.add(id)
      }
      return busy
    }
    return new Set(targets.filter((id) => describeActivities(activities.get(id)).length > 0))
  }

  const busyBefore = await busyNow()
  if (busyBefore === null) {
    return { status: 409, payload: { ok: false, error: '查不到会话的运行状态，为安全起见拒绝删除', session: info } }
  }
  if (busyBefore.size > 0) {
    if (options.stop !== true) {
      return {
        status: 409,
        payload: {
          ok: false,
          error: `还有 ${busyBefore.size} 个会话没跑完（${[...busyBefore].join('、')}）：请勾选「先停掉正在跑的工作」再删`,
          session: info,
          busy: info.busy,
        },
      }
    }
    const beforeStop = archiveBlocker()
    if (beforeStop) return rejected(beforeStop)
    stopSteps = await stopActivities(ctx, [...busyBefore])
    stoppedActivity = true
    const busyAfter = await busyNow()
    if (busyAfter === null || busyAfter.size > 0) {
      return {
        status: 409,
        payload: {
          ok: false,
          error: `已经请求停止，但 ${busyAfter === null ? '无法确认是否停下' : [...busyAfter].join('、')} 还在跑；为安全起见这次不删（可以稍后重试）`,
          session: info,
          busy: info.busy,
          stopSteps,
        },
      }
    }
  }

  // ① 关掉这些会话名下的终端。必须排在"注销 Agent"之前 —— `terminals.list` 按**对象身份**
  //    匹配属主，而注销之后 `agents.get(id)` 就取不到那个活对象了。
  //    终端不属于任何准入族，服务自己的属主回收要等 Agent 释放，那时日志早就没了。
  const beforeClose = archiveBlocker()
  if (beforeClose) return rejected(beforeClose)
  const terminals = await closeOwnedTerminals(ctx, targets)

  // ② 让宿主忘掉它：把目标从本进程的 session store 与 agent registry 里注销。
  //    也必须排在删文件之前 —— 注销失败就什么都不删（文件还在，会话还在，可以重试）；
  //    反过来先删文件再注销失败，就会留下一条刷新去不掉的「未分组」幽灵。
  const beforeForget = archiveBlocker()
  if (beforeForget) return rejected(beforeForget)
  const forget = await forgetSessions(ctx, targets)

  // ③ 复核"宿主还记不记得它"：两张进程内注册表 + 持久层那份内存记录，一个都不许剩。
  //    这是**成功的前提**：只要还有一处记得它，就回 409 并且一个文件都不动（可重试），
  //    绝不做"删了文件却留下幽灵"的半吊子成功。
  const keptInMemory = await stillRemembered(ctx, targets)
  const listedAfterForget = await listSessions(ctx)
  if (listedAfterForget === null) {
    return {
      status: 409,
      payload: {
        ok: false,
        error: '注销后读不到会话列表，无法确认宿主是否已经忘掉它；为安全起见这次不删（文件与登记都保持原样，可以重试）。',
        session: info,
        forget,
        keptInMemory,
      },
    }
  }
  const stillPending = pendingTargetsOf(ctx, listedAfterForget, targets)
  const notForgotten = [...new Set([...keptInMemory, ...stillPending])]
  if (notForgotten.length > 0) {
    return {
      status: 409,
      payload: {
        ok: false,
        error: `宿主进程仍然记着会话「${notForgotten[0]}」，没能把它从内存里注销掉；为安全起见这次不删（文件与登记都保持原样，可以重试）。`,
        session: info,
        forget,
        keptInMemory: notForgotten,
      },
    }
  }

  // 注销可能给未落盘的会话补写日志。再次核对血缘和路径，只放行已预告的落盘工件。
  const listedForPlan = await listSessions(ctx)
  if (listedForPlan === null) return rejected('删除前读不到会话列表，无法复核删除清单')
  const finalTargets = new Set(roots)
  for (const id of roots) {
    const family = await relativesOf(ctx, listedForPlan, id)
    if (family.invalid.length > 0) return previewChanged()
    if (id === sessionId) {
      const forks = new Set(family.forks.map(({ header }) => header.id))
      if (requestedExtras.some((fork) => !forks.has(fork))) return previewChanged()
    }
    for (const entry of family.subagents) finalTargets.add(entry.header.id)
    for (const extra of family.extra) finalTargets.add(extra)
  }
  if (finalTargets.size !== targets.length || targets.some((id) => !finalTargets.has(id))) return previewChanged()
  for (const [id, snapshot] of snapshotMapOf(listedForPlan)) snapshotsById.set(id, snapshot)
  const plan = await collectRemovalPlan(ctx, targets, snapshotsById)
  const { paths, cachePaths, spillPaths } = plan
  const previewedPaths = new Set(previewPlan.paths)
  const flushed = new Set(forget.flushed.filter((id) => info.pendingTargets.includes(id)))
  const approvedPath = (target) => previewedPaths.has(target) || flushed.has(plan.pathOwners.get(target))
  const approvedSpill = new Set(previewPlan.spillPaths)
  const approvedSlugs = new Set(previewPlan.emptyDirs)
  for (const dir of plan.emptyDirs) {
    if (paths.some((target) => path.dirname(target) === dir && flushed.has(plan.pathOwners.get(target)))) approvedSlugs.add(dir)
  }
  if (plan.skipped.length > 0 || paths.some((target) => !approvedPath(target))
    || spillPaths.some((target) => !approvedSpill.has(target))
    || plan.emptyDirs.some((dir) => !approvedSlugs.has(dir))) return previewChanged()

  const beforeDisk = archiveBlocker()
  if (beforeDisk) return rejected(beforeDisk)

  const removed = []
  const failures = []
  const remove = async (target, recursive) => {
    try {
      if (await removeArtifact(target, recursive, archiveBlocker)) removed.push(displayPath(target))
      return true
    } catch (error) {
      failures.push({ path: displayPath(target), error: reasonOf(error) })
      return false
    }
  }

  // 整批缓存必须先删净，才能删除任何一份不可重建的日志。
  for (const target of cachePaths) await remove(target, false)
  if (failures.length === 0) {
    try {
      for (const id of targets) {
        for (const target of projectionCacheFiles(id)) {
          failures.push({ path: displayPath(target), error: '投影缓存仍然存在' })
        }
      }
    } catch (error) {
      failures.push({ path: displayPath(PROJECTION_ROOT), error: reasonOf(error) })
    }
  }
  if (failures.length === 0) {
    for (const target of paths) {
      if (!cachePaths.has(target) && !await remove(target, true)) break
    }
  }

  // 读取失败也不能摘登记，清单保留已执行的删除和无法复核的位置。
  let remaining = []
  try {
    remaining = remainingArtifacts(ctx, targets, snapshotsById)
  } catch (error) {
    failures.push({ path: '磁盘复核', error: reasonOf(error) })
  }
  const clean = failures.length === 0 && remaining.length === 0

  // spill 单独一遍，尽力而为：它的失败**不参与** clean 判定。
  // spill 是临时缓存（官方本来按 30 天年龄回收），而且别的进程可能正在往里写，
  // 让"临时目录里一个文件没删掉"把整次删除判成失败、进而把工作区登记也留在那儿，
  // 代价远大于收益。所以删得掉就删，删不掉就如实报（见 spillRemaining）。
  if (clean) {
    for (const spillDir of spillPaths) {
      try {
        if (await removeArtifact(spillDir, true)) removed.push(displaySpill(spillDir))
      } catch (error) {
        // 记在 spillRemaining 里如实回报，不改结论。
      }
    }
  }

  // 登记只在"确实删干净"之后摘：文件没删净就摘登记，会把日志变成侧栏里看不见、
  // 也没有入口可重试的孤儿 —— 那比"没删掉"更糟。
  let registry
  let danglingPruned = 0
  let emptyDirsRemoved = []
  if (clean) {
    registry = { available: Boolean(ctx.get('workspaceRegistry')), steps: [] }
    for (const target of targets) {
      const detached = await detachFromRegistry(ctx, target, ownersOf(target))
      registry.available = detached.available
      registry.steps.push(...detached.steps)
    }
    // 再复核一次持久化记录：官方接口只能摘掉投影看得见的引用，日志已经删了，
    // 悬空 id 只可能躲在记录里 —— 不剪掉它，界面上就会多出一个"未分组"的幽灵会话。
    const residual = residualReferences(ctx, targets)
    const pruned = await pruneResidualReferences(ctx, targets, residual)
    const steps = [...registry.steps, ...pruned]
    registry = { ...registry, steps, residual }

    // 用户确认过的那些历史遗留悬空引用：按预览列表剪，而且**重新验一遍**——
    // 从"看一眼"到"点确认"之间可能有会话被恢复，那时它就不再是悬空引用了。
    if (previewedDangling.length > 0) {
      const evidence = await invisibilityEvidence(ctx)
      const stillGone = evidence.reliable ? previewedDangling.filter((id) => evidence.isInvisible(id)) : []
      const swept = await pruneDanglingReferences(ctx, stillGone)
      danglingPruned = swept.pruned
      if (swept.steps.length > 0) registry = { ...registry, steps: [...registry.steps, ...swept.steps] }
    }

    // 删完再复核一次：官方接口也可能因为并发/旧宿主而没摘干净。文件已经删了，
    // 这里不谎报"登记也没了"——把残留原样带回去，让界面明确提示"还需要再清一次"。
    const residualAfter = residualReferences(ctx, targets)
    const registryClean = residualAfter === null
      ? null
      : residualAfter.workspaces.length === 0 && residualAfter.archived.length === 0 && residualAfter.pinned.length === 0
    if (registryClean === false) {
      registry = {
        ...registry,
        steps: [...registry.steps, '复核发现工作区登记里仍有这些会话的引用，可能被其他进程写回；文件已删除，登记没有清干净'],
      }
    }
    registry = { ...registry, residual: residualAfter, clean: registryClean }

    // 最后由"空目录"收尾：只收本次删掉的那些会话所在、且**此刻确实为空**的容器目录。
    emptyDirsRemoved = pruneEmptySlugDirs(approvedSlugs)
  } else {
    registry = { available: true, steps: [], kept: true }
  }

  if (!clean) {
    return {
      status: 500,
      payload: {
        ok: false,
        error: remaining.length > 0
          ? `还有 ${remaining.length} 项留在磁盘上（可能被占用，或位于软链/联接之后）；已经删掉的文件无法恢复，终端与宿主内存的注销也无法回滚，工作区登记确实保持原样。可重试或手动删除。`
          : `有 ${failures.length} 项没能删除（可能被其他程序占用）；已经删掉的文件无法恢复，终端与宿主内存的注销也无法回滚，工作区登记确实保持原样。可重试或手动删除。`,
        removed,
        failures,
        remaining,
        registry,
      },
    }
  }
  return {
    status: 200,
    payload: {
      ok: true,
      removed,
      registry,
      /** 登记复核结果：true=清干净，false=还引用着（文件已删、登记没清），null=读不到。 */
      registryClean: registry.clean,
      title: info.title,
      subagents: info.subagents,
      /** 浏览器半区按这份清单清理本地状态与缓存（只含本次真的删掉的 id）。 */
      deletedIds: targets,
      /** 连带删掉的派生会话（用户勾选的那些）。 */
      extraRoots: requestedExtras,
      /** 从宿主内存里注销掉的会话 id（这就是"让宿主忘掉它"的结果）。 */
      forgotten: forget.forgotten,
      /** 注销过程中补写落盘的会话（原本只在内存里的空白会话）。 */
      flushed: forget.flushed,
      /** 关掉的终端（会话名下的 shell 不会留在进程里）。 */
      terminalsClosed: terminals.closed,
      /** 是否先停掉了正在跑的工作，以及停了哪几个。 */
      stoppedActivity,
      stopSteps,
      /** 过程中的异常说明（有内容不代表失败，但值得看一眼）。 */
      warnings: [...info.warnings, ...terminals.steps, ...forget.steps],
      /** 删完之后宿主列表里**还看得见**的目标（正常为空；非空就如实报，不假报删干净）。 */
      memoryRemaining: await stillListing(ctx, targets),
      danglingPruned,
      emptyDirsRemoved,
      /** 临时目录里没删掉的 spill 残留（如实报出来，但不影响"会话已删干净"的结论）。 */
      spillRemaining: remainingSpill(targets),
      note: info.materialized ? '' : '磁盘上没有找到这个会话的文件，本次只清理了工作区登记',
    },
  }
}

/* ── HTTP 层 ───────────────────────────────────────────────────────────── */

/**
 * 读请求体（带上限）。
 * 超限时不掐连接、而是抛一个可识别的错误：路由据此回 413，客户端才拿得到原因
 * （req.destroy() 会让浏览器只看到 "Failed to fetch"）。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks = []
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        settled = true
        const error = new Error('请求体过大')
        error.tooLarge = true
        if (typeof req.resume === 'function') req.resume()
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    // 客户端中途断开时流既不 end 也不 error：不接住就会留下一个永不 settle 的 Promise。
    const aborted = () => {
      if (settled) return
      settled = true
      reject(new Error('客户端中断了请求'))
    }
    req.on('aborted', aborted)
    req.on('close', () => {
      if (!req.complete) aborted()
    })
  })
}

/** 统一的 JSON 响应。重复调用是安全的：已经回过就不再写第二次。 */
function respond(res, status, payload, extraHeaders) {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(status, extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS)
  res.end(JSON.stringify(payload))
}

/**
 * 路由处理：GET 查、POST 删、其它 405。
 * 任何未预期异常都收敛成 500 + 一行原因，绝不把栈丢给前端。
 */
async function handleRequest(ctx, req, res) {
  try {
    const method = (req.method || 'GET').toUpperCase()
    // 删除请求过"严格版"同源闸门（额外要求 Host 是 IP 字面量，挡 DNS rebinding）。
    if (!isSameOrigin(req, method === 'POST')) {
      respond(res, 403, { ok: false, error: '拒绝跨站请求' })
      return
    }

    if (method === 'GET' || method === 'HEAD') {
      const url = new URL(req.url || '/', 'http://localhost')

      const sessionId = url.searchParams.get('id') || ''
      if (!isSessionId(sessionId)) {
        respond(res, 400, { ok: false, error: '缺少或非法的会话 id' })
        return
      }
      // 这里**不再**顺手清扫悬空引用：一次只读的查看不该产生写入。
      // 悬空引用只做预览（info.dangling），要不要剪由后面的删除确认决定。
      const extraRoots = [...new Set(url.searchParams.getAll('extraRoots'))]
      if (extraRoots.length > MAX_TARGETS || extraRoots.some((id) => !isSessionId(id))) {
        respond(res, 400, { ok: false, error: '派生会话清单不合法或超过上限' })
        return
      }
      const { info } = await inspectDeletion(ctx, sessionId, extraRoots)
      respond(res, 200, { ok: true, session: info })
      return
    }

    if (method === 'POST') {
      let body
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch (error) {
        if (error && error.tooLarge) {
          // 已经回包了就别再让客户端继续灌：带 connection: close，让这条连接到此为止。
          respond(res, 413, { ok: false, error: '请求体过大' }, { connection: 'close' })
          return
        }
        respond(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }

      // 显式维护动作：清扫历史遗留的悬空引用（不删任何会话文件）。
      // 用于旧版本删除后留在 workspace 登记里的幽灵条目：日志已经没了，
      // 再对那条会话发删除请求只会 404，所以给它一条单独的、需要确认标记的入口。
      if (body && body.repair === true) {
        if (body.confirm !== CONFIRM_TOKEN) {
          respond(res, 400, { ok: false, error: '缺少维护确认标记' })
          return
        }
        const repair = await sweepDanglingReferences(ctx)
        respond(res, 200, { ok: true, repair })
        return
      }

      const sessionId = body && typeof body.id === 'string' ? body.id : ''
      if (!isSessionId(sessionId)) {
        respond(res, 400, { ok: false, error: '缺少或非法的会话 id' })
        return
      }
      if (!body || body.confirm !== CONFIRM_TOKEN) {
        respond(res, 400, { ok: false, error: '缺少删除确认标记' })
        return
      }
      // `dangling` 是用户在对话框里**看过**的那份悬空引用清单：只剪这些，不做全库大扫除。
      // `extraRoots` 是用户勾选要连带删除的派生会话（宿主自己会再验一遍它们在不在血缘里）。
      // `stop` 表示"先停掉正在跑的工作再删"（停完还要复核一次，还忙就拒）。
      const { status, payload } = await deleteSession(ctx, sessionId, {
        dangling: body.dangling,
        extraRoots: body.extraRoots,
        stop: body.stop === true,
        preview: body.preview,
        requirePreview: true,
      })
      respond(res, status, payload)
      return
    }

    respond(res, 405, { ok: false, error: '不支持的请求方法' })
  } catch (error) {
    // 连回包都失败（比如连接已断）时不再往外抛：这条路由永远不产生未处理的 rejection。
    try {
      respond(res, 500, { ok: false, error: reasonOf(error) })
    } catch (ignored) {
      // 无处可写，认了。
    }
  }
}

/* ── 插件体 ────────────────────────────────────────────────────────────── */

/**
 * 宿主插件体。
 *
 * 用 `ctx.inject(['webServer'], cb)` 局部等待服务，而不是在包上声明 `inject: ['webServer']`，
 * 理由是后者会把整个 apply 推迟到服务就绪之后：本机另一个插件（dsh-codex-theme）在桌面端
 * 实测过"apply 迟到就可能整条插件错过启动时一次性收集的注入窗口"，而路由晚注册本身是安全的
 * （webServer 在属主注册之前回 404，DSH 明确支持后注册）。代价：若这个 composition 里
 * 永远没有 webServer，本插件就没有路由 —— 界面上的表现是请求 404，不会静默改坏任何东西。
 */
function apply(ctx) {
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (req, res) => handleRequest(ctx, req, res),
      }),
      'session-manager: 删除路由',
    )
  })
}

export {
  apply,
  acceptableArtifactDir,
  archivedBlockers,
  archivedStateOf,
  catalogDescendants,
  closeOwnedTerminals,
  collectRemovalPlan,
  danglingPreview,
  deleteSession,
  describeActivities,
  emptySlugDirsAfter,
  evictionAvailable,
  evictionGaps,
  evictionPrimitive,
  forgetSessions,
  gatherActivities,
  handleRequest,
  inspectSession,
  invisibilityEvidence,
  isSameOrigin,
  isSessionId,
  locateArtifactDir,
  memoryBlockers,
  pendingTargetsOf,
  processHoldsSession,
  pruneEmptySlugDirs,
  pruneResidualReferences,
  registryPlan,
  relativesOf,
  spillDirsFor,
  spillSessionName,
  stillListing,
  stillRemembered,
  stopActivities,
  sweepDanglingReferences,
  ROUTE,
  CONFIRM_TOKEN,
  DSH_HOME,
  SESSIONS_ROOT,
  PROJECTION_ROOT,
}
export default { name: 'session-manager', apply }
