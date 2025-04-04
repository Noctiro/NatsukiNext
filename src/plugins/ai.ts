import { html, TelegramClient } from '@mtcute/bun';
import { getHighQualityAI, getFastAI } from '../ai/AiManager';
import type { BotPlugin, CommandContext, EventContext, MessageEventContext } from '../features';
import {
    search,
    OrganicResult,
    TranslateResult,
    DictionaryResult,
    TimeResult,
    CurrencyResult
} from 'google-sr';
import { slowModeState } from '../ai/provider/BaseProvider';
import DynamicMap from '../utils/DynamicMap';
import { Cron } from 'croner';
import { cleanHTML } from '../utils/HtmlHelper';

/**
 * AI插件 - 模块化结构设计
 * 
 * 主要类:
 * - AIPlugin: 插件主体，处理命令和事件
 * - UserManager: 用户管理，包括权限和使用次数
 * - SearchService: 搜索功能封装
 * - KeywordGenerator: 关键词生成
 * - ResponseFormatter: 响应格式化
 * - MessageManager: 消息管理
 */

// 状态消息图标
const STATUS_EMOJIS = {
    analyzing: '🔍',
    searching: '🌐',
    thinking: '🧠',
    processing: '⚙️',
    error: '❌',
    done: '✅',
    warning: '⚠️',
    cached: '⚡'
};

/**
 * 用户管理类 - 处理用户权限和使用限制
 */
class UserManager {
    private userCount: DynamicMap;

    constructor(defaultUserLimit: number = 8) {
        this.userCount = new DynamicMap(defaultUserLimit);
    }

    /**
     * 重置所有用户的每日AI使用次数
     */
    checkAndResetDailyLimits(): void {
        plugin.logger?.info('开始重置所有用户的AI使用次数');

        // 获取所有用户ID
        const userIds = Array.from(this.userCount.keys());

        // 重置每个用户的使用次数为默认值
        for (const userId of userIds) {
            this.userCount.set(userId, this.userCount.getDefaultData());
        }

        plugin.logger?.info(`已重置${userIds.length}个用户的AI使用次数`);
    }

    /**
     * 获取用户当前剩余的AI使用次数
     */
    async getRemainingCount(userId: number): Promise<number> {
        const count = await this.userCount.get(userId);
        return Math.max(0, Math.floor(count * 10) / 10); // 保留一位小数
    }

    async hasUnlimitedAccess(ctx: CommandContext): Promise<boolean> {
        return ctx.hasPermission('ai.unlimited');
    }

    async checkUserLimit(ctx: CommandContext): Promise<{ canUse: boolean, message?: string }> {
        const userId = ctx.message.sender.id;
        const hasUnlimitedAccess = await this.hasUnlimitedAccess(ctx);

        if (hasUnlimitedAccess) {
            return { canUse: true };
        }

        const count = await this.userCount.get(userId);
        if (count < 1) {
            return {
                canUse: false,
                message: `${STATUS_EMOJIS.warning} <b>AI使用次数已耗尽</b><br><br>💡: 在群里保持活跃，每次有效消息能增加AI使用次数`
            };
        }

        // 减少使用次数
        this.userCount.set(userId, count - 1);
        return { canUse: true };
    }

    incrementUsage(userId: number, messageLength?: number): void {
        // 不适用于无限制用户
        this.userCount.get(userId).then(count => {
            // 修复类型问题：确保count是数字
            const numericCount = typeof count === 'number' ? count : 0;

            // 计算基于消息长度的增长值
            let increment = 0.35; // 基础增长值

            // 如果提供了消息长度，根据消息长度线性增加
            if (messageLength && messageLength > 5) {
                // 计算额外增加值（最多额外增加0.6，使总和达到0.95）
                const lengthFactor = Math.min(1, (messageLength - 5) / 300); // 300字为最大增长因子
                const additionalIncrement = 0.6 * lengthFactor;
                increment += additionalIncrement;
            }

            // 设置新值，限制最大值为默认次数的两倍
            this.userCount.set(userId, Math.min(this.userCount.getDefaultData() * 2, numericCount + increment));
        }).catch(err => {
            plugin.logger?.error(`增加用户[${userId}]使用次数失败: ${err}`);
        });
    }

    /**
     * 获取默认的AI使用次数限制
     */
    getDefaultData(): number {
        return this.userCount.getDefaultData();
    }
}

/**
 * 消息管理类 - 处理消息更新和状态显示
 */
class MessageManager {
    private lastGlobalUpdateTime: number = 0;
    private pendingUpdates = new Map<string, { ctx: CommandContext, chatId: string | number, messageId: number, text: string }>();
    private lastMessageContents = new Map<string, string>();
    private readonly updateInterval: number;

    constructor(updateInterval: number = 5000) {
        this.updateInterval = updateInterval;
        setInterval(() => this.executeUpdates(), this.updateInterval);
    }

    async throttledEditMessage(ctx: CommandContext, chatId: string | number, messageId: number, text: string): Promise<void> {
        const key = `${chatId}:${messageId}`;

        // 检查内容是否与上次相同，如果相同则直接跳过
        if (this.isContentUnchanged(key, text)) {
            return;
        }

        // 记录待处理的更新
        this.pendingUpdates.set(key, { ctx, chatId, messageId, text });

        // 执行更新（如果符合时间间隔要求）
        await this.executeUpdates();
    }

    private isContentUnchanged(key: string, newContent: string): boolean {
        const lastContent = this.lastMessageContents.get(key);
        return lastContent === newContent;
    }

    private async executeUpdates(): Promise<void> {
        const now = Date.now();

        // 如果距离上次更新时间小于设定间隔，则跳过执行
        if (now - this.lastGlobalUpdateTime < this.updateInterval) {
            return;
        }

        // 更新全局最后更新时间
        this.lastGlobalUpdateTime = now;

        // 取出所有待处理的更新
        const updatesToProcess = new Map(this.pendingUpdates);
        this.pendingUpdates.clear();

        // 执行所有待处理的更新
        for (const [key, update] of updatesToProcess.entries()) {
            try {
                // 检查内容是否与上次相同，如果相同则跳过
                if (this.isContentUnchanged(key, update.text)) {
                    continue;
                }

                // 更新消息
                await update.ctx.client.editMessage({
                    chatId: update.chatId,
                    message: update.messageId,
                    text: html(update.text)
                });

                // 记录更新后的内容
                this.lastMessageContents.set(key, update.text);
            } catch (e) {
                plugin.logger?.info(update.text)
                plugin.logger?.error(`更新消息失败: ${e}`);
            }
        }
    }

    async updateMessageStatus(ctx: CommandContext, messageId: number, status: keyof typeof STATUS_EMOJIS, additionalText: string = ''): Promise<void> {
        // 获取格式化后的状态文本
        const text = this.formatStatusText(status, additionalText);

        // 清理可能存在的占位符
        const cleanText = this.cleanPlaceholders(text);

        // 检查状态消息是否变化
        const key = `${ctx.chatId}:${messageId}`;
        if (this.isContentUnchanged(key, cleanText)) return;

        try {
            await ctx.client.editMessage({
                chatId: ctx.chatId,
                message: messageId,
                text: html(cleanText)
            });

            // 更新成功后记录内容
            this.lastMessageContents.set(key, cleanText);
        } catch (e) {
            plugin.logger?.error(`更新状态消息失败: ${e}`);
        }
    }

    /**
     * 清理文本中的HTML占位符并修复HTML标签
     */
    private cleanPlaceholders(text: string): string {
        if (!text) return '';

        // 基本清理占位符
        let cleanedText = text
            .replace(/HTML_PLACEHOLDER_\d+/g, '')
            .replace(/HTML_TAG_\d+/g, '')
            .replace(/__HTML_TAG_\d+__/g, '')
            .replace(/HTML_PLACEHOLDER/g, '')
            .replace(/HTML_TAG/g, '')
            .replace(/__HTML_TAG__/g, '')
            .replace(/HTML[_-][A-Za-z]+[_-]?\d*/g, '');

        // 使用cleanHTML处理HTML标签
        return cleanHTML(cleanedText);
    }

