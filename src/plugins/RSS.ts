import { getFastAI, getHighQualityAI } from "../ai/AiManager";
import { log } from "../log";
import { fetchRSS, type RSSItem, type RSSFeed } from "../utils/RssParse";
import type { BotPlugin, CommandContext } from '../features';
import { html, Message, type TelegramClient, type TextWithEntities } from "@mtcute/bun";
import { Cron } from "croner";
import { enableChats } from "../app";
import { cleanHTML } from "../utils/HtmlHelper";

/**
 * 新闻项接口，扩展自 RSSItem
 * @interface NewsItem
 */
interface NewsItem extends Omit<RSSItem, 'source'> {
    source: string;          // 源 URL
    sourceName: string;      // 源名称
    score?: number;          // 新闻分数 (算法选择器使用)
    contentSnippet?: string; // 内容片段
}

/**
 * 服务状态接口
 * @interface ServiceStatus
 */
interface ServiceStatus {
    sources: Array<{
        status: string;
        url: string;
        itemCount?: number;
        oldestItem?: string;
        newestItem?: string;
        responseTime?: string;
        name?: string;
        error?: string;
    }>;
    cacheInfo: {
        size: number;
        sentItems: number;
        cacheTimeout: string;
    };
}

// 定义重试次数类型
type RetryCount = 1 | 2 | 3;

// RSS 源列表
const RSS_SOURCES = [
    // 新闻类
    "http://cn.nytimes.com/rss/news.xml",           // 纽约时报中文
    "https://feedx.net/rss/dw.xml",                 // 德国之声
    "https://feedx.net/rss/wsj.xml",                // 华尔街中文
    "https://feeds.feedburner.com/rsscna/politics", // 中央社政治新闻
    "https://news.pts.org.tw/xml/newsfeed.xml",     // 公视新闻
    "http://www.bbc.co.uk/zhongwen/simp/index.xml", // bbc中文
    "https://feedx.net/rss/zhihudaily.xml",         // 知乎日报
    
    // 科技类
    "http://www.ithome.com/rss/",                   // IT之家
    "https://www.solidot.org/index.rss",             // 奇客Solidot
    "http://rss.cnbeta.com.tw/",                    // cnbeta科技
    "https://www.geekpark.net/rss"                  // 极客公园
];

/**
 * 新闻服务配置
 */
const NEWS_CONFIG = {
    MAX_AGE_HOURS: 6,                            // 新闻最大年龄（小时）
    MIN_CONTENT_LENGTH: 20,                      // 新闻最小内容长度
    CACHE_TIMEOUT: 10,                           // 缓存过期时间（分钟）
    LONG_NEWS_THRESHOLD: 400,                    // 长文阈值（字符）
    CACHE_CLEANUP_INTERVAL: 24 * 60 * 60 * 1000, // 缓存清理间隔（毫秒）
    MIN_UPDATE_INTERVAL: 30000,                  // 最小更新间隔（毫秒）
    DEFAULT_RETRY_DELAY: 1000,                   // 默认重试延迟（毫秒）
    MAX_RETRIES: 3 as RetryCount                 // 最大重试次数
} as const;

/**
 * AI摘要提示词
 */
const AI_SUMMARY_PROMPT = `你是一名专业新闻编辑，擅长提炼新闻核心要点，并以简洁、精准、生动的语言表达。请对以下新闻进行总结，确保信息准确，逻辑清晰，易读易懂。

### 要求：
1. **关键信息提炼**：概括核心事实，包括**时间、地点、事件、人物、背景**等，确保完整、准确。
2. **逻辑结构清晰**：
   - **时间顺序**：按时间线组织信息，适用于事件发展类新闻。
   - **逻辑层次**：
     - **背景** → **事件** → **影响**
     - **原因** → **现状** → **未来**
     - **主要信息** → **补充细节**
   - **条理分明，层次合理**，避免混乱堆砌信息。
3. **语言优化**：
   - **简明有力**：去除冗余、重复、模糊表达。
   - **客观中立**：不加入主观评论、夸张修辞或引导性表述。
4. **合理压缩**：
   - 在保证关键信息完整的前提下，优化篇幅，尽量不超过 **${NEWS_CONFIG.LONG_NEWS_THRESHOLD}** 字。
   - 长新闻可拆分为**简要摘要 + 详细补充**（使用可折叠引用）。
5. **内容安全**：
   - 严格基于原文，不提供额外解释或无关信息。
   - 无需提供标题、来源，直接输出新闻摘要。
   - 如无法提炼有效内容，直接返回 **[CANCEL]**。

### 输出格式（仅支持以下HTML标签）：
- **文本格式**：
  - **<b>加粗</b>**：强调关键信息
  - **<i>斜体</i>**：术语、引用
  - **<u>下划线</u>**：特别提醒
  - **<s>删除线</s>**：更正、废弃信息
  - **<spoiler>隐藏内容</spoiler>**（可折叠查看）
- **代码与链接**：
  - **<code>内联代码</code>**：技术/命令
  - **<a href="URL">超链接</a>**：新闻来源
  - **<pre language="语言">多行代码</pre>**（如 TypeScript、Python）
- **布局**：
  - **<br>**：换行（仅限此方式）
  - **<blockquote>引用</blockquote>**：重要段落
  - **<blockquote collapsible>折叠引用</blockquote>**：次要信息
- **格式规则**：
  - **禁止在 <blockquote> 和 <blockquote collapsible> 之前使用 <br>**（若有，需删除）
  - **禁止使用其他HTML标签**

请严格遵守上述要求，确保输出内容准确、清晰、规范。`

/**
 * AI评论提示词
 */
const AI_COMMENT_PROMPT = `你是一位幽默风趣的新闻评论者，擅长用调侃、双关语、谐音梗、打油诗、幽默比喻等方式，将新闻内容轻松总结评论。  

要求：  
1. 用1-2句简短的话评论新闻核心内容，融入诙谐元素，如妙趣横生的比喻、意想不到的反转、戏谑但不冒犯的调侃等。  
2. 可使用双关语、谐音梗、打油诗、笑话等方式增强趣味性，让评论更具幽默感。  
3. 若新闻内容不适合调侃，或无法幽默评论，则直接返回 [CANCEL]。
4. 不要提供任何解释或要求以外的内容。
` as const;

