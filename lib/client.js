/**
 * dsh-session-manager-delete —— 浏览器半区（可读源码）。
 *
 * 真正被浏览器加载的是 lib/client.bundle.js（scripts/build-client.mjs 把本文件包进
 * DSH 客户端模块系统要求的 `window.__ModuleLoader__.load({ id, factory })` 形状）。
 *
 * 它做三件事：
 *   1. 会话行「…」菜单里加一行「删除会话…」（官方座位 `sidebar.workspaces.session.menu.item`）；
 *   2. 点它弹确认框（官方浮层 `shell.overlay`）：**先把要删的东西全列出来**，
 *      勾选确认之后才允许点「永久删除」；
 *   3. 删除成功后，按宿主回报的 `deletedIds` 把这次会话在浏览器本地状态里的残留一并清掉
 *      （侧栏顺序、每会话草稿、右栏布局），只摘目标 id，别的会话一个字不动。
 *
 * **没有刷新功能**：宿主半区在删除时已经把会话从进程内注册表注销、磁盘删净、登记摘干净，
 * 浏览器侧的本地状态也在同一次删除里清理完毕 —— 所以既不需要用户手动刷新，
 * 也没有"清理缓存"这类额外入口。插件只留一个菜单入口与一个确认框座位。
 *
 * 本地状态的清理规则来自官方 store 的真实契约，不是猜的（逐条核对过整包源码）：
 *   · `@deepseek-ai/dsh-client-store` 的 `defineStore().create(scopeKey)` 把会话级键拼成
 *     `` `${persist}.${scopeKey}` ``（scopeKey 就是会话 id），持久化就是整值 JSON 写 localStorage，
 *     值是 store 状态本身（没有信封、没有版本号）；`clearPersisted()` 也只是 removeItem。
 *   · 会话级键一共五个命名空间，都是"键名里点名会话"的私有键：
 *     `dsh.conversation.<id>`（草稿 `{draft, view, viewRequest}`）、
 *     `dsh.user-questions.drafts.v1.<id>`（答题草稿）、
 *     `dsh.sidebar-browser.v1.<id>`（浏览器页签）、
 *     `dsh.sidebar-right.v1.<id>`（右栏布局）、
 *     `dsh.schedule.task-tab.v1.<id>`（定时任务页签）。
 *   · 共享键里会话 id 只出现在值里：`dsh.workspace.view.v5` 的
 *     `sessionOrderByAccount.<accountKey>` 是 id 数组；`dsh.sessions.current` 是
 *     `{sessionId?, subagentAddress?}` 单选举状态 —— 对它们只做定点摘除/清空，
 *     绝不整键删除（那会连别的会话的偏好一起丢）。
 *
 * 两个已知的坑，代码里都绕开了：
 *   · `dsh.conversation.contentWidth` 与 `dsh.conversation.<id>` 共享前缀，
 *     按 `startsWith('dsh.conversation.')` 扫会把用户的全局转录宽度偏好清掉 ——
 *     本插件判的是"键名里有没有一整段正好是会话 id"，所以 `contentWidth` 不会被误伤；
 *   · 删掉一个键之后，还活着的 store 会在下一次提交时把它**写回来**
 *     （`attachPersistence` 订阅了每次状态变化）。删除流程因此排在"宿主注销之后"：
 *     会话已经不在宿主里了，它的面板/页签作用域随之结束，本地键不会被再写回来；
 *     这是"不需要刷新"的前提。
 *
 * 设计原则（对应"简洁、可读、无 bug、无兼容性问题"）：
 *   1. **只碰官方座位**：不注入 DOM 改别人的节点、不用 hash 类名；座位拿不到就安静不做事。
 *   2. **样式自己带**：客户端没有 styles 服务（那是动态包 builtin 的闭包参数），官方打包插件
 *      都是自己插一个 <style> 并在卸载时收走 —— 本插件照做，所以模态层一定生效。
 *   3. **提醒先于动作**：删除前列清单，勾选确认之后才落刀。
 *   4. **只删自己说过的东西**：清单之外的键、别的会话的引用、别的插件的状态，一律不碰；
 *      值不是认识的 JSON 结构时只报告、不改写。
 *   5. **绝不让界面崩**：拿不到服务、接口 4xx/5xx、字段缺失、localStorage 不可用，
 *      全都降级成"对话框里一行原因"。
 */

/* ── 常量 ──────────────────────────────────────────────────────────────── */

/** 宿主半区注册的唯一端点（见 lib/index.js）。 */
const ROUTE = '/dsh-session-manager-delete/api'
/** 会话行「…」菜单的一个座位：一项一行，按 order 升序排。 */
const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
/** 框架级浮层：两个对话框都挂在这里，脱离侧栏的滚动与裁剪。 */
const OVERLAY_SLOT = 'shell.overlay'
/** 排在官方 pin(100)/rename(200)/fork(300)/copy ID(450)/archive(600) 之后：最危险的动作放最后。 */
const MENU_ORDER = 700
/** 与宿主约定的确认标记：漏了它宿主一定拒删。 */
const CONFIRM_TOKEN = 'delete-session'
/** 样式标签的识别名：插件被重复应用时靠它去重。 */
const STYLE_TAG = 'dsh-session-manager-delete'
/**
 * 会话 id 的形状：`<uuid>`（子代理会话）或 `session-<uuid>`（根会话），只收小写。
 * 与宿主半区的 `SESSION_ID_PATTERN` 是同一个形状 —— 两边认不出同一个东西就没法对话。
 */
const SESSION_ID_PATTERN = /(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
/** 一次最多处理多少个候选会话 id（防着手抖塞一大坨）。 */
const MAX_SCAN_IDS = 500
/** 递归摘引用的最大深度：JSON 再深也不至于到这里，到了就收手。 */
const MAX_STRIP_DEPTH = 16
/** 读会话信息的超时：只影响这一次 GET，超时了可以放心重试。 */
const INSPECT_TIMEOUT_MS = 15_000
/** 删除的超时：中止只是不再等待，宿主那边的删除**不会**跟着停 —— 超时后结果未知。 */
const DELETE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 少数共享键有更对的清法。目前只有一条，但它值得单独写：
 *
 * `dsh.sessions.current` 是单选举状态 `{ sessionId, subagentAddress? }`，而
 * `subagentAddress` 的内部形状没有公开契约（由 `sessions.subagentAddress(id)` 产生，
 * 可能是字符串也可能是对象）。所以分两种情况：
 *   · **选中的会话本身被删** → 退回应用自己的空状态 `{}`（`clearMain()` 就是 `set({})`）；
 *   · **只有 subagentAddress 指向被删的子代理会话** → 只删这一个字段，保留父会话的选中。
 * 绝不深挖 subagentAddress 的内部结构：留下"半个地址"会被 `restoreSelection`
 * （判 `saved.subagentAddress !== undefined`）当成有效地址去恢复。
 */
function patchCurrentSelection(value, wanted) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.sessionId === 'string' && wanted.has(value.sessionId)) return { value: {}, hits: 1 }
  if (!Object.prototype.hasOwnProperty.call(value, 'subagentAddress')) return null
  const mentioned = [...sessionIdsIn(JSON.stringify(value.subagentAddress))].some((id) => wanted.has(id))
  if (!mentioned) return null
  const next = { ...value }
  delete next.subagentAddress
  return { value: next, hits: 1 }
}

/** 有专门清法的共享键；返回 null 表示"这个值不该交给通用规则改写"。 */
const SHARED_KEY_PATCHERS = new Map([['dsh.sessions.current', patchCurrentSelection]])

/**
 * 客户端插件的依赖声明：官方打包插件都这么声明（`exports.inject`），
 * 这样 DSH 会等服务就绪再调用 apply，而不是让插件在 slots 还没挂上时静默什么都不做。
 */
// contextMenus 是可选的：老宿主没有这个服务，硬写进 inject 会让整个插件永远不启动，
// 所以只把 slots 当必需依赖，菜单服务在 apply 里用 ctx.get 探测（见 apply 里的升级逻辑）。
const inject = ['slots']

