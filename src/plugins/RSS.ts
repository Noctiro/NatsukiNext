import { getFastAI, getHighQualityAI } from "../ai/AiManager";
import { log } from "../log";
import { fetchRSS, type RSSItem, type RSSFeed } from "../utils/RssParse";
import type { BotPlugin, CommandContext } from '../features';
import { html, Message, type TelegramClient, type TextWithEntities } from "@mtcute/bun";
import { Cron } from "croner";
import { enableChats } from "../app";

/**
 * RSS 源配置接口
 * @interface RssSources
 */
interface RssSources {
    [key: string]: {
        priority: number;    // 优先级 (数字越小优先级越高)
        cooldown: number;    // 冷却时间 (分钟)
        sources: string[];   // RSS 源 URL 列表
    };
}

/**
 * 新闻项接口，扩展自 RSSItem
 * @interface NewsItem
 */
interface NewsItem extends Omit<RSSItem, 'source'> {
    source: string;          // 源 URL
    sourceName: string;      // 源名称
    score?: number;          // 新闻分数 (算法选择器使用)
    contentSnippet?: string; // 内容片段
    category?: keyof typeof RSS_SOURCES; // 新闻分类
}

/**
 * 服务状态接口
 * @interface ServiceStatus
 */
interface ServiceStatus {
    categories: Record<string, {
        priority: number;
        cooldown: string;
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
    }>;
    cacheInfo: {
        size: number;
        sentItems: number;
        cacheTimeout: string;
    };
}

// 定义重试次数类型
type RetryCount = 1 | 2 | 3;