// 垃圾内容关键词
const SPAM_KEYWORDS = [
    '广告', '推广', 'AD', '赞助', '美元',
    '售价', '续航', '价格', '折扣', '优惠',
    '促销', '买一送一', '特价', '秒杀', '清仓',
    '甩卖', '团购', '砍价', '返现', '红包',
    '抽奖', '中奖', '中奖率'
] as const;

// 重要性关键词配置
const IMPORTANCE_KEYWORDS = [
    { words: ['重大', '突发', '紧急', '重要', '突破', '地震', '海啸', '阳性', '疾控'], weight: 0.4 },
    { words: ['最新', '发布', '公告', '声明', '节日'], weight: 0.3 },
    { words: ['独家', '深度', '调查', '揭秘'], weight: 0.3 },
    { words: ['学术', '数据', '报告', '研究', '分析'], weight: 0.2 }
] as const;

/**
 * 新闻选择器依赖接口
 */
interface NewsSelectorDeps {
    cache: NewsCache;
    lastUpdate: Map<string, number>;
}

/**
 * 新闻缓存管理类 - 负责 RSS 数据和已发送新闻的缓存管理
 */
class NewsCache {
    // 使用静态属性以确保单例模式
    private static readonly cache = new Map<string, { data: RSSFeed; timestamp: number }>();
    private static readonly sent = new Map<string, number>();

    /**
     * 检查缓存是否有效
     * @param key - 缓存键名
     * @returns 缓存是否有效
     */
    isValid(key: string): boolean {
        const entry = NewsCache.cache.get(key);
        return !!entry && (Date.now() - entry.timestamp) < NEWS_CONFIG.CACHE_TIMEOUT * 60 * 1000;
    }

    /**
     * 设置缓存
     * @param key - 缓存键名
     * @param data - 缓存数据
     */
    set(key: string, data: RSSFeed): void {
        NewsCache.cache.set(key, { data, timestamp: Date.now() });
    }

    /**
     * 获取缓存
     * @param key - 缓存键名
     * @returns 缓存数据
     */
    get(key: string): RSSFeed | undefined {
        return NewsCache.cache.get(key)?.data;
    }

    /**
     * 标记新闻为已发送
     * @param newsId - 新闻ID
     */
    markSent(newsId: string): void {
        NewsCache.sent.set(newsId, Date.now());
    }

    /**
     * 检查新闻是否已发送
     * @param newsId - 新闻ID
     * @returns 是否已发送
     */
    wasSent(newsId: string): boolean {
        const timestamp = NewsCache.sent.get(newsId);
        if (!timestamp) return false;

        // 检查缓存是否过期
        if (Date.now() - timestamp < NEWS_CONFIG.CACHE_CLEANUP_INTERVAL) return true;

        // 如果过期则删除缓存条目
        NewsCache.sent.delete(newsId);
        return false;
    }

    /**
     * 清理过期缓存
     */
    clear(): void {
        const now = Date.now();
        // 清理过期的已发送记录
        for (const [id, ts] of NewsCache.sent.entries()) {
            if (now - ts > NEWS_CONFIG.CACHE_CLEANUP_INTERVAL) {
                NewsCache.sent.delete(id);
            }
        }
        // 清理 RSS 缓存
        NewsCache.cache.clear();
    }

    /**
     * 获取缓存信息
     * @returns 缓存大小信息
     */
    getCacheInfo(): { size: number; sentItems: number } {
        return {
            size: NewsCache.cache.size,
            sentItems: NewsCache.sent.size
        };
    }
}

/**
 * 新闻选择器基类 - 定义新闻选择的通用接口和方法
 * @abstract
 */
abstract class NewsSelector {
    protected cache: NewsCache;
    protected lastUpdate: Map<string, number>;

    constructor(deps: NewsSelectorDeps) {
        this.cache = deps.cache;
        this.lastUpdate = deps.lastUpdate;
    }

    /**
     * 选择最佳新闻
     * @param category - RSS分类
     * @param sources - RSS源列表
     * @returns 最佳新闻项或null
     * @abstract
     */
    abstract selectNews(category: keyof typeof RSS_SOURCES, sources: string[]): Promise<NewsItem | null>;

    /**
     * 检查新闻是否满足基本条件
     * @param item - 新闻项
     * @returns 是否为有效新闻
     * @protected
     */
    protected isNewsValid(item: RSSItem | NewsItem): boolean {
        // 计算新闻年龄（毫秒）
        const pubDate = new Date(item.pubDate || '').getTime();
        const age = Date.now() - pubDate;

        // 检查是否在有效期内且内容长度符合要求
        return (
            age <= NEWS_CONFIG.MAX_AGE_HOURS * 3600 * 1000 &&
            (item.description?.length || 0) >= NEWS_CONFIG.MIN_CONTENT_LENGTH
        );
    }

    /**
     * 将 RSSItem 转换为 NewsItem
     * @param item - RSS项
     * @param source - 来源URL
     * @param sourceName - 来源名称
     * @returns 转换后的新闻项
     * @protected
     */
    protected convertToNewsItem(item: RSSItem, source: string, sourceName: string): NewsItem {
        return {
            ...item,
            source,
            sourceName,
            ...(item.source ? { sourceInfo: item.source } : {})
        } as NewsItem;
    }

    /**
     * 从源中获取新闻
     * @param source - RSS源URL
     * @returns 新闻列表
     * @protected
     */
    protected async fetchNewsFromSource(
        source: string
    ): Promise<NewsItem[]> {
        try {
            // 直接使用fetchRSS，它已经内置了超时和重试处理
            const feed = await fetchRSS(source);
            
            // 使用可空链操作符和默认空字符串处理
            const sourceName = feed.channel.title || source.split('/').pop() || '';

            return feed.channel.items
                .filter(item => this.isNewsValid(item))
                .map(item => this.convertToNewsItem(item, source, sourceName));
        } catch (error) {
            log.error(`获取RSS源失败 ${source}: ${error}`);
            return [];
        }
    }
}