/** 全部样式只用一个前缀、只用 DSH 的设计 token，深浅色自动跟随。 */
const CSS = `
.dsm-backdrop {
  position: fixed; inset: 0; z-index: 1000; pointer-events: auto;
  display: flex; align-items: center; justify-content: center; padding: 24px;
  background: rgba(0, 0, 0, 0.38);
}
.dsm-dialog {
  width: min(560px, 100%); max-height: min(82vh, 760px);
  display: flex; flex-direction: column; overflow: hidden; outline: none;
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #ffffff));
  color: var(--dsw-alias-label-primary, #1a1a1a);
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-radius: 12px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
  font-size: 14px; line-height: 20px;
}
.dsm-head { display: flex; align-items: center; gap: 8px; padding: 16px 20px 8px; }
.dsm-head-mark { color: var(--dsw-alias-state-error-primary, #d92d20); }
.dsm-title { margin: 0; font-size: 15px; font-weight: 600; }
.dsm-body { display: flex; flex-direction: column; gap: 12px; padding: 4px 20px 8px; overflow: auto; }
.dsm-session-title { font-weight: 500; word-break: break-word; }
.dsm-session-id {
  display: block; margin-top: 2px; font-size: 12px; word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--dsw-alias-label-secondary, #666666);
}
.dsm-meta { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; font-size: 12px; }
.dsm-meta-label { color: var(--dsw-alias-label-secondary, #666666); }
.dsm-meta-value { margin: 0; word-break: break-all; }
.dsm-box { padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12)); border-radius: 8px; font-size: 12.5px; }
.dsm-box-warn { border-color: var(--dsw-alias-state-warn-primary, #b54708); }
.dsm-box-error { border-color: var(--dsw-alias-state-error-primary, #d92d20); color: var(--dsw-alias-state-error-primary, #d92d20); }
.dsm-box-done { border-color: var(--dsw-alias-state-success-primary, #067647); }
.dsm-box-title { font-weight: 600; }
.dsm-box p { margin: 4px 0 0; }
.dsm-box-actions { margin-top: 8px; }
.dsm-list {
  margin: 6px 0 0; padding-left: 16px; max-height: 132px; overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary, #666666);
}
.dsm-list li { word-break: break-all; }
.dsm-check { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; cursor: pointer; }
.dsm-check input { margin: 2px 0 0; accent-color: var(--dsw-alias-state-error-primary, #d92d20); }
.dsm-check-hint {
  display: block; margin-top: 2px; font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, #666666);
}
.dsm-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 16px; }
.dsm-button {
  padding: 6px 14px; border-radius: 8px; font: inherit; font-size: 13px; line-height: 18px;
  cursor: pointer; border: 0.5px solid transparent; background: transparent; color: inherit;
}
.dsm-button:disabled { opacity: 0.5; cursor: not-allowed; }
.dsm-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2563eb); outline-offset: 1px; }
.dsm-button-ghost { border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12)); }
.dsm-button-ghost:hover:enabled { background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.05)); }
.dsm-button-danger { background: var(--dsw-alias-state-error-primary, #d92d20); color: #ffffff; }
.dsm-button-danger:hover:enabled { filter: brightness(1.06); }
.dsm-menuitem {
  display: block; width: 100%; text-align: left; padding: 6px 10px; border: 0; border-radius: 6px;
  background: transparent; font: inherit; font-size: 13px; line-height: 18px; cursor: pointer;
  color: var(--dsw-alias-state-error-primary, #d92d20);
}
.dsm-menuitem:hover { background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.05)); }
.dsm-menuitem:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2563eb); outline-offset: -2px; }
.dsm-choices { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
.dsm-choice {
  display: flex; align-items: flex-start; gap: 8px; padding: 4px 6px;
  border-radius: 6px; font-size: 13px; line-height: 18px; cursor: pointer;
}
.dsm-choice:hover { background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.05)); }
.dsm-choice[data-disabled="true"] { cursor: not-allowed; opacity: 0.6; }
.dsm-choice[data-disabled="true"]:hover { background: transparent; }
.dsm-choice input { margin-top: 2px; }
.dsm-choice-label { display: block; word-break: break-all; }
.dsm-choice-hint { display: block; opacity: 0.7; font-size: 12px; }
`

