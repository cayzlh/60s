import { config } from '../config.ts'
import { Common, dayjs, TZ_SHANGHAI } from '../common.ts'

/**
 * 博客资讯页重建巡检
 *
 * 背景
 * ----
 * cayzlh.com/news/ 是 Hexo 在 CI 里构建出来的静态页，页面里的期号 = 构建
 * 那一刻的日期。构建由 GitHub Actions 的 schedule 驱动，而 Actions 的
 * schedule 实测经常晚 1~3 小时（对 122 次触发采样：中位 +126 分钟，
 * 84% 超过 1 小时），于是每天上午页面上挂的还是前一天的资讯。
 *
 * 为什么不做成「发刊成功就回调」
 * ----------------------------
 * 本仓库（60s API）只是 vikiboss/60s-static-host 里静态 JSON 的只读代理，
 * 不抓取、不写任何数据。真正的「发刊」发生在别处，我们这里没有那个
 * 事件点。所以换成反向巡检：
 *
 *   1. 今天的资讯上游有吗？        没有 → 没事可做
 *   2. 博客页面已经是今天的期号了吗？是   → 已经好了
 *   3. 两者都不满足 → dispatch 一次，让博客重建
 *
 * 幂等性
 * ------
 * dispatch 只表示「请求重建」，不代表重建完成。用内存 Map 记下最近一次
 * 触发的时间与期号，配合 CDN 传播所需的最小间隔，避免在构建的几分钟里
 * 反复触发。另外 GitHub 侧 workflow 有 concurrency 串行化兜底。
 */

/** 同一期号最多只触发这么多次，防止构建失败时无限重试 */
const MAX_ATTEMPTS_PER_DAY = 3
/** 两次触发之间的最小间隔（构建 + 部署 + CDN 传播大约 5~10 分钟） */
const MIN_INTERVAL_MS = 15 * 60 * 1000
/** 页面回读超时 */
const PROBE_TIMEOUT_MS = 8_000

interface ProbeState {
  date: string
  attempts: number
  lastAt: number
}

class BlogRebuild {
  #state = new Map<string, ProbeState>()

  /** 今天的期号（Asia/Shanghai） */
  today(): string {
    return dayjs().tz(TZ_SHANGHAI).format('YYYY-MM-DD')
  }