/**
 * AI新闻选择器 - 使用AI模型进行新闻筛选
 */
class AiNewsSelector extends NewsSelector {
    private readonly MAX_ITEMS_PER_BATCH = 70;

    /**
     * 实现抽象方法 - 选择最佳新闻
     * 在当前版本中，我们通过从所有源筛选新闻来实现
     * @returns 最佳新闻项或null
     */
    async selectNews(): Promise<NewsItem | null> {
        // 使用新的基于所有源的方法
        return this.selectNewsFromAllSources();
    }

    /**
     * 从所有类别获取新闻并按比例筛选
     * @returns 最佳新闻项或null
     */
    async selectNewsFromAllCategories(): Promise<NewsItem | null> {
        return this.selectNewsFromAllSources();
    }

    /**
     * 从所有源获取新闻并按比例筛选 (用于替代原来基于类别的方法)
     * @returns 最佳新闻项或null
     */
    async selectNewsFromAllSources(): Promise<NewsItem | null> {
        // 计算各源的新闻获取配额
        const totalMaxItems = this.MAX_ITEMS_PER_BATCH;
        const sourcesCount = RSS_SOURCES.length;
        const itemsPerSource = Math.max(2, Math.min(10, Math.ceil(totalMaxItems / sourcesCount)));
        
        // 按最后更新时间排序源，优先获取久未更新的
        const sortedSources = [...RSS_SOURCES].sort((a, b) => {
            const timeA = this.lastUpdate.get(a) || 0;
            const timeB = this.lastUpdate.get(b) || 0;
            return timeA - timeB;
        });
        
        // 只选择部分源进行请求，减少网络负载
        const selectedSources = sortedSources.slice(0, Math.ceil(sourcesCount / 2));
        
        // 并发获取所有源的新闻，带统一超时控制
        const sourcePromises = selectedSources.map(source => 
            this.fetchNewsWithLimit(source, itemsPerSource)
                .catch(error => {
                    log.warn(`获取新闻失败 ${source}: ${error}`);
                    return [];
                })
        );
        
        // 等待所有源完成，允许部分失败
        const results = await Promise.allSettled(sourcePromises);
        
        // 收集成功结果，合并新闻
        const allNews = results
            .filter((result): result is PromiseFulfilledResult<NewsItem[]> => 
                result.status === 'fulfilled')
            .map(result => result.value)
            .flat();
        
        // 合并并过滤新闻
        const filteredNews = this.mergeAndFilterNews(allNews);
        
        if (filteredNews.length === 0) return null;
        if (filteredNews.length === 1) return filteredNews[0] ?? null;
        
        // 限制AI处理的新闻数量
        const MAX_NEWS_FOR_AI = 15;
        const newsForAI = filteredNews.length > MAX_NEWS_FOR_AI
            ? filteredNews.slice(0, MAX_NEWS_FOR_AI)
            : filteredNews;
        
        // 使用AI选择最佳新闻
        return await this.selectBestNewsWithAI(newsForAI);
    }

    /**
     * 从源获取限制数量的新闻
     * @param source - RSS源URL
     * @param maxItems - 最大条目数
     * @returns 新闻列表
     * @private
     */
    private async fetchNewsWithLimit(
        source: string,
        maxItems: number
    ): Promise<NewsItem[]> {
        const news = await this.fetchNewsFromSource(source);
        return news.slice(0, maxItems);
    }

    /**
     * 合并并过滤新闻，去除重复和已发送的
     * @param news - 新闻列表
     * @returns 过滤后的新闻列表
     * @private
     */
    private mergeAndFilterNews(news: NewsItem[]): NewsItem[] {
        const uniqueNews = new Map<string, NewsItem>();

        for (const item of news) {
            const key = item.title.toLowerCase();
            if (!uniqueNews.has(key) && !this.cache.wasSent(key)) {
                uniqueNews.set(key, item);
            }
        }

        return Array.from(uniqueNews.values());
    }

    /**
     * 使用AI选择最佳新闻
     * @param news - 新闻列表
     * @returns 最佳新闻项或null
     * @private
     */
    private async selectBestNewsWithAI(news: NewsItem[]): Promise<NewsItem | null> {
        // 边界情况快速处理
        if (news.length === 0) return null;
        if (news.length === 1) return news[0] ?? null;

        // 构建AI提示词
        const prompt = this.buildAIPrompt(news);

        try {
            // 使用内置的超时控制
            const ai = getFastAI();
            const response = await ai.get(prompt, false);
            
            // 提取数字
            const selectedIndex = parseInt(response.trim(), 10);

            // 确保索引在有效范围内
            if (!isNaN(selectedIndex) && selectedIndex >= 1 && selectedIndex <= news.length) {
                return news[selectedIndex - 1] ?? null;
            }
            
            // 索引无效时随机选择
            log.warn(`AI返回的不是有效数字: ${response}`);
            return news[Math.floor(Math.random() * news.length)] ?? null;
        } catch (error) {
            log.error(`AI选择失败: ${error}`);
            // 错误情况下随机选择
            return news[Math.floor(Math.random() * news.length)] ?? null;
        }
    }

    /**
     * 构建AI提示词 - 精简版
     * @param news - 新闻列表
     * @returns AI提示词
     * @private
     */
    private buildAIPrompt(news: NewsItem[]): string {
        // 减少标题长度，节省tokens
        const MAX_TITLE_LENGTH = 30;
        
        // 简化源统计，只统计总数
        const sourceTypes = new Set(news.map(item => item.sourceName.split('.')[0]));
        const sourceStats = `${sourceTypes.size}个来源，共${news.length}条`;
        
        // 高效生成新闻列表
        const newsItems = news.map((n, i) => {
            // 截断标题
            const title = n.title.length > MAX_TITLE_LENGTH
                ? n.title.substring(0, MAX_TITLE_LENGTH) + '...'
                : n.title;
                
            // 简化日期，只显示月日
            const date = n.pubDate 
                ? new Date(n.pubDate).toLocaleDateString('zh-CN', {month: 'numeric', day: 'numeric'})
                : '';
                
            return `${i + 1}. ${title}${date ? ` (${date})` : ''}`;
        }).join('\n');
        
        // 更简洁的提示词
        return `从下列新闻中选择最重要的一条 (${sourceStats})
优先：重大时政>突发事件>科技动态>一般资讯

${newsItems}

直接回复数字(1-${news.length})，表示你选择的新闻序号。`;
    }
}

