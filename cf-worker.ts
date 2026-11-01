import { app } from './src/app.ts'
import { blogRebuild } from './src/modules/blog-rebuild.module.ts'

/**
 * Cloudflare Workers 的最小类型声明。
 *
 * 仓库没装 @cloudflare/workers-types（保持多运行时通用，不绑定 CF），
 * 这里只声明用得到的两个成员，避免为了一个 handler 引入整包类型依赖。
 */
interface CFExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

export default {
  fetch: app.fetch,

  /**
   * 定时巡检（触发时机见 wrangler.toml 的 [triggers] crons）
   *
   * 上游 60s-static-host 在北京时间 05:31~05:39 发布当天数据，博客自己的
   * schedule 是 UTC 23:30（北京 07:30）。两者都准点的话博客本来就跟得上
   * —— 问题在 GitHub Actions 的 schedule 实测经常晚 1~3 小时。
   * 所以在数据就绪之后补一次巡检：页面还是旧期号就直接 dispatch 重建。
   */
  async scheduled(_event: unknown, _env: unknown, ctx: CFExecutionContext) {
    ctx.waitUntil(
      blogRebuild.check().catch((error: unknown) => {
        console.error('[blog-rebuild] 巡检异常:', (error as Error)?.message ?? error)
      }),
    )
  },
}