/** 插件文案：跟随界面语言，语言服务缺席时退回中文。 */
const DICT = {
  zh: {
    menu: '删除会话…',
    menuHint: '永久删除这个会话的全部记录，删除前会再确认一次',
    title: '删除会话',
    untitled: '（无标题会话）',
    loading: '正在读取会话信息…',
    deleting: '正在删除…',
    cancel: '取消',
    confirm: '永久删除',
    done: '完成',
    doneTitle: '会话已删除',
    missing: '会话不存在，可能已经被删除',
    size: '占用空间',
    records: '对话记录',
    created: '创建时间',
    cwd: '工作目录',
    unknown: '未知',
    warnTitle: '删除后无法恢复',
    warnBody: '这个会话的对话日志、投影缓存和工作区登记都会被移除。工作区目录里的文件不受影响，附件也不会被删除。',
    warnSubagents: '还会一并删除 {n} 个子代理会话（它们在侧栏里不可见，不删就会变成磁盘上的孤儿）。',
    warnForks: '另有 {n} 个派生会话（fork）默认会保留下来；想一起删就在下面的列表里勾选。',
    warnHost: '还有几件事要你知道',
    busyTitle: '这个会话还有没结束的工作',
    busyBody: '正在跑：{list}',
    busyStop: '先停掉正在跑的工作，然后删除',
    busyStopHint: '不勾选就不会删；勾选后宿主会先请它们停下，停不下来就拒绝删除（不会硬删）。',
    forkTitle: '可选：一并删除派生会话（fork）',
    forkBody: '这些是从本会话派生出来的独立对话，默认保留。勾选哪个就删哪个（连它自己的子代理会话一起）。',
    forkNotArchived: '还没有归档，先归档它才能一起删',
    forkHint: '只删上面勾选的那些，没勾的一律不动。',
    terminalsTitle: '会话名下的终端已关闭',
    terminalsClosed: '关掉了 {n} 个终端（命令窗口），它们不会留在进程里。',
    stoppedBefore: '已先停掉 {n} 个会话正在跑的工作，然后才删。',
    extraRootsRemoved: '连带删掉了 {n} 个派生会话。',
    artifacts: '将被删除的文件',
    blocked: '现在不能删除',
    blockedUnknown: '当前状态不允许删除，请稍后再试',
    removed: '已删除',
    registry: '工作区登记',
    registryUnavailable: '服务不可用，未改动登记',
    registryClean: '没有引用需要清理',
    listSeparator: '、',
    labelSeparator: '：',
    nothingRemoved: '磁盘上没有找到这个会话的文件（可能尚未落盘，也可能位于软链/联接之后），本次只清理了工作区登记。',
    failed: '删除失败',
    httpFailed: '请求失败（HTTP {status}）',
    requestTimeout: '请求超时，请稍后重试。',
    inspectTimeout: '读取会话信息超时，请稍后重试。',
    deleteTimeout: '删除请求超时，结果未知：宿主可能已经删完，请先刷新侧栏确认，再决定是否重试。',
    unknownTitle: '删除结果未知',
    noSessionInfo: '宿主没有返回会话信息',
    close: '关闭',
    /* ── 将被删除 / 不会被删除 ── */
    targetsTitle: '将被删除的会话（含子代理会话）',
    registryTitle: '将被清理的工作区登记',
    registryFromWorkspace: '从工作区「{name}」移出',
    registryUnpin: '取消置顶',
    registryUnarchive: '取消归档',
    registryUnknown: '登记服务不可用，这一项无法确认（不会盲改）',
    localTitle: '将被清理的浏览器本地状态',
    localNone: '没有发现指向这些会话的本地状态（无残留）。',
    localRemoveKey: '移除 {key}',
    localEditKey: '{key}：摘掉 {n} 处引用',
    localResetKey: '{key}：清空（退回应用自己的"未选中"状态）',
    localUnreadable: '{key}：提到了这些会话，但值的结构不认识 —— 只报告，不改写',
    localUnavailable: '浏览器不允许读取本地存储，这一层不会被动到。',
    danglingTitle: '另有历史遗留的悬空引用',
    danglingBody: '工作区登记里还挂着 {n} 条指向「已经不存在的会话」的引用（界面上就是那些残留的「未分组」条目）。它们会跟着这次删除一起被剪掉 —— 只动登记，不碰任何文件。',
    notDeletedTitle: '不会被删除',
    notDeletedBody: [
      '工作区目录里的任何文件（你的代码、文档、数据）。',
      '附件与内容寻址缓存（跨会话共享，删了会弄坏别的会话）。',
      '登录凭据、账号与 profile 设置。',
      '其他会话：日志、投影缓存、登记引用、浏览器本地状态，一个都不碰。',
      '其他插件自己的状态文件。',
    ],
    ackLabel: '我已确认：永久删除上面的会话、它的子代理会话，以及上面列出的缓存与登记项。',
    ackHint: '勾选后才能点「永久删除」。',
    /* ── 删除结果 ── */
    archived: '归档状态',
    archivedYes: '已归档（满足删除条件）',
    forgotten: '宿主内存注销：已把 {n} 个会话从本进程的活会话表与 Agent 表里移除',
    flushed: '其中 {n} 个还没落盘，已先补写落盘再删',
    memoryRemainingTitle: '宿主内存里还有残留',
    memoryRemaining: '还有 {n} 个会话没能从宿主内存里注销掉（侧栏里可能仍会出现「未分组」条目）—— 重启 DSH 一定能清掉。',
    emptyDirsRemoved: '顺带收走了 {n} 个空的工作区目录',
    danglingPruned: '顺带剪掉 {n} 条悬空引用',
    spillTitle: '临时目录里的残留',
    spillRemaining: '临时目录里还有 {n} 项工具输出溢出没能删掉（不影响会话本身，官方也会按 30 天自动回收）',
    localCleared: '浏览器本地状态：清理了 {n} 处残留（{k} 个键）',
    localClearedNone: '浏览器本地状态：没有残留需要清理',
    localClearFailed: '浏览器本地状态：有 {n} 个键没能清理（浏览器拒绝了写入）',
    listRefreshTitle: '侧栏列表没有刷新成功',
    listRefreshFailed: '会话已经删掉，但界面里的旧列表还留着这一行（可能显示在「未分组」里）；刷新页面就会消失。',
    registryDirtyTitle: '工作区登记没有清干净',
    registryDirty: '会话文件已经删掉，但工作区登记里还留着它的引用（重启后可能又冒出一条「未分组」）。请重启 DSH，或再打开一次这个对话框清理。',
    danglingRepair: '现在清理',
    danglingRepairing: '清理中…',
    danglingRepaired: '已清理 {n} 条历史悬空引用。',
    danglingRepairFailed: '清理没成功：{error}',
    danglingRepairUnknown: '清理结果未知：宿主可能已经把这几条清掉了。关掉对话框再重新打开，以宿主的结论为准。',
    danglingTruncated: '另有 {n} 条这次没有列出；清理这一批后再打开对话框继续。',
    forkExtraHint: '勾选后的 fork 不在上方清单里：它的日志、工作区登记与浏览器本地状态会跟着一起删除。',
  },
  en: {
    menu: 'Delete session…',
    menuHint: 'Permanently delete this session; you will be asked to confirm',
    title: 'Delete session',
    untitled: '(untitled session)',
    loading: 'Reading session info…',
    deleting: 'Deleting…',
    cancel: 'Cancel',
    confirm: 'Delete permanently',
    done: 'Done',
    doneTitle: 'Session deleted',
    missing: 'The session does not exist; it may already have been deleted',
    size: 'Size',
    records: 'Records',
    created: 'Created',
    cwd: 'Working directory',
    unknown: 'unknown',
    warnTitle: 'This cannot be undone',
    warnBody: 'The conversation log, its projection cache and its workspace registration are removed. Files in the workspace are untouched, and attachments are not deleted.',
    warnSubagents: '{n} subagent session(s) will be deleted with it — they are invisible in the sidebar and would otherwise be orphaned on disk.',
    warnForks: '{n} forked conversation(s) are kept by default; tick them in the list below to delete them too.',
    warnHost: 'A few things to know',
    busyTitle: 'This session still has unfinished work',
    busyBody: 'Running: {list}',
    busyStop: 'Stop the running work first, then delete',
    busyStopHint: 'Nothing is deleted unless you tick this; the Host asks that work to stop and refuses the delete if it will not.',
    forkTitle: 'Optional: delete forked conversations as well',
    forkBody: 'These are separate conversations derived from this one; they are kept by default. Tick one to delete it (with its own subagent sessions).',
    forkNotArchived: 'Not archived yet — archive it first',
    forkHint: 'Only what you tick above is deleted; everything else stays untouched.',
    terminalsTitle: 'Terminals owned by the session were closed',
    terminalsClosed: 'Closed {n} terminal(s); they are not left running in the process.',
    stoppedBefore: 'Stopped the running work of {n} session(s) before deleting.',
    extraRootsRemoved: 'Also deleted {n} forked conversation(s).',
    artifacts: 'Files to be removed',
    blocked: 'Cannot delete right now',
    blockedUnknown: 'This session cannot be deleted right now; please try again later',
    removed: 'Removed',
    registry: 'Workspace registration',
    registryUnavailable: 'The registry service is unavailable; nothing changed there',
    registryClean: 'No references needed cleaning',
    listSeparator: ', ',
    labelSeparator: ': ',
    nothingRemoved: 'Nothing was found on disk for this session (it may not be materialized yet, or its files may sit behind a symlink/junction); only the workspace registration was cleaned.',
    failed: 'Deletion failed',
    httpFailed: 'Request failed (HTTP {status})',
    requestTimeout: 'Request timed out; please try again.',
    inspectTimeout: 'Timed out while reading the session info; please try again.',
    deleteTimeout: 'The delete request timed out, so the result is unknown: the host may already have deleted it. Refresh the sidebar before retrying.',
    unknownTitle: 'Delete result unknown',
    noSessionInfo: 'The host returned no session info',
    close: 'Close',
    targetsTitle: 'Sessions that will be deleted (subagents included)',
    registryTitle: 'Workspace registration to be cleaned',
    registryFromWorkspace: 'Detach from workspace "{name}"',
    registryUnpin: 'Unpin',
    registryUnarchive: 'Unarchive',
    registryUnknown: 'The registry service is unavailable, so this cannot be confirmed (nothing is changed blindly)',
    localTitle: 'Browser-local state to be cleaned',
    localNone: 'No local state points at these sessions (no residue).',
    localRemoveKey: 'Remove {key}',
    localEditKey: '{key}: drop {n} reference(s)',
    localResetKey: '{key}: reset (back to the app\u2019s own "no selection" state)',
    localUnreadable: '{key}: mentions these sessions but its value shape is unknown — reported only, never rewritten',
    localUnavailable: 'The browser does not allow reading local storage, so this layer is left alone.',
    danglingTitle: 'Historical dangling references',
    danglingBody: 'The workspace registration still holds {n} reference(s) to sessions that no longer exist (the leftover "ungrouped" entries in the sidebar). They are pruned together with this deletion — registration only, no file is touched.',
    notDeletedTitle: 'Not deleted',
    notDeletedBody: [
      'Any file in the workspace directory (your code, documents, data).',
      'Attachments and the content-addressed cache (shared across sessions).',
      'Credentials, account and profile settings.',
      'Other sessions: logs, projection caches, registry references and browser-local state are all untouched.',
      'Other plugins\u2019 own state files.',
    ],
    ackLabel: 'I confirm: permanently delete the sessions above, their subagent sessions, and the caches and registration entries listed here.',
    ackHint: 'Tick this before "Delete permanently" becomes available.',
    archived: 'Archive state',
    archivedYes: 'Archived (deletion precondition met)',
    forgotten: 'Host-memory deregistration: removed {n} session(s) from this process\u2019s live-session and Agent tables',
    flushed: '{n} of them were not yet materialized; they were flushed to disk first',
    memoryRemainingTitle: 'Residue left in host memory',
    memoryRemaining: '{n} session(s) could not be deregistered from host memory (an “ungrouped” entry may still show up in the sidebar) — restarting DSH always clears them.',
    emptyDirsRemoved: 'Also removed {n} empty workspace directory(ies)',
    danglingPruned: 'Also pruned {n} dangling reference(s)',
    spillTitle: 'Leftovers in the temp directory',
    spillRemaining: '{n} spilled tool-output item(s) could not be removed from the temp directory (the session itself is unaffected; the official sweep reclaims them after 30 days)',
    localCleared: 'Browser-local state: cleaned {n} reference(s) in {k} key(s)',
    localClearedNone: 'Browser-local state: nothing to clean',
    localClearFailed: 'Browser-local state: {n} key(s) could not be cleaned (the browser refused the write)',
    listRefreshTitle: 'The sidebar list did not refresh',
    listRefreshFailed: 'The session is deleted, but the stale list still shows the row (possibly under “Ungrouped”); reload the page and it will disappear.',
    registryDirtyTitle: 'The workspace registration is not clean',
    registryDirty: 'The session files are gone, but the workspace registration still references it (an “Ungrouped” row may come back after a restart). Restart DSH, or reopen this dialog to clean it up.',
    danglingRepair: 'Clean now',
    danglingRepairing: 'Cleaning…',
    danglingRepaired: 'Cleaned {n} historical dangling reference(s).',
    danglingRepairFailed: 'Cleanup failed: {error}',
    danglingRepairUnknown: 'Cleanup result unknown: the host may already have removed them. Close and reopen this dialog to see the host’s verdict.',
    danglingTruncated: '{n} more are not listed; clean this batch, then reopen the dialog for the rest.',
    forkExtraHint: 'A ticked fork is not in the list above: its log, workspace registration and browser-local state are deleted with it.',
  },
}

/* ── 小工具 ────────────────────────────────────────────────────────────── */

/** React.createElement 的短名字，让下面的组件读起来像树。 */
const h = (type, props, ...children) => React.createElement(type, props, ...children)

/** 错误 → 一行文案。 */
function messageOf(error) {
  return error && error.message ? String(error.message) : String(error)
}

/** 极简插值：把 `{name}` 换成 params 里的值（语言服务缺席时同一套文案也能用）。 */
function fill(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match))
}

/** 字节 → 人话。 */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

/** 时间戳 → 本地时间；没有时间就显示调用方给的兜底文案。 */
function formatTime(milliseconds, fallback) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds)) return fallback
  try {
    return new Date(milliseconds).toLocaleString()
  } catch (error) {
    return String(milliseconds)
  }
}

/** 去重并保序，最多留 n 个。 */
function uniqueIds(values, limit) {
  const seen = new Set()
  const result = []
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue
    seen.add(value)
    result.push(value)
    if (result.length >= limit) break
  }
  return result
}

/* ── 浏览器本地状态：只摘目标 id，别的一字不动 ─────────────────────────── */

/** 一段文本里出现的全部会话 id（键名与 JSON 值都靠它认）。 */
function sessionIdsIn(text) {
  const found = new Set()
  if (typeof text !== 'string' || text === '') return found
  for (const match of String(text).matchAll(SESSION_ID_PATTERN)) found.add(match[0])
  return found
}