/**
 * 传统算法新闻选择器 - 使用评分算法进行新闻筛选
 */
class AlgorithmNewsSelector extends NewsSelector {
    /** 评分权重配置 */
    private static readonly SCORE_WEIGHTS = {
        relevance: 0.4,  // 相关性权重
        timeliness: 0.3, // 时效性权重
        quality: 0.2,    // 质量权重
        source: 0.1      // 来源权重
    } as const;

    /** 时效性配置 */
    private static readonly TIMELINESS_CONFIG = {
        RECENT_HOURS: 6,        // 最近新闻时间窗口（小时）
        WORK_HOURS_START: 8,    // 工作时间开始
        WORK_HOURS_END: 22,     // 工作时间结束
        RECENT_BONUS: 1.3,      // 最近新闻加权
        WORK_HOURS_BONUS: 1.2,  // 工作时间加权
        SIMILAR_TIME_PENALTY: 0.7 // 相似时间惩罚
    } as const;

    /**
     * 选择最佳新闻
     * @returns 最佳新闻项或null
     */
    async selectNews(): Promise<NewsItem | null> {
        try {
            // 并行获取并评分所有源的新闻
            const newsPromises = RSS_SOURCES.map(source => this.fetchAndScoreNews(source));
            const newsArrays = await Promise.all(newsPromises);

            // 合并所有新闻
            const allNews = newsArrays.flat();

            // 根据综合得分排序并返回最佳新闻
            return this.selectBestNews(allNews);
        } catch (error) {
            log.error(`Error selecting news: ${error}`);
            return null;
        }
    }

    /**
     * 获取并评分新闻
     * @param source - RSS源URL
     * @returns 评分后的新闻列表
     * @private
     */
    private async fetchAndScoreNews(
        source: string
    ): Promise<NewsItem[]> {
        try {
            // 添加超时保护
            const timeoutPromise = new Promise<NewsItem[]>((resolve) => {
                setTimeout(() => resolve([]), 4000); // 4秒超时
            });
            
            const newsPromise = this.fetchNewsFromSource(source);
            const news = await Promise.race([newsPromise, timeoutPromise]);
            
            // 为每个新闻项评分，使用默认优先级为1
            // 使用更高效的map方法，避免不必要的对象复制
            return news.map(item => {
                // 直接修改对象属性而不是创建新对象
                item.score = this.calculateScore(item, 1);
                return item;
            });
        } catch (error) {
            log.warn(`评分新闻失败 ${source}: ${error}`);
            return [];
        }
    }

    /**
     * 选择最佳新闻
     * @param news - 新闻列表
     * @returns 最佳新闻项或null
     * @private
     */
    private selectBestNews(news: NewsItem[]): NewsItem | null {
        // 过滤掉已发送的新闻，并按分数降序排序
        return news
            .filter(item => !this.cache.wasSent(item.title.toLowerCase()))
            .sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;
    }

    /**
     * 计算新闻得分 - 优化版本
     * @param item - 新闻项
     * @param priority - 源优先级
     * @returns 新闻分数
     * @private
     */
    private calculateScore(item: NewsItem, priority: number): number {
        // 直接计算得分而不创建中间对象
        const relevanceScore = this.calculateRelevanceScore(item);
        const timelinessScore = this.calculateTimelinessScore(item);
        const qualityScore = item.content ? this.calculateQualityScore(item) : 0;
        const sourceScore = priority / 5;

        // 使用预定义权重直接计算加权和
        const { relevance, timeliness, quality, source } = AlgorithmNewsSelector.SCORE_WEIGHTS;
        const totalScore = 
            relevanceScore * relevance + 
            timelinessScore * timeliness + 
            qualityScore * quality +
            sourceScore * source;

        return Math.min(totalScore, 1); // 确保得分不超过1
    }

    /**
     * 计算相关性得分
     * @param item - 新闻项
     * @returns 相关性得分
     * @private
     */
    private calculateRelevanceScore(item: NewsItem): number {
        let score = 0;
        const content = item.title + ' ' + (item.description || '');

        // 计算关键词得分
        IMPORTANCE_KEYWORDS.forEach(({ words, weight }) => {
            if (words.some(word => content.includes(word))) {
                score += weight;
            }
        });

        // 标题质量评分
        const titleLength = item.title.length;
        if (titleLength >= 10 && titleLength <= 40) {
            score += 0.2; // 适当长度的标题加分
        }

        return Math.min(score, 1);
    }

    /**
     * 计算时效性得分
     * @param item - 新闻项
     * @returns 时效性得分
     * @private
     */
    private calculateTimelinessScore(item: NewsItem): number {
        const now = Date.now();
        const publishTime = new Date(item.pubDate || '').getTime();
        const age = now - publishTime;

        const {
            RECENT_HOURS,
            WORK_HOURS_START,
            WORK_HOURS_END,
            RECENT_BONUS,
            WORK_HOURS_BONUS,
            SIMILAR_TIME_PENALTY
        } = AlgorithmNewsSelector.TIMELINESS_CONFIG;

        // 基础时效性分数 - 年龄越小分数越高
        let score = 1 - (age / (NEWS_CONFIG.MAX_AGE_HOURS * 3600 * 1000));

        // 工作时间加权
        const hour = new Date().getHours();
        if (hour >= WORK_HOURS_START && hour <= WORK_HOURS_END) {
            score *= WORK_HOURS_BONUS;
        }

        // 最近新闻加权
        if (age <= RECENT_HOURS * 3600 * 1000) {
            score *= RECENT_BONUS;
        }

        // 避免相似时间的新闻
        const lastUpdateTime = this.lastUpdate.get(item.source);
        if (lastUpdateTime && (now - lastUpdateTime) < NEWS_CONFIG.MIN_UPDATE_INTERVAL) {
            score *= SIMILAR_TIME_PENALTY;
        }

        return Math.min(score, 1);
    }

