// 浏览器半区的行为验证：在浏览器形状的沙箱里跑构建产物。
//
// 沙箱尽量贴近真实运行时，好让"能过测试"真的等于"能用"：
//   · 一个够用的微型 React：按组件实例保存 hook 槽、尊重 deps、先跑清理再跑副作用、
//     把 ref 接到宿主元素上（于是焦点、Tab 循环这些行为都能被断言）；
//   · 一个有 head 的假 document：样式表必须真的被插进去（客户端没有 styles 服务，
//     这是插件最容易静默失效的一环）；
//   · 一个真的会记数的假 localStorage 与假 location：清理范围与"刷新有没有被触发"
//     都要能被逐条断言 —— 这一版插件**会**动本地状态，所以"动了哪些、没动哪些"
//     必须像删除文件那样被盯住；
//   · 假 ctx 只提供**真实存在**的客户端服务（slots / locale），不提供 styles。
//
// 用法：node scripts/verify-client.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = path.join(root, 'lib', 'client.bundle.js')

const checks = []
function check(label, ok, detail) {
  checks.push({ label, ok: Boolean(ok), detail })
}

/* ── 浏览器形状的沙箱 ──────────────────────────────────────────────────── */

const listeners = new Map()
const head = {
  children: [],
  appendChild(node) {
    node.parentNode = head
    head.children.push(node)
  },
  removeChild(node) {
    const index = head.children.indexOf(node)
    if (index >= 0) head.children.splice(index, 1)
    node.parentNode = null
  },
}

/** 一个假的宿主元素：有 focus，也能像真 DOM 一样被 querySelectorAll。 */
function createElement(tagName) {
  const node = {
    tagName,
    textContent: '',
    attributes: {},
    parentNode: null,
    setAttribute(name, value) {
      node.attributes[name] = String(value)
    },
    focus() {
      document.activeElement = node
    },
    querySelectorAll: () => [],
  }
  return node
}

const focusedBefore = { focus() { document.activeElement = focusedBefore } }
const document = {
  head,
  body: { appendChild() {} },
  documentElement: { setAttribute() {}, removeAttribute() {} },
  activeElement: focusedBefore,
  createElement,
  querySelector(selector) {
    const match = /^style\[data-plugin-css="(.+)"\]$/.exec(selector)
    if (!match) return null
    return head.children.find((node) => node.attributes['data-plugin-css'] === match[1]) || null
  },
  addEventListener(type, listener) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(listener)
  },
  removeEventListener(type, listener) {
    if (listeners.has(type)) listeners.get(type).delete(listener)
  },
}
const fire = (type, event) => {
  for (const listener of [...(listeners.get(type) || [])]) listener(event)
}

/**
 * 假的 localStorage：真实的键值语义（length / key / getItem / setItem / removeItem）。
 * 这一版插件**会**动它，所以它必须像真的那样工作，"清理了哪些、留下了哪些"才可信。
 */
const storageData = new Map()
const localStorage = {
  get length() {
    return storageData.size
  },
  key: (index) => [...storageData.keys()][index] ?? null,
  getItem: (key) => (storageData.has(String(key)) ? storageData.get(String(key)) : null),
  setItem: (key, value) => { storageData.set(String(key), String(value)) },
  removeItem: (key) => { storageData.delete(String(key)) },
}
const seedStorage = (entries) => {
  storageData.clear()
  for (const [key, value] of Object.entries(entries)) storageData.set(key, typeof value === 'string' ? value : JSON.stringify(value))
}
const snapshotStorage = () => Object.fromEntries(storageData)

let registration
const sandbox = {
  window: { __ModuleLoader__: { load: (entry) => { registration = entry } } },
  console,
  localStorage,
}
sandbox.window.document = document
sandbox.window.localStorage = localStorage
sandbox.document = document
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { filename: 'client.bundle.js' })

check('bundle 自注册', registration !== undefined)
check('注册 id 正确', registration && registration.id === 'dsh-session-manager-delete', registration && registration.id)

/* ── 微型 React：按组件实例保存 hook 槽，尊重 deps，ref 接到宿主元素 ───── */

const componentHooks = new Map()
/** 本次顶层渲染碰到的组件键：没碰到的就是"卸载了"，槽位要丢掉（真 React 就是这样）。 */
const touchedComponents = new Set()
let currentSlots = null
let pendingEffects = []
let pendingCleanups = []

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children }, children }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useRef(initial) {
    const index = currentSlots.index += 1
    if (!(index in currentSlots.slots)) currentSlots.slots[index] = { current: initial === undefined ? null : initial }
    return currentSlots.slots[index]
  },
  useEffect(effect, deps) {
    const index = currentSlots.index += 1
    const previous = currentSlots.slots[index]
    const changed = !previous || !deps || !previous.deps ||
      deps.length !== previous.deps.length || deps.some((value, at) => !Object.is(value, previous.deps[at]))
    if (!changed) return
    if (previous && typeof previous.cleanup === 'function') pendingCleanups.push(previous.cleanup)
    const slot = { deps, cleanup: undefined }
    currentSlots.slots[index] = slot
    pendingEffects.push(() => {
      const cleanup = effect()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    })
  },
}

/** 宿主元素的身份按树中位置复用：真 DOM 节点跨渲染是同一个对象，测试也得这样。 */
const hostNodes = new Map()

function render(node, path = '') {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((child, index) => render(child, `${path}.${index}`))

  if (typeof node.type === 'function') {
    // 组件实例按"类名 @ 树中位置"识别：同一个组件挂在两处（两个对话框都用 Modal）
    // 必须是两个实例，否则一个的 hook 槽会被另一个覆盖。
    const identity = `${node.type.name || 'anonymous'}@${path}`
    touchedComponents.add(identity)
    if (!componentHooks.has(identity)) componentHooks.set(identity, { index: -1, slots: [] })
    const outer = currentSlots
    currentSlots = componentHooks.get(identity)
    currentSlots.index = -1
    let output
    try {
      output = node.type(node.props)
    } finally {
      currentSlots = outer
    }
    return render(output, path)
  }

  const children = node.props && node.props.children
  const rendered = hostNodes.get(path) || { type: node.type, props: {} }
  hostNodes.set(path, rendered)
  rendered.type = node.type
  rendered.props = { ...node.props, children: Array.isArray(children)
    ? children.map((child, index) => render(child, `${path}.${index}`))
    : render(children, `${path}.0`) }
  // 接上 ref 与 DOM 能力：组件里就能 focus 到"自己渲染出来的那个节点"。
  rendered.focus = () => { document.activeElement = rendered }
  rendered.querySelectorAll = (selector) => {
    const wanted = String(selector)
    return nodesOf(rendered).filter((candidate) => (candidate.type === 'button' || candidate.type === 'input') &&
      (!wanted.includes(':not([disabled])') || !candidate.props.disabled))
  }
  if (node.props && node.props.ref && typeof node.props.ref === 'object') node.props.ref.current = rendered
  return rendered
}