/** localStorage 句柄；拿不到（隐私模式 / 沙箱 / 被策略禁用）就返回 null，调用方一律降级。 */
function storageOf() {
  try {
    const storage = typeof localStorage !== 'undefined' && localStorage ? localStorage : null
    if (!storage) return null
    // 真的碰一下：有的环境属性存在、方法却抛错。
    void storage.length
    return storage
  } catch (error) {
    return null
  }
}

/** 枚举 localStorage 的全部键；读一半失败就把已经读到的当全部，绝不抛。 */
function storageKeys(storage) {
  const keys = []
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (typeof key === 'string') keys.push(key)
    }
  } catch (error) {
    // 认了：拿到的那些就是全部。
  }
  return keys
}

/** 读一个键的原始文本；读不到当 null。 */
function storageRead(storage, key) {
  try {
    const raw = storage.getItem(key)
    return typeof raw === 'string' ? raw : null
  } catch (error) {
    return null
  }
}

/** 本地状态里提到的全部会话 id（键名 + 值），最多 MAX_SCAN_IDS 个。 */
function referencedLocalSessionIds() {
  const found = new Set()
  const storage = storageOf()
  if (!storage) return found
  for (const key of storageKeys(storage)) {
    for (const id of sessionIdsIn(key)) found.add(id)
    if (found.size >= MAX_SCAN_IDS) break
    for (const id of sessionIdsIn(storageRead(storage, key) || '')) found.add(id)
    if (found.size >= MAX_SCAN_IDS) break
  }
  return found
}

/**
 * 递归摘掉 JSON 树里指向这些会话的引用。
 *
 * 只做两件事，绝不做第三件：
 *   · 数组里**正好等于**某个目标 id 的元素 —— 丢掉；
 *   · 对象里**值正好等于**某个目标 id 的属性 —— 删掉这个属性。
 * 其他任何东西（别的 id、别的字段、字符串里夹着的 id、非字符串标量）一字不动。
 * 这两条正好覆盖官方两个共享键的真实形状：`dsh.workspace.view.v5` 的
 * `sessionOrderByAccount.<accountKey>` 是 id 数组；`dsh.sessions.current` 是
 * `{ sessionId, subagentAddress }` —— 而它自己的 `clearMain()` 就是 `set({})`，
 * 所以删掉属性正是应用自己的"没有选中会话"状态。
 *
 * @returns {{ value: any, hits: number }} hits 为 0 时调用方必须原样处理（等价于不写）。
 */
function stripSessionIds(value, wanted, depth = 0) {
  if (depth > MAX_STRIP_DEPTH) return { value, hits: 0 }
  if (Array.isArray(value)) {
    const next = []
    let hits = 0
    for (const item of value) {
      if (typeof item === 'string' && wanted.has(item)) {
        hits += 1
        continue
      }
      const inner = stripSessionIds(item, wanted, depth + 1)
      hits += inner.hits
      next.push(inner.value)
    }
    return { value: next, hits }
  }
  if (value !== null && typeof value === 'object') {
    const next = {}
    let hits = 0
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && wanted.has(item)) {
        hits += 1
        continue
      }
      const inner = stripSessionIds(item, wanted, depth + 1)
      hits += inner.hits
      next[key] = inner.value
    }
    return { value: next, hits }
  }
  return { value, hits: 0 }
}

/**
 * 盘点这次要动本地状态的哪些键（**只读**，一个字都不写）。
 *
 * 规则只有两条，都要"指名道姓"地指向目标会话：
 *   1. 键名里有一整段就是某个目标 id（官方会话级键就是 `<命名空间>.<会话 id>`）
 *      → 整个键移除；
 *   2. 键名没点名、但 JSON 值里引用着目标 id（例如侧栏顺序）→ 只把那些引用摘掉，
 *      值的其他部分原样保留。
 * 值不是认识的 JSON 结构时只报告不改写（宁可留一条，也不猜着改写别人的数据）。
 */
function planLocalCleanup(ids) {
  const wanted = new Set(uniqueIds(ids, MAX_SCAN_IDS))
  const plan = { available: false, removes: [], edits: [], untouched: 0, hits: 0, checked: wanted.size }
  const storage = storageOf()
  if (!storage) return plan
  plan.available = true
  if (wanted.size === 0) {
    plan.untouched = storageKeys(storage).length
    return plan
  }

  for (const key of storageKeys(storage)) {
    const named = key.split('.').some((segment) => wanted.has(segment))
    if (named) {
      plan.removes.push({ key })
      plan.hits += 1
      continue
    }
    const raw = storageRead(storage, key)
    if (raw === null) {
      plan.untouched += 1
      continue
    }
    const mentioned = [...sessionIdsIn(raw)].filter((id) => wanted.has(id))
    if (mentioned.length === 0) {
      plan.untouched += 1
      continue
    }
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      parsed = null
    }
    // 有专门清法的共享键：认不出结构就只报告，绝不交给通用规则去猜。
    const patcher = SHARED_KEY_PATCHERS.get(key)
    if (patcher) {
      const patched = parsed !== null && typeof parsed === 'object' ? patcher(parsed, wanted) : null
      if (patched) {
        plan.edits.push({ key, ids: mentioned, hits: patched.hits, value: patched.value, reset: Object.keys(patched.value).length === 0 })
        plan.hits += patched.hits
      } else {
        plan.edits.push({ key, ids: mentioned, hits: 0 })
      }
      continue
    }
    const stripped = parsed !== null && typeof parsed === 'object' ? stripSessionIds(parsed, wanted) : { value: null, hits: 0 }
    if (stripped.hits === 0) {
      plan.edits.push({ key, ids: mentioned, hits: 0 })
      continue
    }
    plan.edits.push({ key, ids: mentioned, hits: stripped.hits, value: stripped.value })
    plan.hits += stripped.hits
  }
  return plan
}

/**
 * 执行清理：**按同一份 id 重新盘点一次再动手**（预览与执行之间值可能变了），
 * 而且只做盘点结果里的动作 —— 整键移除 = removeItem，定点摘除 = 写回摘好的 JSON。
 * 任何一步失败都如实记下来，不吞、不假报。
 */
function applyLocalCleanup(ids) {
  const plan = planLocalCleanup(ids)
  const result = { available: plan.available, removed: [], edited: [], hits: 0, failed: [] }
  const storage = storageOf()
  if (!storage) return result
  for (const entry of plan.removes) {
    try {
      storage.removeItem(entry.key)
      result.removed.push(entry.key)
      result.hits += 1
    } catch (error) {
      result.failed.push(entry.key)
    }
  }
  for (const entry of plan.edits) {
    if (entry.hits <= 0) continue
    try {
      storage.setItem(entry.key, JSON.stringify(entry.value))
      result.edited.push(entry.key)
      result.hits += entry.hits
    } catch (error) {
      result.failed.push(entry.key)
    }
  }
  return result
}

/* ── 与宿主对话（唯一出口，错误统一收敛）────────────────────────────────── */

/**
 * 发一个请求并要一份 `{ok:true,…}` 的 JSON。
 * 非 2xx、非 JSON（比如被登录页顶掉的 HTML）、ok !== true 一律抛成带原因的异常，
 * 调用方只需处理一种失败形态；文案走 t，英文界面里不会漏出中文。
 */
async function request(url, options, t, timeout) {
  // 没有 AbortController 的环境（老 WebView / 极简注入）退回普通 fetch：不能因为超时设施缺席就整个插件不可用。
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller && timeout && typeof setTimeout === 'function'
    ? setTimeout(() => controller.abort(), timeout.ms)
    : null
  const timedOut = () => {
    const error = new Error((timeout && timeout.message) || t('requestTimeout'))
    error.code = 'TIMEOUT'
    return error
  }
  try {
    let response
    try {
      response = await fetch(url, controller ? { ...options, signal: controller.signal } : options)
    } catch (error) {
      if (controller && controller.signal.aborted) throw timedOut()
      throw error
    }
    // 超时覆盖到**读完响应体**为止：只在响应头回来后就撤掉计时器，服务端回了头却卡住 body 时会永远等下去。
    let payload = null
    try {
      payload = await response.json()
    } catch (error) {
      if (controller && controller.signal.aborted) throw timedOut()
      payload = null
    }
    if (!response.ok || !payload || payload.ok !== true) {
      if (controller && controller.signal.aborted) throw timedOut()
      throw new Error((payload && payload.error) || fill(t('httpFailed'), { status: response.status }))
    }
    return payload
  } finally {
    if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer)
  }
}

/** 查一个会话的可删除性（无副作用）：磁盘清单、登记清单、悬空引用预览都在里面。 */
async function inspectSession(sessionId, t) {
  const payload = await request(
    `${ROUTE}?id=${encodeURIComponent(sessionId)}`,
    { headers: { accept: 'application/json' } },
    t,
    { ms: INSPECT_TIMEOUT_MS, message: t('inspectTimeout') },
  )
  if (!payload.session) throw new Error(t('noSessionInfo'))
  return { session: payload.session }
}

/**
 * 真删（宿主侧还会再查一遍身份、归档、确认标记、可选项是否真在血缘里）。
 *
 * @param {object} options
 * @param {string[]} [options.dangling] 对话框里**给用户看过**的那份悬空引用清单：宿主只剪这些。
 * @param {string[]} [options.extraRoots] 用户勾选要连带删除的派生会话（fork）id。
 * @param {boolean} [options.stop] 用户勾了"先停掉正在跑的工作"。
 */
