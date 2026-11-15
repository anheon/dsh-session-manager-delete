// 把 lib/client.js 打成 DSH 客户端模块系统要求的注册格式：
//   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
// 与官方 client bundle 同一形状 —— 客户端模块表只认注册过的 package id，
// 不认插件内部的相对 import，所以源码里不写 import，React 由 factory 顶部注入。
//
// 用法：node scripts/build-client.mjs            构建并写回 lib/client.bundle.js
//       node scripts/build-client.mjs --check     只校验产物是否与源码同步（CI / check:client 用）
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const source = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

/** 构建失败就说清楚"哪里不能写"，而不是产出一个坏 bundle。 */
function fail(message) {
  throw new Error(`${message}（lib/client.js 不支持 ESM 的模块语法：React 由 factory 注入，导出统一写在一行 export { … } 里）`)
}

// 1) 先拒绝不该出现的东西。
//    必须在剥离之前检查：单行 import 会被下面的 replace 悄悄删掉，
//    那样"忘了处理"就会变成运行期的 ReferenceError，而不是构建期的一声响。
const strayImport = source.match(/^\s*import\b.*$/m)
if (strayImport) fail(`lib/client.js 里不能有 import：${strayImport[0].trim()}`)
if (/^\s*export\s+default\b/m.test(source)) fail('lib/client.js 不能用 export default')

// 2) 导出名以 `export { … }` 为准，避免两处各写一份。
const exportLine = source.match(/^export \{([^}]*)\}\s*$/m)
if (!exportLine) fail('lib/client.js 里找不到 `export { … }` 行')
const exported = exportLine[1].split(',').map((name) => name.trim()).filter(Boolean)
if (!exported.includes('apply')) fail('lib/client.js 必须导出 apply —— 那是客户端插件的入口')

// 3) 去掉具名导出的关键字：函数/常量留在 factory 作用域里，最后统一导出。
const body = source
  .replace(/^export \{[^}]*\}\s*$/gm, '')
  .replace(/^export (const|function|let|var|class) /gm, '$1 ')
if (/^\s*(import|export)\b/m.test(body) || /\bfrom\s+['"]/.test(body)) {
  fail('lib/client.js 里还有未处理的 import/export')
}

const bundle = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(pkg.name)},
	factory: (require) => {
		var React = require("react");
		var module = { exports: {} };
${body.replace(/^(?=.)/gm, '\t\t')}
		module.exports = { ${exported.join(', ')} };
		return module.exports;
	}
});
`

// 4) 产物必须先能解析：否则浏览器里 __ModuleLoader__.load 连解析都过不去，
//    而构建脚本还会开开心心地退出 0。
try {
  new vm.Script(bundle, { filename: 'client.bundle.js' })
} catch (error) {
  throw new Error(`生成的 bundle 语法不合法：${error.message}`)
}

const out = path.join(root, 'lib', 'client.bundle.js')
const target = path.relative(root, out)

// --check：不写文件，只回答"产物是不是跟着源码走了"。验证套件直接跑产物，
// 没有这道闸门，改了 client.js 却忘了构建时它会一路绿到底。
if (process.argv.includes('--check')) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null
  if (current !== bundle) {
    console.error(`stale ${target}：它和 lib/client.js 不同步，请先运行 node scripts/build-client.mjs`)
    process.exitCode = 1
  } else {
    console.log(`ok ${target} (${Buffer.byteLength(bundle)} bytes, exports: ${exported.join(', ')})`)
  }
} else {
  fs.writeFileSync(out, bundle)
  console.log(`built ${target} (${Buffer.byteLength(bundle)} bytes, exports: ${exported.join(', ')})`)
}