// RSS 源配置
const RSS_SOURCES: RssSources = {
    integration: {
        priority: 2,
        cooldown: 15, // 分钟
        sources: [
            "http://cn.nytimes.com/rss/news.xml",           // 纽约时报中文
            "https://feedx.net/rss/dw.xml",                 // 德国之声
            "https://feedx.net/rss/wsj.xml",                // 华尔街中文
            "https://feeds.feedburner.com/rsscna/politics", // 中央社政治新闻
            "https://news.pts.org.tw/xml/newsfeed.xml",     // 公视新闻
            "http://www.bbc.co.uk/zhongwen/simp/index.xml", // bbc中文
            "https://feedx.net/rss/zhihudaily.xml",         // 知乎日报
        ]
    },
    tech: {
        priority: 1,
        cooldown: 60, // 分钟
        sources: [
            "http://www.ithome.com/rss/",       // IT之家
            "https://www.solidot.org/index.rss", // 奇客Solidot
            "http://rss.cnbeta.com.tw/",        // cnbeta科技
            "https://www.geekpark.net/rss"      // 极客公园
        ]
    }
};

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
const AI_SUMMARY_PROMPT = `你是一名专业的新闻编辑，擅长提炼新闻的核心要点，并用简洁、有力、流畅的语言进行表达。请从以下长篇新闻中提取关键信息，优化表述，使其更易读、更有逻辑性，并确保信息准确无误。

要求：
1. 核心要点提炼：概括新闻的主要事实，包括时间、地点、事件、涉及人物和重要背景信息。
2. 逻辑清晰：按照"背景—事件—影响"的结构整理内容，使读者易于理解。
3. 语言优化：用简洁、精准、生动的语言表达，去掉冗余信息，避免重复和模糊表述。
4. 客观中立：保持新闻客观性，不加入主观评论或夸张修辞。
5. 适当压缩：根据原文长度，将信息精炼至合理篇幅，确保涵盖关键信息的同时不影响可读性。尽量在${NEWS_CONFIG.LONG_NEWS_THRESHOLD}字以内。
6. 内容安全: 不要提供任何解释或要求以外的内容。
7. 错误回馈: 如果无法提炼出关键信息或内容不适合总结，则直接返回 [CANCEL]。
` as const;

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
        source: string,
        category: keyof typeof RSS_SOURCES
    ): Promise<NewsItem[]> {
        try {
            const feed = await fetchRSS(source);
            // 使用可空链操作符和默认空字符串处理，避免返回undefined
            const sourceName = feed.channel.title || source.split('/').pop() || '';

            return feed.channel.items
                .filter(item => this.isNewsValid(item))
                .map(item => this.convertToNewsItem(item, source, sourceName));
        } catch (error) {
            log.error(`Error fetching ${source}: ${error}`);
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
     * 在当前版本中，我们通过从所有分类筛选新闻来实现
     * @param category - RSS分类
     * @param sources - RSS源列表
     * @returns 最佳新闻项或null
     */
    async selectNews(category: keyof typeof RSS_SOURCES, sources: string[]): Promise<NewsItem | null> {
        // 为了保持兼容性，我们尝试从所有分类获取，然后过滤相应分类的结果
        const news = await this.selectNewsFromAllCategories();
        
        // 如果找不到任何新闻，则专门从指定分类中获取
        if (!news) {
            const maxItemsPerSource = Math.ceil(this.MAX_ITEMS_PER_BATCH / sources.length);
            const newsPromises = sources.map(source => 
                this.fetchNewsWithLimit(source, maxItemsPerSource, category));
            
            const allNewsArrays = await Promise.all(newsPromises);
            const allNews = this.mergeAndFilterNews(allNewsArrays.flat());
            
            if (allNews.length === 0) return null;
            
            return await this.selectBestNewsWithAI(allNews);
        }
        
        // 已经找到新闻，则直接返回
        return news;
    }

    /**
     * 从所有分类获取新闻并按比例筛选
     * @returns 最佳新闻项或null
     */
    async selectNewsFromAllCategories(): Promise<NewsItem | null> {
        // 计算所有分类的新闻总数上限
        const totalMaxItems = this.MAX_ITEMS_PER_BATCH;
        
        // 计算每个分类的权重总和
        const totalWeight = Object.values(RSS_SOURCES).reduce((sum, config) => 
            sum + (1 / config.priority), 0);
        
        // 获取每个分类的新闻
        const allCategoryNews: NewsItem[] = [];
        
        for (const [category, config] of Object.entries(RSS_SOURCES)) {
            // 根据优先级比例分配每个分类的条目数
            const categoryWeight = 1 / config.priority;
            const categoryMaxItems = Math.floor((categoryWeight / totalWeight) * totalMaxItems);
            
            // 平均分配到每个源
            const itemsPerSource = Math.ceil(categoryMaxItems / config.sources.length);
            
            // 并行获取该分类所有源的新闻
            const newsPromises = config.sources.map(source => 
                this.fetchNewsWithLimit(source, itemsPerSource, category as keyof typeof RSS_SOURCES));
            
            const categoryNewsArrays = await Promise.all(newsPromises);
            const categoryNews = categoryNewsArrays.flat();
            
            // 添加分类信息
            categoryNews.forEach(item => {
                item.category = category as keyof typeof RSS_SOURCES;
            });
            
            allCategoryNews.push(...categoryNews);
        }
        
        // 合并并过滤所有新闻
        const filteredNews = this.mergeAndFilterNews(allCategoryNews);
        
        if (filteredNews.length === 0) return null;
        
        // 使用AI选择最佳新闻
        return await this.selectBestNewsWithAI(filteredNews);
    }

    /**
     * 从源获取限制数量的新闻
     * @param source - RSS源URL
     * @param maxItems - 最大条目数
     * @param category - RSS分类
     * @returns 新闻列表
     * @private
     */
    private async fetchNewsWithLimit(
        source: string,
        maxItems: number,
        category: keyof typeof RSS_SOURCES
    ): Promise<NewsItem[]> {
        const news = await this.fetchNewsFromSource(source, category);
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
        // 构建 AI 提示词
        const prompt = this.buildAIPrompt(news);

        try {
            const response = await getFastAI().get(prompt, false);
            const selectedIndex = parseInt(response.trim(), 10);

            if (isNaN(selectedIndex) || selectedIndex < 1 || selectedIndex > news.length) {
                throw new Error('AI返回的不是有效数字');
            }

            return news[selectedIndex - 1] || null;
        } catch (error) {
            log.error(`AI selection failed: ${error}`);
            return null;
        }
    }

    /**
     * 构建AI提示词
     * @param news - 新闻列表
     * @returns AI提示词
     * @private
     */
    private buildAIPrompt(news: NewsItem[]): string {
        // 统计各分类新闻数量
        const categoryCounts = news.reduce((counts, item) => {
            if (item.category) {
                counts[item.category] = (counts[item.category] || 0) + 1;
            }
            return counts;
        }, {} as Record<string, number>);
        
        // 构建分类统计信息
        const categoryStats = Object.entries(categoryCounts)
            .map(([category, count]) => `${category}: ${count}条`)
            .join(', ');
            
        return `作为新闻编辑，从以下${news.length}条新闻中选择最值得报道的一条（${categoryStats}）。考虑新闻的：
1. 重要性和影响力
2. 时效性
3. 受众关注度
4. 新闻价值
5. 有趣程度

优先考虑时政类和科技类的新闻，除非其他类别的更加有意思和重要。

现在时间 ${new Date().toLocaleString()}
新闻清单：
${news.map((n, i) => {
    const categoryInfo = n.category ? `[${n.category}] ` : '';
    return `${i + 1}. ${categoryInfo}${n.title.trim()} (${new Date(n.pubDate || '').toLocaleString()})`;
}).join('\n')}

只需返回选择的新闻序号，例如: "3" 。不需要解释原因。`;
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
     * @param category - RSS分类
     * @param sources - RSS源列表
     * @returns 最佳新闻项或null
     */
    async selectNews(category: keyof typeof RSS_SOURCES, sources: string[]): Promise<NewsItem | null> {
        const config = RSS_SOURCES[category];
        if (!config) return null;

        // 并行获取并评分所有源的新闻
        const newsPromises = sources.map(source => this.fetchAndScoreNews(source, config.priority, category));
        const newsArrays = await Promise.all(newsPromises);

        // 合并所有新闻
        const allNews = newsArrays.flat();

        // 根据综合得分排序并返回最佳新闻
        return this.selectBestNews(allNews);
    }

    /**
     * 获取并评分新闻
     * @param source - RSS源URL
     * @param priority - 源优先级
     * @param category - RSS分类
     * @returns 评分后的新闻列表
     * @private
     */
    private async fetchAndScoreNews(
        source: string,
        priority: number,
        category: keyof typeof RSS_SOURCES
    ): Promise<NewsItem[]> {
        const news = await this.fetchNewsFromSource(source, category);

        // 为每个新闻项评分
        return news.map(item => ({
            ...item,
            score: this.calculateScore(item, priority)
        }));
    }

    /**
     * 计算新闻得分
     * @param item - 新闻项
     * @param priority - 源优先级
     * @returns 新闻分数
     * @private
     */
    private calculateScore(item: NewsItem, priority: number): number {
        const scores = {
            relevance: this.calculateRelevanceScore(item),
            timeliness: this.calculateTimelinessScore(item),
            quality: this.calculateQualityScore(item),
            source: priority / 5 // 归一化源优先级分
        };

        // 计算加权总分
        const totalScore = Object.entries(scores).reduce(
            (total, [key, score]) =>
                total + score * AlgorithmNewsSelector.SCORE_WEIGHTS[key as keyof typeof AlgorithmNewsSelector.SCORE_WEIGHTS],
            0
        );

        return Math.min(totalScore, 1); // 确保得分不超过1
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
        // 统计图片数量并给予分数
        const imageCount = (content.match(/<img/g) || []).length;
        return Math.min(imageCount * 0.2, 0.4); // 最多0.4分
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
     */
    async fetchAndSendNews(client: TelegramClient, chatId: number, replyMessage: Message | null): Promise<void> {
        const waitMsg = replyMessage ? client.replyText(replyMessage, "📰 正在获取新闻...") : client.sendText(chatId, "📰 正在获取新闻...");

        try {
            // 从所有分类中获取新闻
            const news = await this.getAllCategoriesNews();

            if (!news) {
                await client.editMessage({
                    message: await waitMsg,
                    text: `未找到合适的新闻`
                });
                return;
            }

            // 处理新闻内容
            const formattedContent = await this.processNewsContent(news);

            // 发送新闻
            const { text, images } = formattedContent;

            // 如果没有图片，直接发送文本
            if (!images.length) {
                await client.editMessage({
                    message: await waitMsg,
                    text: text
                });
                return;
            }

            // 如果只有一张图片，发送带图片的消息
            const firstImage = images[0];
            if (images.length === 1 && firstImage) {
                if (replyMessage) {
                    client.replyMedia(replyMessage, firstImage, { caption: text });
                } else {
                    client.sendMedia(chatId, firstImage, { caption: text });
                }
                await client.deleteMessagesById(chatId, [(await waitMsg).id]);
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


            if (replyMessage) {
                client.replyMediaGroup(replyMessage, mediaGroup);
            } else {
                client.sendMediaGroup(chatId, mediaGroup);
            }

            // 删除等待消息
            await client.deleteMessagesById(chatId, [(await waitMsg).id]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            await client.editMessage({
                message: await waitMsg,
                text: `获取新闻失败: ${errorMessage}`
            });
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
            categories: {},
            cacheInfo: {
                size,
                sentItems,
                cacheTimeout: `${NEWS_CONFIG.CACHE_TIMEOUT}分钟`
            }
        };

        // 收集各分类的状态
        for (const [category, config] of Object.entries(RSS_SOURCES)) {
            status.categories[category] = {
                priority: config.priority,
                cooldown: `${config.cooldown}分钟`,
                sources: await Promise.all(config.sources.map(url => this.checkSourceStatus(url)))
            };
        }

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
        const rawContent = (news.contentEncoded || news.description || '').replace(/null/g, '').trim();

        // 根据内容长度决定使用AI摘要还是简单格式化
        let contentText: string;
        if (rawContent.length > NEWS_CONFIG.LONG_NEWS_THRESHOLD) {
            contentText = await this.getAiSummary(news) || this.formatContent(news);
        } else {
            contentText = this.formatContent(news);
        }

        // 获取AI评论
        const aiComment = await this.getAiComment(news);

        // 提取图片
        const images = this.extractImages(news.contentEncoded || '');

        // 组装最终内容
        return {
            text: html`<b>${news.title}</b><br><br>${contentText}<br><br>${aiComment}📎 详情 <a href="${news.link}">${news.sourceName}</a>`,
            images
        };
    }

    /**
     * 获取AI摘要
     * @param news - 新闻项
     * @returns AI生成的摘要
     */
    private async getAiSummary(news: NewsItem): Promise<string> {
        try {
            const comment = await getHighQualityAI().get(
                `${AI_SUMMARY_PROMPT}\n标题: ${news.title}\n内容: ${news.content || news.description}`,
                false
            );
            return comment && comment !== '[CANCEL]' ? comment.trim() : '';
        } catch (error) {
            log.error(`AI summary generation failed: ${error}`);
            return '';
        }
    }

    /**
     * 获取AI评论
     * @param news - 新闻项
     * @returns AI生成的评论
     */
    private async getAiComment(news: NewsItem): Promise<string> {
        try {
            const comment = await getHighQualityAI().get(
                `${AI_COMMENT_PROMPT}\n标题: ${news.title}\n内容: ${news.content || news.description}`,
                false
            );
            return comment && comment !== '[CANCEL]' && comment.length <= 150 ? `🤖 ${comment.trim()}\n` : '';
        } catch (error) {
            log.error(`AI comment generation failed: ${error}`);
            return '';
        }
    }

    /**
     * 格式化新闻内容
     * @param news - 新闻项
     * @returns 格式化的内容
     */
    private formatContent(news: NewsItem): string {
        let content = news.description || news.content || '';
        content = content.replace(/null/g, '').trim();

        // 避免标题重复
        if (content.startsWith(news.title)) {
            content = content.slice(news.title.length).trim();
        }

        // 统一换行符
        content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // 过滤无效内容
        const paragraphs = content.split('\n')
            .map((line: string) => line.trim())
            .filter((line: string) => line.length >= 3 && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line));

        content = paragraphs.join('\n\n');

        // 处理超长内容
        if (content.length > NEWS_CONFIG.LONG_NEWS_THRESHOLD) {
            const cutLength = NEWS_CONFIG.LONG_NEWS_THRESHOLD - 100;
            content = `${content.slice(0, cutLength)}......\n(字数过多 剩余${content.length - cutLength}字请看详情)`;
        }

        return content;
    }

    /**
     * 提取图片URL
     * @param content - HTML内容
     * @returns 图片URL数组
     */
    private extractImages(content: string): string[] {
        if (!content) return [];

        const imgRegex = /<img.*?src=['"](.*?)['"]/gi;
        return Array.from(content.matchAll(imgRegex), match => match[1])
            .filter((url): url is string => !!url);
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
     * 获取指定分类的新闻
     * @param category - RSS新闻分类
     * @returns 筛选后的新闻项
     */
    async getNews(category: keyof typeof RSS_SOURCES): Promise<NewsItem | null> {
        const config = RSS_SOURCES[category];
        if (!config) return null;

        const sources = config.sources;

        // 首先尝试使用AI选择器进行智能筛选
        let selectedNews = await this.aiSelector.selectNews(category, sources);

        // 如果AI筛选失败，回退到传统算法筛选
        if (!selectedNews) {
            log.info('Falling back to algorithm selector');
            selectedNews = await this.algorithmSelector.selectNews(category, sources);
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
     * 从所有分类获取新闻
     * @returns 最佳新闻项或null
     */
    async getAllCategoriesNews(): Promise<NewsItem | null> {
        // 首先尝试使用AI选择器从所有分类获取新闻
        let selectedNews = await this.aiSelector.selectNewsFromAllCategories();

        // 如果AI筛选失败，回退到传统单类别筛选方式
        if (!selectedNews) {
            log.info('Falling back to algorithm selector for each category');
            // 随机选择一个分类
            const categories = Object.keys(RSS_SOURCES) as Array<keyof typeof RSS_SOURCES>;
            const randomCategory = categories[Math.floor(Math.random() * categories.length)];
            
            // 获取该分类的新闻
            selectedNews = await this.getNews(randomCategory as keyof typeof RSS_SOURCES);
        }

        // 如果成功获取新闻，更新追踪信息
        if (selectedNews) {
            await this.updateNewsTracking(selectedNews);
        }

        return selectedNews;
    }

    /**
     * 检查RSS源状态
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
            
            // 获取RSS源数据
            const feed = await this.fetchFeed(url, 1 as RetryCount);
            
            // 计算响应时间
            const responseTime = Date.now() - startTime;
            
            // 安全处理所有可能的undefined值
            let sourceName = "未知源";
            if (feed && feed.channel) {
                if (feed.channel.title) {
                    sourceName = feed.channel.title;
                } else {
                    const parts = url.split('/');
                    const lastPart = parts[parts.length - 1];
                    if (lastPart && lastPart.length > 0) {
                        sourceName = lastPart;
                    }
                }
            }
            
            // 安全处理条目数据
            const items = feed && feed.channel && feed.channel.items ? feed.channel.items : [];
            let oldestDate: Date | undefined;
            let newestDate: Date | undefined;
            
            if (items.length > 0) {
                const lastItem = items[items.length - 1];
                if (lastItem && lastItem.pubDate) {
                    oldestDate = new Date(lastItem.pubDate);
                }
                
                const firstItem = items[0];
                if (firstItem && firstItem.pubDate) {
                    newestDate = new Date(firstItem.pubDate);
                }
            }
            
            return {
                status: 'ok',
                url,
                itemCount: items.length,
                oldestItem: oldestDate ? oldestDate.toLocaleString() : 'N/A',
                newestItem: newestDate ? newestDate.toLocaleString() : 'N/A',
                responseTime: `${responseTime}ms`,
                name: sourceName
            };
        } catch (error) {
            return {
                status: 'error',
                url,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * 获取RSS源内容
     * @param url - RSS源URL
     * @param retries - 重试次数
     * @returns RSS源数据
     */
    private async fetchFeed(url: string, retries: RetryCount = NEWS_CONFIG.MAX_RETRIES): Promise<RSSFeed> {
        // 尝试从缓存获取
        const cachedFeed = this.cache.get(url);
        if (this.cache.isValid(url) && cachedFeed) {
            return cachedFeed;
        }

        try {
            // 获取新数据
            const feed = await fetchRSS(url);

            // 更新缓存
            this.cache.set(url, feed);

            return feed;
        } catch (error) {
            // 重试机制
            if (retries > 1) {
                await new Promise(resolve => setTimeout(resolve, NEWS_CONFIG.DEFAULT_RETRY_DELAY));
                return this.fetchFeed(url, (retries - 1) as RetryCount);
            }
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
            name: 'news',
            description: '获取最新新闻',
            aliases: ['rss'],
            async handler(ctx: CommandContext) {
                if (!serviceInstance) {
                    await ctx.message.replyText("RSS服务未初始化");
                    return;
                }
                await serviceInstance.fetchAndSendNews(ctx.client, ctx.chatId, ctx.message);
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

                const waitMsg = await ctx.message.replyText("⚙️ 正在检查RSS状态...");
                try {
                    const status = await serviceInstance.getServiceStatus();
                    const response = ["📊 RSS 服务状态\n"];

                    // 添加缓存信息
                    response.push("📦 缓存信息:");
                    response.push(`- 缓存源数量: ${status.cacheInfo.size}`);
                    response.push(`- 已发送条目: ${status.cacheInfo.sentItems}`);
                    response.push(`- 缓存时间: ${status.cacheInfo.cacheTimeout}\n`);

                    // 添加各分类源状态
                    for (const [category, info] of Object.entries(status.categories)) {
                        response.push(`📰 ${category}:`);
                        response.push(`优先级: ${info.priority} | 冷却: ${info.cooldown}\n`);

                        info.sources.forEach(source => {
                            if (source.status === 'ok') {
                                response.push(`✅ ${source.name}`);
                                response.push(`- 条目数量: ${source.itemCount}`);
                                response.push(`- 最新更新: ${source.newestItem}`);
                                response.push(`- 响应时间: ${source.responseTime}\n`);
                            } else {
                                response.push(`❌ ${source.url}`);
                                response.push(`- 错误: ${source.error}\n`);
                            }
                        });
                    }

                    await ctx.client.editMessage({
                        message: waitMsg,
                        text: response.join('\n')
                    });
                } catch (error) {
                    await ctx.client.editMessage({
                        message: waitMsg,
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
                serviceInstance?.fetchAndSendNews(client, chatId, null);
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