function removeSession(sessionId, options, t) {
  const body = { id: sessionId, confirm: CONFIRM_TOKEN, dangling: uniqueIds(options.dangling, MAX_SCAN_IDS) }
  const extraRoots = uniqueIds(options.extraRoots, MAX_SCAN_IDS)
  if (extraRoots.length > 0) body.extraRoots = extraRoots
  if (options.stop === true) body.stop = true
  return request(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, t, { ms: DELETE_TIMEOUT_MS, message: t('deleteTimeout') })
}

/**
 * 只清历史遗留的悬空引用，不删任何会话文件。
 *
 * 用在"日志早就没了、登记里还留着 id"的幽灵条目上：对那条会话再发删除请求只会 404，
 * 所以宿主单独给了这个入口。它同样要确认标记，并且只动**确实看不见、也没在跑**的 id。
 */
function repairDangling(t) {
  return request(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repair: true, confirm: CONFIRM_TOKEN }),
  }, t, { ms: INSPECT_TIMEOUT_MS, message: t('inspectTimeout') })
}

/* ── 对话框状态 ────────────────────────────────────────────────────────── */

/**
 * 一个小 store 骨架：菜单行与浮层是两个互不相邻的座位，
 * 只有共享同一个 store，"点它 → 查 → 弹框 → 操作 → 更新结果"才能跨座位成立。
 * 每次 apply 建一套。`patch` 只在同一个主题还在框里时才允许改状态，
 * 免得关掉之后又被一个迟到的响应叫回来。
 */
function createStore() {
  let state = null
  const listeners = new Set()
  const publish = (next) => {
    state = next
    for (const listener of [...listeners]) listener()
  }
  const patch = (topicId, next, requestId) => {
    if (!state || state.topicId !== topicId) return
    // 可选序号：异步动作只允许改自己那一轮打开的状态，迟到的响应不能污染新对话框。
    if (requestId !== undefined && state.requestId !== requestId) return
    publish({ ...state, ...next })
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot() {
      return state
    },
    dispose() {
      listeners.clear()
      state = null
    },
    publish,
    patch,
  }
}

/**
 * 删除会话的对话框状态。
 *
 * `open` 里算出来的本地状态清单（plan）会被摆在对话框里 ——
 * 用户在确认之前就能看到"哪些键会被清"，确认之后才真的清，清完如实回显。
 */
function createDialogStore(t, refreshList) {
  const store = createStore()
  /** 打开对话框的序号（见 open）：只用来丢弃迟到的旧响应。 */
  let requestSeq = 0

  return {
    ...store,
    /** 打开确认框：先把标题显示出来，再向宿主查这个会话能不能删。 */
    open(sessionId, title) {
      // 删除进行中就不再接受新的打开请求：避免把"正在删"的框重置成另一个会话的待确认态。
      if (store.getSnapshot() && store.getSnapshot().phase === 'deleting') return
      // 每次打开一个序号：迟到的旧响应（快速关了又开）不许覆盖当前这一次的状态。
      const requestId = (requestSeq += 1)
      store.publish({ topicId: sessionId, requestId, phase: 'loading', sessionId, title, info: null, local: null, error: '', result: null, acknowledged: false, stop: false, extraRoots: [], listRefreshFailed: false, repairing: false, repaired: 0, repairError: '', repairUnknown: false })
      const isCurrent = () => {
        const current = store.getSnapshot()
        return Boolean(current && current.topicId === sessionId && current.requestId === requestId)
      }
      inspectSession(sessionId, t).then(
        ({ session }) => {
          if (!isCurrent()) return
          store.patch(sessionId, {
            phase: 'ready',
            info: session,
            // 本地状态清单在**确认之前**就算好：所见即所清。
            local: planLocalCleanup(targetIdsOf(session)),
            // 还有工作在跑时默认替用户勾上"先停掉"（界面里明确写着要停什么），
            // 别的可选项一律默认不动：默认值必须是最保守的那个。
            stop: Boolean(session && session.busy && session.busy.total > 0),
            extraRoots: [],
          })
        },
        (error) => {
          if (!isCurrent()) return
          store.patch(sessionId, { phase: 'error', error: messageOf(error) })
        },
      )
    },
    /** 勾选"我已确认"；不勾选就不允许真删。 */
    acknowledge(value) {
      const state = store.getSnapshot()
      if (!state || state.phase !== 'ready') return
      store.patch(state.topicId, { acknowledged: value === true })
    },
    /** 勾/取消"先停掉正在跑的工作"。 */
    toggleStop(value) {
      const state = store.getSnapshot()
      if (!state || state.phase !== 'ready') return
      store.patch(state.topicId, { stop: value === true })
    },
    /** 勾/取消一个可选连带删除的派生会话。 */
    toggleFork(id, value) {
      const state = store.getSnapshot()
      if (!state || state.phase !== 'ready') return
      const current = Array.isArray(state.extraRoots) ? state.extraRoots : []
      const next = value === true
        ? uniqueIds([...current, id], MAX_SCAN_IDS)
        : current.filter((entry) => entry !== id)
      store.patch(state.topicId, { extraRoots: next })
    },
    /** 二次确认之后才真删：宿主删磁盘与登记，本地状态由这里按同一份 id 清理。 */
    async confirm() {
      const state = store.getSnapshot()
      if (!state || state.phase !== 'ready' || state.acknowledged !== true || state.repairing === true) return
      const { sessionId, info, requestId } = state
      store.patch(sessionId, { phase: 'deleting' }, requestId)
      try {
        const result = await removeSession(sessionId, {
          dangling: info && info.dangling ? info.dangling.ids : [],
          extraRoots: state.extraRoots,
          stop: state.stop === true,
        }, t)
        // 宿主说删掉了哪几个 id，就清哪几个 id 的本地状态：不多清一个，也不少清一个。
        const deleted = uniqueIds(result.deletedIds, MAX_SCAN_IDS)
        const ids = deleted.length > 0 ? deleted : targetIdsOf(info)
        store.patch(sessionId, { phase: 'done', unknown: false, result, localResult: applyLocalCleanup(ids) }, requestId)
        // 删文件不会推会话列表事件：不重拉一次，浏览器里的旧快照仍留着这一行，
        // 而它已经从工作区登记里摘掉了 —— 侧栏就会把它显示成「未分组」。
        if (typeof refreshList === 'function') {
          try {
            await refreshList(ids)
          } catch (error) {
            store.patch(sessionId, { listRefreshFailed: true }, requestId)
          }
        }
      } catch (error) {
        // 超时≠失败：中止的只是这次等待，宿主那边可能已经删完。文案与标题都要如实说"结果未知"。
        const unknown = Boolean(error && error.code === 'TIMEOUT')
        store.patch(sessionId, { phase: 'error', unknown, error: messageOf(error) }, requestId)
      }
    },
    /**
     * 清掉历史遗留的悬空引用（只动登记，不删会话）。
     * 清完重查一遍：对话框里的悬空清单、不可删原因都要跟着宿主的最新结论走。
     */
    async repair() {
      const state = store.getSnapshot()
      if (!state || state.phase !== 'ready' || state.repairing === true) return
      const { sessionId, requestId } = state
      const isCurrent = () => {
        const current = store.getSnapshot()
        return Boolean(current && current.topicId === sessionId && current.requestId === requestId)
      }
      let swept = 0
      store.patch(sessionId, { repairing: true, repairError: '', repairUnknown: false }, requestId)
      try {
        const payload = await repairDangling(t)
        swept = payload && payload.repair && typeof payload.repair.swept === 'number' ? payload.repair.swept : 0
        if (!isCurrent()) return
        const { session } = await inspectSession(sessionId, t)
        if (!isCurrent()) return
        store.patch(sessionId, {
          repairing: false,
          repaired: swept,
          info: session,
          local: planLocalCleanup(targetIdsOf(session)),
        }, requestId)
      } catch (error) {
        if (!isCurrent()) return
        // 超时≠没清：宿主可能已经清完了，但回包没等到。别让用户以为什么都没发生。
        const unknown = Boolean(error && error.code === 'TIMEOUT')
        store.patch(sessionId, {
          repairing: false,
          repaired: swept,
          repairUnknown: unknown,
          repairError: unknown ? '' : messageOf(error),
        }, requestId)
      }
    },
    /** 关闭。删除进行中不许关，避免"以为取消了其实正在删"。 */
    dismiss() {
      const state = store.getSnapshot()
      if (!state || state.phase === 'deleting') return
      store.publish(null)
    },
  }
}

/** 一个会话信息里的全部目标 id（目标在前，子代理会话在后）。 */
function targetIdsOf(info) {
  if (info && Array.isArray(info.targets)) {
    const ids = uniqueIds(info.targets.map((entry) => (entry && typeof entry.id === 'string' ? entry.id : '')), MAX_SCAN_IDS)
    if (ids.length > 0) return ids
  }
  return info && typeof info.id === 'string' ? [info.id] : []
}

/* ── 样式 ──────────────────────────────────────────────────────────────── */