  /**
   * 上游今天的数据发刊了吗？
   *
   * 直接探 vikiboss/60s-static-host 的静态文件，和 60s.module.ts 用的是
   * 同一个数据源，避免「接口说有了、实际没发」这种口径不一致。
   * 注意不要走本地 #cache：那玩意儿可能缓存着昨天的结果。
   */
  async #upstreamDate(): Promise<string | null> {
    const today = this.today()
    try {
      const response = config.blogRebuild.upstreamUrl
        ? await fetch(config.blogRebuild.upstreamUrl.replace('{date}', today), {
            headers: { 'User-Agent': Common.chromeUA },
          })
        : await Common.tryRepoUrl({
            repo: 'vikiboss/60s-static-host',
            path: `static/60s/${today}.json`,
            alternatives: [
              `https://60s-static.viki.moe/60s/${today}.json`,
              `https://60s-static-host.vercel.app/60s/${today}.json`,
            ],
          })
      if (!response || !response.ok) return null
      const data = (await response.json()) as { date?: string; news?: unknown[] }
      // 文件和期号都要对得上，否则是上游提前建了个空壳
      if (!data?.news?.length) return null
      return data.date ?? null
    } catch {
      return null
    }
  }

  /** 回读博客资讯页，取出页面上的期号 */
  async #pageDate(): Promise<string | null> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
      // 加随机串绕过 Cloudflare 边缘缓存，否则读到的永远是旧 HTML
      const url = `${config.blogRebuild.siteUrl}?_=${Date.now()}`
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': Common.chromeUA,
          'Cache-Control': 'no-cache',
        },
      })
      clearTimeout(timer)
      if (!response.ok) return null

      const html = await response.text()
      // 与 themes/polaris/layout/daily.ejs 里的 `var pageDate = 'YYYY-MM-DD'` 对应
      const matched = html.match(/var\s+pageDate\s*=\s*'(\d{4}-\d{2}-\d{2})'/)
      if (matched) return matched[1]

      // 兜底：新版页面把期号渲染进了日签区
      const display = html.match(/(\d{4})-(\d{2})-(\d{2})/)
      return display ? `${display[1]}-${display[2]}-${display[3]}` : null
    } catch {
      return null
    }
  }

  async #dispatch(): Promise<boolean> {
    const { repo, eventType, token } = config.blogRebuild
    if (!token) {
      console.warn('[blog-rebuild] BLOG_DISPATCH_TOKEN 未配置，跳过')
      return false
    }

    try {
      const response = await fetch(`${config.blogRebuild.apiBase}/repos/${repo}/dispatches`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cayzlh-60s',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ event_type: eventType }),
      })

      if (response.status === 204) {
        console.log(`[blog-rebuild] 已触发 ${repo} 重建`)
        return true
      }

      const body = await response.text()
      console.error(`[blog-rebuild] dispatch 失败 ${response.status}: ${body.slice(0, 200)}`)
      return false
    } catch (error) {
      console.error('[blog-rebuild] dispatch 异常:', (error as Error).message)
      return false
    }
  }

  /**
   * 执行一次巡检：上游数据已就绪 + 页面还是旧期号 → 触发重建。
   *
   * @returns 是否真的触发了重建（便于区分「没必要」和「已触发」）
   */
  async check(): Promise<boolean> {
    if (!config.blogRebuild.enable) return false

    const today = this.today()

    const state = this.#state.get(today) ?? { date: today, attempts: 0, lastAt: 0 }
    const now = Date.now()
    if (state.attempts >= MAX_ATTEMPTS_PER_DAY) return false
    if (now - state.lastAt < MIN_INTERVAL_MS) return false

    // 1. 上游今天的数据发了吗？没发就没什么可做的
    const upstream = await this.#upstreamDate()
    if (upstream !== today) return false

    // 2. 博客页面已经是今天的期号了吗？是就不用动
    const pageDate = await this.#pageDate()

    // 页面期号读不到（站点挂了/结构改了）→ 不贸然触发，留日志观察
    if (pageDate === null) {
      console.warn('[blog-rebuild] 无法读取页面期号，跳过')
      return false
    }
    if (pageDate >= today) return false

    // 3. 数据比页面新 → 补一次构建
    state.attempts++
    state.lastAt = Date.now()
    this.#state.set(today, state)

    console.log(`[blog-rebuild] 数据已到 ${today}，页面还停在 ${pageDate}，触发第 ${state.attempts} 次重建`)

    const ok = await this.#dispatch()
    if (!ok) {
      // dispatch 失败不算用量，允许下一次巡检重试
      state.attempts--
    }
    return ok
  }

  /** 巡检状态，供 /v2/60s/rebuild/status 调试用 */
  status() {
    return {
      enabled: config.blogRebuild.enable,
      repo: config.blogRebuild.repo,
      today: this.today(),
      states: Array.from(this.#state.values()),
    }
  }

  /** 只读探针：报告上游与页面的期号，不触发任何副作用 */
  async inspect() {
    const today = this.today()
    const [upstream, page] = await Promise.all([this.#upstreamDate(), this.#pageDate()])
    return {
      enabled: config.blogRebuild.enable,
      today,
      upstreamDate: upstream,
      pageDate: page,
      // 与 check() 的判断口径保持一致
      stale: !!(upstream === today && page !== null && page < today),
      states: Array.from(this.#state.values()),
    }
  }

  /** 仅测试用：清空限流状态 */
  __resetForTest() {
    this.#state.clear()
  }
}

export const blogRebuild = new BlogRebuild()