    formatStatusText(status: keyof typeof STATUS_EMOJIS, additionalText: string = ''): string {
        const emoji = STATUS_EMOJIS[status];

        switch (status) {
            case 'thinking': return `${emoji} 思考中...`;
            case 'analyzing': return `${emoji} 正在分析您的问题...`;
            case 'searching': return `${emoji} 正在搜索: ${additionalText}`;
            case 'processing': return `${emoji} 分析搜索结果中...`;
            case 'cached': return `${emoji} 使用缓存数据: ${additionalText}`;
            default: return `${emoji} ${additionalText}`;
        }
    }
}

/**
 * 关键词生成类 - 处理搜索关键词的生成
 */
class KeywordGenerator {
    private static readonly SEARCH_KEYWORDS_GENERATION_PROMPT = `作为一名智能搜索优化助手，您的任务是深入理解用户的查询意图，并生成最精准、高效的搜索查询，以获取最相关的搜索结果。

当前时间：CURRENT_DATETIME

请分析以下用户问题，推理其核心需求，并生成 1-3 个最优搜索查询（每行一个），确保搜索结果精准全面：

"$USER_QUESTION$"

### 生成原则：
1. **理解用户意图**：
   - 判断用户是在寻找**事实性信息**、**深入研究**，还是**寻找特定网站或资源**。
   - 考虑用户可能的上下文需求，如时间范围、地域、行业术语等。
   
2. **精准搜索表达**：
   - 生成完整的搜索查询，而不是单独的关键词拼凑。
   - 使用自然语言短语，确保查询符合搜索引擎的最佳实践。
   - 结合**专业术语、权威来源**，避免过于宽泛的词汇。
   
3. **智能调整语言**：
   - **本地信息**（如天气、新闻、政府服务等）优先使用该地区的主要语言。
   - **国际性主题**（如科技、学术、经济、外交等）优先提供英文查询，并结合相关国家的语言。
   - **特定国家的政策、法律、文化等**，优先提供该国主要语言的查询。
   
4. **优化查询结构**：
   - **添加限定词**：使用"最新"、"官方"、"PDF"、"研究报告"等提高结果质量。
   - **结合高信赖来源**：可加入"site:gov"、"site:edu"、"Google Scholar"、"PubMed"等。
   - **时间筛选**：适当添加年份或"最近"类词汇，确保获取最新信息。

### 输出格式：
- 每行一个优化后的搜索查询，不添加编号或引号。
- 直接输出查询词，无需额外说明或注释。
- 查询应精炼、可执行，通常不超过 8 个单词。
- 不同语言的查询分行列出，避免冗余。`;

