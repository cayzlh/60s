/**
 * 博客资讯页重建巡检的回归测试
 *
 * 用本地 HTTP 服务同时扮演两个角色：
 *   1. vikiboss/60s-static-host 的数据文件（判断「发刊了吗」）
 *   2. GitHub 的 /repos/:owner/:repo/dispatches（记录 dispatch 调用）
 * 再让 BLOG_SITE_URL 指向本地页面，验证四种情况的判定与幂等性。
 *
 * 运行：node --experimental-strip-types test/blog-rebuild.ts
 */
import http from 'node:http'

const PORT = 4398
const BASE = `http://127.0.0.1:${PORT}`

const state = {
  /** 最新可用期号；null 表示今天的还没发刊 */
  upstream: null as string | null,
  /** 博客页面上的期号 */
  page: '',
  /** dispatch 被调用的次数 */
  dispatches: 0,
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', BASE)

  // 数据源：/data/YYYY-MM-DD.json
  if (url.pathname.startsWith('/data/')) {
    const date = url.pathname.replace('/data/', '').replace('.json', '')
    if (state.upstream === date) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ date, news: ['t1', 't2'], tip: '' }))
    } else {
      res.writeHead(404)
      res.end('not found')
    }
    return
  }

  // GitHub dispatch
  if (url.pathname.endsWith('/dispatches')) {
    state.dispatches++
    res.writeHead(204)
    res.end()
    return
  }

  // 博客页面：需要包含 var pageDate = 'YYYY-MM-DD'
  if (url.pathname.startsWith('/news')) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<html><script>var pageDate = '${state.page}';</script></html>`)
    return
  }

  res.writeHead(404)
  res.end()
})

await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))

// config 在模块加载时读取环境变量，所以先设好再动态 import
process.env.BLOG_AUTO_REBUILD = '1'
process.env.BLOG_DISPATCH_TOKEN = 'test-token'
process.env.BLOG_SITE_URL = `${BASE}/news/`
process.env.BLOG_API_BASE = BASE
process.env.BLOG_UPSTREAM_URL = `${BASE}/data/{date}.json`

const { blogRebuild } = await import('../src/modules/blog-rebuild.module.ts')

function today(): string {
  return blogRebuild.today()
}
function shift(days: number): string {
  const d = new Date(today() + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''))
  }
}

console.log('博客重建巡检测试（今天 = ' + today() + '）\n')

// 场景 1：上游没发刊 → 不动
state.upstream = shift(-1)
state.page = shift(-1)
const d0 = state.dispatches
await blogRebuild.check()
check('上游没发今天的数据 → 不触发', state.dispatches === d0)

// 场景 2：数据已就绪 + 页面也是今天 → 不动
state.upstream = today()
state.page = today()
const d1 = state.dispatches
await blogRebuild.check()
check('页面已是今天 → 不触发', state.dispatches === d1)

// 场景 3：数据已就绪 + 页面还是昨天 → 触发一次
state.page = shift(-1)
const d2 = state.dispatches
const fired = await blogRebuild.check()
check('数据已就绪但页面落后 → 触发', fired && state.dispatches === d2 + 1, `dispatches=${state.dispatches}`)

// 场景 4：紧接着再巡检 → 被最小间隔挡住，不重复触发
const d3 = state.dispatches
await blogRebuild.check()
check('15 分钟内重复巡检 → 不重复触发（幂等）', state.dispatches === d3, `dispatches=${state.dispatches}`)

// 场景 5：页面期号读不到（站点异常）→ 不贸然触发
// 先用掉最小间隔：换一个「明天」的日期状态是不行的，这里直接让页面返回
// 不含期号的 HTML，验证解析失败时不 dispatch。
state.page = 'garbage-no-date'
// 绕开 15 分钟最小间隔：把内部状态的时间戳改掉
blogRebuild.__resetForTest()
const d4 = state.dispatches
await blogRebuild.check()
check('页面期号解析失败 → 不触发', state.dispatches === d4, `dispatches=${state.dispatches}`)

console.log('\n' + pass + '/' + (pass + fail) + ' 通过')
server.close()
process.exit(fail === 0 ? 0 : 1)
