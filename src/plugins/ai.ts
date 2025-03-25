import { html } from '@mtcute/bun';
import { getHighQualityAI, getFastAI } from '../ai/AiManager';
import type { BotPlugin, CommandContext, EventContext, MessageEventContext } from '../features';
import { log } from '../log';
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

// 基础常量配置
const CACHE_EXPIRY = 30 * 60 * 1000; // 缓存有效期：30分钟
const MESSAGE_UPDATE_INTERVAL = 5000; // 消息更新间隔(ms)
const userCount = new DynamicMap(5); // 默认每个用户每天5次使用机会

// 缓存和状态管理
const searchCache = new Map<string, { timestamp: number, results: any }>();
let lastGlobalUpdateTime = 0;
let pendingUpdates = new Map<string, { ctx: CommandContext, chatId: string | number, messageId: number, text: string }>();
let lastMessageContents = new Map<string, string>();

// 状态消息图标
const STATUS_EMOJIS = {
    thinking: '🧠',
    analyzing: '🔍',
    searching: '🔎',
    processing: '⚙️',
    error: '❌',
    done: '✅',
    warning: '⚠️',
    cached: '⚡',
    limited: '🔒'
};

// 搜索限制参数
const searchLimits = {
    maxQueriesPerUser: 20,
    maxQueriesTotal: 100,
    currentTotal: 0,
    userSearchCounts: new Map<number, number>(),
    lastReset: Date.now()
};

// 设置定时器，确保消息定期更新
setInterval(executeUpdates, MESSAGE_UPDATE_INTERVAL);

// 帮助信息
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
- 🔄 自动优化搜索关键词，提高搜索质量<br>
- 🌟 智能分析和排序搜索结果，优先展示高质量信息<br>
- 💡 结合搜索结果与AI知识库，提供全面分析<br>
- 💭 显示AI思考过程，便于理解推理方式<br>
- 🔒 普通用户每天限制使用${userCount.getDefaultData()}次<br>
- ⚡ 拥有无限制权限的用户可无限使用`;

// 关键词生成提示词
const SEARCH_KEYWORDS_GENERATION_PROMPT = `作为AI搜索助手，您的任务是基于用户问题直接生成最佳搜索关键词，以获取最相关的搜索结果。

当前时间：CURRENT_DATETIME

请分析以下用户问题，并直接生成4-5个最优质的搜索查询（每行一个），确保能获取最精准、最新的信息：

"$USER_QUESTION$"

优化原则：
1. 查询应包含关键概念、术语和实体，避免一般性词汇
2. 对于复杂问题，拆分为多个具体的子查询
3. 添加特定的技术术语、专业词汇或领域标识词
4. 考虑不同的表达方式和同义词，确保覆盖全面
5. 对于多语言内容，添加语言指示词（如"中文教程"或"英文文档"）
6. 为需要最新信息的查询添加年份（如"CURRENT_YEAR"、"最新"）
7. 添加"最佳实践"、"教程"、"官方"等修饰词以获取权威信息
8. 限制在4-5个最优质的查询，质量优于数量