    /**
     * 计算质量得分
     * @param item - 新闻项
     * @returns 质量得分
     * @private
     */
    private calculateQualityScore(item: NewsItem): number {
        if (!item.content) return 0;

        const content = item.content + (item.description || '');

        // 计算各项指标得分
        const formatScore = this.calculateFormatScore(content);
        const richContentScore = this.calculateRichContentScore(content);
        const imageScore = this.calculateImageScore(content);

        // 合并得分
        let score = formatScore + richContentScore + imageScore;

        // 垃圾内容检测
        if (SPAM_KEYWORDS.some(word => content.includes(word))) {
            score *= 0.5; // 降低垃圾内容得分
        }

        return Math.min(Math.max(score, 0), 1); // 确保得分在0-1之间
    }

    /**
     * 计算格式得分
     * @param content - 内容
     * @returns 格式得分
     * @private
     */
    private calculateFormatScore(content: string): number {
        // 检查是否包含表格、引用和列表等格式
        const hasTable = content.includes('<table');
        const hasBlockquote = content.includes('<blockquote');
        const hasLists = content.includes('<ul') || content.includes('<ol');

        return (hasTable ? 0.1 : 0) +
            (hasBlockquote ? 0.1 : 0) +
            (hasLists ? 0.1 : 0);
    }

    /**
     * 计算内容丰富度得分
     * @param content - 内容
     * @returns 内容丰富度得分
     * @private
     */
    private calculateRichContentScore(content: string): number {
        // 检查是否包含链接、数字和引用等
        const hasLinks = content.includes('href=');
        const hasNumbers = /\d+([,.]\d+)?%?/.test(content);
        const hasQuotes = /"[^"]{10,}"/.test(content);

        return (hasLinks ? 0.1 : 0) +
            (hasNumbers ? 0.1 : 0) +
            (hasQuotes ? 0.1 : 0);
    }

    /**
     * 计算图片得分
     * @param content - 内容
     * @returns 图片得分
     * @private
     */
    private calculateImageScore(content: string): number {
        const imageCount = (content.match(/<img/g) || []).length;
        
        if (imageCount >= 3) return 0.3;
        if (imageCount >= 1) return 0.2;
        return 0;
    }

    /**
     * 从所有源获取新闻并计算得分
     * @returns 最佳新闻项或null
     */
    async selectNewsFromAllSources(): Promise<NewsItem | null> {
        // 复用selectNews方法，因为我们现在只有一个统一的源列表
        return this.selectNews();
    }
}

/**
 * 新闻服务主控制器 - 协调各组件完成新闻获取和发送
 */
class NewsService {
    private readonly cache = new NewsCache();
    private readonly lastUpdate = new Map<string, number>();
    private readonly aiSelector: AiNewsSelector;
    private readonly algorithmSelector: AlgorithmNewsSelector;
    private readonly cleanupTimer: ReturnType<typeof setInterval>;

    constructor() {
        // 初始化选择器
        const deps = { cache: this.cache, lastUpdate: this.lastUpdate };
        this.aiSelector = new AiNewsSelector(deps);
        this.algorithmSelector = new AlgorithmNewsSelector(deps);

        // 启动缓存清理定时器
        this.cleanupTimer = this.startCacheCleanup();
    }

    /**
     * 初始化服务
     */
    async init(): Promise<void> {
        this.cache.clear();
    }

    /**
     * 释放资源
     */
    dispose(): void {
        clearInterval(this.cleanupTimer);
    }