/**
 * 注入样式表。
 *
 * 客户端**没有** styles 服务 —— 那是动态包 builtin 的闭包参数，打包插件拿不到
 * （客户端服务目录里只有 layout / locale / sessions / slots / theme / timer /
 * uiWorkspace / workspaces）。官方打包插件（如 ui-layout）都是自己插一个 <style>
 * 并在卸载时收走；这里照做，并用 data 标记去重，插件被重复应用也不会留下多份。
 */
function installStyles(ctx) {
  if (typeof document === 'undefined' || !document.head) return
  ctx.effect(() => {
    const selector = `style[data-plugin-css="${STYLE_TAG}"]`
    if (typeof document.querySelector === 'function') {
      const previous = document.querySelector(selector)
      if (previous && previous.parentNode) previous.parentNode.removeChild(previous)
    }
    const tag = document.createElement('style')
    tag.setAttribute('data-plugin-css', STYLE_TAG)
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => {
      if (tag.parentNode) tag.parentNode.removeChild(tag)
    }
  }, 'session-manager: 样式表')
}

/* ── 菜单行 ────────────────────────────────────────────────────────────── */

/**
 * 取座位注入的菜单开关。
 *
 * 契约（ui-workspace 的实现 + 座位目录里的用例）：hook 以**直接 prop**
 * `useMenuOpenState` 注入，调用后返回 React 的 `[open, setOpen]` 状态对，
 * 官方行写的就是 `const [, setMenuOpen] = useMenuOpenState(); setMenuOpen(false)`。
 * 这里按同一契约调用，并对返回值做防御性读取（认不出来就当作"关不掉"，不影响删除流程）。
 *
 * 为什么"有没有这个 prop"可以决定调不调它：注入与否由座位版本决定、每次渲染都一样，
 * 不会打乱 hook 顺序；而反过来"拿不准就当 hook 调"才是真的会炸。
 */
function useMenuCloser(props) {
  const hook = props.useMenuOpenState
  if (typeof hook !== 'function') return null
  const state = hook()
  if (Array.isArray(state) && typeof state[1] === 'function') return () => state[1](false)
  if (state && typeof state.close === 'function') return state.close
  return null
}

/** 会话行「…」菜单里的一行：点它开确认框。 */
function SessionMenuRow(props) {
  const closeMenu = useMenuCloser(props)
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  if (sessionId === '') return null
  // 旧座位没有 observe：每次渲染现读一次归档状态，读不到就按老行为放行。
  if (typeof props.canDelete === 'function' && props.canDelete(sessionId) === false) return null

  const openDialog = () => {
    if (typeof closeMenu === 'function') closeMenu()
    props.store.open(sessionId, typeof props.displayTitle === 'string' ? props.displayTitle : '')
  }

  return h('button', {
    type: 'button',
    role: 'menuitem',
    className: 'dsm-menuitem',
    title: props.t('menuHint'),
    onClick: openDialog,
  }, props.t('menu'))
}

/* ── 对话框外壳 ────────────────────────────────────────────────────────── */

/**
 * 两个对话框共用的外壳：遮罩、Esc、焦点收进框内、Tab 循环、关闭时把焦点还回去。
 * 抽出来是为了让"焦点与键盘行为"只有一份实现 —— 两份实现迟早会漂移。
 * children 就是框里的东西（本插件传两段：可滚动的 body 与固定在底部的 foot）。
 */
function Modal(props) {
  const { titleId, targetId, children, onDismiss, dismissable } = props
  const dialogRef = React.useRef(null)
  /** 按下动作是否发生在遮罩本身：避免"从对话框里拖选到遮罩上松手"把框关掉。 */
  const pressedOnBackdrop = React.useRef(false)
  /**
   * onDismiss / dismissable 每次渲染都可能是新值，用 ref 取最新的：
   * 既不用把它们塞进 deps（那会让焦点效果每渲染都重跑、焦点来回抖），
   * 也不会像"模块级共享 ref"那样在两个对话框同时打开时叫错人。
   */
  const onDismissRef = React.useRef(onDismiss)
  onDismissRef.current = onDismiss
  const canDismissRef = React.useRef(dismissable)
  canDismissRef.current = dismissable

  React.useEffect(() => {
    const node = dialogRef.current
    const previous = typeof document !== 'undefined' ? document.activeElement : null
    if (node && typeof node.focus === 'function') node.focus()

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        // 别让 Esc 同时触发底下的侧栏/弹层快捷键：这个键已经由对话框接管了。
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
        if (canDismissRef.current) onDismissRef.current()
        return
      }
      if (event.key !== 'Tab' || !node || typeof node.querySelectorAll !== 'function') return
      const focusables = node.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')
      if (!focusables || focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = typeof document !== 'undefined' ? document.activeElement : null
      if (event.shiftKey && active === first) {
        event.preventDefault()
        if (last.focus) last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        if (first.focus) first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (previous && typeof previous.focus === 'function') {
        try {
          previous.focus()
        } catch (error) {
          // 原元素可能已经卸载：还不了焦点就算了。
        }
      }
    }
  }, [props.open])

  return h('div', {
    className: 'dsm-backdrop',
    onMouseDown: (event) => {
      pressedOnBackdrop.current = event.target === event.currentTarget
    },
    onClick: (event) => {
      if (pressedOnBackdrop.current && event.target === event.currentTarget && canDismissRef.current) onDismissRef.current()
      pressedOnBackdrop.current = false
    },
  }, h('div', {
    className: 'dsm-dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    // 只有正文真的渲染了目标节点（ready/deleting）时才指它，避免悬空引用。
    'aria-describedby': props.describedBy || undefined,
    tabIndex: -1,
    ref: dialogRef,
  },
  h('div', { className: 'dsm-head', key: 'head' },
    h('span', { className: 'dsm-head-mark', 'aria-hidden': 'true' }, '⚠'),
    h('h2', { className: 'dsm-title', id: titleId }, props.title)),
  ...children))
}

/* ── 通用片段 ──────────────────────────────────────────────────────────── */

/** 一行元信息（`<dl>` 里的一对 dt/dd）。 */
function metaRow(label, value) {
  return h('div', { className: 'dsm-meta-row', key: label },
    h('dt', { className: 'dsm-meta-label' }, label),
    h('dd', { className: 'dsm-meta-value' }, value))
}

/** 一个带标题的提示框；lines 是标题下面的段落。 */
function box(kind, title, lines, extra) {
  return h('div', { className: kind ? `dsm-box dsm-box-${kind}` : 'dsm-box' },
    h('div', { className: 'dsm-box-title' }, title),
    ...lines.map((line, index) => h('p', { key: index }, line)),
    extra || null)
}

/** 文件清单（等宽、可滚动）。元素一律转成字符串：宿主是可信的，但渲染不该因此炸。 */
function fileList(title, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return null
  return h('div', { className: 'dsm-box' },
    h('div', { className: 'dsm-box-title' }, title),
    h('ul', { className: 'dsm-list' }, ...paths.map((value) => h('li', { key: String(value) }, String(value)))))
}

/** 一个按钮；disabled 时不给点击。 */
function button(label, kind, onClick, disabled) {
  return h('button', {
    type: 'button',
    className: `dsm-button dsm-button-${kind}`,
    disabled: Boolean(disabled),
    onClick: disabled ? undefined : onClick,
  }, label)
}

/** 工作区登记清理结果 → 一行摘要（分隔符也跟着语言走）。 */
function registryLine(registry, t) {
  if (!registry) return ''
  if (registry.kept) return t('registry') + t('labelSeparator') + t('registryClean')
  if (!registry.available) return t('registryUnavailable')
  const steps = Array.isArray(registry.steps) ? registry.steps : []
  const detail = steps.length === 0 ? t('registryClean') : steps.map(String).join(t('listSeparator'))
  return t('registry') + t('labelSeparator') + detail
}

/** 登记预览 → 一行行"会摘掉什么"。服务不可用时明说看不到，而不是装作没有。 */
function registryPlanLines(plan, t) {
  if (!plan) return []
  if (!plan.available) return [t('registryUnknown')]
  const lines = []
  for (const workspace of plan.workspaces) {
    lines.push(fill(t('registryFromWorkspace'), { name: workspace.title || workspace.id }))
  }
  if (plan.pinned) lines.push(t('registryUnpin'))
  if (plan.archived) lines.push(t('registryUnarchive'))
  if (lines.length === 0) lines.push(t('registryClean'))
  return lines
}

/** 本地状态清单 → 一行行"会清掉什么"。 */
function localPlanLines(plan, t) {
  if (!plan) return []
  if (!plan.available) return [t('localUnavailable')]
  const lines = []
  for (const entry of plan.removes) lines.push(fill(t('localRemoveKey'), { key: entry.key }))
  for (const entry of plan.edits) {
    if (entry.reset) lines.push(fill(t('localResetKey'), { key: entry.key }))
    else if (entry.hits > 0) lines.push(fill(t('localEditKey'), { key: entry.key, n: entry.hits }))
    else lines.push(fill(t('localUnreadable'), { key: entry.key }))
  }
  if (lines.length === 0) lines.push(t('localNone'))
  return lines
}

/** 本地状态清理结果 → 一行摘要。 */
function localResultLine(local, t) {
  if (!local) return ''
  if (!local.available) return t('localUnavailable')
  const keys = local.removed.length + local.edited.length
  const parts = [fill(t('localCleared'), { n: local.hits, k: keys })]
  if (local.failed.length > 0) parts.push(fill(t('localClearFailed'), { n: local.failed.length }))
  if (keys === 0) parts.push(t('localClearedNone'))
  return parts.join(t('listSeparator'))
}