输出格式：
- 每行一个优化后的查询
- 不要添加任何额外注释、编号或引号
- 仅输出最终优化的查询关键词列表`;

// 添加全局消息更新节流机制
async function executeUpdates() {
    const now = Date.now();
    
    // 如果距离上次更新时间小于设定间隔，则跳过执行
    if (now - lastGlobalUpdateTime < MESSAGE_UPDATE_INTERVAL) {
        return;
    }
    
    // 更新全局最后更新时间
    lastGlobalUpdateTime = now;
    
    // 取出所有待处理的更新
    const updatesToProcess = new Map(pendingUpdates);
    pendingUpdates.clear();
    
    // 执行所有待处理的更新
    for (const [key, update] of updatesToProcess.entries()) {
        try {
            // 检查内容是否与上次相同，如果相同则跳过
            if (isContentUnchanged(key, update.text)) {
                continue;
            }
            
            // 更新消息
            await update.ctx.client.editMessage({
                chatId: update.chatId,
                message: update.messageId,
                text: html(update.text)
            });
            
            // 记录更新后的内容
            lastMessageContents.set(key, update.text);
        } catch (e) {
            log.error(`更新消息失败: ${e}`);
        }
    }
}

// 检查消息内容是否未变化
function isContentUnchanged(key: string, newContent: string): boolean {
    const lastContent = lastMessageContents.get(key);
    return lastContent === newContent;
}

// 节流函数，控制消息更新频率
async function throttledEditMessage(ctx: CommandContext, chatId: string | number, messageId: number, text: string): Promise<void> {
    const key = `${chatId}:${messageId}`;
    
    // 检查内容是否与上次相同，如果相同则直接跳过
    if (isContentUnchanged(key, text)) {
        return;
    }
    
    // 记录待处理的更新
    pendingUpdates.set(key, { ctx, chatId, messageId, text });
    
    // 执行更新（如果符合时间间隔要求）
    await executeUpdates();
}

// 重置搜索限制（每24小时）
function checkAndResetSearchLimits() {
    const now = Date.now();
    if (now - searchLimits.lastReset > 24 * 60 * 60 * 1000) {
        searchLimits.currentTotal = 0;
        searchLimits.userSearchCounts.clear();
        searchLimits.lastReset = now;
        log.info('Search limits have been reset');
    }
}

// 检查搜索限制
function checkSearchLimits(userId: number): { canSearch: boolean, reason?: string } {
    checkAndResetSearchLimits();
    
    // 检查全局限制
    if (searchLimits.currentTotal >= searchLimits.maxQueriesTotal) {
        return { 
            canSearch: false, 
            reason: `⚠️ 已达今日全局搜索次数限制(${searchLimits.maxQueriesTotal}次)，机器人正在保护搜索服务不被过度使用。请在24小时后再试` 
        };
    }
    
    // 检查用户限制
    const userCount = searchLimits.userSearchCounts.get(userId) || 0;
    if (userCount >= searchLimits.maxQueriesPerUser) {
        return { 
            canSearch: false, 
            reason: `⚠️ 您今日的搜索次数(${userCount}/${searchLimits.maxQueriesPerUser}次)已达上限。每位用户每24小时可进行${searchLimits.maxQueriesPerUser}次搜索` 
        };
    }
    
    return { canSearch: true };
}

// 增加搜索计数
function incrementSearchCount(userId: number) {
    searchLimits.currentTotal++;
    const userCount = searchLimits.userSearchCounts.get(userId) || 0;
    searchLimits.userSearchCounts.set(userId, userCount + 1);
}

// 生成搜索关键词
async function generateSearchKeywords(aiModel: any, userQuestion: string): Promise<string> {
    try {
        // 获取当前时间和年份
        const currentDateTime = new Date().toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        });
        const currentYear = new Date().getFullYear().toString();
        
        // 使用提示词模板生成最终的提示词，替换所有动态值
        let prompt = SEARCH_KEYWORDS_GENERATION_PROMPT
            .replace('$USER_QUESTION$', userQuestion)
            .replace('CURRENT_DATETIME', currentDateTime)
            .replace(/CURRENT_YEAR/g, currentYear);
        
        // 使用AI直接获取优化后的关键词
        const generatedKeywords = await aiModel.get(prompt, false);
        
        if (generatedKeywords && generatedKeywords.trim()) {
            const optimizedKeywords = generatedKeywords.trim();
            log.info(`生成搜索关键词: "${optimizedKeywords.replace(/\n/g, '; ')}"`);
            return optimizedKeywords;
        }
        
        throw new Error('AI返回的关键词为空');
    } catch (err) {
        log.warn(`对问题生成关键词失败，使用备用方法: ${err instanceof Error ? err.message : String(err)}`);
        return generateFallbackKeywords(userQuestion);
    }
}

// 备用的关键词生成函数
function generateFallbackKeywords(userQuestion: string): string {
    // 简单地将问题分割成多个部分作为关键词
    const words = userQuestion
        .replace(/[.,?!;:"']/g, '')
        .split(/\s+/)
        .filter(word => word.length > 2)
        .slice(0, 5);
    
    // 如果分词后的关键词不足3个，则使用整个问题作为一个关键词
    if (words.length < 3) return userQuestion;
    
    // 将单词组合成2-3个关键词短语
    const keywordPhrases = [];
    
    // 添加前3个词组合
    if (words.length >= 3) {
        keywordPhrases.push(words.slice(0, 3).join(' '));
    }
    
    // 添加后3个词组合（如果不同）
    if (words.length > 3) {
        const lastThree = words.slice(-3).join(' ');
        if (lastThree !== keywordPhrases[0]) {
            keywordPhrases.push(lastThree);
        }
    }
    
    // 如果关键词仍然太少，添加中间词组合
    if (keywordPhrases.length < 2 && words.length > 3) {
        keywordPhrases.push(words.slice(1, 4).join(' '));
    }
    
    // 添加年份获取更新信息
    if (keywordPhrases.length === 1) {
        keywordPhrases.push(`${keywordPhrases[0]} ${new Date().getFullYear()}`);
    }
    
    log.info(`生成备用关键词: "${keywordPhrases.join('; ')}"`);
    return keywordPhrases.join('\n');
}

const plugin: BotPlugin = {
    name: 'ai',
    description: 'AI智能助手',
    version: '1.1.0',
    
    // 定义权限
    permissions: [
        {
            name: 'ai.unlimited',
            description: '无限制使用AI助手的权限',
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
            async handler(ctx: CommandContext) {
                // 检查是否有无限制权限
                const userId = ctx.message.sender.id;
                const hasUnlimitedAccess = await ctx.hasPermission('ai.unlimited');
                
                // 检查用户使用次数（仅对非无限用户）
                if (!hasUnlimitedAccess) {
                    const count = await userCount.get(userId);
                    
                    if (count < 1) {
                        await ctx.message.replyText(`${STATUS_EMOJIS.warning} 您今日的AI使用次数已耗尽，每天会自动重置`);
                        return;
                    }
                    
                    // 减少使用次数
                    userCount.set(userId, count - 1);
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
                        log.error('Failed to get replied message:', err);
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
                    log.error('Failed to send initial message');
                    return;
                }
                
                try {
                    // 提取搜索关键词
                    const fastAI = getFastAI();
                    const keywords = await generateSearchKeywords(fastAI, question);
                    
                    // 检查是否有关键词且不为空
                    if (!keywords.trim()) {
                        // 关键词提取失败，给出错误信息
                        await updateMessageStatus(ctx, waitMsg.id, 'error', "无法识别您的问题，请尝试重新表述或提供更多信息");
                        return;
                    }
                    
                    // 需要搜索，先检查搜索限制
                    const { canSearch, reason } = checkSearchLimits(userId);
                    
                    if (!canSearch) {
                        // 搜索受限，通知用户
                        await updateMessageStatus(ctx, waitMsg.id, 'limited', `${reason}。请稍后再试。`);
                        return;
                    }
                    
                    // 增加搜索计数
                    incrementSearchCount(userId);
                    
                    // 进行搜索
                    const searchPreview = formatSearchPreview(keywords);
                    
                    await updateMessageStatus(ctx, waitMsg.id, 'searching', `${searchPreview} ${slowModeTip}`);
                    
                    // 执行批量搜索
                    const searchResults = await performBatchSearch(keywords);
                    
                    // 格式化搜索结果
                    await updateMessageStatus(ctx, waitMsg.id, 'processing', `正在分析搜索结果中... ${slowModeTip}`);
                    
                    // 将搜索结果转化为提示词的一部分
                    const searchResultText = formatSearchResults(searchResults);
                    
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
                        log.warn(`未获取到任何搜索结果，将使用AI自身知识回答问题: "${question}"`);
                        await updateMessageStatus(ctx, waitMsg.id, 'warning', `未找到相关搜索结果，将使用AI自身知识回答问题... ${slowModeTip}`);
                    } else if (!hasHighQualityResults) {
                        // 有结果但质量可能不高
                        log.info(`获取到一些搜索结果，但质量可能不高，AI将参考这些结果回答问题`);
                        
                        // 检查特殊结果类型
                        if (searchResultText.includes("字典解释") || searchResultText.includes("翻译结果") || 
                            searchResultText.includes("时间信息") || searchResultText.includes("货币转换")) {
                            await updateMessageStatus(ctx, waitMsg.id, 'thinking', `已找到相关特殊信息，正在分析并思考中... ${slowModeTip}`);
                        } else {
                            await updateMessageStatus(ctx, waitMsg.id, 'thinking', `找到一些相关内容，可能不够全面，AI将结合这些内容进行回答... ${slowModeTip}`);
                        }
                    } else {
                        // 有高质量结果
                        log.info(`获取到高质量搜索结果，长度: ${searchResultText.length} 字符`);
                        // 显示搜索结果摘要给用户
                        const resultSummary = summarizeSearchResults(searchResults);
                        await updateMessageStatus(ctx, waitMsg.id, 'thinking', `已找到${resultSummary}，正在分析并思考中... ${slowModeTip}`);
                    }
                    
                    // 无论如何都将所有搜索结果传递给AI，让AI自行判断有用内容
                    const prompt = generateComprehensiveAIPrompt(question, searchResultText);
                    
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
                                        const finalDisplayText = formatAIResponse(safeContent, safeThinking || '');
                                        const key = `${ctx.chatId}:${waitMsg.id}`;
                                        
                                        // 检查内容是否与上次相同
                                        const lastContent = lastMessageContents.get(key);
                                        if (lastContent === finalDisplayText) {
                                            // 内容相同，跳过更新
                                            log.debug(`跳过最终更新，内容未变化`);
                                            return;
                                        }
                                        
                                        // 更新最终消息
                                        ctx.client.editMessage({
                                            chatId: ctx.chatId,
                                            message: waitMsg.id,
                                            text: html(finalDisplayText)
                                        }).then(() => {
                                            // 更新成功后记录内容
                                            lastMessageContents.set(key, finalDisplayText);
                                        }).catch(e => log.error(`最终更新消息失败: ${e}`));
                                    } catch (e) {
                                        log.error(`创建最终消息时出错: ${e}`);
                                    }
                                } else {
                                    try {
                                        // 使用节流机制更新中间消息
                                        const displayText = formatAIResponse(safeContent, safeThinking || '');
                                        throttledEditMessage(ctx, ctx.chatId, waitMsg.id, displayText);
                                    } catch (e) {
                                        log.error(`创建中间消息时出错: ${e}`);
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
                    log.error('AI processing error:', error);
                    
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
                    
                    await updateMessageStatus(ctx, waitMsg.id, 'error', errorMessage);
                }
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
                const userId = ctx.message.sender.id;
                
                // 检查是否有无限使用权限，如果有则不需要增加次数
                const hasUnlimitedAccess = await ctx.hasPermission('ai.unlimited');
                if (hasUnlimitedAccess) {
                    return;
                }
                
                const count = await userCount.get(userId);
                // 每条有效消息增加0.2次使用机会，最多到初始值的2倍
                userCount.set(userId, Math.min(userCount.getDefaultData() * 2, count + 0.2));
            }
        }
    ]
};

// 更新消息状态的辅助函数
async function updateMessageStatus(ctx: CommandContext, messageId: number, status: keyof typeof STATUS_EMOJIS, additionalText: string = ''): Promise<void> {
    // 获取格式化后的状态文本
    const text = formatStatusText(status, additionalText);
    
    // 检查状态消息是否变化
    const key = `${ctx.chatId}:${messageId}`;
    if (isContentUnchanged(key, text)) return;
    
    try {
        await ctx.client.editMessage({
            chatId: ctx.chatId,
            message: messageId,
            text: html(text)
        });
        
        // 更新成功后记录内容
        lastMessageContents.set(key, text);
    } catch (e) {
        log.error(`更新状态消息失败: ${e}`);
    }
}

// 格式化状态文本（可以被其他地方重用）
function formatStatusText(status: keyof typeof STATUS_EMOJIS, additionalText: string = ''): string {
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

// 执行搜索
async function performSearch(keyword: string) {
    const result = await search({
        query: keyword,
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
                num: 8
            } 
        }
    });
    
    return {
        keyword,
        results: result,
        hasResults: true 
    };
}

// 执行批量搜索
async function performBatchSearch(keywords: string): Promise<any[]> {
    if (!keywords || typeof keywords !== 'string') {
        log.warn('无效的搜索关键词格式');
        return [];
    }
    
    // 分行处理多个关键词
    const keywordLines = keywords.split('\n').filter(line => line && line.trim());
    if (keywordLines.length === 0) {
        log.warn('没有找到有效的搜索关键词');
        return [];
    }
    
    const results: Array<{
        keyword: string;
        results: any;
        fromCache: boolean;
        hasResults?: boolean;
    }> = [];
    
    const searchStats = {
        total: keywordLines.length,
        cached: 0,
        failed: 0,
        successful: 0
    };
    
    log.info(`开始批量搜索，关键词数量: ${keywordLines.length}`);
    
    // 保留最多3个关键词以减少搜索请求数量
    const limitedKeywords = keywordLines.slice(0, 5);
    
    // 将关键词分成批次，每批次最多3个关键词
    const batches: string[][] = [];
    for (let i = 0; i < limitedKeywords.length; i += 3) {
        batches.push(limitedKeywords.slice(i, i + 3));
    }
    
    // 按批次串行处理
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        if (!batch || !Array.isArray(batch)) continue;
        
        const batchPromises = batch.map(keyword => {
            if (!keyword || !keyword.trim()) {
                return Promise.resolve({
                    keyword: '',
                    results: null,
                    fromCache: false,
                    hasResults: false
                });
            }
            
            // 检查缓存
            const cacheKey = keyword.trim().toLowerCase();
            const cachedResult = searchCache.get(cacheKey);
            
            if (cachedResult && (Date.now() - cachedResult.timestamp) < CACHE_EXPIRY) {
                // 使用缓存结果
                log.info(`使用缓存的搜索结果: ${keyword}`);
                searchStats.cached++;
                
                const anyResultCache = cachedResult.results as any;
                const hasResultsCache = !!(
                    (Array.isArray(anyResultCache?.organic) && anyResultCache.organic.length > 0) || 
                    anyResultCache?.dictionary || 
                    anyResultCache?.translate || 
                    anyResultCache?.time || 
                    anyResultCache?.currency
                );
                
                return Promise.resolve({
                    keyword,
                    results: cachedResult.results,
                    fromCache: true,
                    hasResults: hasResultsCache
                });
            }
            
            // 执行新搜索
            log.info(`执行搜索：${keyword}`);
            return performSearch(keyword)
                .then(result => {
                    if (!result || !result.results) {
                        log.warn(`搜索 "${keyword}" 返回空结果`);
                        return { keyword, results: null, fromCache: false };
                    }
                    
                    // 检查结果是否有效，放宽判断条件
                    let hasValidResults = false;
                    try {
                        const resultAsAny = result.results as any;
                        hasValidResults = !!(
                            (Array.isArray(resultAsAny.organic) && resultAsAny.organic.length > 0) || 
                            resultAsAny.dictionary || 
                            resultAsAny.translate || 
                            resultAsAny.time || 
                            resultAsAny.currency
                        );
                    } catch (e) {
                        log.error(`检查搜索结果有效性时出错: ${e}`);
                    }
                    
                    // 缓存结果
                    searchCache.set(cacheKey, {
                        timestamp: Date.now(),
                        results: result.results
                    });
                    searchStats.successful++;
                    
                    return { 
                        keyword, 
                        results: result.results, 
                        fromCache: false,
                        hasResults: hasValidResults
                    };
                })
                .catch(err => {
                    log.error(`搜索 "${keyword}" 失败:`, err);
                    searchStats.failed++;
                    return { keyword, results: null, fromCache: false, hasResults: false };
                });
        });
        
        try {
            // 同时执行一批搜索
            const batchResults = await Promise.all(batchPromises);
            
            // 添加有效结果到结果数组 - 放宽筛选条件，接受任何有结果的项
            for (const result of batchResults) {
                if (!result || !result.results) continue;
                
                // 标记为有效，让后续处理决定如何使用
                result.hasResults = true;
                results.push(result);
            }
            
            // 添加短暂延迟避免请求过于频繁
            if (i < batches.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } catch (error) {
            log.error(`批量搜索过程中出错:`, error);
        }
    }
    
    log.info(`搜索完成 - 总计: ${searchStats.total}, 成功: ${searchStats.successful}, 缓存: ${searchStats.cached}, 失败: ${searchStats.failed}`);
    return results;
}

// 格式化搜索预览文本
function formatSearchPreview(searchKeywords: string): string {
    if (!searchKeywords || typeof searchKeywords !== 'string') {
        return "正在搜索...";
    }
    
    const keywordLines = searchKeywords.split('\n').filter(line => line.trim());
    if (keywordLines.length === 0) return "正在搜索...";
    
    // 使用通用函数格式化预览文本
    if (keywordLines.length > 1) {
        const firstKeyword = keywordLines[0] || '';
        const keywordPreview = truncateText(firstKeyword, 25, 22);
        return `${keywordPreview} 等${keywordLines.length}个关键词`;
    } else {
        const singleKeyword = keywordLines[0] || '';
        return truncateText(singleKeyword, 30, 27);
    }
}

// 文本截断辅助函数
function truncateText(text: string, maxLength: number, truncateAt: number): string {
    if (!text) return '';
    return text.length > maxLength ? text.slice(0, truncateAt) + '...' : text;
}

// Markdown到HTML的转换
function markdownToHtml(text: string): string {
    if (!text) return '';
    if (text.includes('<b>') || text.includes('<i>') || text.includes('<a href=')) {
        return text; // 已经包含HTML标签，不需要转换
    }

    // 标题和格式
    let html = text
        .replace(/^# (.+)$/gm, '<b>$1</b>')
        .replace(/^## (.+)$/gm, '<b>$1</b>')
        .replace(/^### (.+)$/gm, '<b>$1</b>')
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/\*(.+?)\*/g, '<i>$1</i>')
        .replace(/__(.+?)__/g, '<u>$1</u>')
        .replace(/~~(.+?)~~/g, '<s>$1</s>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
        .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
        .replace(/^- (.+)$/gm, '• $1')
        .replace(/^\d+\. (.+)$/gm, '$1')
        .replace(/^---+$/gm, '<hr>')
        .replace(/^> (.+)$/gm, '❝ <i>$1</i>');
    
    // 特殊字符处理
    html = html
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    
    // 修复HTML标签
    const tagPairs = [
        ['b', 'b'], ['i', 'i'], ['u', 'u'], ['s', 's'], ['code', 'code'], 
        ['a href=', 'a'], ['hr', 'hr'], ['br', 'br'],
        ['blockquote collapsible', 'blockquote']
    ];
    
    for (const [openTag, closeTag] of tagPairs) {
        html = html
            .replace(new RegExp(`&lt;${openTag}&gt;`, 'g'), `<${openTag}>`)
            .replace(new RegExp(`&lt;\\/${closeTag}&gt;`, 'g'), `</${closeTag}>`);
    }
    
    // 处理换行
    return html
        .replace(/\n\n/g, '<br><br>')
        .replace(/\n/g, '<br>');
}

// 格式化AI响应
function formatAIResponse(content: string, thinking: string): string {
    let displayText = "";
    
    // 添加思考过程（如果有）
    if (thinking && thinking.trim()) {
        try {
            const cleanedThinking = cleanThinkingProcess(thinking);
            if (cleanedThinking && cleanedThinking.trim()) {
                displayText += `<blockquote collapsible>\n<b>💭 思考过程</b><br><br>${cleanedThinking}\n</blockquote><br><br>`;
            }
        } catch (e) {
            log.error(`处理思考过程时出错: ${e}`);
        }
    }
    
    // 处理内容为空的情况
    if (!content || !content.trim()) {
        displayText += `${STATUS_EMOJIS.error} AI未能生成有效回复，请重试或换一种问法。`;
        return displayText;
    }
    
    // 添加正文内容
    try {
        displayText += markdownToHtml(content);
    } catch (e) {
        log.error(`转换Markdown内容时出错: ${e}`);
        displayText += content; // 回退到原始内容
    }
    
    return displayText;
}

// 清理思考过程
function cleanThinkingProcess(thinking: string): string {
    if (!thinking || typeof thinking !== 'string') return "";
    
    try {
        // 预处理，替换markdown格式为HTML
        let processedThinking = thinking
            .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
            .replace(/\*(.+?)\*/g, '<i>$1</i>');
            
        // 按段落分割
        const paragraphs = processedThinking.split('\n\n').filter(p => p.trim().length > 0);
        
        // 如果段落太少，直接返回处理后的内容
        if (paragraphs.length <= 5) return processedThinking;
        
        // 对于较长的思考过程，进行智能筛选
        const keyParagraphs: string[] = [];
        
        // 保留第一段（通常是问题分析）
        if (paragraphs[0]) keyParagraphs.push(paragraphs[0]);
        
        // 查找包含关键信息的段落
        const infoKeywords = ['搜索结果', '信息', '数据', '分析', '关键点', '结论', '总结', '网络搜索', '网络信息'];
        
        // 从中间段落中选择包含关键词的段落（最多2个）
        const middleParagraphs = paragraphs.slice(1, -2);
        const selectedMiddle = middleParagraphs
            .filter(p => infoKeywords.some(keyword => p.includes(keyword)))
            .slice(0, 2);
        
        keyParagraphs.push(...selectedMiddle);
        
        // 如果没有找到包含关键词的中间段落，选择一个中间段落
        if (selectedMiddle.length === 0 && middleParagraphs.length > 0) {
            const midIndex = Math.floor(middleParagraphs.length / 2);
            const midParagraph = middleParagraphs[midIndex];
            if (midParagraph) keyParagraphs.push(midParagraph);
        }
        
        // 保留最后两段（通常包含结论）
        if (paragraphs.length >= 2) {
            keyParagraphs.push(...paragraphs.slice(-2).filter(Boolean));
        }
        
        // 去重并按原始顺序排序
        const uniqueParagraphs = [...new Set(keyParagraphs)].filter(Boolean);
        const sortedParagraphs = uniqueParagraphs.sort((a, b) => {
            return paragraphs.indexOf(a) - paragraphs.indexOf(b);
        });
        
        // 添加段落分隔符
        return sortedParagraphs.join('<br><br><i>• • •</i><br><br>');
    } catch (e) {
        log.error(`清理思考过程时出错: ${e}`);
        return ""; // 出错时返回空字符串
    }
}

// 格式化搜索结果
function formatSearchResults(searchResultsArray: any[]): string {
    // 检查是否有搜索结果
    if (!searchResultsArray || searchResultsArray.length === 0) {
        return "未找到相关搜索结果";
    }
    
    // 筛选有效结果，放宽筛选条件
    const validResults = searchResultsArray.filter(item => item && item.results);
    log.info(`搜索结果筛选: ${validResults.length}/${searchResultsArray.length}个有效`);
    
    // 如果没有任何有效结果，直接返回错误信息
    if (validResults.length === 0) {
        return "未找到相关搜索结果";
    }
    
    // 检查是否有特殊结果类型（字典、翻译等）
    const hasSpecialResults = validResults.some(item => {
        if (!item.results) return false;
        const r = item.results;
        return r.dictionary || r.translate || r.time || r.currency;
    });
    
    // 如果有特殊结果类型，处理并返回
    if (hasSpecialResults) {
        let specialOutput = "";
        
        for (const item of validResults) {
            if (!item.results) continue;
            const specialText = processSpecialResults(item.results, '');
            if (specialText) {
                specialOutput += specialText + '\n\n';
            }
        }
        
        if (specialOutput.trim()) {
            return specialOutput.trim();
        }
    }
    
    // 准备处理有机搜索结果
    let output = '';
    const processedLinks = new Set<string>();
    let highQualityCount = 0;
    let resultNumber = 1;
    let hasOrganicResults = false;
    let hasAnyResults = false;
    
    // 处理各搜索关键词的结果
    for (const item of validResults) {
        if (!item.results) continue;
        
        // 处理特殊结果类型
        const specialText = processSpecialResults(item.results, '');
        if (specialText) {
            output += specialText + '\n\n';
            hasAnyResults = true;
        }
        
        // 处理有机搜索结果
        const organic = item.results.organic;
        if (!organic || !Array.isArray(organic) || organic.length === 0) continue;
        
        hasOrganicResults = true;
        
        // 按质量排序
        const sortedResults = [...organic].sort((a, b) => {
            return getResultQualityScore(b) - getResultQualityScore(a);
        });
        
        // 添加标题（仅一次）
        if (output.indexOf('网络搜索结果') === -1) {
            output += `网络搜索结果:\n\n`;
        }
        
        // 每个关键词至少处理1个结果，最多处理3个
        let processedCount = 0;
        let minResultsToProcess = 1; // 确保每个关键词至少提供1个结果
        
        for (const result of sortedResults) {
            if (!result) continue;
            
            // 链接去重
            const hasLink = !!result.link;
            if (hasLink && processedLinks.has(result.link)) continue;
            
            // 放宽有效性检查条件
            const hasMinimalContent = (result.title || (result.snippet && result.snippet.length > 0));
            if (!hasMinimalContent) continue;
            
            // 记录链接
            if (hasLink) processedLinks.add(result.link);
            
            // 格式化并添加结果
            output += `[结果 ${resultNumber}] -----\n`;
            output += formatSearchResultItem(result);
            processedCount++;
            resultNumber++;
            hasAnyResults = true;
            
            // 统计高质量结果
            if (getResultQualityScore(result) > 5) highQualityCount++;
            
            // 限制每个关键词的结果数量，但确保至少处理最小数量
            if (processedCount >= 3 || (processedCount >= minResultsToProcess && resultNumber > 10)) break;
        }
    }
    
    // 如果没有找到任何结果，创建一个备用结果
    if (!hasAnyResults) {
        // 尝试从任何可能的来源提取信息
        const backupOutput = createBackupResults(searchResultsArray);
        if (backupOutput) {
            return backupOutput;
        }
        
        return "未能获取到相关搜索结果，但AI将尝试使用自身知识回答问题";
    }
    
    // 添加低质量警告
    if (hasOrganicResults && highQualityCount === 0 && processedLinks.size > 0) {
        output += `\n⚠️ 注意：搜索结果质量不高，信息可能不够准确或不够全面。\n`;
    }
    
    log.info(`搜索结果格式化：共${processedLinks.size}个结果，${highQualityCount}个高质量源`);
    return output;
}

// 创建备用搜索结果
function createBackupResults(searchResultsArray: any[]): string {
    let backupOutput = "可能相关的搜索结果（仅供参考）:\n\n";
    const processedLinks = new Set<string>();
    let resultNumber = 1;
    let hasAnyResults = false;
    
    // 尝试从所有结果中提取任何可能有用的内容
    for (const resultItem of searchResultsArray) {
        if (!resultItem) continue;
        
        try {
            // 特殊结果
            if (resultItem.results) {
                const specialText = processSpecialResults(resultItem.results, '');
                if (specialText) {
                    backupOutput += specialText + '\n\n';
                    hasAnyResults = true;
                }
            }
            
            // 如果没有organic但有其他可能的结果字段
            const anyResultObj = resultItem.results || resultItem;
            
            // 处理有机搜索结果
            const organic = anyResultObj.organic;
            if (organic && Array.isArray(organic)) {
                // 最多取前3个结果
                for (const searchResult of organic.slice(0, 3)) {
                    if (!searchResult) continue;
                    
                    // 放宽有效性检查
                    const hasTitle = !!searchResult.title;
                    const hasSnippet = !!searchResult.snippet;
                    const hasLink = !!searchResult.link;
                    
                    if (!hasTitle && !hasSnippet && !hasLink) continue;
                    
                    // 链接去重
                    if (hasLink && processedLinks.has(searchResult.link)) continue;
                    if (hasLink) processedLinks.add(searchResult.link);
                    
                    // 添加结果
                    backupOutput += `[结果 ${resultNumber}] -----\n`;
                    backupOutput += formatSearchResultItem(searchResult);
                    resultNumber++;
                    hasAnyResults = true;
                    
                    // 收集到3个结果就停止
                    if (resultNumber > 3) break;
                }
            }
        } catch (e) {
            log.error(`处理备选结果时出错: ${e}`);
        }
    }
    
    // 如果找到了任何结果
    if (hasAnyResults) {
        backupOutput += "\n⚠️ 注意：这些搜索结果可能与问题相关性不高，请结合AI知识回答。\n";
        return backupOutput;
    }
    
    return ""; // 如果没有找到任何内容，返回空字符串
}

// 处理特殊结果类型（字典、翻译、时间等）
function processSpecialResults(results: any, initialText: string = ''): string {
    if (!results) return initialText;
    
    let processedText = initialText;
    
    try {
        // 1. 处理字典解释结果
        if (results.dictionary) {
            const term = results.dictionary.term || '未知术语';
            const definition = results.dictionary.definition || '无定义';
            processedText += `字典解释: ${term} - ${definition}\n`;
        }
        
        // 2. 处理翻译结果
        if (results.translate) {
            const source = results.translate.source || '未知';
            const target = results.translate.target || '未知';
            const sourceText = results.translate.sourceText || '无原文';
            const targetText = results.translate.targetText || '无译文';
            processedText += `翻译结果: ${source} → ${target}\n`;
            processedText += `原文: ${sourceText}\n`;
            processedText += `译文: ${targetText}\n`;
        }
        
        // 3. 处理时间信息结果
        if (results.time && results.time.display) {
            processedText += `时间信息: ${results.time.display}\n`;
        }
        
        // 4. 处理货币转换结果
        if (results.currency) {
            const fromAmount = results.currency.fromAmount || '?';
            const fromCode = results.currency.fromCode || '?';
            const toAmount = results.currency.toAmount || '?';
            const toCode = results.currency.toCode || '?';
            processedText += `货币转换: ${fromAmount} ${fromCode} = ${toAmount} ${toCode}\n`;
        }
    } catch (e) {
        log.error(`处理特殊结果类型时出错: ${e}`);
    }
    
    return processedText;
}

// 格式化单个搜索结果项
function formatSearchResultItem(searchResult: any): string {
    if (!searchResult) return '';
    
    try {
        let resultText = '';
        
        // 添加标题
        resultText += searchResult.title 
            ? `标题: ${searchResult.title}\n`
            : `标题: (无标题)\n`;
        
        // 添加链接
        if (searchResult.link) {
            resultText += `链接: ${searchResult.link}\n`;
        }
        
        // 处理摘要
        if (searchResult.snippet) {
            // 如果摘要过长，智能截断
            let snippet = searchResult.snippet;
            if (snippet.length > 200) {
                const endPos = snippet.substr(0, 200).lastIndexOf('。');
                snippet = endPos > 100
                    ? snippet.substr(0, endPos + 1) + '...'
                    : snippet.substr(0, 197) + '...';
            }
            resultText += `内容摘要: ${snippet}\n`;
        } else {
            resultText += `内容摘要: (无摘要)\n`;
        }
        
        // 添加相关链接
        if (searchResult.sitelinks && Array.isArray(searchResult.sitelinks) && searchResult.sitelinks.length > 0) {
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
        log.error(`处理搜索结果项时出错: ${e}`);
        return '搜索结果处理出错\n\n';
    }
}

// 计算搜索结果质量分数
function getResultQualityScore(result: any): number {
    if (!result) return 0;
    
    const { title = '', link = '', snippet = '' } = result;
    let score = 0;
    
    // 网站域名权威性评分
    if (link.includes('.gov') || link.includes('.edu')) {
        score += 6; // 政府和教育网站通常最权威
    } else if (link.includes('.org')) {
        score += 4; // 组织网站通常也比较权威
    } else if (checkTopDomains(link)) {
        score += 3; // 知名网站
    }
    
    // 内容类型评分
    if (link.includes('wikipedia') || link.includes('baike.baidu')) {
        score += 5; // 百科类网站
    } else if (
        title.includes('官方') || 
        title.includes('Official') || 
        link.includes('official')
    ) {
        score += 4; // 官方内容
    } else if (
        title.includes('指南') || 
        title.includes('教程') || 
        title.includes('文档') ||
        title.includes('Guide') || 
        title.includes('Tutorial') || 
        title.includes('Doc')
    ) {
        score += 3; // 教程和指南
    }
    
    // 摘要质量评分
    if (snippet) {
        // 摘要长度
        if (snippet.length > 150) {
            score += 2;
        } else if (snippet.length > 100) {
            score += 1;
        }
        
        // 关键信息指标
        const infoTerms = ['研究', '数据', '报告', '统计', '分析', '调查', '发布', '官方数据', 
                          'research', 'data', 'report', 'statistics', 'analysis', 'survey'];
        const infoCount = infoTerms.filter(term => snippet.includes(term)).length;
        score += Math.min(infoCount, 3);
    }
    
    // 时效性评分 - 检查是否包含年份，偏好最近的内容
    const yearMatches = snippet.match(/20[0-9]{2}/g) || [];
    if (yearMatches.length > 0) {
        const currentYear = new Date().getFullYear();
        const years = yearMatches.map((y: string) => parseInt(y)).filter((y: number) => y <= currentYear);
        if (years.length > 0) {
            const mostRecentYear = Math.max(...years);
            // 为最近的内容加分
            if (mostRecentYear >= currentYear - 1) {
                score += 3; // 非常新的内容
            } else if (mostRecentYear >= currentYear - 3) {
                score += 2; // 较新的内容
            } else if (mostRecentYear >= currentYear - 5) {
                score += 1; // 一般新的内容
            }
        }
    }
    
    return score;
}

// 检查是否为知名域名
function checkTopDomains(link: string): boolean {
    // 精简后的高质量域名列表
    const topDomains = [
        // 开发和技术
        'github.com', 'stackoverflow.com', 'gitlab.com', 'gitee.com',
        'developer.mozilla.org', 'docs.microsoft.com', 'developer.android.com',
        'cloud.google.com', 'aws.amazon.com',
        
        // 技术社区
        'medium.com', 'dev.to', 
        'zhihu.com', 'csdn.net', 'juejin.cn', 'segmentfault.com',
        'freecodecamp.org', 'leetcode.com',
        
        // 科技媒体
        '36kr.com', 'techcrunch.com',
        'huxiu.com', 'sspai.com', 'ithome.com',
        
        // AI相关
        'openai.com', 'anthropic.com', 'huggingface.co', 'deepmind.com',
        'pytorch.org', 'tensorflow.org', 
        
        // 大型科技公司
        'microsoft.com', 'apple.com', 'google.com', 'amazon.com',
        'meta.com', 'facebook.com', 'alibaba.com', 'tencent.com', 'baidu.com',
        
        // 编程语言和框架
        'python.org', 'rust-lang.org', 'golang.org', 
        'reactjs.org', 'vuejs.org', 'angular.io', 'nodejs.org',
        
        // 知识库
        'wikipedia.org', 'baike.baidu.com', 'arxiv.org',
        'scholar.google.com', 'researchgate.net'
    ];
    
    return topDomains.some(domain => link.includes(domain));
}

// 生成AI提示词
function generateComprehensiveAIPrompt(userQuestion: string, searchResults: string): string {
    // 获取当前时间
    const currentDateTime = new Date().toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    
    // 安全处理输入
    const safeSearchResults = typeof searchResults === 'string' ? searchResults : '';
    const safeUserQuestion = typeof userQuestion === 'string' ? userQuestion : '请回答用户问题';
    
    // 放宽搜索结果有效性检查条件
    const hasValidResults = safeSearchResults && 
                          safeSearchResults.length > 10 && // 降低最小长度要求
                          (
                             safeSearchResults.includes("搜索结果") || 
                             safeSearchResults.includes("网络搜索结果") ||
                             safeSearchResults.includes("相关的搜索结果") ||
                             safeSearchResults.includes("[结果") ||
                             safeSearchResults.includes("字典解释") ||
                             safeSearchResults.includes("翻译结果") ||
                             safeSearchResults.includes("时间信息") ||
                             safeSearchResults.includes("货币转换")
                          );
    
    log.info(`向AI传递搜索结果: 有效=${hasValidResults}, 长度=${safeSearchResults.length}`);
    
    // 构建搜索结果部分
    let searchResultsSection;
    if (hasValidResults) {
        if (safeSearchResults.includes("可能相关的搜索结果")) {
            searchResultsSection = `搜索结果（可能不够相关，请谨慎使用）:
\`\`\`
${safeSearchResults}
\`\`\`

这些结果可能与用户问题相关性不高。请分析这些结果，提取有用信息，但如果发现信息不相关或不准确，请优先使用您的知识回答问题。`;
        } else {
            searchResultsSection = `搜索结果:
\`\`\`
${safeSearchResults}
\`\`\``;
        }
    } else {
        // 即使搜索结果被判定为无效，也传递原始内容给AI模型评估
        if (safeSearchResults && safeSearchResults.trim()) {
            searchResultsSection = `搜索结果(可能不完整或相关性较低):
\`\`\`
${safeSearchResults}
\`\`\`

这些搜索结果可能不够完整，请酌情使用并结合您的知识回答问题。`;
        } else {
            searchResultsSection = `搜索结果:
\`\`\`
未能获取到与问题直接相关的搜索结果。请基于您的知识库和训练数据回答问题。
\`\`\``;
        }
    }
    
    // 返回完整提示词
    return `问题：${safeUserQuestion}

当前时间：${currentDateTime}

以下是基于互联网搜索整理的相关信息和搜索结果。请根据这些实际搜索结果和你的知识，提供一个全面、准确且直击问题核心的回答。

分析指南：
1. 综合分析所有搜索结果，提取最相关、最可靠的信息
2. 将不同来源的信息进行对比和综合，形成全面的回答
3. 特别注意信息的时效性，优先使用最新的信息，并在回答中标明时间范围
4. 如果搜索结果中包含矛盾的信息，请指出这些矛盾并分析可能的原因
5. 确保内容的权威性，对官方来源的信息给予更高权重
6. 在思考过程中，请使用明确的标记表示你的分析步骤

回答格式要求（使用HTML标签）：
1. 给予明确、有条理的回答，重点突出，避免冗余
2. 使用<b>加粗</b>、<i>斜体</i>、<u>下划线</u>、<s>删除线</s>和<code>代码</code>标签
3. 使用<br>标签表示换行，<br><br>表示段落分隔
4. 适当添加表情符号，使回答更加生动
5. 使用<a href="链接">链接文本</a>格式添加链接
6. 列表项使用普通文本格式，前面添加"•"或"◦"符号
7. 可以使用<blockquote>标签创建引用块，对引用内容进行突出

思考过程格式：
1. 在思考过程中也使用HTML标签进行格式化
2. 使用明确的步骤表示你的分析过程
3. 对关键词和重要结论使用<b>标签突出显示
4. 指出信息来源，以便在思考过程中清晰显示信息的可靠性

注意：
- 不要使用Markdown格式（如**加粗**、*斜体*等），使用HTML标签替代
- 不要使用不支持的HTML标签（如<div>、<span>、<p>等）
- 不要使用HTML标题标签（如<h1>、<h2>等），使用<b>加粗文本</b>代替
- 支持嵌套标签但确保正确嵌套，如<b>粗体<i>斜体粗体</i></b>

信息可信度评估原则：
- 官方网站(.gov、.edu、.org)和权威机构的信息通常更可靠
- 有明确出处、数据支持和详细解释的信息更可信
- 近期发布的信息通常比旧信息更具时效性
- 多个独立来源一致的信息比单一来源的信息更可靠

${searchResultsSection}

若搜索结果不足以全面回答问题，请基于你的知识补充必要信息，但请明确区分哪些是基于搜索结果的信息，哪些是你的知识补充。如果问题涉及最新发展或变化，请说明现有信息可能已过时。`;
}