    /**
     * 获取并发送新闻
     * @param client - 客户端
     * @param chatId - 聊天ID
     * @param messageToReply - 回复的消息对象（null表示不回复任何消息）
     * @param isCommand - 是否由命令触发，如果是则显示等待消息
     */
    async fetchAndSendNews(client: TelegramClient, chatId: number, messageToReply: Message | null, isCommand: boolean = false): Promise<void> {
        // 创建等待消息（命令触发或提供了回复消息时）
        const waitMsgPromise = isCommand 
            ? (messageToReply 
                ? client.replyText(messageToReply, "📰 正在获取新闻...") 
                : client.sendText(chatId, "📰 正在获取新闻..."))
            : null;

        try {
            // 设置整体超时
            const timeoutPromise = new Promise<null>((resolve) => {
                setTimeout(() => resolve(null), 20000); // 20秒总超时
            });

            // 从所有分类中获取新闻，带超时处理
            const newsPromise = this.getAllSourcesNews();
            const news = await Promise.race([newsPromise, timeoutPromise]);

            // 如果没有找到新闻
            if (!news) {
                if (waitMsgPromise) {
                    // 仅在有等待消息时需要编辑
                    await client.editMessage({
                        message: await waitMsgPromise,
                        text: `未找到合适的新闻`
                    });
                }
                return;
            }

            // 处理新闻内容
            const formattedContent = await this.processNewsContent(news);
            
            // 从结果中提取文本和图片
            const { text, images } = formattedContent;

            // 如果没有图片，直接发送文本
            if (!images.length) {
                if (waitMsgPromise) {
                    // 有等待消息时，编辑它
                    await client.editMessage({
                        message: await waitMsgPromise,
                        text: text
                    });
                } else {
                    // 没有等待消息时，直接发送
                    await client.sendText(chatId, text);
                }
                return;
            }

            // 如果有等待消息，需要在后续发送媒体前删除它
            const shouldDeleteWaitMsg = waitMsgPromise !== null;
            let waitMsgId: number | undefined;
            
            if (shouldDeleteWaitMsg) {
                waitMsgId = (await waitMsgPromise!).id;
            }

            // 如果只有一张图片，发送带图片的消息
            const firstImage = images[0];
            if (images.length === 1 && firstImage) {
                if (messageToReply) {
                    await client.replyMedia(messageToReply, firstImage, { caption: text });
                } else {
                    await client.sendMedia(chatId, firstImage, { caption: text });
                }
                
                // 删除等待消息
                if (shouldDeleteWaitMsg && waitMsgId) {
                    await client.deleteMessagesById(chatId, [waitMsgId]);
                }
                return;
            }

            // 如果有多张图片，创建媒体组
            const mediaGroup = images
                .filter(Boolean)
                .map((img, index) => ({
                    type: 'photo' as const,
                    file: img,
                    caption: index === 0 ? text : undefined
                }));

            if (messageToReply) {
                await client.replyMediaGroup(messageToReply, mediaGroup);
            } else {
                await client.sendMediaGroup(chatId, mediaGroup);
            }

            // 删除等待消息
            if (shouldDeleteWaitMsg && waitMsgId) {
                await client.deleteMessagesById(chatId, [waitMsgId]);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            if (waitMsgPromise) {
                // 只在有等待消息时才编辑更新错误
                await client.editMessage({
                    message: await waitMsgPromise,
                    text: `获取新闻失败: ${errorMessage}`
                });
            } else {
                // 定时任务出错时发送新消息
                await client.sendText(chatId, `获取新闻失败: ${errorMessage}`);
            }
            
            log.error('News fetch error:', error);
        }
    }

    /**
     * 获取服务状态
     * @returns 服务状态信息
     */
    async getServiceStatus(): Promise<ServiceStatus> {
        const { size, sentItems } = this.cache.getCacheInfo();

        // 创建基本状态对象
        const status: ServiceStatus = {
            sources: [],
            cacheInfo: {
                size,
                sentItems,
                cacheTimeout: `${NEWS_CONFIG.CACHE_TIMEOUT}分钟`
            }
        };

        // 并行收集各分类的状态
        const sourcePromises = RSS_SOURCES.map(url => this.checkSourceStatus(url));
        const sources = await Promise.all(sourcePromises);
        
        status.sources = sources;

        return status;
    }

    /**
     * 处理新闻内容
     * @param news - 新闻项
     * @returns 格式化的内容
     */
    private async processNewsContent(news: NewsItem): Promise<{
        text: TextWithEntities;
        images: string[];
    }> {
        // 提前提取图片，减少重复处理
        const images = this.extractImages(news.content || news.contentEncoded || news.description || '');
        
        // 准备原始内容，优先使用contentEncoded，然后是description
        const rawContent = (news.content || news.contentEncoded || news.description || '')
            .replace(/null/g, '')
            .trim();
        
        // 判断内容长度决定是否需要AI摘要
        const needsAiSummary = rawContent.length > NEWS_CONFIG.LONG_NEWS_THRESHOLD;
        
        // 优化并行处理
        const [contentText, aiComment] = await Promise.all([
            // 条件性地获取AI摘要
            needsAiSummary 
                ? this.getAiSummary(news).then(summary => summary || this.formatContent(news))
                : this.formatContent(news),
            
            // 对于较长的新闻才获取AI评论，避免对短新闻浪费API调用
            rawContent.length > 300 && !news.title.includes('天气') && !news.title.includes('预报')
                ? this.getAiComment(news)
                : Promise.resolve('')
        ]);

        // 构建更高效的链接文本
        const detailsText = news.link ? `📎 详情 <a href="${news.link}">${news.sourceName}</a>` : '';
        
        // 组装最终内容
        return {
            text: html`<b>${news.title}</b><br><br>${html(contentText)}<br><br>${aiComment}${html(detailsText)}`,
            images
        };
    }

    /**
     * 获取AI摘要 - 优化版本
     * @param news - 新闻项
     * @returns AI生成的摘要
     */
    private async getAiSummary(news: NewsItem): Promise<string> {
        // 如果内容太短，不需要摘要
        const content = news.content || news.description || '';
        if (content.length < 200) return '';
        
        try {
            // 构建更简洁的提示词，减少token用量
            const prompt = `${AI_SUMMARY_PROMPT}\n标题: ${news.title}\n内容: ${this.truncateContent(content, 1500)}`;
            
            // 添加超时处理
            const timeoutPromise = new Promise<string>((_, reject) => {
                setTimeout(() => reject(new Error('AI摘要生成超时')), 40000); // 超时时间
            });

            const aiPromise = getHighQualityAI().get(prompt, false);
            const comment = await Promise.race([aiPromise, timeoutPromise]);
            
            if (!comment || comment === '[CANCEL]') return '';
            
            // 使用HtmlHelper一站式处理HTML
            return cleanHTML(comment.trim());
        } catch (error) {
            log.error(`AI summary generation failed: ${error}`);
            return '';
        }
    }

    /**
     * 获取AI评论 - 优化版本
     * @param news - 新闻项
     * @returns AI生成的评论
     */
    private async getAiComment(news: NewsItem): Promise<string> {
        try {
            // 构建更简洁的提示词，减少token用量
            const titleOnly = news.title.length < 100;
            const prompt = `${AI_COMMENT_PROMPT}\n标题: ${news.title}${
                titleOnly ? '' : `\n内容: ${this.truncateContent(news.description || '', 600)}`
            }`;
            
            // 添加超时处理
            const timeoutPromise = new Promise<string>((_, reject) => {
                setTimeout(() => reject(new Error('AI评论生成超时')), 40000); // 超时时间
            });

            const aiPromise = getHighQualityAI().get(prompt, false);
            const comment = await Promise.race([aiPromise, timeoutPromise]);
            
            if (!comment || comment === '[CANCEL]' || comment.length > 150) return '';
            
            // 使用HtmlHelper一站式处理HTML
            const cleanHtml = cleanHTML(comment.trim());
            
            return cleanHtml ? `🤖 ${cleanHtml}<br>` : '';
        } catch (error) {
            log.error(`AI comment generation failed: ${error}`);
            return '';
        }
    }

    /**
     * 截断内容到指定长度
     * @param content - 原始内容
     * @param maxLength - 最大长度
     * @returns 截断后的内容
     */
    private truncateContent(content: string, maxLength: number): string {
        if (content.length <= maxLength) return content;
        return content.substring(0, maxLength) + '...';
    }

    /**
     * 格式化新闻内容 - 优化版本
     * @param news - 新闻项
     * @returns 格式化的内容
     */
    private formatContent(news: NewsItem): string {
        // 获取内容，优先使用description，因为通常更简洁
        let content = news.description || news.content || '';
        
        // 简单性能优化：只在必要时进行替换
        if (content.includes('null')) {
            content = content.replace(/null/g, '').trim();
        } else {
            content = content.trim();
        }

        // 避免标题重复，通常发生在某些RSS源
        if (news.title && content.startsWith(news.title)) {
            content = content.slice(news.title.length).trim();
        }

        // 统一换行符 - 只在必要时处理
        if (content.includes('\r')) {
            content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        }

        // 使用更高效的方式过滤无效内容
        const lines = content.split('\n');
        const validLines = [];
        
        // 单次循环处理所有行，避免多次遍历
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // 过滤掉太短的行和日期时间格式的行
            if (line.length >= 3 && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line)) {
                validLines.push(line);
            }
        }
        