function collect(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  out.push(node)
  collect(node.props && node.props.children, out)
  return out
}
const nodesOf = (tree) => collect(tree).filter((item) => typeof item === 'object')
const textOf = (tree) => collect(tree).filter((item) => typeof item === 'string').join(' ')
const findByClass = (tree, className) => nodesOf(tree).find((node) => String(node.props.className || '').split(' ').includes(className))
const hasClass = (tree, className) => Boolean(findByClass(tree, className))
const buttonsOf = (tree) => nodesOf(tree).filter((node) => node.type === 'button')
const buttonWithText = (tree, label) => buttonsOf(tree).find((node) => textOf(node).includes(label))
const checkboxOf = (tree) => nodesOf(tree).find((node) => node.type === 'input' && node.props.type === 'checkbox')
/** 专门取"我已确认"那一个（.dsm-ack 里的 input）：忙碌勾选与派生会话勾选都排在它前面。 */
const ackBoxOf = (tree) => {
  const label = findByClass(tree, 'dsm-ack')
  return label ? nodesOf(label).find((node) => node.type === 'input' && node.props.type === 'checkbox') : undefined
}
/** 专门取"先停掉正在跑的工作"那一个。 */
const stopBoxOf = (tree) => {
  const label = findByClass(tree, 'dsm-stop')
  return label ? nodesOf(label).find((node) => node.type === 'input' && node.props.type === 'checkbox') : undefined
}
/** 所有可勾选项（派生会话列表）。 */
const choiceBoxesOf = (tree) => nodesOf(tree).filter((node) => node.type === 'input' && node.props.type === 'checkbox' && String(node.props.className || '') === 'dsm-choice-box')
const tick = () => new Promise((resolve) => setImmediate(resolve))

/** 渲染完成后按 React 的顺序结算：先跑上一轮的清理，再跑这一轮的副作用。 */
function settle() {
  const cleanups = pendingCleanups
  const effects = pendingEffects
  pendingCleanups = []
  pendingEffects = []
  for (const cleanup of cleanups) cleanup()
  for (const effect of effects) effect()
}

/**
 * 顶层渲染：渲染完把"这次没碰到的组件"当成**卸载**，丢掉它们的 hook 槽。
 * 真 React 就是这样（组件不再被渲染 → 实例销毁 → 重新挂载时副作用重跑），
 * 少了这一步，"关掉对话框再打开，焦点应该重新进来"这类断言就会假阴。
 */
function renderRoot(node, rootPath) {
  touchedComponents.clear()
  const tree = render(node, rootPath)
  for (const [key, instance] of [...componentHooks.entries()]) {
    if (touchedComponents.has(key)) continue
    // 卸载：先跑这个实例残留的副作用清理（焦点归还、监听摘除都挂在这里）。
    for (const slot of instance.slots) {
      if (slot && typeof slot.cleanup === 'function') pendingCleanups.push(slot.cleanup)
    }
    componentHooks.delete(key)
  }
  settle()
  return tree
}

/* ── 假 fetch：按预设队列回答 ──────────────────────────────────────────── */

const requests = []
const responses = []
sandbox.fetch = async (url, options) => {
  requests.push({ url, options })
  const next = responses.shift()
  if (!next) throw new Error(`没有预设响应：${url}`)
  // 预设错误：直接抛给 request，用来模拟超时等“宿主没回话”的失败形态。
  if (next.error) throw next.error
  if (next.pending) await new Promise((resolve) => { next.release = resolve })
  return {
    ok: next.ok !== false,
    status: next.status || 200,
    json: next.raw ? async () => { throw new Error('不是 JSON') } : async () => next.body,
  }
}

/* ── 假 cordis 上下文：只提供真实存在的客户端服务 ──────────────────────── */

const registrations = new Map()
const disposers = []
let injectedLocale = null
const slotDisposals = { count: 0 }