/** 勾选框：勾了才允许真删（React 的 onChange 与真实 DOM 一致）。 */
function acknowledgeRow(props) {
  return h('label', { className: 'dsm-check dsm-ack' },
    h('input', {
      type: 'checkbox',
      checked: props.checked === true,
      onChange: (event) => props.onChange(Boolean(event && event.target ? event.target.checked : false)),
    }),
    h('span', null,
      h('span', null, props.t('ackLabel')),
      h('span', { className: 'dsm-check-hint' }, props.t('ackHint'))))
}

/**
 * 一行可勾选项：`{ id, title, disabled }`。
 * 不能勾的项**照样列出来**，并说明原因 —— 小白最需要知道的正是"为什么这一项不能选"。
 */
function choiceRow(props) {
  const { entry, checked, onToggle, t } = props
  const label = entry.title && entry.title !== '' ? `${entry.title}（${entry.id}）` : entry.id
  return h('label', { className: 'dsm-choice', 'data-disabled': String(entry.disabled === true) },
    h('input', {
      type: 'checkbox',
      className: 'dsm-choice-box',
      checked: entry.disabled === true ? false : checked === true,
      disabled: entry.disabled === true,
      onChange: (event) => onToggle(entry.id, Boolean(event && event.target ? event.target.checked : false)),
    }),
    h('span', null,
      h('span', { className: 'dsm-choice-label' }, label),
      entry.disabled === true ? h('span', { className: 'dsm-choice-hint' }, t('forkNotArchived')) : null))
}

/* ── 删除确认框 ────────────────────────────────────────────────────────── */

/** 确认框本体：挂在 shell.overlay 上，没打开时渲染 null。 */
function DialogHost(props) {
  const { store, t, titleId } = props
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  if (state === null) return null

  const { phase, info, error, result, title, sessionId, local, localResult, acknowledged, stop, extraRoots, unknown, listRefreshFailed, repairing, repaired, repairError, repairUnknown } = state
  const targetId = `${titleId}-target`
  const describedBy = phase === 'ready' || phase === 'deleting' ? targetId : undefined
  /**
   * 能不能删只认宿主的结论（`deletable` / `blocking`）：界面自己再推一遍迟早会跟宿主不一致。
   * 一次算好，正文与页脚共用，免得两处判断漂移。
   */
  const blocked = Boolean(info && (info.deletable === false || info.blocking || info.exists === false))
  /** 还有工作在跑、但用户把"先停掉"取消了：宿主一定拒删，所以这里就不让他点。 */
  const busyCount = info && info.busy && typeof info.busy.total === 'number' ? info.busy.total : 0
  const needsStop = busyCount > 0 && stop !== true
  const body = []

  if (phase === 'loading') {
    body.push(box('', t('loading'), [], null))
  } else if (phase === 'error') {
    body.push(box('error', unknown ? t('unknownTitle') : t('failed'), [error]))
  } else if (phase === 'done') {
    // 真删掉了文件才报登记摘要；一项都没删时说明"磁盘上没找到文件"，不谎报战果。
    const removedList = Array.isArray(result && result.removed) ? result.removed : []
    const doneLines = removedList.length > 0
      ? [registryLine(result && result.registry, t), localResultLine(localResult, t)]
      : [t('nothingRemoved'), localResultLine(localResult, t)]
    // 宿主内存注销是核心动作：做了就报，别让用户猜"侧栏会不会又冒出来"。
    if (result && Array.isArray(result.forgotten) && result.forgotten.length > 0) {
      doneLines.push(fill(t('forgotten'), { n: result.forgotten.length }))
    }
    if (result && Array.isArray(result.flushed) && result.flushed.length > 0) {
      doneLines.push(fill(t('flushed'), { n: result.flushed.length }))
    }
    // 删会话时顺带做的事：做过就要说，没做就不提。
    if (result && result.stoppedActivity === true) doneLines.push(fill(t('stoppedBefore'), { n: busyCount || 1 }))
    if (result && Array.isArray(result.terminalsClosed) && result.terminalsClosed.length > 0) {
      doneLines.push(fill(t('terminalsClosed'), { n: result.terminalsClosed.length }))
    }
    if (result && Array.isArray(result.extraRoots) && result.extraRoots.length > 0) {
      doneLines.push(fill(t('extraRootsRemoved'), { n: result.extraRoots.length }))
    }
    body.push(box('done', t('doneTitle'), doneLines.filter(Boolean)))
    // 文件删了但登记没清干净：不谎报成功，明确指出还需要再清一次。
    if (result && result.registryClean === false) body.push(box('warn', t('registryDirtyTitle'), [t('registryDirty')]))
    // 删除成功但列表没刷新成功：旧快照正是「未分组」幽灵的来源，必须让用户知道要手动刷新。
    if (listRefreshFailed === true) body.push(box('warn', t('listRefreshTitle'), [t('listRefreshFailed')]))
    // 注销没做干净就如实报（罕见，但绝不假报"删干净了"）。
    if (result && Array.isArray(result.memoryRemaining) && result.memoryRemaining.length > 0) {
      body.push(box('warn', t('memoryRemainingTitle'), [fill(t('memoryRemaining'), { n: result.memoryRemaining.length })], fileList('', result.memoryRemaining)))
    }
    if (result && result.danglingPruned > 0) body.push(box('done', t('danglingTitle'), [fill(t('danglingPruned'), { n: result.danglingPruned })]))
    if (result && Array.isArray(result.spillRemaining) && result.spillRemaining.length > 0) {
      body.push(box('warn', t('spillTitle'), [fill(t('spillRemaining'), { n: result.spillRemaining.length })], fileList('', result.spillRemaining)))
    }
    if (result && Array.isArray(result.emptyDirsRemoved) && result.emptyDirsRemoved.length > 0) {
      body.push(box('done', t('removed'), [fill(t('emptyDirsRemoved'), { n: result.emptyDirsRemoved.length })], fileList('', result.emptyDirsRemoved)))
    }
    body.push(fileList(t('removed'), removedList))
    if (result && Array.isArray(result.warnings) && result.warnings.length > 0) {
      body.push(box('warn', t('warnHost'), result.warnings.map(String)))
    }
  } else {
    // ready / deleting：会话信息 + 将被删除的东西 + 不会被碰的东西 + 确认勾选
    body.push(h('div', { id: targetId, key: 'target' },
      h('div', { className: 'dsm-session-title' }, title || t('untitled')),
      h('code', { className: 'dsm-session-id' }, sessionId)))

    if (info) {
      body.push(h('dl', { className: 'dsm-meta', key: 'meta' },
        metaRow(t('size'), formatBytes(info.bytes)),
        metaRow(t('records'), info.events === null || info.events === undefined ? t('unknown') : String(info.events)),
        metaRow(t('created'), formatTime(info.createdAt, t('unknown'))),
        // 归档是删除的**前置条件**：满足时明确显示出来，让用户确认这道闸门过了。
        info.archived === true ? metaRow(t('archived'), t('archivedYes')) : null,
        info.cwd ? metaRow(t('cwd'), String(info.cwd)) : null))

      const warnings = [t('warnBody')]
      if (info.subagents > 0) warnings.push(fill(t('warnSubagents'), { n: info.subagents }))
      if (info.forks > 0) warnings.push(fill(t('warnForks'), { n: info.forks }))
      body.push(box('warn', t('warnTitle'), warnings))

      // 能不能删只认宿主的结论（deletable）：界面自己再推一遍迟早会跟宿主不一致。
      if (info.blocking) body.push(box('error', t('blocked'), [info.blocking]))
      else if (info.exists === false) body.push(box('error', t('blocked'), [t('missing')]))
      else if (info.deletable === false) body.push(box('error', t('blocked'), [t('blockedUnknown')]))

      // ① 会被删掉的每一个会话 id（含子代理会话）
      const targets = Array.isArray(info.targets) && info.targets.length > 0
        ? info.targets.map((entry) => entry.id)
        : [sessionId]
      body.push(fileList(t('targetsTitle'), targets))
      // ② 磁盘文件
      body.push(fileList(t('artifacts'), info.artifacts))
      // ③ 工作区登记
      body.push(fileList(t('registryTitle'), registryPlanLines(info.registry, t)))
      // ④ 浏览器本地状态
      body.push(fileList(t('localTitle'), localPlanLines(local, t)))
      // ⑤ 历史遗留的悬空引用（这次会一起剪掉）
      if (info.dangling && info.dangling.reliable && info.dangling.count > 0) {
        const danglingLines = [fill(t('danglingBody'), { n: info.dangling.count })]
        const hiddenDangling = Number(info.dangling.total) - Number(info.dangling.count)
        if (info.dangling.truncated === true && hiddenDangling > 0) {
          danglingLines.push(fill(t('danglingTruncated'), { n: hiddenDangling }))
        }
        body.push(box('warn', t('danglingTitle'), danglingLines,
          h('div', { className: 'dsm-box-actions' },
            button(repairing === true ? t('danglingRepairing') : t('danglingRepair'), 'ghost', () => store.repair(), repairing === true),
            fileList('', info.dangling.ids))))
      }
      // 清理完（或失败）之后悬空清单可能已经空了，结果要单独留在界面上，不能跟着清单一起消失。
      if (repaired > 0) body.push(box('', t('danglingTitle'), [fill(t('danglingRepaired'), { n: repaired })]))
      if (repairUnknown) body.push(box('warn', t('danglingTitle'), [t('danglingRepairUnknown')]))
      else if (repairError) body.push(box('warn', t('danglingTitle'), [fill(t('danglingRepairFailed'), { error: repairError })]))
      // ⑥ 明确"不会被删除"的边界
      body.push(box('', t('notDeletedTitle'), t('notDeletedBody').map(String)))

      // ⑦ 宿主发现、但不足以拦住删除的事（血缘读不全、子会话太多……）：逐条摆出来。
      if (Array.isArray(info.warnings) && info.warnings.length > 0) {
        body.push(box('warn', t('warnHost'), info.warnings.map(String)))
      }

      // ⑧ 还有工作在跑：把"在跑什么"列清楚，并给一个默认勾上的「先停掉」。
      if (busyCount > 0) {
        const labels = busyCount === 1 && info.busy.sessions[0] && info.busy.sessions[0].id === sessionId
          ? info.busy.sessions[0].labels
          : info.busy.sessions.map((entry) => `${entry.id}：${entry.labels.join('、')}`)
        body.push(box('warn', t('busyTitle'), [fill(t('busyBody'), { list: labels.join('；') })],
          h('label', { className: 'dsm-check dsm-stop' },
            h('input', {
              type: 'checkbox',
              checked: stop === true,
              onChange: (event) => store.toggleStop(Boolean(event && event.target ? event.target.checked : false)),
            }),
            h('span', null,
              h('span', null, t('busyStop')),
              h('span', { className: 'dsm-check-hint' }, t('busyStopHint'))))))
      }

      // ⑨ 可选：一并删除派生会话（fork）。默认一个都不勾。
      const forks = Array.isArray(info.optionalForks) ? info.optionalForks : []
      if (forks.length > 0) {
        const choices = forks.map((entry) => h('div', { key: entry.id, className: 'dsm-choice-row' },
          choiceRow({
            entry: { id: entry.id, title: entry.title, disabled: entry.archived !== true },
            checked: Array.isArray(extraRoots) && extraRoots.includes(entry.id),
            onToggle: store.toggleFork,
            t,
          })))
        const forkLines = [t('forkBody'), t('forkHint')]
        // 勾了 fork 才提醒：它的工件、登记与本地状态不在上方清单里，确认后会一起删。
        if (Array.isArray(extraRoots) && extraRoots.length > 0) forkLines.push(t('forkExtraHint'))
        body.push(box('warn', t('forkTitle'), forkLines,
          h('div', { className: 'dsm-choices' }, choices)))
      }

      if (!blocked) body.push(acknowledgeRow({ checked: acknowledged, onChange: store.acknowledge, t }))
    }
    if (phase === 'deleting') body.push(box('', t('deleting'), []))
  }

  const footer = []
  if (phase === 'done') {
    footer.push(button(t('done'), 'ghost', store.dismiss, false))
  } else if (blocked || phase === 'error' || phase === 'loading') {
    footer.push(button(t('close'), 'ghost', store.dismiss, false))
  } else {
    footer.push(button(t('cancel'), 'ghost', store.dismiss, phase === 'deleting'))
    footer.push(button(phase === 'deleting' ? t('deleting') : t('confirm'), 'danger', () => store.confirm(), phase !== 'ready' || acknowledged !== true || needsStop || repairing === true))
  }

  return h(Modal, {
    open: true,
    titleId,
    targetId,
    describedBy,
    onDismiss: store.dismiss,
    dismissable: phase !== 'deleting',
    title: t('title'),
  },
  h('div', { className: 'dsm-body', key: 'body' }, ...body),
  h('div', { className: 'dsm-foot', key: 'foot' }, ...footer))
}

