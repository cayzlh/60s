export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: process.env.PORT ? +process.env.PORT : 4399,
  group: '595941841',
  author: 'Viki <hi@viki.moe>',
  github: 'https://github.com/vikiboss/60s',
  debug: !!process.env.DEBUG,
  overseas_first: !!process.env.OVERSEAS_FIRST,
  encodingParamName: process.env.ENCODING_PARAM_NAME || 'encoding',

  /**
   * 定时巡检：当今天的资讯已经能从上游取到、而博客 /news/ 页还挂着
   * 昨天的内容时，主动 repository_dispatch 触发博客重建。
   *
   * 为什么是「巡检」而不是「发刊后回调」：本服务只是上游静态 JSON 的
   * 只读代理，自己不抓取、不写数据，真正的发刊发生在
   * vikiboss/60s-static-host。所以没有「发刊成功」这个事件可挂，
   * 只能反过来比对「数据好了没」与「页面更新了没」。
   *
   * 默认关闭，设置 BLOG_AUTO_REBUILD=1 才启用。
   */
  blogRebuild: {
    enable: !!process.env.BLOG_AUTO_REBUILD,
    /** 目标仓库，格式 owner/name */
    repo: process.env.BLOG_REPO || 'cayzlh/blog-framework',
    /** 与 blog-framework workflow 的 repository_dispatch.types 对应 */
    eventType: process.env.BLOG_EVENT_TYPE || 'Hexo',
    /** 细粒度 PAT：该仓库 Contents:Read + Actions:Write */
    token: process.env.BLOG_DISPATCH_TOKEN || '',
    /** 回读页面期号，判断是否已经重建过 */
    siteUrl: process.env.BLOG_SITE_URL || 'https://www.cayzlh.com/news/',
    /** GitHub API 基址，仅测试时覆盖 */
    apiBase: process.env.BLOG_API_BASE || 'https://api.github.com',
    /**
     * 上游当日数据文件地址，`{date}` 会被替换成当期期号。
     * 留空走 Common.tryRepoUrl 的多 CDN 兜底；测试时指向本地。
     */
    upstreamUrl: process.env.BLOG_UPSTREAM_URL || '',
  },
}

export const COMMON_MSG = `获取成功。开源地址 ${config.github}，反馈群 ${config.group}。`