    /**
     * 生成搜索关键词
     */
    static async generateKeywords(aiModel: any, userQuestion: string): Promise<string> {
        try {
            // 获取当前时间和年份
            const currentDateTime = new Date().toLocaleString('zh-CN', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
            });

            // 使用提示词模板生成最终的提示词，替换所有动态值
            let prompt = this.SEARCH_KEYWORDS_GENERATION_PROMPT
                .replace('$USER_QUESTION$', userQuestion)
                .replace('CURRENT_DATETIME', currentDateTime);

            // 使用AI直接获取优化后的关键词
            const generatedKeywords = await aiModel.get(prompt, false);

            if (generatedKeywords && generatedKeywords.trim()) {
                const optimizedKeywords = generatedKeywords.trim();
                plugin.logger?.info(`生成搜索关键词: "${optimizedKeywords.replace(/\n/g, '; ')}"`);
                return optimizedKeywords;
            }

            throw new Error('AI返回的关键词为空');
        } catch (err) {
            plugin.logger?.warn(`对问题生成关键词失败，使用备用方法: ${err instanceof Error ? err.message : String(err)}`);
            return this.generateFallbackKeywords(userQuestion);
        }
    }

    /**
     * 备用关键词生成方法
     */
    static generateFallbackKeywords(userQuestion: string): string {
        // 简单地将问题分割成多个部分作为关键词
        const words = userQuestion
            .replace(/[.,?!;:"']/g, '')
            .split(/\s+/)
            .filter(word => word.length > 2)
            .slice(0, 5);

        // 如果分词后的关键词不足2个，则使用整个问题作为一个关键词
        if (words.length < 2) return userQuestion;

        // 限制只生成最多2个关键词短语
        const keywordPhrases = [];

        // 添加前3个词组合
        if (words.length >= 3) {
            keywordPhrases.push(words.slice(0, 3).join(' '));
        } else {
            keywordPhrases.push(words.join(' '));
        }

        // 如果有足够的词，添加后面的词组合（如果与第一个不同）
        if (words.length > 3) {
            const lastThree = words.slice(-3).join(' ');
            if (lastThree !== keywordPhrases[0]) {
                keywordPhrases.push(lastThree);
            }
        }

        // 限制最多返回3个关键词短语
        const limitedPhrases = keywordPhrases.slice(0, 3);

        plugin.logger?.info(`生成备用关键词: "${limitedPhrases.join('; ')}"`);
        return limitedPhrases.join('\n');
    }

    /**
     * 格式化搜索预览文本
     */
    static formatSearchPreview(searchKeywords: string): string {
        if (!searchKeywords || typeof searchKeywords !== 'string') {
            return "正在搜索...";
        }

        const keywordLines = searchKeywords.split('\n').filter(line => line.trim());
        if (keywordLines.length === 0) return "正在搜索...";

        // 使用通用函数格式化预览文本
        if (keywordLines.length > 1) {
            const firstKeyword = keywordLines[0] || '';
            const keywordPreview = this.truncateText(firstKeyword, 25, 22);
            return `${keywordPreview} 等${keywordLines.length}个关键词`;
        } else {
            const singleKeyword = keywordLines[0] || '';
            return this.truncateText(singleKeyword, 30, 27);
        }
    }

    /**
     * 文本截断辅助方法
     */
    static truncateText(text: string, maxLength: number, truncateAt: number): string {
        if (!text) return '';
        return text.length > maxLength ? text.slice(0, truncateAt) + '...' : text;
    }
}

/**
 * 搜索服务类 - 处理搜索功能和缓存
 */
class SearchService {
    private searchCache = new Map<string, { timestamp: number, results: any }>();
    private readonly cacheExpiry: number;

    constructor(cacheExpiryMinutes: number = 30) {
        this.cacheExpiry = cacheExpiryMinutes * 60 * 1000;
    }

    /**
     * 执行单个关键词的搜索
     */
    async performSearch(keyword: string): Promise<{ results: any }> {
        if (!keyword || typeof keyword !== 'string' || keyword.trim().length < 2) {
            return { results: null };
        }

        try {
            // 执行搜索
            const result = await search({
                query: keyword.trim(),
                resultTypes: [
                    DictionaryResult,
                    TimeResult,
                    CurrencyResult,
                    TranslateResult,
                    OrganicResult,
                ],
                strictSelector: true,
                requestConfig: {
                    params: {
                        safe: 'off',
                        num: 10  // 增加返回结果数量
                    }
                }
            });

            return { results: result };
        } catch (error) {
            plugin.logger?.error(`搜索 "${keyword}" 失败:`, error);
            return { results: null };
        }
    }

    /**
     * 执行批量搜索，处理多个关键词
     */
    async performBatchSearch(keywords: string): Promise<any[]> {
        if (!keywords || typeof keywords !== 'string') {
            plugin.logger?.warn('无效的搜索关键词格式');
            return [];
        }

        // 处理关键词：去重、过滤短词
        const keywordLines = keywords.split('\n')
            .map(line => line.trim())
            .filter(line => line && line.length >= 3)
            .filter((line, index, self) => self.indexOf(line) === index)
            .slice(0, 3); // 直接限制为最多3个关键词

        if (keywordLines.length === 0) {
            plugin.logger?.warn('没有找到有效的搜索关键词');
            return [];
        }

        plugin.logger?.info(`开始搜索，关键词数量: ${keywordLines.length}`);

        const results = [];
        let totalResults = 0;
        let highQualityResults = 0;

        // 尝试执行多个批次的搜索，确保获取足够结果
        let searchAttempts = 0;
        const MAX_SEARCH_ATTEMPTS = 2; // 最多尝试2轮搜索

        while (searchAttempts < MAX_SEARCH_ATTEMPTS) {
            searchAttempts++;

            // 第一轮使用原始关键词，第二轮使用备用关键词
            const currentKeywords: string[] = searchAttempts === 1 ?
                keywordLines :
                this.generateBackupSearchKeywords(keywordLines, 3 - results.length);

            if (searchAttempts > 1 && currentKeywords.length > 0) {
                plugin.logger?.info(`第${searchAttempts}轮搜索, 使用备用关键词: ${currentKeywords.join(', ')}`);
            }

            // 按顺序执行搜索，避免并行请求
            for (const keyword of currentKeywords) {
                const cacheKey = keyword.trim().toLowerCase();
                const cachedResult = this.searchCache.get(cacheKey);

                let searchResult;

                // 检查缓存或执行搜索
                if (cachedResult && (Date.now() - cachedResult.timestamp) < this.cacheExpiry) {
                    plugin.logger?.info(`使用缓存结果: ${keyword}`);
                    searchResult = cachedResult.results;
                } else {
                    try {
                        plugin.logger?.info(`执行搜索: ${keyword}`);
                        const result = await this.performSearch(keyword);
                        if (!result?.results) {
                            plugin.logger?.warn(`搜索 "${keyword}" 返回空结果`);
                            continue;
                        }

                        // 缓存新结果
                        this.searchCache.set(cacheKey, {
                            timestamp: Date.now(),
                            results: result.results
                        });

                        searchResult = result.results;
                    } catch (error) {
                        plugin.logger?.error(`搜索 "${keyword}" 失败:`, error);
                        continue;
                    }
                }

                // 更新结果计数
                let currentResultCount = 0;
                let hasValidResults = false;

                // 判断是否有有效结果
                if (Array.isArray(searchResult)) {
                    // 数组形式的结果
                    currentResultCount = searchResult.length;

                    if (currentResultCount > 0) {
                        hasValidResults = true;
                        totalResults += currentResultCount;
                        highQualityResults += searchResult.filter((res: any) =>
                            ResponseFormatter.getResultQualityScore(res) > 5).length;
                    }
                } else if (searchResult && typeof searchResult === 'object') {
                    // 对象形式的特殊结果
                    if (searchResult.dictionary || searchResult.translate ||
                        searchResult.time || searchResult.currency) {
                        hasValidResults = true;
                        currentResultCount = 1; // 特殊结果计为1条
                        totalResults += 1;
                    }
                }

                // 添加到结果列表
                results.push({
                    keyword,
                    results: searchResult,
                    hasResults: hasValidResults, // 使用检测到的有效结果标志
                    resultCount: currentResultCount
                });

                // 检查是否已获取足够结果
                if (totalResults >= 20 && highQualityResults >= 7) {
                    plugin.logger?.info(`已找到足够高质量结果(${highQualityResults}/${totalResults})，停止搜索`);
                    return results;
                }

                // 搜索间隔延迟
                if (currentKeywords.indexOf(keyword) < currentKeywords.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }

            // 检查是否已经有足够的结果
            if ((totalResults >= 10 && highQualityResults >= 3) || results.length >= 3) {
                break;
            }
        }

        plugin.logger?.info(`搜索完成 - 总计: ${results.length}个关键词, 结果: ${totalResults}, 高质量: ${highQualityResults}`);
        return results;
    }

    /**
     * 生成备用搜索关键词
     */
    private generateBackupSearchKeywords(originalKeywords: string[], count: number): string[] {
        if (originalKeywords.length === 0 || count <= 0) return [];

        // 从原始关键词中提取所有单词
        const allWords = originalKeywords.join(' ')
            .replace(/[.,?!;:"']/g, '')
            .split(/\s+/)
            .filter(word => word.length > 2);

        if (allWords.length <= 1) return [];

        // 生成新的关键词组合
        const backupKeywords = [];

        // 1. 如果有两个以上的词，尝试生成不同的组合
        if (allWords.length >= 3) {
            // 前两个词
            backupKeywords.push(allWords.slice(0, 2).join(' '));

            // 最后两个词
            backupKeywords.push(allWords.slice(-2).join(' '));

            // 第一个和最后一个
            if (allWords.length >= 4) {
                backupKeywords.push(`${allWords[0]} ${allWords[allWords.length - 1]}`);
            }
        } else if (allWords.length === 2) {
            // 只有两个词，使用这两个词
            backupKeywords.push(allWords.join(' '));
        }

        // 过滤掉与原始关键词相同的组合
        const newKeywords = backupKeywords
            .filter(kw => !originalKeywords.includes(kw))
            .slice(0, count);

        return newKeywords;
    }
}

/**
 * 响应格式化类 - 处理搜索结果和AI响应的格式化
 */
class ResponseFormatter {
    /**
     * 将Markdown格式转换为HTML格式，并确保只使用允许的HTML标签
     */
    static markdownToHtml(text: string): string {
        if (!text) return '';

        try {
            // 应用Markdown转换规则，符合 @mtcute/html-parser 支持的实体
            const markdownRules = [
                // 基本格式
                { pattern: /^#+ (.+)$/gm, replacement: '<b>$1</b>' },             // 标题转为粗体
                { pattern: /\*\*(.+?)\*\*/g, replacement: '<b>$1</b>' },         // 粗体
                { pattern: /\*(.+?)\*/g, replacement: '<i>$1</i>' },             // 斜体
                { pattern: /__(.+?)__/g, replacement: '<u>$1</u>' },             // 下划线
                { pattern: /~~(.+?)~~/g, replacement: '<s>$1</s>' },             // 删除线
                { pattern: /`([^`]+)`/g, replacement: '<code>$1</code>' },       // 行内代码
                { pattern: /\[(.+?)\]\((.+?)\)/g, replacement: '<a href="$2">$1</a>' }, // 链接
                { pattern: /^- (.+)$/gm, replacement: '• $1' },                   // 无序列表
                { pattern: /^\d+\. (.+)$/gm, replacement: '• $1' },               // 有序列表
                { pattern: /^---+$/gm, replacement: '<br>' },                    // 分隔线转为换行
                { pattern: /^> (.+)$/gm, replacement: '❝ <i>$1</i>' }            // 引用转为斜体带引号
            ];

            // 处理代码块（使用 <pre> 标签）
            let htmlText = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, language, code) => {
                return language ? `<pre language="${language}">${code}</pre>` : `<pre>${code}</pre>`;
            });

            // 应用转换规则
            for (const rule of markdownRules) {
                htmlText = htmlText.replace(rule.pattern, rule.replacement);
            }

            // 处理换行，但根据AI实际情况还是会忍不住换行，所以注释掉这段(之前使用deepseek r1有这个问题，但是现在用的gemini 2.5 pro 没有这个问题)
            htmlText = htmlText
                .replace(/\n\n+/g, '<br><br>')  // 多个连续换行转为两个 <br>
                .replace(/\n/g, '<br>');        // 单个换行转为 <br>

            // 注意：不在这里调用cleanHTML，而是将HTML文本返回给调用者
            // 由调用者决定在最终组装完所有内容后一次性进行清理，避免多次清理
            return htmlText;
        } catch (e) {
            plugin.logger?.error(`Markdown转HTML出错: ${e}`);
            // 出错时返回原始文本，让调用者处理清理
            return text;
        }
    }

    /**
     * 格式化AI响应
     */
    static formatAIResponse(content: string, thinking: string): string {
        let displayText = "";

        // 添加思考过程（如果有）
        if (thinking && thinking.trim()) {
            // 先不对思考过程单独清理，保存原始转换后的内容
            const formattedThinking = this.markdownToHtml(thinking.trim()).replace(/\n/g, '<br>'); // 换行转<br>
            displayText += `<blockquote collapsible><b>💭 思考过程:</b><br><br>${formattedThinking}</blockquote><br><br>`;
        }

        // 处理内容为空或生成中的情况
        if (!content || !content.trim()) {
            // 根据思考过程判断状态
            if (thinking && thinking.trim()) {
                // 如果有思考过程，说明 AI 正在工作，只是还没有生成完整回复
                displayText += `${STATUS_EMOJIS.processing} AI正在思考中，即将生成回复...`;
            } else {
                // 如果没有思考过程，可能是正在启动或遇到了问题
                displayText += `${STATUS_EMOJIS.warning} AI尚未生成内容，可能正在初始化或遇到了问题。如果长时间无响应，可以尝试重新提问。`;
            }
            return displayText;
        }

        // 处理内容过短的情况（可能是生成中）
        if (content.trim().length < 20 && !content.includes('。') && !content.includes('.')) {
            displayText += this.markdownToHtml(content);
            displayText += `<br><br>${STATUS_EMOJIS.processing} AI正在继续生成内容...`;
            return displayText;
        }

        // 添加正文内容
        try {
            const formatContent = this.markdownToHtml(content).replace(/\n/g, ''); // 去除所有换行

            // 根据内容长度决定显示格式
            if (formatContent.length > 500 && !formatContent.includes('blockquote>')) {
                displayText += `✏️ 回答内容(共${formatContent.length}字，已自动收缩):<br><blockquote collapsible>${formatContent}</blockquote>`;
            } else {
                displayText += `✏️ 回答内容(共${formatContent.length}字):<br>${formatContent}`;
            }
        } catch (e) {
            plugin.logger?.error(`转换Markdown内容时出错: ${e}`);
            displayText += content; // 回退到原始内容
        }

        // 在最终输出前进行一次性清理，避免多次清理操作
        return cleanHTML(displayText);
    }

    /**
     * 计算搜索结果质量分数
     */
    static getResultQualityScore(result: any): number {
        if (!result) return 0;

        const { title = '', link = '', snippet = '' } = result;
        let score = 0;

        // 网站域名权威性评分
        score += this.getDomainAuthorityScore(link);

        // 内容类型评分
        score += this.getContentTypeScore(title, link);

        // 摘要质量评分
        score += this.getSnippetQualityScore(snippet);

        // 时效性评分
        score += this.getTimelinessScore(snippet);

        return score;
    }

    /**
     * 评估域名权威性
     */
    private static getDomainAuthorityScore(link: string): number {
        if (!link) return 0;

        // 政府和教育网站通常最权威
        if (link.includes('.gov') || link.includes('.edu') ||
            link.includes('.gov.cn') || link.includes('.edu.cn')) {
            return 6;
        }

        // 组织网站通常也比较权威
        if (link.includes('.org') || link.includes('.org.cn')) {
            return 4;
        }

        // 知名网站
        if (this.checkTopDomains(link)) {
            return 3;
        }

        return 0;
    }

    /**
     * 评估内容类型
     */
    private static getContentTypeScore(title: string, link: string): number {
        if (!title && !link) return 0;

        // 百科类网站
        if (link.includes('wikipedia') || link.includes('baike.baidu') ||
            link.includes('wiki') || link.includes('encyclopedia')) {
            return 5;
        }

        // 官方内容
        if (title.includes('官方') || title.includes('官网') ||
            title.includes('Official') || title.includes('official') ||
            link.includes('official')) {
            return 4;
        }

        // 教程和指南
        if (title.includes('指南') || title.includes('教程') ||
            title.includes('文档') || title.includes('手册') ||
            title.includes('Guide') || title.includes('guide') ||
            title.includes('Tutorial') || title.includes('tutorial') ||
            title.includes('Doc') || title.includes('document') ||
            title.includes('Manual') || title.includes('handbook')) {
            return 3;
        }

        return 0;
    }

    /**
     * 评估摘要质量
     */
    private static getSnippetQualityScore(snippet: string): number {
        if (!snippet) return 0;
        let score = 0;

        // 摘要长度
        if (snippet.length > 150) {
            score += 2;
        } else if (snippet.length > 100) {
            score += 1;
        }

        // 关键信息指标 - 中英文关键词
        const infoTerms = [
            // 中文关键信息指标
            '研究', '数据', '报告', '统计', '分析', '调查', '发布', '官方数据',
            '来源', '权威', '专业', '引用', '科学', '实验', '结论', '证据',

            // 英文关键信息指标
            'research', 'data', 'report', 'statistics', 'analysis', 'survey',
            'source', 'authority', 'professional', 'citation', 'science',
            'experiment', 'conclusion', 'evidence', 'published', 'study'
        ];

        const infoCount = infoTerms.filter(term => snippet.includes(term)).length;
        score += Math.min(infoCount, 3);

        return score;
    }

    /**
     * 评估时效性
     */
    private static getTimelinessScore(snippet: string): number {
        if (!snippet) return 0;

        // 检查包含的年份，偏好最近内容
        const yearMatches = snippet.match(/20[0-9]{2}/g) || [];
        if (!yearMatches.length) return 0;

        const currentYear = new Date().getFullYear();
        const years = yearMatches
            .map(y => parseInt(y))
            .filter(y => y <= currentYear);

        if (!years.length) return 0;

        const mostRecentYear = Math.max(...years);

        // 为最近的内容加分
        if (mostRecentYear >= currentYear - 1) {
            return 3; // 非常新的内容
        } else if (mostRecentYear >= currentYear - 3) {
            return 2; // 较新的内容
        } else if (mostRecentYear >= currentYear - 5) {
            return 1; // 一般新的内容
        }

        return 0;
    }

    /**
     * 检查是否为知名域名
     */
    private static checkTopDomains(link: string): boolean {
        // 扩展后的高质量域名列表，包括国际和中文网站
        const topDomains = [
            // 开发和技术
            'github.com', 'stackoverflow.com', 'gitlab.com', 'gitee.com',
            'developer.mozilla.org', 'docs.microsoft.com', 'developer.android.com',
            'cloud.google.com', 'aws.amazon.com', 'azure.microsoft.com',

            // 技术社区
            'medium.com', 'dev.to', 'hashnode.com',
            'zhihu.com', 'csdn.net', 'juejin.cn', 'segmentfault.com', 'oschina.net',
            'freecodecamp.org', 'leetcode.com', 'leetcode.cn',

            // 科技媒体
            '36kr.com', 'techcrunch.com', 'wired.com', 'engadget.com',
            'huxiu.com', 'sspai.com', 'ithome.com', 'cnbeta.com', 'tmtpost.com',

            // AI相关
            'openai.com', 'anthropic.com', 'huggingface.co', 'deepmind.com',
            'pytorch.org', 'tensorflow.org', 'jiqizhixin.com', 'paperswithcode.com',

            // 大型科技公司
            'microsoft.com', 'apple.com', 'google.com', 'amazon.com',
            'meta.com', 'facebook.com', 'alibaba.com', 'tencent.com', 'baidu.com',
            'huawei.com', 'lenovo.com', 'xiaomi.com', 'jd.com',

            // 编程语言和框架
            'python.org', 'rust-lang.org', 'golang.org', 'ruby-lang.org',
            'reactjs.org', 'vuejs.org', 'angular.io', 'nodejs.org', 'php.net',

            // 知识库和学术网站
            'wikipedia.org', 'baike.baidu.com', 'arxiv.org', 'nature.com',
            'scholar.google.com', 'researchgate.net', 'sciencedirect.com',
            'cnki.net', 'wanfangdata.com.cn', 'ncbi.nlm.nih.gov', 'ieee.org',

            // 新闻媒体
            'nytimes.com', 'theguardian.com', 'bbc.com', 'cnn.com',
            'reuters.com', 'people.com.cn', 'xinhuanet.com', 'cctv.com',
            'caixin.com', 'ft.com', 'economist.com'
        ];

        return topDomains.some(domain => link.includes(domain));
    }
}

/**
 * 搜索结果格式化类 - 专门处理搜索结果的格式化
 */
class SearchResultFormatter {
    /**
     * 格式化搜索结果
     */
    static formatSearchResults(searchResultsArray: any[]): string {
        // 校验输入
        if (!searchResultsArray?.length) return '';

        plugin.logger?.info(`开始格式化搜索结果，共 ${searchResultsArray.length} 个查询结果`);

        // 筛选有效结果
        const validResults = searchResultsArray.filter(item => {
            // 检查结果是否存在
            const hasResults = !!item?.results;
            if (!hasResults) {
                plugin.logger?.warn(`搜索结果项缺少 results 字段`);
            }
            return hasResults;
        });

        if (!validResults.length) {
            plugin.logger?.warn(`没有找到有效的搜索结果`);
            return '';
        }

        plugin.logger?.info(`有效的搜索结果: ${validResults.length}/${searchResultsArray.length}`);

        // 准备结果容器
        let specialOutput = "";
        const allSearchResults: Array<{ result: any, quality: number }> = [];
        const processedLinks = new Set<string>();

        // 第一步：收集所有结果和特殊结果
        for (const item of validResults) {
            const results = item.results;

            // 处理特殊结果
            const specialText = this.processSpecialResults(results, '');
            if (specialText) {
                plugin.logger?.info(`发现特殊结果类型: ${specialText.split('\n')[0]}...`);
                specialOutput += specialText + '\n\n';
            }

            // 处理搜索结果
            if (Array.isArray(results)) {
                // 收集有效结果并计算质量分数
                for (const result of results) {
                    if (result && (result.title || result.snippet || result.link)) {
                        allSearchResults.push({
                            result,
                            quality: ResponseFormatter.getResultQualityScore(result)
                        });
                    }
                }
            } else if (results?.organic && Array.isArray(results.organic)) {
                // 兼容旧格式：结果在 organic 数组中
                for (const organicResult of results.organic) {
                    if (organicResult && (organicResult.title || organicResult.snippet || organicResult.link)) {
                        allSearchResults.push({
                            result: organicResult,
                            quality: ResponseFormatter.getResultQualityScore(organicResult)
                        });
                    }
                }
            } else if (results?.json?.organic && Array.isArray(results.json.organic)) {
                // 兼容另一种格式：结果在 json.organic 中
                for (const organicResult of results.json.organic) {
                    if (organicResult && (organicResult.title || organicResult.snippet || organicResult.link)) {
                        allSearchResults.push({
                            result: organicResult,
                            quality: ResponseFormatter.getResultQualityScore(organicResult)
                        });
                    }
                }
            }
        }

        plugin.logger?.info(`收集了 ${allSearchResults.length} 个搜索结果项`);

        // 第二步：去重并排序结果
        allSearchResults.sort((a, b) => b.quality - a.quality);

        const uniqueResults = [];
        for (const item of allSearchResults) {
            const link = item.result.link || item.result.url;
            if (!link || !processedLinks.has(link)) {
                if (link) processedLinks.add(link);
                uniqueResults.push(item);
            }
        }

        plugin.logger?.info(`去重后剩余 ${uniqueResults.length} 个搜索结果项`);

        // 第三步：如果没有找到有效结果，创建备用结果
        if (!uniqueResults.length && !specialOutput) {
            plugin.logger?.warn(`没有有效结果和特殊结果，尝试创建备用结果`);
            return this.createBackupResults(searchResultsArray, 5) || '';
        }

        // 第四步：构建输出内容
        let output = specialOutput;

        // 处理有机搜索结果
        if (uniqueResults.length) {
            // 选择结果
            const highQualityResults = uniqueResults.filter(item => item.quality > 5);
            const lowQualityResults = uniqueResults.filter(item => item.quality <= 5);

            plugin.logger?.info(`高质量结果: ${highQualityResults.length}, 低质量结果: ${lowQualityResults.length}`);

            // 高质量结果优先，但如果总结果数不超过5条，则全部保留
            let selectedResults: typeof uniqueResults = [];

            if (uniqueResults.length <= 5) {
                // 结果总数不超过5条，全部保留
                selectedResults = [...uniqueResults];
            } else {
                // 结果总数超过5条，优先选择高质量结果
                selectedResults = [...highQualityResults];

                // 如果高质量结果不足5条，添加低质量结果
                if (selectedResults.length < 5) {
                    const additionalNeeded = Math.min(5 - selectedResults.length, lowQualityResults.length);
                    selectedResults = [...selectedResults, ...lowQualityResults.slice(0, additionalNeeded)];
                }
            }

            // 如果结果依然少于5条且有备用结果，补充备用结果
            if (selectedResults.length < 5) {
                // 格式化现有结果
                let resultIndex = 1;
                selectedResults.forEach((item) => {
                    output += `[结果 ${resultIndex++}] `;
                    output += this.formatSearchResultItem(item.result);
                });

                // 补充备用结果
                const backupOutput = this.createBackupResults(searchResultsArray, 5 - selectedResults.length);
                if (backupOutput) {
                    output += backupOutput;
                }
            } else {
                // 限制最多12条结果
                selectedResults = selectedResults.slice(0, 12);

                // 格式化结果
                selectedResults.forEach((item, index) => {
                    output += `[结果 ${index + 1}] -----\n`;
                    output += this.formatSearchResultItem(item.result);
                });

                // 添加质量提示（如果全是低质量结果）
                if (highQualityResults.length === 0 && selectedResults.length > 0) {
                    output += `\n⚠️ 注意：搜索结果质量不高，信息可能不够准确或不够全面。\n`;
                }
            }

            // 记录结果数量
            const resultCount = (output.match(/\[结果 \d+\]/g) || []).length;
            plugin.logger?.info(`搜索结果格式化：输出${resultCount}个结果，包括${Math.min(highQualityResults.length, selectedResults.length)}个高质量结果`);
        } else if (specialOutput) {
            // 只有特殊结果，无需添加占位结果
            const specialResultCount = specialOutput.split('\n\n').filter(s => s.trim()).length;
            plugin.logger?.info(`只有${specialResultCount}个特殊结果`);
        }

        return output;
    }

    /**
     * 处理特殊结果类型（字典、翻译、时间等）
     */
    private static processSpecialResults(results: any, initialText: string = ''): string {
        if (!results) return initialText;

        const output: string[] = [];

        try {
            // 处理数组类型结果
            if (Array.isArray(results)) {
                for (const result of results) {
                    if (!result) continue;
                    this.extractSpecialResult(result, output);
                }
            }
            // 处理对象类型结果
            else if (typeof results === 'object') {
                this.extractSpecialResult(results, output);
            }

            return output.length > 0 ? output.join('\n') : initialText;
        } catch (e) {
            plugin.logger?.error(`处理特殊结果类型时出错: ${e}`);
            return initialText;
        }
    }

    /**
     * 从结果对象中提取特殊结果
     */
    private static extractSpecialResult(result: any, output: string[]): void {
        // 字典解释
        if (result.type === 'dictionary' || result.dictionary) {
            const dictionary = result.dictionary || result;
            const term = dictionary.term || result.term || '未知术语';
            const definition = dictionary.definition || result.definition || '无定义';
            output.push(`📚 字典解释: ${term} - ${definition}`);
        }
        // 翻译结果
        else if (result.type === 'translate' || result.translate) {
            const translate = result.translate || result;
            const source = translate.source || result.source || '未知';
            const target = translate.target || result.target || '未知';
            const sourceText = translate.sourceText || result.sourceText || translate.source_text || result.source_text || '无原文';
            const targetText = translate.targetText || result.targetText || translate.target_text || result.target_text || '无译文';

            output.push(`🌐 翻译结果: ${source} → ${target}`);
            output.push(`原文: ${sourceText}`);
            output.push(`译文: ${targetText}`);
        }
        // 时间信息
        else if (result.type === 'time' || result.time) {
            const time = result.time || result;
            const timeDisplay = time.display || time.time_display || result.display || '未知时间';
            output.push(`⏰ 时间信息: ${timeDisplay}`);
        }
        // 货币转换
        else if (result.type === 'currency' || result.currency) {
            const currency = result.currency || result;
            const fromAmount = currency.fromAmount || currency.from_amount || result.fromAmount || result.from_amount || '?';
            const fromCode = currency.fromCode || currency.from_code || result.fromCode || result.from_code || '?';
            const toAmount = currency.toAmount || currency.to_amount || result.toAmount || result.to_amount || '?';
            const toCode = currency.toCode || currency.to_code || result.toCode || result.to_code || '?';

            output.push(`💱 货币转换: ${fromAmount} ${fromCode} = ${toAmount} ${toCode}`);
        }
        // 天气信息
        else if (result.type === 'weather' || result.weather) {
            const weather = result.weather || result;
            const location = weather.location || result.location || '未知地点';
            const condition = weather.condition || result.condition || '未知天气';
            const temperature = weather.temperature || result.temperature || '';

            output.push(`🌤️ 天气信息: ${location} - ${condition}${temperature ? ` ${temperature}` : ''}`);
        }
        // 处理纯对象中的特殊字段
        else {
            // 检查是否直接包含字典、翻译等字段
            if (result.term && result.definition) {
                output.push(`📚 字典解释: ${result.term} - ${result.definition}`);
            }

            if (result.source && result.target &&
                (result.sourceText || result.source_text) &&
                (result.targetText || result.target_text)) {
                const sourceText = result.sourceText || result.source_text;
                const targetText = result.targetText || result.target_text;

                output.push(`🌐 翻译结果: ${result.source} → ${result.target}`);
                output.push(`原文: ${sourceText}`);
                output.push(`译文: ${targetText}`);
            }

            if (result.display && result.type === 'time') {
                output.push(`⏰ 时间信息: ${result.display}`);
            }

            if ((result.fromAmount || result.from_amount) &&
                (result.fromCode || result.from_code) &&
                (result.toAmount || result.to_amount) &&
                (result.toCode || result.to_code)) {

                const fromAmount = result.fromAmount || result.from_amount;
                const fromCode = result.fromCode || result.from_code;
                const toAmount = result.toAmount || result.to_amount;
                const toCode = result.toCode || result.to_code;

                output.push(`💱 货币转换: ${fromAmount} ${fromCode} = ${toAmount} ${toCode}`);
            }

            if (result.location && result.condition && result.type === 'weather') {
                const temperature = result.temperature || '';
                output.push(`🌤️ 天气信息: ${result.location} - ${result.condition}${temperature ? ` ${temperature}` : ''}`);
            }
        }
    }

    /**
     * 格式化单个搜索结果项
     */
    private static formatSearchResultItem(searchResult: any): string {
        if (!searchResult) return '';

        try {
            // 提取基础字段
            const title = searchResult.title || searchResult.name || '(无标题)';
            const link = searchResult.link || searchResult.url || '';

            // 获取摘要内容
            let snippet = searchResult.snippet || searchResult.description || searchResult.content || '';
            if (!snippet) {
                // 尝试提取备用摘要
                snippet = this.extractAlternativeSnippet(searchResult) || '(无摘要)';
            } else if (snippet.length > 250) {
                // 智能截断长摘要
                const endPos = snippet.substr(0, 300).lastIndexOf('。');
                snippet = endPos > 200
                    ? snippet.substr(0, endPos + 1) + '...'
                    : snippet.substr(0, 297) + '...';
            }

            // 拼接结果文本
            let resultText = `标题: ${title}\n`;
            if (link) resultText += `链接: ${link}\n`;
            resultText += `内容摘要: ${snippet}\n`;

            // 添加相关链接（如果有）
            if (Array.isArray(searchResult.sitelinks) && searchResult.sitelinks.length > 0) {
                const linkTitles = searchResult.sitelinks
                    .filter(Boolean)
                    .map((link: any) => link.title || "(无标题)")
                    .filter(Boolean)
                    .join(', ');

                if (linkTitles) {
                    resultText += `相关链接: ${linkTitles}\n`;
                }
            }

            resultText += '\n';
            return resultText;
        } catch (e) {
            plugin.logger?.error(`处理搜索结果项时出错: ${e}`);
            return '搜索结果处理出错\n\n';
        }
    }

    /**
     * 从搜索结果中提取备用摘要
     */
    private static extractAlternativeSnippet(result: any): string {
        if (!result || typeof result !== 'object') return '';

        // 常见的可能包含摘要的字段
        const simpleFields = ['abstract', 'summary', 'text', 'extract', 'description'];

        // 检查简单字段
        for (const field of simpleFields) {
            if (result[field] && typeof result[field] === 'string' && result[field].trim()) {
                return result[field].trim();
            }
        }

        // 检查嵌套字段 - pagemap
        if (result.pagemap?.metatags?.[0]) {
            const metatags = result.pagemap.metatags[0];
            const metaDescription = metatags['og:description'] || metatags['description'];
            if (metaDescription && typeof metaDescription === 'string') {
                return metaDescription.trim();
            }
        }

        return '';
    }

    /**
     * 创建备用搜索结果
     */
    private static createBackupResults(searchResultsArray: any[], requiredCount: number = 5): string {
        if (!searchResultsArray?.length) return "";

        // 收集所有可能有用的结果和特殊结果
        const allPotentialResults: any[] = [];
        const specialResults: string[] = [];

        // 处理所有结果项
        for (const resultItem of searchResultsArray) {
            if (!resultItem?.results) continue;

            // 处理特殊结果
            const specialText = this.processSpecialResults(resultItem.results, '');
            if (specialText) specialResults.push(specialText);

            // 收集标准搜索结果
            if (Array.isArray(resultItem.results)) {
                resultItem.results.forEach((result: any) => {
                    if (result && (result.title || result.snippet || result.link)) {
                        allPotentialResults.push(result);
                    }
                });
            }
        }

        // 如果没有任何结果，返回空字符串
        if (allPotentialResults.length === 0 && specialResults.length === 0) {
            return "";
        }

        // 构建结果字符串
        let backupOutput = "可能相关的搜索结果（仅供参考）:\n\n";

        // 添加特殊结果
        if (specialResults.length > 0) {
            backupOutput += specialResults.join('\n\n') + '\n\n';
        }

        // 如果没有标准结果，只返回特殊结果
        if (allPotentialResults.length === 0) {
            return specialResults.length > 0 ? backupOutput : "";
        }

        // 选择最相关的结果
        let selectedResults = allPotentialResults
            .sort((a, b) => {
                // 优先选择有标题和摘要的结果
                const aScore = (a.title ? 2 : 0) + (a.snippet ? 1 : 0);
                const bScore = (b.title ? 2 : 0) + (b.snippet ? 1 : 0);
                return bScore - aScore;
            })
            .slice(0, requiredCount);

        // 格式化结果
        selectedResults.forEach((result, index) => {
            backupOutput += `[结果 ${index + 1}] -----\n`;
            backupOutput += this.formatSearchResultItem(result);
        });

        // 添加提示信息
        backupOutput += "\n⚠️ 注意：这些搜索结果可能与问题相关性不高，请结合AI知识回答。\n";

        return backupOutput;
    }

    /**
     * 搜索结果摘要
     */
    static summarizeSearchResults(results: any[]): string {
        if (!results || !Array.isArray(results) || results.length === 0) {
            return "0个结果";
        }

        try {
            // 统计链接数和高质量结果数
            let totalLinks = 0;
            let highQualityCount = 0;
            const specialTypes = new Set<string>();

            // 处理所有结果
            for (const result of results) {
                // 跳过无效结果
                if (!result?.results) continue;

                // 处理搜索结果
                const searchResults = result.results;

                if (Array.isArray(searchResults)) {
                    // 处理每个搜索结果项
                    for (const item of searchResults) {
                        // 检查是否是标准搜索结果
                        if (item?.link) {
                            totalLinks++;
                            if (ResponseFormatter.getResultQualityScore(item) > 5) {
                                highQualityCount++;
                            }
                        }

                        // 检查是否是特殊结果
                        if (item?.type === 'dictionary') specialTypes.add("字典解释");
                        if (item?.type === 'translate') specialTypes.add("翻译结果");
                        if (item?.type === 'time') specialTypes.add("时间信息");
                        if (item?.type === 'currency') specialTypes.add("货币转换");
                    }
                } else if (typeof searchResults === 'object' && searchResults !== null) {
                    // 处理非数组形式的结果（向后兼容）

                    // 收集特殊结果类型
                    if (searchResults.dictionary) specialTypes.add("字典解释");
                    if (searchResults.translate) specialTypes.add("翻译结果");
                    if (searchResults.time) specialTypes.add("时间信息");
                    if (searchResults.currency) specialTypes.add("货币转换");
                }
            }

            // 构建摘要文本
            let summary = `${totalLinks}个相关网页`;

            // 添加高质量结果信息
            if (highQualityCount > 0) {
                summary += `(${highQualityCount}个高质量来源)`;
            }

            // 添加特殊结果类型
            if (specialTypes.size > 0) {
                summary += ` 和 ${Array.from(specialTypes).join("、")}`;
            }

            return summary;
        } catch (e) {
            plugin.logger?.error(`统计搜索结果时出错: ${e}`);
            return "搜索结果";
        }
    }
}

/**
 * AI提示词生成类 - 处理AI提示词的生成
 */
class AIPromptGenerator {
    /**
     * 生成综合AI提示词
     */
    static generateComprehensivePrompt(userQuestion: string, searchResults: string): string {
        // 获取当前时间
        const currentDateTime = new Date().toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        });

        // 安全处理输入
        const safeSearchResults = typeof searchResults === 'string' ? searchResults : '';
        const safeUserQuestion = typeof userQuestion === 'string' ? userQuestion : '请回答用户问题';

        // 检查搜索结果是否有效
        const hasResults = safeSearchResults && safeSearchResults.trim().length > 5;

        // 构建搜索结果部分
        let searchResultsSection = hasResults
            ? `系统自动搜索结果:\n\`\`\`\n${safeSearchResults}\n\`\`\`\n\n这些搜索结果由系统自动获取，不一定可靠。`
            : `系统自动搜索结果:\n\`\`\`\n未能获取到相关搜索结果。请基于您的知识库回答问题。\n\`\`\``;

        // 返回完整提示词
        return `问题：${safeUserQuestion}

当前时间：${currentDateTime}

请根据这些实际搜索结果和你的知识，提供一个全面、准确且直击问题核心的回答。

分析指南：
1. 将不同来源的信息进行对比和综合，形成全面的回答
2. 特别注意信息的时效性，优先使用最新的信息
3. 如果搜索结果中包含矛盾的信息，请指出这些矛盾并分析可能的原因
4. 确保内容的权威性，对官方来源的信息给予更高权重

回答格式要求（使用HTML标签）：
1. 给予明确、有条理的回答，重点突出，避免冗余
2. 使用<b>加粗</b>、<i>斜体</i>、<u>下划线</u>、<s>删除线</s>和<code>代码</code>标签
3. 使用<br>标签表示换行，<br><br>表示段落分隔
4. 适当添加表情符号，使回答更加生动
5. 使用<a href="链接">链接文本</a>格式添加链接
6. 列表项使用普通文本格式，前面添加"•"或"◦"符号
7. 可以使用<blockquote>标签创建引用块，对引用内容进行突出

注意：
- 不要使用Markdown格式（如**加粗**、*斜体*等），使用HTML标签替代
- 不要使用不支持的HTML标签（如<div>、<span>、<p>等）
- 不要使用HTML标题标签（如<h1>、<h2>等），使用<b>加粗文本</b>代替
- 支持嵌套标签但确保正确嵌套，如<b>粗体<i>斜体粗体</i></b>
- 必须使用<br>标签表示换行，不要使用句号来分隔句子代替换行，比如应该使用<br>来替换\\n
- 段落之间必须用<br><br>分隔，不要只依赖句号作为段落分隔

${searchResultsSection}

若搜索结果不足以全面回答问题，请基于你的知识补充必要信息，但请明确区分哪些是基于搜索结果的信息，哪些是你的知识补充。如果问题涉及最新发展或变化，请说明现有信息可能已过时。`;
    }
}

/**
 * 帮助信息
 */
const HELP = `<b>🤖 AI助手</b><br>
<br>
<b>使用方法:</b><br>
1. 直接使用 /ai 问题内容<br>
2. 回复一条消息并使用 /ai 可以让AI分析该消息<br>
<br>
<b>示例:</b><br>
/ai 简要介绍一下人工智能的发展历程<br>
/ai 能帮我解释一下这段代码吗？(作为回复消息)<br>
<br>
<b>功能特点:</b><br>
- 🔍 智能联网搜索，获取最新信息和多方观点<br>
- 💡 结合搜索结果与AI知识库，提供全面分析<br>
- 🔒 普通用户每天限制使用8次<br>
- ⚡ 拥有无限制权限的用户可无限使用`;

/**
 * AI插件类 - 主要插件类，整合所有功能
 */
class AIPlugin {
    private userManager: UserManager;
    private searchService: SearchService;
    private keywordGenerator: KeywordGenerator;
    private responseFormatter: ResponseFormatter;
    private messageManager: MessageManager;

    constructor() {
        this.userManager = new UserManager();
        this.searchService = new SearchService();
        this.keywordGenerator = new KeywordGenerator();
        this.responseFormatter = new ResponseFormatter();
        this.messageManager = new MessageManager();
    }

    /**
     * 检查并重置用户AI使用次数的公共方法
     */
    checkAndResetUserLimits(): void {
        this.userManager.checkAndResetDailyLimits();
    }

    /**
     * 处理查询剩余次数命令
     */
    async handleCheckUsageCommand(ctx: CommandContext): Promise<void> {
        const userId = ctx.message.sender.id;
        const hasUnlimitedAccess = await this.userManager.hasUnlimitedAccess(ctx);

        if (hasUnlimitedAccess) {
            await ctx.message.replyText(html(`${STATUS_EMOJIS.done} <b>您拥有无限使用权限</b><br><br>您可以无限制地使用AI助手，不受次数限制。`));
            return;
        }

        const remainingCount = await this.userManager.getRemainingCount(userId);
        const maxCount = this.userManager.getDefaultData();

        // 格式化剩余次数（保留一位小数）
        const formattedCount = Math.floor(remainingCount * 10) / 10;

        // 构建响应消息
        let message = `${STATUS_EMOJIS.done} <b>AI使用次数状态</b><br><br>`;
        message += `• 剩余次数：${formattedCount}/${maxCount * 2}次<br>`;
        message += `• 基础每日免费：${maxCount}次<br>`;
        message += `• 参与群聊可获得额外次数<br>`;

        if (formattedCount < 1) {
            message += `<br>⚠️ <b>您的使用次数不足</b><br>发送更多消息（5字以上）可获得额外次数，消息越长获得的次数越多！`;
        } else if (formattedCount < 2) {
            message += `<br>⚠️ <b>您的使用次数较少</b><br>继续保持活跃以获取更多使用次数。`;
        }

        await ctx.message.replyText(html(message));
    }

    /**
     * 处理AI命令
     */
    async handleAICommand(ctx: CommandContext): Promise<void> {
        // 检查是否有无限制权限
        const userId = ctx.message.sender.id;
        const hasUnlimitedAccess = await this.userManager.hasUnlimitedAccess(ctx);

        // 检查用户使用次数（仅对非无限用户）
        if (!hasUnlimitedAccess) {
            const limitCheck = await this.userManager.checkUserLimit(ctx);
            if (!limitCheck.canUse) {
                await ctx.message.replyText(html(limitCheck.message!!) || '使用次数已耗尽');
                return;
            }
        }

        // 处理输入内容
        const slowModeTip = slowModeState.isSlowMode ? "(慢速模式已启用，响应可能需要更长时间)" : "";
        let question = ctx.content;

        // 如果是回复其他消息，将回复内容加入问题
        if (ctx.message.replyToMessage?.id) {
            try {
                const repliedMsg = await ctx.client.getMessages(ctx.chatId, [ctx.message.replyToMessage.id]);

                if (repliedMsg?.[0]?.text) {
                    if (question) {
                        question = `${repliedMsg[0].text}\n\n${question}`;
                    } else {
                        question = repliedMsg[0].text;
                    }
                }
            } catch (err) {
                plugin.logger?.error('Failed to get replied message:', err);
            }
        }

        // 如果没有内容，显示帮助信息
        if (!question || question.trim().length === 0) {
            await ctx.message.replyText(html(HELP));
            return;
        }

        // 开始处理请求
        const waitMsg = await ctx.message.replyText(`${STATUS_EMOJIS.analyzing} 正在分析您的问题...${slowModeTip}`);
        if (!waitMsg?.id) {
            plugin.logger?.error('Failed to send initial message');
            return;
        }

        try {
            // 提取搜索关键词
            const fastAI = getFastAI();
            const keywords = await KeywordGenerator.generateKeywords(fastAI, question);

            // 检查是否有关键词且不为空
            if (!keywords.trim()) {
                // 关键词提取失败，给出错误信息
                await this.messageManager.updateMessageStatus(ctx, waitMsg.id, 'error', "无法识别您的问题，请尝试重新表述或提供更多信息");
                return;
            }

            // 记录关键词数量
            const keywordCount = keywords.split('\n').filter(k => k.trim()).length;
            plugin.logger?.info(`已提取${keywordCount}个搜索关键词，将进行精准搜索`);

            // 进行搜索
            const searchPreview = KeywordGenerator.formatSearchPreview(keywords);

            await this.messageManager.updateMessageStatus(ctx, waitMsg.id, 'searching', `${searchPreview} ${slowModeTip}`);

            // 执行搜索
            const searchResults = await this.searchService.performBatchSearch(keywords);

            // 格式化搜索结果
            await this.messageManager.updateMessageStatus(ctx, waitMsg.id, 'processing', `正在分析搜索结果中... ${slowModeTip}`);

            // 将搜索结果转化为提示词的一部分
            const searchResultText = SearchResultFormatter.formatSearchResults(searchResults);

            // 判断是否有任何形式的搜索结果
            const hasAnySearchResults = searchResultText &&
                searchResultText.trim().length > 0 &&
                searchResultText !== "未找到相关搜索结果" &&
                searchResultText !== "未能获取到相关搜索结果，但AI将尝试使用自身知识回答问题";

            // 检查搜索结果的质量
            const hasHighQualityResults = hasAnySearchResults &&
                !searchResultText.includes("可能与问题相关性不高") &&
                !searchResultText.includes("质量不高") &&
                !searchResultText.includes("仅供参考");

            if (!hasAnySearchResults) {
                // 完全没有搜索结果
                plugin.logger?.warn(`未获取到任何搜索结果，将使用AI自身知识回答问题: "${question}"`);
                await this.messageManager.updateMessageStatus(ctx, waitMsg.id, 'warning', `未找到相关搜索结果，将使用AI自身知识回答问题... ${slowModeTip}`);
            } else if (!hasHighQualityResults) {
                // 有结果但质量可能不高
                plugin.logger?.info(`获取到一些搜索结果，但质量可能不高，AI将参考这些结果回答问题`);

                // 检查特殊结果类型
                if (searchResultText.includes("字典解释") || searchResultText.includes("翻译结果") ||
                    searchResultText.includes("时间信息") || searchResultText.includes("货币转换")) {
                    await this.messageManager.updateMessageStatus(ctx, waitMsg.id, 'thinking', `已找到相关特殊信息，正在分析并思考中... ${slowModeTip}`);
                } else {
                    await this.messageManager.updateMessageStatus(ctx, waitMsg.id, 'thinking', `找到一些相关内容，可能不够全面，AI将结合这些内容进行回答... ${slowModeTip}`);
                }
            } else {
                // 有高质量结果
                plugin.logger?.info(`获取到高质量搜索结果，长度: ${searchResultText.length} 字符`);
                // 显示搜索结果摘要给用户
                const resultSummary = SearchResultFormatter.summarizeSearchResults(searchResults);
                await this.messageManager.updateMessageStatus(ctx, waitMsg.id, 'thinking', `已找到${resultSummary}，正在分析并思考中... ${slowModeTip}`);
            }

            // 无论如何都将所有搜索结果传递给AI，让AI自行判断有用内容
            const prompt = AIPromptGenerator.generateComprehensivePrompt(question, searchResultText);

            // 使用高质量AI回答问题
            const ai = getHighQualityAI();

            // 初始化变量跟踪最新内容
            let latestContent = '';
            let latestThinking = '';

            try {
                await ai.stream(
                    (content: string, done: boolean, thinking?: string) => {
                        // 确保内容始终是字符串
                        const safeContent = (content || '').toString();

                        // 确保thinking是字符串或undefined
                        const safeThinking = thinking ? thinking.toString() : undefined;

                        // 更新最新内容
                        latestContent = safeContent;
                        if (safeThinking) latestThinking = safeThinking;

                        // 如果流结束，进行最终更新不受节流限制
                        if (done) {
                            try {
                                // 最终更新直接发送，不使用节流机制
                                const finalDisplayText = ResponseFormatter.formatAIResponse(safeContent, safeThinking || '');
                                // 使用新方法清理最终输出中的HTML
                                const cleanFinalText = cleanHTML(finalDisplayText);
                                const key = `${ctx.chatId}:${waitMsg.id}`;

                                // 检查内容是否与上次相同
                                if (this.messageManager['isContentUnchanged'](key, cleanFinalText)) {
                                    // 内容相同，跳过更新
                                    plugin.logger?.debug(`跳过最终更新，内容未变化`);
                                    return;
                                }

                                // 更新最终消息
                                ctx.client.editMessage({
                                    chatId: ctx.chatId,
                                    message: waitMsg.id,
                                    text: html(cleanFinalText)
                                }).then(() => {
                                    // 更新成功后记录内容
                                    this.messageManager['lastMessageContents'].set(key, cleanFinalText);
                                }).catch(e => plugin.logger?.error(`最终更新消息失败: ${e}`));
                            } catch (e) {
                                plugin.logger?.error(`创建最终消息时出错: ${e}`);
                            }
                        } else {
                            try {
                                // 使用节流机制更新中间消息
                                const displayText = ResponseFormatter.formatAIResponse(safeContent, safeThinking || '');
                                // 使用新方法清理中间输出的HTML
                                const cleanText = cleanHTML(displayText);
                                this.messageManager.throttledEditMessage(ctx, ctx.chatId, waitMsg.id, cleanText);
                            } catch (e) {
                                plugin.logger?.error(`创建中间消息时出错: ${e}`);
                            }
                        }
                    },
                    prompt,
                    true
                );
            } catch (error) {
                throw error; // 重新抛出错误以便外层 catch 捕获
            }
        } catch (error) {
            // 改进错误处理以提供更友好的错误信息
            plugin.logger?.error('AI processing error:', error);

            let errorMessage = '处理请求时出错';
            if (error instanceof Error) {
                // 分析错误类型并提供更具体的消息
                if (error.message.includes('timeout') || error.message.includes('timed out')) {
                    errorMessage = '搜索请求超时，可能是网络问题或搜索服务暂时不可用';
                } else if (error.message.includes('rate') || error.message.includes('limit')) {
                    errorMessage = '搜索频率受限，请稍后再试';
                } else if (error.message.includes('network') || error.message.includes('connect')) {
                    errorMessage = '网络连接问题，无法完成搜索请求';
                } else if (error.message.includes('html content')) {
                    errorMessage = '无法解析搜索结果，可能是搜索服务临时不可用';
                } else if (error.message.includes('fetch') || error.message.includes('http')) {
                    errorMessage = '网络请求失败，无法获取搜索结果';
                } else {
                    errorMessage = `处理请求出错: ${error.message}`;
                }
            }

            await this.messageManager.updateMessageStatus(ctx, waitMsg.id, 'error', errorMessage);
        }
    }

    /**
     * 处理普通消息事件
     */
    async handleMessageEvent(ctx: MessageEventContext): Promise<void> {
        const userId = ctx.message.sender.id;

        // 检查是否有无限使用权限，如果有则不需要增加次数
        const hasUnlimitedAccess = await ctx.hasPermission('ai.unlimited');
        if (hasUnlimitedAccess) {
            return;
        }

        // 获取消息长度并传递给incrementUsage方法
        const messageLength = ctx.message.text?.trim().length || 0;
        this.userManager.incrementUsage(userId, messageLength);
    }
}

// 创建插件实例
const aiPluginInstance = new AIPlugin();
// 用户次数刷新计划任务
let userLimitResetCron: Cron | null = null;

/**
 * 导出插件定义
 */
const plugin: BotPlugin = {
    name: 'ai',
    description: 'AI智能助手',
    version: '1.1.0',

    // 定义权限
    permissions: [
        {
            name: 'ai.unlimited',
            description: '无限制使用AI助手的权限',
            parent: 'admin',
            isSystem: false,
            allowedUsers: []
        }
    ],

    // 命令处理
    commands: [
        {
            name: 'ai',
            description: '使用AI助手回答问题，支持联网搜索',
            aliases: ['ask', 'chat'],
            cooldown: 6,
            handler: async (ctx: CommandContext) => {
                await aiPluginInstance.handleAICommand(ctx);
            }
        },
        {
            name: 'aiusage',
            description: '查看您的AI助手使用次数',
            aliases: ['aicheck', 'aicount'],
            handler: async (ctx: CommandContext) => {
                await aiPluginInstance.handleCheckUsageCommand(ctx);
            }
        }
    ],

    // 消息事件，用于恢复使用次数
    events: [
        {
            type: 'message',
            filter: (ctx: EventContext) => {
                return ctx.type === 'message' &&
                    !!ctx.message.text &&
                    ctx.message.text.trim().length > 5 &&
                    !ctx.message.text.startsWith('/');
            },
            handler: async (ctx: MessageEventContext) => {
                await aiPluginInstance.handleMessageEvent(ctx);
            }
        }
    ],

    async onLoad(client: TelegramClient) {
        // 创建Cron任务，每天凌晨0点执行一次用户次数重置
        userLimitResetCron = new Cron("0 0 * * *", () => {
            plugin.logger?.info('执行定时任务：重置所有用户的AI使用次数');
            aiPluginInstance.checkAndResetUserLimits();
        });
    },

    async onUnload() {
        // 停止Cron任务
        if (userLimitResetCron) {
            userLimitResetCron.stop();
            plugin.logger?.info('AI插件已卸载：用户次数刷新计划任务已停止');
        }
    }
};

export default plugin;