/* ── 插件体 ────────────────────────────────────────────────────────────── */

/** 绑定文案：优先跟随界面语言，语言服务缺席时退回中文。 */
function bindCopy(ctx) {
  const locale = ctx.get('locale')
  if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
    ctx.effect(() => locale.register('session-manager', DICT), 'session-manager: 文案')
    const bound = locale.bind('session-manager')
    return (key) => bound(key)
  }
  return (key) => DICT.zh[key] || key
}

/** 客户端插件体。 */
function apply(ctx) {
  const slots = ctx.get('slots')
  const t = bindCopy(ctx)
  /**
   * 读归档集合：读不到就返回 null（保持旧行为，宁可多显示一行也不误藏），
   * 读到了就只允许「已归档」的会话显示删除入口 —— 归档是宿主删除的前置条件。
   */
  const archivedIds = () => {
    try {
      const workspaces = ctx.get('workspaces')
      const list = workspaces && workspaces.list
      const snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null
      const ids = snapshot && Array.isArray(snapshot.archivedSessionIds) ? snapshot.archivedSessionIds : null
      return ids === null ? null : new Set(ids)
    } catch (error) {
      return null
    }
  }
  const canOfferDelete = (sessionId) => {
    const archived = archivedIds()
    return archived === null || archived.has(sessionId)
  }
  // 会话服务可能在插件启动之后才就位，所以每次删除完成时再取；缺席时只跳过刷新，不影响删除本身。
  const store = createDialogStore(t, async (ids) => {
    const sessions = ctx.get('sessions')
    if (!sessions || typeof sessions.refresh !== 'function') return
    await sessions.refresh()
    // refreshList 是 single-flight：删除完成时如果正好有一个删除前发起的列表请求在飞，
    // 这次 refresh 会复用它，结果里仍可能带着刚删掉的行。再检查一次快照，还在就再拉一遍
    // （第一次已经把旧请求等完了，第二次必定新发）。
    const list = sessions.list
    const snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null
    if (!snapshot || !snapshot.byId || !Array.isArray(ids)) return
    if (!ids.some((id) => snapshot.byId[id] !== undefined)) return
    await sessions.refresh()
  })
  /** 每个 apply 一份 DOM id：插件被应用两次也不会撞 id。 */
  const suffix = Math.random().toString(36).slice(2, 8)
  const titleId = `dsm-dialog-title-${suffix}`

  ctx.effect(() => () => {
    store.dispose()
  }, 'session-manager: 卸载清理')
  installStyles(ctx)

  if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
    // 有 contextMenus 时用结构化贡献：菜单项能拿到官方排序、danger 红字、分隔线与键盘可达；
    // 老版本没有这个服务时退回旧座位，插件至少还能用。
    let fallbackMenu = null
    let structuredMenu = null
    /** 菜单服务的出现可能晚于插件启动：contextMenus 一到位就升级，并撤掉旧座位，避免出现两份。 */
    const useStructuredMenu = () => {
      const menus = ctx.get('contextMenus')
      if (!menus || typeof menus.register !== 'function') return false
      if (structuredMenu) return true
      if (fallbackMenu) {
        fallbackMenu()
        fallbackMenu = null
      }
      structuredMenu = ctx.effect(() => menus.register({
        id: 'session-manager.delete',
        target: 'session',
        order: MENU_ORDER,
        // 归档状态一变，菜单要跟着重算；没有 workspaces 服务时观察为空，不影响启动。
        observe: () => {
          const workspaces = ctx.get('workspaces')
          const list = workspaces && workspaces.list
          return list ? [list] : []
        },
        resolve: (target) => {
          const sessionId = target && typeof target.sessionId === 'string' ? target.sessionId : ''
          if (sessionId === '' || !canOfferDelete(sessionId)) return []
          return [{
            id: 'session-manager.delete',
            label: t('menu'),
            danger: true,
            separatorBefore: true,
            run: () => store.open(sessionId, target.displayTitle),
          }]
        },
      }), 'session-manager: 会话菜单项')
      return true
    }
    if (!useStructuredMenu()) {
      fallbackMenu = ctx.effect(() => slots.inject(MENU_SLOT, () => slots.register(
        { name: MENU_SLOT, id: 'session-manager', order: MENU_ORDER },
        (props) => h(SessionMenuRow, { ...props, store, t, canDelete: canOfferDelete }),
      )), 'session-manager: 会话菜单行')
      // 只依赖 slots，所以老宿主照常启动；新宿主的 contextMenus 晚到时再升级。
      if (typeof ctx.inject === 'function') ctx.inject(['contextMenus'], () => { useStructuredMenu() })
    }

    ctx.effect(() => slots.inject(OVERLAY_SLOT, () => slots.register(
      { name: OVERLAY_SLOT, id: 'session-manager-dialog', order: 100 },
      (props) => h(DialogHost, { ...props, store, t, titleId }),
    )), 'session-manager: 确认对话框')
  }
}

export {
  apply,
  inject,
  acknowledgeRow,
  applyLocalCleanup,
  createDialogStore,
  DialogHost,
  formatBytes,
  localPlanLines,
  planLocalCleanup,
  referencedLocalSessionIds,
  sessionIdsIn,
  SessionMenuRow,
  storageOf,
  stripSessionIds,
  targetIdsOf,
  MENU_SLOT,
  OVERLAY_SLOT,
}
