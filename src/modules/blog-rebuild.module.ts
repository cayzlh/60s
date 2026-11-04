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
/** 上游健康度回溯：今天没数据时，往回最多查几天 */
const UPSTREAM_LOOKBACK_DAYS = 3
/** 上游滞后超过几天算不健康（留一天缓冲，容忍偶发晚点） */
const UPSTREAM_TOLERANCE_DAYS = 1

interface ProbeState {
  date: string
  attempts: number
  lastAt: number
}

interface UpstreamHealth {
  /** 最近一个有数据的期号；全回溯失败时为 null */
  latest: string | null
  /** 距今滞后几天；latest 为 null 时为 null */
  lagDays: number | null
  /** 是否健康（滞后在容忍范围内） */
  healthy: boolean
}

/** 日期加减（只处理 YYYY-MM-DD，按 UTC 算，不受宿主时区影响） */
function shiftDate(ymd: string, days: number): string {
  const d = new Date(ymd + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 两个 YYYY-MM-DD 相差几天（a - b） */
function dayDiff(a: string, b: string): number {
  const ms = new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()
  return Math.round(ms / 86_400_000)
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

  /**
   * 探指定日期的数据文件是否存在（用于「上游最近生产到哪一天」）。
   *
   * 只发 HEAD，不下载正文 —— 健康度检查每天要问好几次，没必要拉全量。
   */
  async #hasData(date: string): Promise<boolean> {
    try {
      const response = config.blogRebuild.upstreamUrl
        ? await fetch(config.blogRebuild.upstreamUrl.replace('{date}', date), {
            method: 'HEAD',
            headers: { 'User-Agent': Common.chromeUA },
          })
        : await Common.tryRepoUrl({
            repo: 'vikiboss/60s-static-host',
            path: `static/60s/${date}.json`,
            alternatives: [
              `https://60s-static.viki.moe/60s/${date}.json`,
              `https://60s-static-host.vercel.app/60s/${date}.json`,
            ],
          })
      return !!response?.ok
    } catch {
      return false
    }
  }

  /**
   * 上游健康度：最近生产到哪一天、滞后今天多少天。
   *
   * 背景：上游靠 vikiboss/60s-static-host 的 GitHub Actions 每天 05:31~05:39
   * 发刊。它一旦挂了，我们这边什么都做不了 —— 重建出来还是旧数据。但用户
   * 看到的现象和「我们构建晚了」一模一样，所以必须能区分开。
   *
   * 契约：upstreamDate 为空时（今天没发），往回找最近一个有数据的日期。
   * 最多回溯 UPSTREAM_LOOKBACK_DAYS 天，避免每次巡检都打一堆请求。
   */
  async upstreamHealth(): Promise<UpstreamHealth> {
    const today = this.today()

    // 先看今天 —— 最常见的情况，一次请求就够
    const todayDate = await this.#upstreamDate()
    if (todayDate) {
      return { latest: todayDate, lagDays: 0, healthy: true }
    }

    // 今天没有 → 往回找最近一个可用日期
    for (let back = 1; back <= UPSTREAM_LOOKBACK_DAYS; back++) {
      const date = shiftDate(today, -back)
      if (await this.#hasData(date)) {
        const lagDays = back
        return {
          latest: date,
          lagDays,
          // 允许一天的自然波动（上游偶发晚点），超过就认为不健康
          healthy: lagDays <= UPSTREAM_TOLERANCE_DAYS,
        }
      }
    }

    // 全部回溯都失败 → 上游彻底异常
    return { latest: null, lagDays: null, healthy: false }
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
   * 执行一次巡检。
   *
   * 两种情况会触发重建：
   *   A. 上游今天已发 + 页面还没跟上      → 补构建
   *   B. 上游今天没发、但页面连「上游最近可用的那一期」都没跟上
   *                                      → 也补构建（上游晚发时仍有价值）
   *
   * 情况 B 是这次新增的：上游偶尔整天不发（2026-11-04 就发生过），
   * 若只认「今天」，页面会一直停在更早的版本，且探针显示 stale:false
   * 让人误以为一切正常。
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

    // 1. 上游生产到哪一天了？
    const upstream = await this.upstreamHealth()

    if (!upstream.healthy) {
      // 上游自己出问题了 —— 我们重建也没用，但要让日志里看得见
      const lag = upstream.lagDays === null ? '未知（回溯全失败）' : `${upstream.lagDays} 天`
      console.warn(`[blog-rebuild] 上游异常：最近可用 ${upstream.latest ?? '无'}，滞后 ${lag}`)
      return false
    }

    // 没有可用基准（连昨天都没有）→ 无从判断，别乱触发
    if (!upstream.latest) return false

    // 2. 页面跟上「上游最近可用版本」了吗？
    const pageDate = await this.#pageDate()

    // 页面期号读不到（站点挂了/结构改了）→ 不贸然触发，留日志观察
    if (pageDate === null) {
      console.warn('[blog-rebuild] 无法读取页面期号，跳过')
      return false
    }
    if (pageDate >= upstream.latest) return false

    // 3. 页面落后 → 补一次构建
    state.attempts++
    state.lastAt = Date.now()
    this.#state.set(today, state)

    const behind = dayDiff(upstream.latest, pageDate)
    console.log(
      `[blog-rebuild] 上游最新 ${upstream.latest}，页面停在 ${pageDate}（落后 ${behind} 天），` +
        `触发第 ${state.attempts} 次重建`,
    )

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
    const [upstream, page] = await Promise.all([this.upstreamHealth(), this.#pageDate()])

    return {
      enabled: config.blogRebuild.enable,
      today,
      /** 上游最近一个可用的期号（今天没发时是往回的日期） */
      upstreamDate: upstream.latest,
      /** 上游滞后今天几天；0 = 今天已发 */
      upstreamLagDays: upstream.lagDays,
      /** 上游是否健康；false 表示等多久都没用，得去源头看 */
      upstreamHealthy: upstream.healthy,
      /** 博客页面当前的期号 */
      pageDate: page,
      /**
       * 是否需要重建：上游今天已发 + 页面还没跟上。
       * 注意上游没发时这里一定是 false —— 重建也没用。
       */
      stale: !!(upstream.latest === today && page !== null && page < today),
      /** 页面落后上游最近可用版本的期数（含上游未发的情况） */
      pageBehindDays: page && upstream.latest ? dayDiff(page, upstream.latest) : null,
      states: Array.from(this.#state.values()),
    }
  }

  /** 仅测试用：清空限流状态 */
  __resetForTest() {
    this.#state.clear()
  }
}

export const blogRebuild = new BlogRebuild()