// 搜索结果摘要
function summarizeSearchResults(results: any[]): string {
    if (!results || !Array.isArray(results) || results.length === 0) {
        return "0个结果";
    }
    
    // 计算有效结果数和高质量结果数
    let totalLinks = 0;
    let highQualityCount = 0;
    
    try {
        // 统计链接数和质量评分
        for (const result of results) {
            const organic = result?.results?.organic;
            if (!organic || !Array.isArray(organic)) continue;
            
            for (const item of organic) {
                if (!item?.link) continue;
                
                totalLinks++;
                const score = getResultQualityScore(item);
                if (score > 5) highQualityCount++;
            }
        }
        
        // 构建摘要文本
        let summary = `${totalLinks}个相关网页`;
        if (highQualityCount > 0) {
            summary += `(${highQualityCount}个高质量来源)`;
        }
        
        // 添加特殊结果类型
        const specialTypes = [];
        for (const result of results) {
            if (!result?.results) continue;
            
            const anyResult = result.results as any;
            if (anyResult.dictionary) specialTypes.push("字典解释");
            if (anyResult.translate) specialTypes.push("翻译结果");
            if (anyResult.time) specialTypes.push("时间信息");
            if (anyResult.currency) specialTypes.push("货币转换");
        }
        
        if (specialTypes.length > 0) {
            summary += ` 和 ${specialTypes.join("、")}`;
        }
        
        return summary;
    } catch (e) {
        log.error(`统计搜索结果时出错: ${e}`);
        return "搜索结果";
    }
}

export default plugin; 