        // 重新组合内容
        content = validLines.join('\n\n');

        // 处理超长内容
        if (content.length > NEWS_CONFIG.LONG_NEWS_THRESHOLD) {
            const cutLength = NEWS_CONFIG.LONG_NEWS_THRESHOLD - 100;
            return `${content.slice(0, cutLength)}......\n(字数过多 剩余${content.length - cutLength}字请看详情)`;
        }

        return content;
    }

    /**
     * 提取图片URL - 高性能版本
     * @param content - HTML内容
     * @returns 图片URL数组
     */
    private extractImages(content: string): string[] {
        if (!content || content.length < 10) return [];
        
        // 使用缓存的正则表达式
        const imgRegex = /<img[^>]+src=["'](https?:\/\/[^'"]+)["'][^>]*>/gi;
        
        // 使用Set去重，更高效
        const uniqueUrls = new Set<string>();
        const maxImages = 3; // 减少图片数量，提高性能
        
        let match;
        // 使用正则表达式迭代方式，避免创建数组
        while ((match = imgRegex.exec(content)) !== null && uniqueUrls.size < maxImages) {
            const url = match[1];
            if (url && this.isValidImageUrl(url)) {
                uniqueUrls.add(url);
            }
        }
        
        return Array.from(uniqueUrls);
    }

    /**
     * 检查图片URL是否有效 - 优化版本
     * @param url - 图片URL
     * @returns 是否为有效图片URL
     */
    private isValidImageUrl(url: string): boolean {
        // 排除无效图片关键词 - 整合为一次检查
        const invalidKeywords = ['icon', 'logo', 'pixel', 'tracker', 'analytics', 'avatar', 'emoji'];
        const urlLower = url.toLowerCase();
        
        if (invalidKeywords.some(keyword => urlLower.includes(keyword))) {
            return false;
        }
        
        // 检查常见图片扩展名 - 合并为一次检查
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
        const hasImageExtension = imageExtensions.some(ext => urlLower.includes(ext));
        
        // 检查大小参数 - 通常有尺寸的是正常图片
        const hasSizeInfo = urlLower.includes('width=') || urlLower.includes('height=') || 
                           urlLower.includes('size=') || urlLower.includes('=s');
        
        return hasImageExtension || hasSizeInfo;
    }

    /**
     * 启动缓存清理定时器
     * @returns 定时器ID
     */
    private startCacheCleanup(): ReturnType<typeof setInterval> {
        return setInterval(() => {
            // 清理缓存
            this.cache.clear();

            // 清理过期的最后更新时间记录
            const now = Date.now();
            for (const [source, time] of this.lastUpdate.entries()) {
                if (now - time > NEWS_CONFIG.CACHE_CLEANUP_INTERVAL) {
                    this.lastUpdate.delete(source);
                }
            }
        }, NEWS_CONFIG.CACHE_CLEANUP_INTERVAL);
    }

    /**
     * 获取新闻
     * @returns 筛选后的新闻项
     */
    async getNews(): Promise<NewsItem | null> {
        // 首先尝试使用AI选择器进行智能筛选
        let selectedNews = await this.aiSelector.selectNews();

        // 如果AI筛选失败，回退到传统算法筛选
        if (!selectedNews) {
            log.info('Falling back to algorithm selector');
            selectedNews = await this.algorithmSelector.selectNews();
        }

        // 如果成功获取新闻，更新追踪信息
        if (selectedNews) {
            await this.updateNewsTracking(selectedNews);
        }

        return selectedNews;
    }

    /**
     * 更新新闻追踪信息
     * @param news - 需要更新追踪信息的新闻项
     */
    private async updateNewsTracking(news: NewsItem): Promise<void> {
        // 使用标题的小写形式作为唯一ID，确保和wasSent方法使用相同的键
        const newsId = news.title.toLowerCase();

        // 标记新闻为已发送
        this.cache.markSent(newsId);

        // 更新源的最后更新时间
        this.lastUpdate.set(news.source, Date.now());
    }

    /**
     * 从所有源获取新闻 - 优化版本
     * @returns 最佳新闻项或null
     */
    async getAllSourcesNews(): Promise<NewsItem | null> {
        try {
            // 使用更短的超时时间，避免长时间等待
            const timeoutPromise = new Promise<NewsItem | null>((resolve) => {
                setTimeout(() => resolve(null), 12000); // 减少超时时间
            });

            // 首先尝试使用AI选择器从所有源获取新闻
            const aiSelectorPromise = this.aiSelector.selectNewsFromAllSources();
            
            // 使用Promise.race让两个Promise竞争，谁先完成就用谁的结果
            let selectedNews = await Promise.race([aiSelectorPromise, timeoutPromise]);

            // 如果AI筛选失败，回退到算法选择器
            if (!selectedNews) {
                log.info('RSS: AI选择器未返回结果，回退到算法选择器');
                
                // 使用更短的二级超时
                const algorithmTimeoutPromise = new Promise<NewsItem | null>((resolve) => {
                    setTimeout(() => resolve(null), 8000); 
                });
                
                const algorithmPromise = this.algorithmSelector.selectNewsFromAllSources();
                selectedNews = await Promise.race([algorithmPromise, algorithmTimeoutPromise]);
                
                if (!selectedNews) {
                    log.warn('RSS: 两种选择器均未返回结果');
                }
            }

            // 如果成功获取新闻，更新追踪信息
            if (selectedNews) {
                await this.updateNewsTracking(selectedNews);
            }

            return selectedNews;
        } catch (error) {
            log.error(`获取新闻失败: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    /**
     * 检查RSS源状态 - 优化版本
     * @param url - RSS源URL
     * @returns 源状态信息
     */
    private async checkSourceStatus(url: string): Promise<{
        status: string;
        url: string;
        itemCount?: number;
        oldestItem?: string;
        newestItem?: string;
        responseTime?: string;
        name?: string;
        error?: string;
    }> {
        try {
            // 记录开始时间
            const startTime = Date.now();
            
            // 添加超时保护
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error(`获取${url}超时`)), 5000);
            });
            
            // 并行获取RSS源数据
            const feedPromise = this.fetchFeed(url);
            const feed = await Promise.race([feedPromise, timeoutPromise]);
            
            // 计算响应时间
            const responseTime = Date.now() - startTime;
            
            // 简化源名称处理
            const sourceName = feed?.channel?.title || url.split('/').pop() || "未知源";
            
            // 简化条目数据处理 - 使用可选链和默认值
            const items = feed?.channel?.items || [];
            
            // 安全处理日期 - 避免多次调用Date构造函数
            let oldestItem = 'N/A';
            let newestItem = 'N/A';
            
            // 只在有条目时处理日期信息
            if (items.length > 0) {
                // 使用可选链和空值合并，减少潜在错误
                const firstPubDate = items[0]?.pubDate;
                const lastPubDate = items[items.length - 1]?.pubDate;
                
                if (firstPubDate) {
                    try {
                        // 使用更简洁的日期格式
                        newestItem = new Date(firstPubDate).toLocaleString('zh-CN', {
                            month: 'numeric',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: 'numeric'
                        });
                    } catch {
                        newestItem = 'Invalid Date';
                    }
                }
                
                if (lastPubDate) {
                    try {
                        oldestItem = new Date(lastPubDate).toLocaleString('zh-CN', {
                            month: 'numeric',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: 'numeric'
                        });
                    } catch {
                        oldestItem = 'Invalid Date';
                    }
                }
            }
            
            return {
                status: 'ok',
                url,
                itemCount: items.length,
                oldestItem,
                newestItem,
                responseTime: `${responseTime}ms`,
                name: sourceName
            };
        } catch (error) {
            // 更详细的错误信息
            const errorMessage = error instanceof Error 
                ? `${error.name}: ${error.message}` 
                : String(error);
                
            log.warn(`RSS源状态检查失败: ${url} - ${errorMessage}`);
            
            return {
                status: 'error',
                url,
                error: errorMessage
            };
        }
    }

    /**
     * 获取RSS源数据
     * @param url - RSS源URL
     * @returns RSS源数据
     * @private
     */
    private async fetchFeed(url: string): Promise<RSSFeed> {
        try {
            return await fetchRSS(url);
        } catch (error) {
            log.error(`获取RSS源失败: ${url} - ${error}`);
            throw error;
        }
    }
}

// 插件全局实例
let serviceInstance: NewsService | null = null;
let cycleSendJob: Cron | null = null;

/**
 * RSS插件定义
 */
const plugin: BotPlugin = {
    name: 'rss',
    description: '多源RSS新闻订阅服务',
    version: '1.0.0',

    commands: [
        {
            name: 'rss',
            description: '获取最新新闻',
            aliases: ['news', 'feed', 'feeds'],
            async handler(ctx: CommandContext) {
                if (!serviceInstance) {
                    await ctx.message.replyText("RSS服务未初始化");
                    return;
                }
                
                // 传递isCommand=true，表示由命令触发
                await serviceInstance.fetchAndSendNews(ctx.client, ctx.chatId, ctx.message, true);
            }
        },
        {
            name: 'rssstatus',
            description: '查看RSS服务状态',
            async handler(ctx: CommandContext) {
                if (!serviceInstance) {
                    await ctx.message.replyText("RSS服务未初始化");
                    return;
                }

                const waitMsg = ctx.message.replyText("⚙️ 正在检查RSS状态...");
                try {
                    const status = await serviceInstance.getServiceStatus();
                    const response = ["📊 RSS 服务状态\n"];

                    // 添加缓存信息
                    response.push("📦 缓存信息:");
                    response.push(`- 缓存源数量: ${status.cacheInfo.size}`);
                    response.push(`- 已发送条目: ${status.cacheInfo.sentItems}`);
                    response.push(`- 缓存时间: ${status.cacheInfo.cacheTimeout}\n`);

                    // 添加各分类源状态
                    for (const source of status.sources) {
                        if (source.status === 'ok') {
                            response.push(`✅ ${source.name}`);
                            response.push(`- 条目数量: ${source.itemCount}`);
                            response.push(`- 最新更新: ${source.newestItem}`);
                            response.push(`- 响应时间: ${source.responseTime}\n`);
                        } else {
                            response.push(`❌ ${source.url}`);
                            response.push(`- 错误: ${source.error}\n`);
                        }
                    }

                    await ctx.client.editMessage({
                        chatId: ctx.chatId,
                        message: (await waitMsg).id,
                        text: response.join('\n')
                    });
                } catch (error) {
                    await ctx.client.editMessage({
                        chatId: ctx.chatId,
                        message: (await waitMsg).id,
                        text: `检查失败\n${error}`
                    });
                }
            }
        }
    ],

    async onLoad(client: TelegramClient) {
        // 初始化服务
        serviceInstance = new NewsService();
        await serviceInstance.init();

        cycleSendJob = new Cron("0,30 * * * *", () => {
            for (const chatId of enableChats) {
                serviceInstance?.fetchAndSendNews(client, chatId, null, false);
            }
        });
    },

    async onUnload() {
        // 释放资源
        if (serviceInstance) {
            serviceInstance.dispose();
            serviceInstance = null;
        }

        if (cycleSendJob) {
            cycleSendJob.stop();
            cycleSendJob = null;
        }
    }
};

export default plugin;