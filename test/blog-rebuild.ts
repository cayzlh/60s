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
blogRebuild.__resetForTest()
const d1 = state.dispatches
await blogRebuild.check()
check('页面已是今天 → 不触发', state.dispatches === d1)

// 场景 3：数据已就绪 + 页面还是昨天 → 触发一次
state.page = shift(-1)
blogRebuild.__resetForTest()
const d2 = state.dispatches
const fired = await blogRebuild.check()
check('数据已就绪但页面落后 → 触发', fired && state.dispatches === d2 + 1, `dispatches=${state.dispatches}`)

// 场景 4：紧接着再巡检 → 被最小间隔挡住，不重复触发
const d3 = state.dispatches
await blogRebuild.check()
check('15 分钟内重复巡检 → 不重复触发（幂等）', state.dispatches === d3, `dispatches=${state.dispatches}`)

// 场景 5：页面期号读不到（站点异常）→ 不贸然触发
state.page = 'garbage-no-date'
blogRebuild.__resetForTest()
const d4 = state.dispatches
await blogRebuild.check()
check('页面期号解析失败 → 不触发', state.dispatches === d4, `dispatches=${state.dispatches}`)

// 场景 6：上游今天没发，但页面落后于「上游最近可用版本」→ 仍应触发
//         （2026-11-04 的真实情况：上游停在 11-03，页面也停在 11-03 —— 不算落后）
state.upstream = shift(-1) // 上游最近只有昨天
state.page = shift(-2) // 页面落后一天
blogRebuild.__resetForTest()
const d5 = state.dispatches
const fired6 = await blogRebuild.check()
check(
  '上游没发今天但页面落后于其最近版本 → 触发',
  fired6 && state.dispatches === d5 + 1,
  `dispatches=${state.dispatches}`,
)

// 场景 7：上游今天没发，页面已等于「上游最近可用版本」→ 不触发
//         （这就是 11-04 的实际情况：没数据可发，重建也没用）
state.upstream = shift(-1)
state.page = shift(-1)
blogRebuild.__resetForTest()
const d6 = state.dispatches
await blogRebuild.check()
check('上游没发且页面已跟上其最近版本 → 不触发', state.dispatches === d6, `dispatches=${state.dispatches}`)

// 场景 8：上游彻底异常（回溯全部失败）→ 不触发
state.upstream = null
state.page = shift(-3)
blogRebuild.__resetForTest()
const d7 = state.dispatches
await blogRebuild.check()
check('上游回溯全失败 → 不触发', state.dispatches === d7, `dispatches=${state.dispatches}`)

// 场景 9：健康度报告 —— 今天有数据 → lagDays=0, healthy
state.upstream = today()
const h1 = await blogRebuild.upstreamHealth()
check('健康度：今天已发 → lag0/healthy', h1.lagDays === 0 && h1.healthy, JSON.stringify(h1))

// 场景 10：健康度 —— 今天没发、昨天有 → lagDays=1, 仍在容忍范围
state.upstream = shift(-1)
const h2 = await blogRebuild.upstreamHealth()
check('健康度：滞后1天 → 容忍内仍 healthy', h2.lagDays === 1 && h2.healthy, JSON.stringify(h2))

// 场景 11：健康度 —— 今天和昨天都没有、前天有 → lagDays=2, 不健康
state.upstream = shift(-2)
const h3 = await blogRebuild.upstreamHealth()
check('健康度：滞后2天 → 判定不健康', h3.lagDays === 2 && !h3.healthy, JSON.stringify(h3))

console.log('\n' + pass + '/' + (pass + fail) + ' 通过')
server.close()
process.exit(fail === 0 ? 0 : 1)