const slots = {
  inject: (key, callback) => {
    const disposeRegistration = callback()
    return () => {
      if (typeof disposeRegistration === 'function') disposeRegistration()
      slotDisposals.count += 1
    }
  },
  register: (descriptor, Component) => {
    registrations.set(`${descriptor.name}#${descriptor.id}`, { descriptor, Component })
    return () => {}
  },
}
const locale = {
  register: (namespace, dict) => {
    injectedLocale = { namespace, dict }
    return () => {}
  },
  bind: () => (key) => injectedLocale.dict.zh[key] || key,
}
// 注意：**没有** styles 服务 —— 客户端根本没有这个服务（那是动态包 builtin），
// 插件必须自己插 <style>。这里少给一个服务，就是为了让"依赖它"的写法当场失效。
let sessionRefreshes = 0
let refreshError = null
// 第一次刷新已经被旧的在飞请求"复用"时，列表快照里还会留着待删的 id；
// 插件应当发现它还在，再刷一次，而不是让旧行留成「未分组」。
let staleRow = null
let staleReads = 0
const sessions = {
  refresh: async () => {
    sessionRefreshes += 1
    if (refreshError) throw refreshError
  },
  list: {
    getSnapshot: () => {
      if (staleReads > 0) {
        staleReads -= 1
        return { byId: staleRow || {} }
      }
      return { byId: {} }
    },
  },
}
const ctx = {
  get: (name) => ({ slots, locale, sessions })[name],
  effect: (callback) => {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
}

/* ── 跑 apply ──────────────────────────────────────────────────────────── */

let strayRequire = ''
const exportsObject = registration.factory((spec) => {
  if (spec === 'react') return React
  strayRequire = spec
  throw new Error(`意外的外部请求：${spec}`)
})
check('factory 可执行', typeof exportsObject === 'object' && exportsObject !== null)
check('只依赖 react', strayRequire === '', strayRequire)
check('导出 apply', typeof exportsObject.apply === 'function')
check('导出 inject 依赖声明：contextMenus 不能是硬依赖', Array.isArray(exportsObject.inject) && exportsObject.inject.includes('slots') && !exportsObject.inject.includes('contextMenus'), JSON.stringify(exportsObject.inject))

exportsObject.apply(ctx)

check('注册了文案', injectedLocale && injectedLocale.namespace === 'session-manager' && injectedLocale.dict.zh.menu.length > 0)
check('中英文字典键集一致', Object.keys(injectedLocale.dict.en).sort().join() === Object.keys(injectedLocale.dict.zh).sort().join())
check('注册了会话菜单行', registrations.has('sidebar.workspaces.session.menu.item#session-manager'))
check('注册了确认框', registrations.has('shell.overlay#session-manager-dialog'))
check('菜单行排在官方归档行之后', registrations.get('sidebar.workspaces.session.menu.item#session-manager').descriptor.order > 400)

const styleTags = head.children.filter((node) => node.tagName === 'style')
check('自己插入了样式表（不依赖 styles 服务）', styleTags.length === 1)
check('样式表打进 head', styleTags[0] && styleTags[0].parentNode === head)
check('样式带有去重标记', styleTags[0] && styleTags[0].attributes['data-plugin-css'] === 'dsh-session-manager-delete')
check('样式里含模态遮罩规则', styleTags[0] && styleTags[0].textContent.includes('.dsm-backdrop'))
check('样式只用 DSH 设计 token', styleTags[0] && styleTags[0].textContent.includes('var(--dsw-alias-'))

/* ── 渲染入口 ──────────────────────────────────────────────────────────── */

const menuEntry = registrations.get('sidebar.workspaces.session.menu.item#session-manager')
const overlayEntry = registrations.get('shell.overlay#session-manager-dialog')
const t = (key) => injectedLocale.dict.zh[key] || key

const SESSION = 'session-4ac3ddd0-1e6e-4a4e-a44f-fd18beb6f593'
/** 子代理会话：跟父会话一起删，它的本地键也要一起清。 */
const CHILD = '17ea8a30-9736-4b5a-b04a-f936274951d3'
/** 另一个会话：它的一切都必须原样保留。 */
const OTHER = 'session-75d3c071-9ff7-45b8-ae52-73eb8c5804cc'
/** 早已不存在、只在本地状态里留了引用的会话：缓存清理要认出来的就是它。 */
const GHOST = 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

/* contextMenus 存在时：注册结构化菜单项（排序、danger、分隔线），不再占旧座位。 */
const menuContributions = []
const menuSlotNames = []
const menuSlots = {
  inject: (_name, callback) => {
    const dispose = callback()
    return () => { if (typeof dispose === 'function') dispose() }
  },
  register: (descriptor) => {
    menuSlotNames.push(descriptor.name)
    return () => {}
  },
}
const menuCtx = {
  get: (name) => {
    if (name === 'contextMenus') {
      return { register: (input) => { menuContributions.push(input); return () => {} } }
    }
    if (name === 'slots') return menuSlots
    if (name === 'locale') return locale
    return undefined
  },
  effect: (callback) => {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
}
exportsObject.apply(menuCtx)
const contribution = menuContributions[0]
check('contextMenus 存在时注册结构化菜单项', menuContributions.length === 1)
check('结构化菜单项挂在 session 目标上', contribution && contribution.target === 'session')
check('结构化菜单项排在归档(600)之后', contribution && contribution.order > 600)
check('结构化菜单项不再注册旧座位', !menuSlotNames.includes('sidebar.workspaces.session.menu.item'))
check('结构化菜单项仍注册确认框', menuSlotNames.includes('shell.overlay'))
const menuActions = contribution.resolve({ sessionId: SESSION, displayTitle: '标题' })
check('解析出一条删除动作', Array.isArray(menuActions) && menuActions.length === 1)
check('删除动作是危险项并带分隔线', menuActions[0].danger === true && menuActions[0].separatorBefore === true)
check('删除动作文案与菜单一致', menuActions[0].label === t('menu'))
check('删除动作可执行', typeof menuActions[0].run === 'function')

/* 菜单只对已归档的会话显示：归档集合来自 workspaces.list 的快照，读不到就保持旧行为。 */
const baseMenuGet = menuCtx.get
const archivedSessionIds = []
const workspaceList = { getSnapshot: () => ({ archivedSessionIds }) }
menuCtx.get = (name) => (name === 'workspaces' ? { list: workspaceList } : baseMenuGet(name))
check('结构化菜单声明要观察归档列表', typeof contribution.observe === 'function')
const observed = typeof contribution.observe === 'function' ? contribution.observe() : null
check('观察目标就是归档列表', Array.isArray(observed) && observed[0] === workspaceList, JSON.stringify(observed))
check('未归档时不出删除入口', contribution.resolve({ sessionId: SESSION, displayTitle: '标题' }).length === 0)
archivedSessionIds.push(SESSION)
check('已归档时出删除入口', contribution.resolve({ sessionId: SESSION, displayTitle: '标题' }).length === 1)
check('旧座位也能按归档状态隐藏', exportsObject.SessionMenuRow({ t, sessionId: SESSION, displayTitle: '示例会话', canDelete: () => false, store: { open: () => {} } }) === null)
menuCtx.get = baseMenuGet

/* contextMenus 晚于插件启动：先用旧座位，服务一到位就升级并撤掉旧座位。 */
const lateNames = []
const lateContributions = []
let lateDisposed = 0
let lateReady = null
const lateSlots = {
  inject: (_name, callback) => {
    const dispose = callback()
    return () => { if (typeof dispose === 'function') dispose(); lateDisposed += 1 }
  },
  register: (descriptor) => { lateNames.push(`${descriptor.name}#${descriptor.id}`); return () => {} },
}
let lateMenus = null
const lateCtx = {
  get: (name) => {
    if (name === 'contextMenus') return lateMenus
    if (name === 'slots') return lateSlots
    if (name === 'locale') return locale
    return undefined
  },
  effect: (callback) => {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  inject: (deps, callback) => { lateReady = { deps, callback }; return () => {} },
}
exportsObject.apply(lateCtx)
check('contextMenus 缺席时先用旧座位', lateNames.includes('sidebar.workspaces.session.menu.item#session-manager'))
check('并挂上了等待 contextMenus 的升级回调', lateReady && lateReady.deps.includes('contextMenus'))
lateMenus = { register: (input) => { lateContributions.push(input); return () => {} } }
lateReady.callback()
check('contextMenus 晚到时升级为结构化菜单', lateContributions.length === 1)
check('升级后撤掉旧座位（菜单里不会出现两份）', lateDisposed >= 1, String(lateDisposed))

/** 一份贴近真实的本地状态：会话私有键、共享键、别的会话、全局偏好、无关插件。 */
const seedLocalState = () => seedStorage({
  [`dsh.conversation.${SESSION}`]: { draft: '草稿', view: 'chat', viewRequest: null },
  [`dsh.conversation.${CHILD}`]: { draft: '子代理草稿', view: null, viewRequest: null },
  [`dsh.sidebar-right.v1.${SESSION}`]: { bySession: { [SESSION]: { layout: { tabs: [] }, minted: 1 } } },
  [`dsh.sidebar-browser.v1.${SESSION}`]: { byTab: { t1: { url: 'about:blank' } } },
  'dsh.workspace.view.v5': {
    groupBy: 'workspace',
    orderBy: 'manual',
    groupExpansion: { 'ws-1': true },
    sessionOrderByAccount: { 'ws-1': [OTHER, SESSION], '': [CHILD] },
    archivedFilter: 'default',
  },
  'dsh.sessions.current': { sessionId: SESSION },
  [`dsh.user-questions.drafts.v1.${OTHER}`]: { progressByRequest: {} },
  'dsh.conversation.contentWidth': '920',
  'whale.settings': JSON.stringify({ sound: true }),
  'unrelated.key': 'untouched',
})

const renderDialog = () => renderRoot(overlayEntry.Component({ t }), 'delete-dialog')
const renderMenu = (props = {}) => renderRoot(menuEntry.Component({ t, sessionId: SESSION, displayTitle: '示例会话', ...props }), 'session-menu-row')
const openViaMenu = (props = {}) => renderMenu(props).props.onClick()

const sessionPayload = (overrides = {}) => ({
  ok: true,
  session: {
    id: SESSION,
    title: '示例会话',
    bytes: 2_097_152,
    events: 42,
    createdAt: Date.parse('2026-01-02T03:04:05Z'),
    cwd: 'C:\\ws',
    subagents: 1,
    forks: 1,
    deletable: true,
    preview: 'fixture-preview',
    blocking: null,
    artifacts: ['sessions/--ws--/session-…/session.v4.jsonl.zstd', 'storages/session_projcache/sessions/session-….json'],
    targets: [{ id: SESSION, origin: 'self' }, { id: CHILD, origin: 'subagent' }],
    archived: true,
    registry: { available: true, workspaces: [{ id: 'ws-1', title: 'default-workspace' }], pinned: true, archived: false, readable: true },
    dangling: { reliable: true, reason: '', count: 0, ids: [] },
    ...overrides,
  },
})

/** 勾选"我已确认"，让危险按钮可用（界面上的安全闸门之一）。 */
const acknowledge = (tree) => {
  const input = ackBoxOf(tree) || checkboxOf(tree)
  if (input) input.props.onChange({ target: { checked: true } })
  return input
}

/* ── 1. 本地状态清理规则（纯函数，先把规则本身钉死）────────────────────── */

const localIds = [SESSION, CHILD]
seedLocalState()

const scanIds = exportsObject.referencedLocalSessionIds()
check('扫描能认出键名里的会话 id', scanIds.has(SESSION) && scanIds.has(CHILD))
check('扫描能认出值里的会话 id', scanIds.has(OTHER))
check('扫描不会把全局偏好当成会话', !scanIds.has('920'))

const plan = exportsObject.planLocalCleanup(localIds)
const plannedRemoves = plan.removes.map((entry) => entry.key).sort()
check('盘点：会话私有键整键移除', plannedRemoves.join() === [
  `dsh.conversation.${CHILD}`,
  `dsh.conversation.${SESSION}`,
  `dsh.sidebar-browser.v1.${SESSION}`,
  `dsh.sidebar-right.v1.${SESSION}`,
].sort().join(), JSON.stringify(plannedRemoves))
check('盘点：共享键做定点摘除而不是整键删除', plan.edits.some((entry) => entry.key === 'dsh.workspace.view.v5' && entry.hits === 2), JSON.stringify(plan.edits))
check('盘点：dsh.sessions.current 退回应用自己的空状态', plan.edits.some((entry) => entry.key === 'dsh.sessions.current' && entry.reset === true && JSON.stringify(entry.value) === '{}'), JSON.stringify(plan.edits))
check('盘点：别的会话的键不动', !plannedRemoves.includes(`dsh.user-questions.drafts.v1.${OTHER}`))
check('盘点：全局偏好不动（dsh.conversation.contentWidth 前缀陷阱）', !plannedRemoves.includes('dsh.conversation.contentWidth') && !plan.edits.some((entry) => entry.key === 'dsh.conversation.contentWidth'))
check('盘点：无关插件的键不动', !plannedRemoves.includes('whale.settings') && !plan.edits.some((entry) => entry.key === 'whale.settings'))
check('盘点：报告了会动几个键几处引用', plan.hits === 7, String(plan.hits))
check('盘点：只读，没写任何东西', storageData.get(`dsh.conversation.${SESSION}`) !== null && storageData.has('dsh.workspace.view.v5'))

const applied = exportsObject.applyLocalCleanup(localIds)
check('清理：移动了 4 个私有键', applied.removed.length === 4, JSON.stringify(applied.removed))
check('清理：目标会话的草稿键没了', !storageData.has(`dsh.conversation.${SESSION}`) && !storageData.has(`dsh.conversation.${CHILD}`))
check('清理：右栏与浏览器页签键没了', !storageData.has(`dsh.sidebar-right.v1.${SESSION}`) && !storageData.has(`dsh.sidebar-browser.v1.${SESSION}`))
const viewAfter = JSON.parse(storageData.get('dsh.workspace.view.v5'))
check('清理：侧栏顺序里摘掉了目标 id', viewAfter.sessionOrderByAccount['ws-1'].join() === OTHER && viewAfter.sessionOrderByAccount[''].length === 0, JSON.stringify(viewAfter.sessionOrderByAccount))
check('清理：侧栏其他字段原样保留', viewAfter.groupBy === 'workspace' && viewAfter.orderBy === 'manual' && viewAfter.archivedFilter === 'default' && viewAfter.groupExpansion['ws-1'] === true)
check('清理：当前选中会话被清空', storageData.get('dsh.sessions.current') === '{}')
check('清理：别的会话的草稿原样保留', storageData.get(`dsh.user-questions.drafts.v1.${OTHER}`) === JSON.stringify({ progressByRequest: {} }))
check('清理：全局偏好原样保留', storageData.get('dsh.conversation.contentWidth') === '920')
check('清理：无关插件的键原样保留', storageData.get('whale.settings') === JSON.stringify({ sound: true }))
check('清理：回报摘掉的处数', applied.hits === 7, String(applied.hits))

check('幂等：再清一次什么都不动', exportsObject.applyLocalCleanup(localIds).hits === 0)

// 只有 subagentAddress 指向被删的子代理会话：保留父会话的选中，只摘地址字段。
seedStorage({ 'dsh.sessions.current': { sessionId: OTHER, subagentAddress: { sessionId: CHILD }, other: 'keep' } })
const subPlan = exportsObject.planLocalCleanup([CHILD])
const subEdit = subPlan.edits.find((entry) => entry.key === 'dsh.sessions.current')
check('只删子代理地址时，不重置父会话的选中', Boolean(subEdit) && subEdit.reset !== true && subEdit.value.sessionId === OTHER && !('subagentAddress' in subEdit.value) && subEdit.value.other === 'keep', JSON.stringify(subEdit && subEdit.value))
exportsObject.applyLocalCleanup([CHILD])
check('写回后父会话仍选中，地址字段已摘掉', JSON.parse(storageData.get('dsh.sessions.current')).sessionId === OTHER && !('subagentAddress' in JSON.parse(storageData.get('dsh.sessions.current'))))

// 值不是认识的 JSON 结构：只报告，不改写。
seedStorage({ [`dsh.workspace.view.v5`]: `raw ${SESSION} text` })
const rawPlan = exportsObject.planLocalCleanup([SESSION])
check('值不是 JSON 时只报告不改写', rawPlan.edits.length === 1 && rawPlan.edits[0].hits === 0 && rawPlan.hits === 0, JSON.stringify(rawPlan.edits))
check('值不是 JSON 时数据原样留着', storageData.get('dsh.workspace.view.v5') === `raw ${SESSION} text`)

const otherDraft = `dsh.conversation.${OTHER}`
const pluginKey = `third-party.${SESSION}`
seedStorage({
  [otherDraft]: { draft: SESSION },
  [pluginKey]: { id: SESSION },
  'dsh.workspace.view.v5': { lastLabel: SESSION, sessionOrderByAccount: { work: [SESSION, OTHER] } },
})
exportsObject.applyLocalCleanup([SESSION])
check('其他会话草稿中即使写着目标 id 也不会被改', JSON.parse(storageData.get(otherDraft)).draft === SESSION)
check('第三方私有键原样保留', JSON.parse(storageData.get(pluginKey)).id === SESSION)
check('共享视图只改已知顺序字段', JSON.parse(storageData.get('dsh.workspace.view.v5')).lastLabel === SESSION
  && JSON.parse(storageData.get('dsh.workspace.view.v5')).sessionOrderByAccount.work.join() === OTHER)

/* ── 2. 菜单行 ─────────────────────────────────────────────────────────── */

const menuTree = renderMenu()
check('菜单行是一个 menuitem 按钮', menuTree.type === 'button' && menuTree.props.role === 'menuitem')
check('菜单行文案正确', textOf(menuTree).includes('删除会话'))
check('没有 sessionId 时不渲染', renderMenu({ sessionId: undefined }) === null)
check('未打开时不渲染对话框', renderDialog() === null)

/* ── 3. 菜单开关 hook：按官方契约用 [open, setOpen] ────────────────────── */

let menuClosedWith = null
responses.push({ body: sessionPayload() })
renderMenu({ useMenuOpenState: () => [true, (value) => { menuClosedWith = value }] }).props.onClick()
check('点完菜单行会收起菜单', menuClosedWith === false, String(menuClosedWith))
await tick()

responses.push({ body: sessionPayload() })
const plainMenu = renderMenu()
check('未注入菜单 hook 时照样渲染', plainMenu.type === 'button' && textOf(plainMenu).includes('删除会话'))
plainMenu.props.onClick()
await tick()
check('点菜单行只查不删', requests.every((item) => !(item.options && item.options.method)))

/* ── 4. 点菜单行 → 查会话 → 弹确认框（先列清单）────────────────────────── */

// 先关掉上一节留下的框：open 从 false 翻到 true，焦点效果才会重新跑。
buttonWithText(renderDialog(), '取消').props.onClick()
check('取消关闭对话框', renderDialog() === null)

seedLocalState()
responses.push({ body: sessionPayload({ dangling: { reliable: true, reason: '', count: 2, ids: [GHOST, 'session-bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'] } }) })
focusedBefore.focus()
openViaMenu()
const firstGet = requests.find((item) => !(item.options && item.options.method))
check('查询请求带 id 参数', firstGet.url.startsWith('/dsh-session-manager-delete/api?id=') && firstGet.url.includes(SESSION))
await tick()

const readyTree = renderDialog()
check('对话框有 dialog 语义', Boolean(findByClass(readyTree, 'dsm-dialog')) && findByClass(readyTree, 'dsm-dialog').props.role === 'dialog')
check('对话框有模态语义', findByClass(readyTree, 'dsm-dialog').props['aria-modal'] === 'true')
check('用 aria-labelledby 指向标题', findByClass(readyTree, 'dsm-dialog').props['aria-labelledby'] === findByClass(readyTree, 'dsm-title').props.id)
check('用 aria-describedby 指向目标会话', findByClass(readyTree, 'dsm-dialog').props['aria-describedby'] === findByClass(readyTree, 'dsm-body').props.children[0].props.id)
check('打开时焦点进入对话框', document.activeElement === findByClass(readyTree, 'dsm-dialog'))
check('显示会话标题', textOf(readyTree).includes('示例会话'))
check('显示会话 id', textOf(readyTree).includes(SESSION))
check('显示占用空间', textOf(readyTree).includes('2.0 MB'))
check('显示记录数', textOf(readyTree).includes('42'))
check('写明不可恢复', textOf(readyTree).includes('删除后无法恢复'))
check('写明会带走子代理会话', textOf(readyTree).includes('1 个子代理会话'))
check('写明 fork 会话会保留', textOf(readyTree).includes('1 个派生会话'))
check('列出将被删除的文件', textOf(readyTree).includes('sessions/--ws--/session-…/session.v4.jsonl.zstd'))
check('列出会被一起删掉的会话 id', textOf(readyTree).includes(CHILD))
check('列出工作区登记要摘掉什么', textOf(readyTree).includes('default-workspace') && textOf(readyTree).includes('移出') && textOf(readyTree).includes('取消置顶'))
check('列出浏览器本地状态要清什么', textOf(readyTree).includes(`移除 dsh.conversation.${SESSION}`) && textOf(readyTree).includes('dsh.workspace.view.v5'))
check('列出悬空引用会一起剪掉', textOf(readyTree).includes('悬空引用') && textOf(readyTree).includes('2'))
check('写明不会被删除的边界', textOf(readyTree).includes('不会被删除') && textOf(readyTree).includes('附件'))
check('有危险按钮', hasClass(readyTree, 'dsm-button-danger'))
check('有取消按钮', Boolean(buttonWithText(readyTree, '取消')))
check('未勾选确认时危险按钮禁用', Boolean(findByClass(readyTree, 'dsm-button-danger').props.disabled))
check('没开着的会话不显示"开着"提醒', !textOf(readyTree).includes('打开着'))

/* ── 5. 勾选确认闸门 ───────────────────────────────────────────────────── */

check('有确认勾选框', Boolean(ackBoxOf(readyTree)))
check('勾选框默认不勾', ackBoxOf(readyTree).props.checked !== true)
acknowledge(readyTree)
const ackedTree = renderDialog()
check('勾选后危险按钮可用', findByClass(ackedTree, 'dsm-button-danger').props.disabled !== true)
check('勾选状态可见', textOf(ackedTree).includes('我已确认'))

// 换一个会话重新打开：勾选状态必须是全新的（绝不能沿用上一个会话的"已确认"）。
responses.push({ body: sessionPayload() })
openViaMenu()
await tick()
check('新打开的对话框重新要求勾选', Boolean(findByClass(renderDialog(), 'dsm-button-danger').props.disabled))
buttonWithText(renderDialog(), '取消').props.onClick()

// v0.2.0 起的行为：会话"在界面里开着"时宿主会拒删 —— 删了会在侧栏留下
// 一条刷新页面去不掉的「未分组」条目（数据源在宿主内存里）。界面照实显示原因。
responses.push({
  body: sessionPayload({
    archived: false,
    deletable: false,
    blocking: '这个会话还没有归档。删除只对**已归档**的会话开放 —— 请先在侧栏用它「…」菜单里的「归档」把它收起来（归档还会顺手停掉正在跑的回合与后台任务），然后再回来删。',
  }),
})
openViaMenu()
await tick()
const liveTree = renderDialog()
check('未归档时显示宿主给的阻塞原因', textOf(liveTree).includes('还没有归档') && textOf(liveTree).includes('归档'))
check('未归档时说明归档会停掉在跑的回合', textOf(liveTree).includes('停掉'))
check('未归档时没有危险按钮', !hasClass(liveTree, 'dsm-button-danger'))
check('未归档时不显示确认勾选', !ackBoxOf(liveTree))
buttonWithText(liveTree, '关闭').props.onClick()
check('未归档时只能关闭', renderDialog() === null)

/* ── 6. 二次确认 → 真删 → 本地状态按回报的 id 清理 ─────────────────────── */

seedLocalState()
responses.push({ body: sessionPayload({ dangling: { reliable: true, reason: '', count: 1, ids: [GHOST] } }) })
openViaMenu()
await tick()
buttonWithText(renderDialog(), '取消').props.onClick()
responses.push({ body: sessionPayload({ dangling: { reliable: true, reason: '', count: 1, ids: [GHOST] } }) })
openViaMenu()
await tick()
acknowledge(renderDialog())

responses.push({
  body: {
    ok: true,
    removed: ['sessions/--ws--/session-…/session.v4.jsonl.zstd'],
    registry: { available: true, steps: ['取消置顶', '移出工作区「default-workspace」'] },
    title: '示例会话',
    deletedIds: [SESSION, CHILD],
    forgotten: [SESSION, CHILD],
    flushed: [],
    memoryRemaining: [],
    danglingPruned: 1,
    emptyDirsRemoved: ['sessions/--ws--/(删除后已空，一并清理)'],
    spillRemaining: ['C:\\Temp\\dsh-spill-Ab12Cd\\session-0123456789ab（工具输出溢出临时目录）'],
  },
})
findByClass(renderDialog(), 'dsm-button-danger').props.onClick()
check('点危险按钮立即进删除态', textOf(renderDialog()).includes('正在删除'))
await tick()
const posts = requests.filter((item) => item.options && item.options.method === 'POST')
check('确认后只发一次 POST', posts.length === 1, String(posts.length))
check('删成功后重拉一次会话列表（否则旧行会显示成「未分组」）', sessionRefreshes === 1, String(sessionRefreshes))
check('POST 带确认标记', JSON.parse(posts[0].options.body).confirm === 'delete-session')
check('POST 带上已确认的清单版本', JSON.parse(posts[0].options.body).preview === 'fixture-preview')
check('POST 里回传的是看过的那份悬空引用', JSON.parse(posts[0].options.body).dangling.join() === GHOST)

const doneTree = renderDialog()
check('显示已删除', textOf(doneTree).includes('会话已删除'))
check('回显被删文件', textOf(doneTree).includes('sessions/--ws--/session-…/session.v4.jsonl.zstd'))
check('回显登记清理', textOf(doneTree).includes('取消置顶'))
check('回显本地状态清理结果', textOf(doneTree).includes('浏览器本地状态'))
check('回显顺带剪掉的悬空引用', textOf(doneTree).includes('顺带剪掉 1 条悬空引用'))
check('回显宿主内存注销', textOf(doneTree).includes('宿主内存注销'))
check('回显顺带收走的空目录', textOf(doneTree).includes('空的工作区目录'))
check('删不掉的 spill 残留如实提示', textOf(doneTree).includes('临时目录') && textOf(doneTree).includes('没能删掉'))
check('成功态只有完成一个按钮', !hasClass(doneTree, 'dsm-button-danger') && Boolean(buttonWithText(doneTree, '完成')))

check('本地状态已按 deletedIds 清理（含子代理会话）', !storageData.has(`dsh.conversation.${SESSION}`) && !storageData.has(`dsh.conversation.${CHILD}`))
check('本地状态：共享键里的引用也摘掉了', JSON.parse(storageData.get('dsh.workspace.view.v5')).sessionOrderByAccount['ws-1'].join() === OTHER)
check('本地状态：别的会话与全局偏好一字不动', storageData.get(`dsh.user-questions.drafts.v1.${OTHER}`) !== null && storageData.get('dsh.conversation.contentWidth') === '920')

check('点完成关闭对话框', (buttonWithText(renderDialog(), '完成').props.onClick(), renderDialog() === null))
check('关闭后焦点回到原处', document.activeElement === focusedBefore)

// 注销没做干净时如实报出来（罕见，但绝不假报"删干净了"）。
seedLocalState()
responses.push({ body: sessionPayload() })
openViaMenu()
await tick()
acknowledge(renderDialog())
responses.push({
  body: {
    ok: true,
    removed: ['sessions/--ws--/session-…/session.v4.jsonl.zstd'],
    registry: { available: true, steps: [] },
    deletedIds: [SESSION],
    forgotten: [SESSION],
    flushed: [SESSION],
    memoryRemaining: [SESSION],
  },
})
findByClass(renderDialog(), 'dsm-button-danger').props.onClick()
await tick()
const leftoverTree = renderDialog()
check('注销没做干净时如实报警', textOf(leftoverTree).includes('宿主内存里还有残留') && textOf(leftoverTree).includes('重启 DSH'))
check('并回显补写落盘的那几个', textOf(leftoverTree).includes('补写落盘'))
check('报警不影响收尾', Boolean(buttonWithText(leftoverTree, '完成')))
buttonWithText(leftoverTree, '完成').props.onClick()
check('报警后可以关闭', renderDialog() === null)

// 列表重拉失败（宿主服务掉线等）：删除本身是成功的，但旧行可能还显示在「未分组」里。
refreshError = new Error('会话服务暂时不可用')
responses.push({ body: sessionPayload() })
openViaMenu()
await tick()
acknowledge(renderDialog())
responses.push({
  body: {
    ok: true,
    removed: ['sessions/--ws--/session-…/session.v4.jsonl.zstd'],
    registry: { available: true, steps: [] },
    deletedIds: [SESSION],
    forgotten: [SESSION],
    flushed: [],
    memoryRemaining: [],
  },
})
findByClass(renderDialog(), 'dsm-button-danger').props.onClick()
await tick()
const staleTree = renderDialog()
check('列表刷新失败时如实提示', textOf(staleTree).includes('没有刷新成功') && textOf(staleTree).includes('刷新页面'))
refreshError = null
check('刷新失败不改变删除结果', textOf(staleTree).includes('会话已删除'))
buttonWithText(staleTree, '完成').props.onClick()

// 刷新被 single-flight 复用、旧行还在：再刷一次才算完。
const retryBase = sessionRefreshes
staleRow = { [SESSION]: {} }
staleReads = 1
responses.push({ body: sessionPayload() })
openViaMenu()
await tick()
acknowledge(renderDialog())
responses.push({
  body: {
    ok: true,
    removed: ['sessions/--ws--/session-…/session.v4.jsonl.zstd'],
    registry: { available: true, steps: [] },
    deletedIds: [SESSION],
    forgotten: [SESSION],
    flushed: [],
    memoryRemaining: [],
  },
})
findByClass(renderDialog(), 'dsm-button-danger').props.onClick()
await tick()
await tick()
check('旧列表里还留着时再拉一次', sessionRefreshes === retryBase + 2, String(sessionRefreshes - retryBase))
check('第二次拉到干净列表后不报警', !textOf(renderDialog()).includes('没有刷新成功'))
buttonWithText(renderDialog(), '完成').props.onClick()
staleRow = null
staleReads = 0

// 悬空引用：界面给一个"现在清理"入口，不用为了清一条幽灵去重启 DSH。
responses.push({ body: sessionPayload({ dangling: { reliable: true, reason: '', count: 2, ids: [GHOST, 'session-bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'] } }) })
openViaMenu()
await tick()
const repairTree = renderDialog()
check('悬空引用有清理入口', Boolean(buttonWithText(repairTree, '现在清理')))
const repairsBefore = requests.filter((item) => item.options && item.options.method === 'POST').length
responses.push({ body: { ok: true, repair: { swept: 2, steps: ['移出工作区「default-workspace」的悬空引用'], skipped: '' } } })
responses.push({ body: sessionPayload() })
buttonWithText(renderDialog(), '现在清理').props.onClick()
await tick()
await tick()
const repairPosts = requests.filter((item) => item.options && item.options.method === 'POST')
check('清理入口发一次维护请求', repairPosts.length === repairsBefore + 1, String(repairPosts.length - repairsBefore))
check('维护请求带 repair 与确认标记', JSON.parse(repairPosts[repairPosts.length - 1].options.body).repair === true && JSON.parse(repairPosts[repairPosts.length - 1].options.body).confirm === 'delete-session')
check('清理后回显条数', textOf(renderDialog()).includes('已清理 2 条'))
buttonWithText(renderDialog(), '取消').props.onClick()

// 悬空引用被截断：把没列出来的条数如实告诉用户，别让人以为一次就清完了。
const GHOST2 = 'session-bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
responses.push({ body: sessionPayload({ dangling: { reliable: true, reason: '', count: 2, total: 5, truncated: true, ids: [GHOST, GHOST2] } }) })
openViaMenu()
await tick()
check('截断时说明还有多少条没列出', textOf(renderDialog()).includes('另有 3 条'))
buttonWithText(renderDialog(), '取消').props.onClick()

// 清理超时：宿主可能已经清完，界面必须说“结果未知”，不能报成普通失败。
responses.push({ body: sessionPayload({ dangling: { reliable: true, reason: '', count: 1, ids: [GHOST] } }) })
openViaMenu()
await tick()
responses.push({ error: Object.assign(new Error('timeout'), { code: 'TIMEOUT' }) })
buttonWithText(renderDialog(), '现在清理').props.onClick()
await tick()
await tick()
check('清理超时显示结果未知', textOf(renderDialog()).includes('清理结果未知'))
check('清理超时不再显示成普通失败', !textOf(renderDialog()).includes('清理没成功'))
buttonWithText(renderDialog(), '取消').props.onClick()

// 清理进行中：危险按钮必须锁住；取消后迟到的清理响应不许污染下一轮对话框。
const repairPending = { pending: true }
responses.push({ body: sessionPayload({ dangling: { reliable: true, reason: '', count: 1, ids: [GHOST] } }) })
openViaMenu()
await tick()
acknowledge(renderDialog())
responses.push(repairPending)
buttonWithText(renderDialog(), '现在清理').props.onClick()
await tick()
const repairingTree = renderDialog()
check('清理中确认删除被锁住', findByClass(repairingTree, 'dsm-button-danger').props.disabled === true)
check('清理中按钮显示进行中', Boolean(buttonWithText(repairingTree, '清理中…')))
buttonWithText(repairingTree, '取消').props.onClick()
check('清理中允许取消（删除中才不允许）', renderDialog() === null)

responses.push({ body: sessionPayload({ title: '新一轮会话' }) })
openViaMenu()
await tick()
const requestsBeforeLate = requests.length
repairPending.release()
await tick()
await tick()
const lateText = textOf(renderDialog())
check('迟到的清理响应不覆盖新对话框', !lateText.includes('清理结果未知') && !lateText.includes('清理没成功') && !lateText.includes('清理中…'), lateText)
check('迟到的清理响应不再发后续请求', requests.length === requestsBeforeLate, String(requests.length - requestsBeforeLate))
buttonWithText(renderDialog(), '取消').props.onClick()

/* ── 7. 宿主说不可删 / 会话已不存在 / 无原因不可删 ─────────────────────── */

responses.push({ body: sessionPayload({ title: '在跑的会话', deletable: false, blocking: '会话正在运行（有回合在跑），请先停止它再删除', artifacts: [] }) })
openViaMenu()
await tick()
const blockedTree = renderDialog()
check('阻塞原因可见', textOf(blockedTree).includes('正在运行'))
check('阻塞时没有危险按钮', !hasClass(blockedTree, 'dsm-button-danger'))
check('阻塞时不显示确认勾选', !checkboxOf(blockedTree))
check('阻塞时只能关闭', (buttonWithText(blockedTree, '关闭').props.onClick(), renderDialog() === null))

responses.push({ body: sessionPayload({ exists: false, deletable: false, artifacts: [] }) })
openViaMenu()
await tick()
check('会话不存在时给出原因', textOf(renderDialog()).includes('不存在'))
check('会话不存在时没有危险按钮', !hasClass(renderDialog(), 'dsm-button-danger'))
buttonWithText(renderDialog(), '关闭').props.onClick()

responses.push({ body: sessionPayload({ deletable: false, blocking: null }) })
openViaMenu()
await tick()
check('不可删但无原因时有兜底说明', textOf(renderDialog()).includes('不允许删除'))
check('不可删但无原因时没有危险按钮', !hasClass(renderDialog(), 'dsm-button-danger'))
buttonWithText(renderDialog(), '关闭').props.onClick()

/* ── 8. 失败：404、非 JSON、删除失败 ───────────────────────────────────── */

responses.push({ status: 404, ok: false, body: { ok: false, error: '会话不存在，可能已经被删除' } })
openViaMenu()
await tick()
check('查询失败显示原因', textOf(renderDialog()).includes('会话不存在'))
buttonWithText(renderDialog(), '关闭').props.onClick()

responses.push({ raw: true })
openViaMenu()
await tick()
const rawTree = renderDialog()
check('非 JSON 响应也有可读文案', textOf(rawTree).includes('请求失败'))
check('非 JSON 响应不炸渲染', Boolean(findByClass(rawTree, 'dsm-dialog')))
buttonWithText(rawTree, '关闭').props.onClick()

/* ── 9. 删除中不能关框；删除失败 → error（且不动本地状态）─────────────── */

seedLocalState()
responses.push({ body: sessionPayload() })
openViaMenu()
await tick()
acknowledge(renderDialog())
const pendingDelete = { pending: true, ok: false, body: { ok: false, error: '有 1 项没能删除（可能被其他程序占用）' } }
responses.push(pendingDelete)
findByClass(renderDialog(), 'dsm-button-danger').props.onClick()
await tick()

const deletingTree = renderDialog()
check('删除进行中显示进度', textOf(deletingTree).includes('正在删除'))
check('删除进行中危险按钮禁用', Boolean(findByClass(deletingTree, 'dsm-button-danger').props.disabled))
check('删除进行中取消按钮禁用', Boolean(buttonWithText(deletingTree, '取消').props.disabled))
document.activeElement = focusedBefore
fire('keydown', { key: 'Escape' })
check('删除进行中 Esc 关不掉', renderDialog() !== null)

pendingDelete.release()
await tick()
check('删除失败显示原因', textOf(renderDialog()).includes('没能删除'))
check('删除失败时本地状态原样保留（会话还在）', storageData.has(`dsh.conversation.${SESSION}`))
check('失败后仍可关闭', (buttonWithText(renderDialog(), '关闭').props.onClick(), renderDialog() === null))

/* ── 10. Esc / 遮罩 / 拖拽 / Tab 循环 ──────────────────────────────────── */

responses.push({ body: sessionPayload() })
openViaMenu()
await tick()
renderDialog()
check('Esc 监听已挂上', (listeners.get('keydown') || new Set()).size > 0)
fire('keydown', { key: 'Escape' })
check('Esc 关闭对话框', renderDialog() === null)

responses.push({ body: sessionPayload() })
openViaMenu()
await tick()
const backdrop = findByClass(renderDialog(), 'dsm-backdrop')
backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop })
backdrop.props.onClick({ target: backdrop, currentTarget: backdrop })
check('点遮罩关闭对话框', renderDialog() === null)

responses.push({ body: sessionPayload() })
openViaMenu()
await tick()
const dragTree = renderDialog()
const dragBackdrop = findByClass(dragTree, 'dsm-backdrop')
const insideDialog = findByClass(dragTree, 'dsm-dialog')
// 在对话框里按下、拖到遮罩上松手：click 的 target 会是遮罩，但不该当成"点了遮罩"。
dragBackdrop.props.onMouseDown({ target: insideDialog, currentTarget: dragBackdrop })
dragBackdrop.props.onClick({ target: dragBackdrop, currentTarget: dragBackdrop })
check('从框内拖到遮罩松手不会误关', renderDialog() !== null)

const trapTree = renderDialog()
const trapButtons = trapTree.focus ? trapTree.querySelectorAll('button:not([disabled])') : []
check('框内有可聚焦控件', trapButtons.length >= 2, String(trapButtons.length))
if (trapButtons.length >= 2) {
  document.activeElement = trapButtons[trapButtons.length - 1]
  fire('keydown', { key: 'Tab', shiftKey: false, preventDefault() {} })
  check('Tab 到末尾会回到框内第一个控件', document.activeElement === trapButtons[0])
}
buttonWithText(renderDialog(), '取消').props.onClick()
check('取消关闭对话框', renderDialog() === null)

/* ── 12. 还有工作在跑：默认勾上"先停掉"，取消勾选就不许删 ─────────────── */

seedLocalState()
responses.push({
  body: sessionPayload({
    busy: { total: 1, sessions: [{ id: SESSION, labels: ['turn', 'job（构建）'] }], activityReliable: true },
  }),
})
openViaMenu()
await tick()
const busyTree = renderDialog()
check('忙碌时显示"还有没结束的工作"', textOf(busyTree).includes('还有没结束的工作'))
check('并列出在跑什么', textOf(busyTree).includes('构建'))
check('默认替用户勾上"先停掉"', Boolean(stopBoxOf(busyTree)) && stopBoxOf(busyTree).props.checked === true)
acknowledge(busyTree)
check('勾了确认就能删（先停已默认勾上）', findByClass(renderDialog(), 'dsm-button-danger').props.disabled !== true)

stopBoxOf(renderDialog()).props.onChange({ target: { checked: false } })
check('取消"先停掉"后危险按钮禁用（宿主一定会拒，界面先拦住）', Boolean(findByClass(renderDialog(), 'dsm-button-danger').props.disabled))
stopBoxOf(renderDialog()).props.onChange({ target: { checked: true } })
check('勾回来就恢复可删', findByClass(renderDialog(), 'dsm-button-danger').props.disabled !== true)

requests.length = 0
responses.push({
  body: {
    ok: true,
    removed: ['sessions/--ws--/session-…/session.v4.jsonl.zstd'],
    registry: { available: true, steps: [] },
    deletedIds: [SESSION, CHILD],
    forgotten: [SESSION],
    stoppedActivity: true,
    stopSteps: ['已请求停止 ' + SESSION + ' 的工作'],
    terminalsClosed: ['term-1'],
    extraRoots: [],
    warnings: ['有 1 个子会话的目录读不出来：它们会一起删掉，但它们自己带出的下一层没法枚举'],
  },
})
findByClass(renderDialog(), 'dsm-button-danger').props.onClick()
await tick()
const busyPost = JSON.parse(requests.filter((item) => item.options && item.options.method === 'POST')[0].options.body)
check('POST 带上"先停掉"', busyPost.stop === true, JSON.stringify(busyPost))
const busyDone = renderDialog()
check('回显"已先停掉"', textOf(busyDone).includes('已先停掉'))
check('回显关掉的终端', textOf(busyDone).includes('终端') && textOf(busyDone).includes('关掉了 1 个'))
check('回显宿主给的提醒', textOf(busyDone).includes('目录读不出来'))
buttonWithText(busyDone, '完成').props.onClick()

/* ── 13. 可选：一并删除派生会话（fork）────────────────────────────────── */

const FORK_A = 'session-aaaa1111-1111-4111-8111-111111111111'
const FORK_B = 'session-bbbb2222-2222-4222-8222-222222222222'
const forkOptions = [
  { id: FORK_A, title: '分支甲', archived: true, live: false },
  { id: FORK_B, title: '', archived: false, live: false },
]
responses.push({
  body: sessionPayload({ optionalForks: forkOptions }),
})
openViaMenu()
await tick()
const forkTree = renderDialog()
check('列出可选的派生会话', textOf(forkTree).includes('分支甲') && textOf(forkTree).includes(FORK_A))
check('未归档的那一项说明原因', textOf(forkTree).includes('先归档'))
check('未归档的那一项不可勾', choiceBoxesOf(forkTree).some((box) => box.props.disabled === true))
check('默认一个都不勾（默认值必须最保守）', choiceBoxesOf(forkTree).every((box) => box.props.checked !== true))
acknowledge(forkTree)
seedStorage({ [`dsh.conversation.${FORK_A}`]: { draft: 'fork 草稿' } })
responses.push({
  body: sessionPayload({
    preview: 'selected-fork-preview',
    optionalForks: forkOptions,
    targets: [{ id: SESSION }, { id: CHILD }, { id: FORK_A }],
    artifacts: ['fork transcript'],
    registryTargets: [{ id: FORK_A, workspaces: [{ id: 'fork-ws' }], available: true }],
  }),
})
choiceBoxesOf(forkTree)[0].props.onChange({ target: { checked: true } })
check('勾上后状态可见', choiceBoxesOf(renderDialog())[0].props.checked === true)
check('更新清单时不能确认删除', findByClass(renderDialog(), 'dsm-button-danger').props.disabled === true)
await tick()
const forkPreview = renderDialog()
check('新清单显示 fork 的文件、登记与本地状态', ['fork transcript', 'fork-ws', `dsh.conversation.${FORK_A}`]
  .every((entry) => textOf(forkPreview).includes(entry)))
check('勾选变更后必须重新确认', ackBoxOf(forkPreview).props.checked === false)
acknowledge(renderDialog())

responses.push({ ok: false, status: 409, body: { ok: false, code: 'PREVIEW_CHANGED', error: '删除清单已变化' } })
responses.push({
  body: sessionPayload({
    preview: 'updated-fork-preview',
    optionalForks: forkOptions,
    targets: [{ id: SESSION }, { id: CHILD }, { id: FORK_A }],
    artifacts: ['updated fork transcript'],
  }),
})
findByClass(renderDialog(), 'dsm-button-danger').props.onClick()
await tick()
const updatedFork = renderDialog()
check('旧清单被拒后自动显示新清单并要求再确认', textOf(updatedFork).includes('updated fork transcript')
  && textOf(updatedFork).includes('重新确认') && ackBoxOf(updatedFork).props.checked === false)
acknowledge(updatedFork)

requests.length = 0
responses.push({
  body: {
    ok: true,
    removed: ['sessions/--ws--/session-…/session.v4.jsonl.zstd'],
    registry: { available: true, steps: [] },
    deletedIds: [SESSION, CHILD, FORK_A],
    forgotten: [SESSION],
    extraRoots: [FORK_A],
  },
})
findByClass(renderDialog(), 'dsm-button-danger').props.onClick()
await tick()
const forkPost = JSON.parse(requests.filter((item) => item.options && item.options.method === 'POST')[0].options.body)
check('POST 带上勾选的派生会话', Array.isArray(forkPost.extraRoots) && forkPost.extraRoots.join() === FORK_A, JSON.stringify(forkPost))
check('重试提交的是重新确认的清单版本', forkPost.preview === 'updated-fork-preview')
check('没勾的一个都不带', !forkPost.extraRoots.includes(FORK_B))
check('回显连带删除的派生会话', textOf(renderDialog()).includes('连带删掉了 1 个派生会话'))
buttonWithText(renderDialog(), '完成').props.onClick()

/* ── 14. 宿主给的提醒（血缘读不全等）：照实显示，但不影响能不能删 ─────── */

responses.push({ body: sessionPayload({ warnings: ['有 2 个子会话的目录读不出来：它们会一起删掉，但它们自己带出的下一层没法枚举'] }) })
openViaMenu()
await tick()
const warnTree = renderDialog()
check('显示宿主给的提醒', textOf(warnTree).includes('还有几件事要你知道') && textOf(warnTree).includes('目录读不出来'))
check('提醒不影响可删性', Boolean(findByClass(warnTree, 'dsm-button-danger')))
check('提醒不影响确认勾选', Boolean(ackBoxOf(warnTree)))
buttonWithText(warnTree, '取消').props.onClick()
check('取消后关闭', renderDialog() === null)

/* ── 15. 尺寸格式化 ────────────────────────────────────────────────────── */

check('0 字节', exportsObject.formatBytes(0) === '0 B')
check('KB', exportsObject.formatBytes(2048) === '2.0 KB')
check('GB', exportsObject.formatBytes(3 * 1024 ** 3) === '3.0 GB')

check('会话 id 提取只认小写 uuid 形状', exportsObject.sessionIdsIn(`x ${SESSION} y session-ABCDEF00-1111-4222-8333-444444444444`).size === 1)

/* ── 13. 卸载 ──────────────────────────────────────────────────────────── */

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
check('卸载释放两个座位', slotDisposals.count === 2, String(slotDisposals.count))
check('卸载移除样式表', head.children.length === 0, String(head.children.length))
check('卸载清空对话框', renderDialog() === null)

/* ── 汇总 ──────────────────────────────────────────────────────────────── */

let failed = 0
for (const item of checks) {
  if (!item.ok) failed += 1
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.detail ? `  (${item.detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
if (failed > 0) process.exitCode = 1
