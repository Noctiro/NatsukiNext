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
    maxQueriesPerUser: 15,      // 每个用户24小时内最多15次搜索
    maxQueriesTotal: 80,       // 所有用户总共每24小时最多80次搜索
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
- 💡 结合搜索结果与AI知识库，提供全面分析<br>
- 🔒 普通用户每天限制使用${userCount.getDefaultData()}次<br>
- ⚡ 拥有无限制权限的用户可无限使用`;

// 关键词生成提示词
const SEARCH_KEYWORDS_GENERATION_PROMPT = `作为AI搜索助手，您的任务是基于用户问题生成最少且最有效的搜索关键词，以获取最相关的搜索结果。

当前时间：CURRENT_DATETIME

请分析以下用户问题，并生成1-3个高质量搜索查询（每行一个），可能包括中文和英文（或其他语言）版本，确保能获取最全面的信息：

"$USER_QUESTION$"

优化原则：
1. 语言多样化：根据问题性质，提供中文和英文（或其他相关语言）的关键词版本，以获取更全面的结果
2. 少而精：生成的不同语言版本的关键词总数不超过3个
3. 查询应包含关键概念、实体、专业术语，避免一般性词汇
4. 对于技术、科学、国际事件等话题，优先提供英文关键词
5. 对于中国本地、文化或地区性话题，优先提供中文关键词
6. 对于需要最新信息的查询添加年份（如"CURRENT_YEAR"）
7. 考虑添加"官方"、"权威"、"official"等修饰词以提高结果质量
8. 如果问题简单明确，只需1个最佳查询词即可
9. 某些特殊情况下，可考虑使用日语、韩语等其他语言构建关键词

输出格式：
- 每行一个优化后的查询，不要添加编号或引号
- 不要添加任何说明或评论，直接输出查询词
- 查询词应保持简洁，通常不超过6个单词
- 不同语言的查询分行列出`;

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
    // 检测问题是否包含英文字符
    const hasEnglish = /[a-zA-Z]/.test(userQuestion);
    // 检测问题是否包含中文字符
    const hasChinese = /[\u4e00-\u9fa5]/.test(userQuestion);
    
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
    
    // 如果问题同时包含中英文，尝试添加单语言版本关键词
    if (hasChinese && hasEnglish) {
        // 尝试提取主要英文部分
        const englishWords = userQuestion.match(/[a-zA-Z]+(?:\s+[a-zA-Z]+)*/g);
        if (englishWords && englishWords.length > 0) {
            const englishPhrase = englishWords
                .filter(word => word.length > 3)
                .slice(0, 3)
                .join(' ');
            
            if (englishPhrase && englishPhrase.length > 3 && !keywordPhrases.includes(englishPhrase)) {
                keywordPhrases.push(englishPhrase);
            }
        }
        
        // 尝试提取主要中文部分
        const chineseWords = userQuestion.match(/[\u4e00-\u9fa5]+/g);
        if (chineseWords && chineseWords.length > 0) {
            const chinesePhrase = chineseWords.join('');
            
            if (chinesePhrase && chinesePhrase.length > 1 && !keywordPhrases.includes(chinesePhrase)) {
                keywordPhrases.push(chinesePhrase);
            }
        }
    }
    
    // 限制最多返回3个关键词短语
    const limitedPhrases = keywordPhrases.slice(0, 3);
    
    log.info(`生成备用关键词: "${limitedPhrases.join('; ')}"`);
    return limitedPhrases.join('\n');
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
                const waitMsg = await ctx.message.replyText(`${STATUS_EMOJIS.analyzing} 正在分析您的问题并提取关键词...${slowModeTip}`);
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
                    
                    // 记录关键词数量
                    const keywordCount = keywords.split('\n').filter(k => k.trim()).length;
                    log.info(`已提取${keywordCount}个搜索关键词，将进行精准搜索`);
                    
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
                    
                    // 执行搜索
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
async function performSearch(keyword: string): Promise<{ results: any }> {
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
        log.error(`搜索 "${keyword}" 失败:`, error);
        return { results: null };
    }
}

// 执行批量搜索
async function performBatchSearch(keywords: string): Promise<any[]> {
    if (!keywords || typeof keywords !== 'string') {
        log.warn('无效的搜索关键词格式');
        return [];
    }
    
    // 处理关键词：去重、过滤短词
    const keywordLines = keywords.split('\n')
        .map(line => line.trim())
        .filter(line => line && line.length >= 3) 
        .filter((line, index, self) => self.indexOf(line) === index);
    
    if (keywordLines.length === 0) {
        log.warn('没有找到有效的搜索关键词');
        return [];
    }
    
    // 限制关键词数量，确保有足够多的结果
    const limitedKeywords = keywordLines.slice(0, 3);
    
    const results = [];
    const stats = {
        total: limitedKeywords.length,
        cached: 0,
        successful: 0,
        failed: 0,
        totalResults: 0,
        highQualityResults: 0
    };
    
    log.info(`开始搜索，关键词数量: ${limitedKeywords.length}/${keywordLines.length}`);
    
    // 按顺序执行搜索，避免并行请求
    for (const keyword of limitedKeywords) {
        const cacheKey = keyword.trim().toLowerCase();
        const cachedResult = searchCache.get(cacheKey);
        
        // 检查缓存
        if (cachedResult && (Date.now() - cachedResult.timestamp) < CACHE_EXPIRY) {
            stats.cached++;
            
            // 更新统计信息
            const result = cachedResult.results;
            updateSearchStats(result, stats);
            
            results.push({
                keyword,
                results: result,
                fromCache: true,
                hasResults: hasValidResults(result)
            });
            
            continue;
        }
        
        // 执行新搜索
        try {
            log.info(`执行搜索：${keyword}`);
            const { results: searchResult } = await performSearch(keyword);
            
            if (!searchResult) {
                log.warn(`搜索 "${keyword}" 返回空结果`);
                stats.failed++;
                continue;
            }
            
            // 更新统计信息
            updateSearchStats(searchResult, stats);
            stats.successful++;
            
            // 缓存结果
            searchCache.set(cacheKey, {
                timestamp: Date.now(),
                results: searchResult
            });
            
            results.push({ 
                keyword, 
                results: searchResult, 
                fromCache: false,
                hasResults: hasValidResults(searchResult)
            });
            
            // 仅当获取了足够多高质量结果时才提前结束
            // 目标：至少12个总结果，其中至少5个高质量结果
            if (stats.totalResults >= 15 && stats.highQualityResults >= 6) {
                log.info(`已找到足够高质量结果(${stats.highQualityResults}/${stats.totalResults})，停止搜索`);
                break;
            }
            
            // 搜索间隔延迟
            if (limitedKeywords.indexOf(keyword) < limitedKeywords.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        } catch (error) {
            log.error(`搜索 "${keyword}" 失败:`, error);
            stats.failed++;
        }
    }
    
    // 记录搜索统计信息
    log.info(`搜索完成 - 总计: ${stats.total}, 成功: ${stats.successful}, 缓存: ${stats.cached}, 失败: ${stats.failed}, 结果: ${stats.totalResults}, 高质量: ${stats.highQualityResults}`);
    return results;
}

// 检查结果是否有效
function hasValidResults(results: any): boolean {
    if (!results) return false;
    
    return !!(
        (Array.isArray(results.organic) && results.organic.length > 0) || 
        results.dictionary || 
        results.translate || 
        results.time || 
        results.currency
    );
}

// 更新搜索统计信息
function updateSearchStats(results: any, stats: any): void {
    if (!results || !Array.isArray(results.organic)) return;
    
    stats.totalResults += results.organic.length;
    
    // 计算高质量结果
    for (const res of results.organic) {
        if (getResultQualityScore(res) > 5) {
            stats.highQualityResults++;
        }
    }
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
        // 检查是否包含多语言关键词
        const hasMultiLang = keywordLines.some(kw => {
            // 检测一行中是否同时包含中文和英文或其他语言
            const hasChinese = /[\u4e00-\u9fa5]/.test(kw);
            const hasEnglish = /[a-zA-Z]/.test(kw);
            return hasChinese && hasEnglish;
        });
        
        // 如果包含多语言关键词，提供更多信息
        if (hasMultiLang) {
            return `正在使用多语言关键词搜索(${keywordLines.length}个)`;
        }
        
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
    
    // 如果已经包含HTML标签，不需要转换
    if (text.includes('<b>') || text.includes('<i>') || text.includes('<a href=')) {
        return text;
    }

    // 定义Markdown到HTML的转换规则
    const markdownRules = [
        // 标题
        { pattern: /^# (.+)$/gm, replacement: '<b>$1</b>' },
        { pattern: /^## (.+)$/gm, replacement: '<b>$1</b>' },
        { pattern: /^### (.+)$/gm, replacement: '<b>$1</b>' },
        
        // 格式化
        { pattern: /\*\*(.+?)\*\*/g, replacement: '<b>$1</b>' },
        { pattern: /\*(.+?)\*/g, replacement: '<i>$1</i>' },
        { pattern: /__(.+?)__/g, replacement: '<u>$1</u>' },
        { pattern: /~~(.+?)~~/g, replacement: '<s>$1</s>' },
        { pattern: /`(.+?)`/g, replacement: '<code>$1</code>' },
        
        // 链接和列表
        { pattern: /\[(.+?)\]\((.+?)\)/g, replacement: '<a href="$2">$1</a>' },
        { pattern: /^- (.+)$/gm, replacement: '• $1' },
        { pattern: /^\d+\. (.+)$/gm, replacement: '$1' },
        
        // 其他格式
        { pattern: /^---+$/gm, replacement: '<hr>' },
        { pattern: /^> (.+)$/gm, replacement: '❝ <i>$1</i>' }
    ];
    
    // 应用Markdown规则
    let html = text;
    for (const rule of markdownRules) {
        html = html.replace(rule.pattern, rule.replacement);
    }
    
    // 特殊字符处理
    html = html
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    
    // HTML标签恢复
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
    // 校验输入
    if (!searchResultsArray?.length) return "未找到相关搜索结果";
    
    // 筛选有效结果
    const validResults = searchResultsArray.filter(item => item?.results);
    log.info(`搜索结果筛选: ${validResults.length}/${searchResultsArray.length}个有效`);
    
    if (!validResults.length) return "未找到相关搜索结果";
    
    // 处理搜索结果
    let specialOutput = "";
    let hasSpecialResults = false;
    const allSearchResults: Array<{result: any, quality: number}> = [];
    
    // 收集所有结果
    for (const item of validResults) {
        // 处理特殊结果
        const specialText = processSpecialResults(item.results, '');
        if (specialText) {
            specialOutput += specialText + '\n\n';
            hasSpecialResults = true;
        }
        
        // 处理有机搜索结果
        const organic = item.results?.organic;
        if (Array.isArray(organic) && organic.length) {
            // 筛选有效结果
            for (const result of organic) {
                if (result && (result.title || (result.snippet && result.snippet.length))) {
                    allSearchResults.push({
                        result,
                        quality: getResultQualityScore(result)
                    });
                }
            }
        }
    }
    
    // 排序并去重
    allSearchResults.sort((a, b) => b.quality - a.quality);
    
    // 去除重复链接
    const uniqueResults = [];
    const processedLinks = new Set<string>();
    
    for (const item of allSearchResults) {
        const link = item.result.link;
        if (!link || !processedLinks.has(link)) {
            if (link) processedLinks.add(link);
            uniqueResults.push(item);
        }
    }
    
    // 没有任何结果的情况
    if (!uniqueResults.length && !hasSpecialResults) {
        const backupOutput = createBackupResults(searchResultsArray);
        return backupOutput || "未能获取到相关搜索结果，但AI将尝试使用自身知识回答问题";
    }
    
    // 构建输出内容
    let output = hasSpecialResults ? specialOutput : '';
    
    // 添加搜索结果
    if (uniqueResults.length) {
        output += `网络搜索结果:\n\n`;
        
        // 计算高质量结果数量
        const highQualityResults = uniqueResults.filter(item => item.quality > 5);
        const highQualityCount = highQualityResults.length;
        
        log.info(`搜索结果统计：总共${uniqueResults.length}个结果，${highQualityCount}个高质量结果`);
        
        // 确保至少提供5条结果，但不超过12条
        // 先选择所有高质量结果
        let selectedResults = [...highQualityResults];
        
        // 如果高质量结果不足5条，添加其他结果直到达到5条
        if (selectedResults.length < 5 && uniqueResults.length > highQualityCount) {
            // 获取剩余的非高质量结果
            const otherResults = uniqueResults.filter(item => item.quality <= 5);
            // 添加足够的其他结果，确保总数至少达到5条（如果有足够的结果）
            const additionalNeeded = Math.min(5 - selectedResults.length, otherResults.length);
            selectedResults = [...selectedResults, ...otherResults.slice(0, additionalNeeded)];
        }
        
        // 限制最多12条结果
        selectedResults = selectedResults.slice(0, 12);
        
        // 格式化结果
        selectedResults.forEach((item, index) => {
            output += `[结果 ${index + 1}] -----\n`;
            output += formatSearchResultItem(item.result);
        });
        
        // 添加质量提示
        if (highQualityCount === 0 && uniqueResults.length > 0) {
            output += `\n⚠️ 注意：搜索结果质量不高，信息可能不够准确或不够全面。\n`;
        }
        
        log.info(`搜索结果格式化：输出${selectedResults.length}个结果，包括${Math.min(highQualityCount, selectedResults.length)}个高质量结果`);
    } else if (hasSpecialResults) {
        log.info(`搜索结果仅包含特殊结果类型，无有机搜索结果`);
    }
    
    return output;
}

// 创建备用搜索结果
function createBackupResults(searchResultsArray: any[]): string {
    if (!searchResultsArray?.length) return "";
    
    let backupOutput = "可能相关的搜索结果（仅供参考）:\n\n";
    const processedLinks = new Set<string>();
    let resultNumber = 1;
    let hasAnyResults = false;
    
    // 收集所有可能有用的结果
    const allPotentialResults = [];
    
    // 处理所有结果
    for (const resultItem of searchResultsArray) {
        if (!resultItem) continue;
        
        try {
            // 处理特殊结果
            if (resultItem.results) {
                const specialText = processSpecialResults(resultItem.results, '');
                if (specialText) {
                    backupOutput += specialText + '\n\n';
                    hasAnyResults = true;
                }
                
                // 处理有机搜索结果
                const organic = resultItem.results.organic;
                if (Array.isArray(organic)) {
                    for (const searchResult of organic) {
                        // 过滤无效结果
                        if (!searchResult) continue;
                        if (!searchResult.title && !searchResult.snippet && !searchResult.link) continue;
                        
                        // 添加到潜在结果列表
                        allPotentialResults.push(searchResult);
                    }
                }
            }
        } catch (e) {
            log.error(`处理备选结果时出错: ${e}`);
        }
    }
    
    // 去重并选择最多5条结果
    if (allPotentialResults.length > 0) {
        // 简单排序：优先选择有标题和摘要的结果
        allPotentialResults.sort((a, b) => {
            const aScore = (a.title ? 2 : 0) + (a.snippet ? 1 : 0);
            const bScore = (b.title ? 2 : 0) + (b.snippet ? 1 : 0);
            return bScore - aScore;
        });
        
        // 最多选择5条不重复的结果
        const maxResultsToShow = 5;
        let resultsAdded = 0;
        
        for (const result of allPotentialResults) {
            // 去重
            if (result.link && processedLinks.has(result.link)) continue;
            if (result.link) processedLinks.add(result.link);
            
            // 添加结果
            backupOutput += `[结果 ${resultNumber}] -----\n`;
            backupOutput += formatSearchResultItem(result);
            resultNumber++;
            hasAnyResults = true;
            resultsAdded++;
            
            // 收集到足够数量的结果就停止
            if (resultsAdded >= maxResultsToShow) break;
        }
        
        log.info(`备选搜索结果：共显示${resultsAdded}条结果，从${allPotentialResults.length}条潜在结果中筛选`);
    }
    
    // 如果找到了任何结果，添加注意提示
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
        // 处理字典解释
        if (results.dictionary) {
            const { term = '未知术语', definition = '无定义' } = results.dictionary;
            processedText += `字典解释: ${term} - ${definition}\n`;
        }
        
        // 处理翻译结果
        if (results.translate) {
            const { 
                source = '未知', 
                target = '未知', 
                sourceText = '无原文', 
                targetText = '无译文' 
            } = results.translate;
            
            processedText += `翻译结果: ${source} → ${target}\n`;
            processedText += `原文: ${sourceText}\n`;
            processedText += `译文: ${targetText}\n`;
        }
        
        // 处理时间信息
        if (results.time?.display) {
            processedText += `时间信息: ${results.time.display}\n`;
        }
        
        // 处理货币转换
        if (results.currency) {
            const { 
                fromAmount = '?', 
                fromCode = '?', 
                toAmount = '?', 
                toCode = '?' 
            } = results.currency;
            
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
        const { title, link, snippet, sitelinks } = searchResult;
        let resultText = '';
        
        // 添加标题
        resultText += title 
            ? `标题: ${title}\n`
            : `标题: (无标题)\n`;
        
        // 添加链接
        if (link) {
            resultText += `链接: ${link}\n`;
        }
        
        // 处理摘要
        if (snippet) {
            // 智能截断长摘要
            let formattedSnippet = snippet;
            if (snippet.length > 200) {
                const endPos = snippet.substr(0, 200).lastIndexOf('。');
                formattedSnippet = endPos > 100
                    ? snippet.substr(0, endPos + 1) + '...'
                    : snippet.substr(0, 197) + '...';
            }
            resultText += `内容摘要: ${formattedSnippet}\n`;
        } else {
            resultText += `内容摘要: (无摘要)\n`;
        }
        
        // 添加相关链接
        if (Array.isArray(sitelinks) && sitelinks.length > 0) {
            const linkTitles = sitelinks
                .filter(Boolean)
                .map(link => link.title || "(无标题)")
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
    score += getDomainAuthorityScore(link);
    
    // 内容类型评分
    score += getContentTypeScore(title, link);
    
    // 摘要质量评分
    score += getSnippetQualityScore(snippet);
    
    // 时效性评分
    score += getTimelinessScore(snippet);
    
    return score;
}

// 评估域名权威性
function getDomainAuthorityScore(link: string): number {
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
    if (checkTopDomains(link)) {
        return 3;
    }
    
    return 0;
}

// 评估内容类型
function getContentTypeScore(title: string, link: string): number {
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

// 评估摘要质量
function getSnippetQualityScore(snippet: string): number {
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

// 评估时效性
function getTimelinessScore(snippet: string): number {
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

// 检查是否为知名域名
function checkTopDomains(link: string): boolean {
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
    
    // 判断搜索结果有效性
    const hasAnyResults = safeSearchResults && 
                      safeSearchResults.length > 5 && 
                      !safeSearchResults.includes("未找到相关搜索结果") &&
                      !safeSearchResults.includes("未能获取到相关搜索结果");
    
    log.info(`AI提示词生成：搜索结果长度${safeSearchResults.length}字符，有效=${hasAnyResults}`);
    
    // 构建搜索结果部分
    let resultContext = "";
    
    if (hasAnyResults) {
        // 根据结果类型确定提示内容
        if (safeSearchResults.includes("字典解释") || 
            safeSearchResults.includes("翻译结果") || 
            safeSearchResults.includes("时间信息") || 
            safeSearchResults.includes("货币转换")) {
            resultContext = "包含特殊信息";
        } 
        else if (safeSearchResults.includes("可能相关的搜索结果") || 
                safeSearchResults.includes("可能不够相关") || 
                safeSearchResults.includes("质量不高") ||
                safeSearchResults.includes("仅供参考")) {
            resultContext = "可能相关性不高，但仍有参考价值";
        }
    }
    
    // 构建搜索结果部分
    const searchResultsSection = hasAnyResults 
        ? `搜索结果${resultContext ? `(${resultContext})` : ""}:
\`\`\`
${safeSearchResults}
\`\`\``
        : `搜索结果:
\`\`\`
未能获取到与问题直接相关的搜索结果。请基于您的知识库和训练数据回答问题。
\`\`\``;
    
    // 返回完整提示词
    return `问题：${safeUserQuestion}

当前时间：${currentDateTime}

以下是基于互联网搜索整理的相关信息和搜索结果。请根据这些实际搜索结果和你的知识，提供一个全面、准确且直击问题核心的回答。

分析指南：
1. 综合分析所有搜索结果，充分利用每一条提供的信息
2. 将不同来源的信息进行对比和综合，形成全面的回答
3. 特别注意信息的时效性，优先使用最新的信息，并在回答中标明时间范围
4. 如果搜索结果中包含矛盾的信息，请指出这些矛盾并分析可能的原因
5. 确保内容的权威性，对官方来源的信息给予更高权重
6. 所提供的搜索结果都是经过筛选的，即使质量不高也可能包含有价值的信息，请全面分析
7. 搜索结果按照质量排序，但这不意味着靠后的结果一定价值较低，请综合评估

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
    
    try {
        // 统计链接数和高质量结果数
        let totalLinks = 0;
        let highQualityCount = 0;
        const specialTypes = new Set<string>();
        
        // 处理所有结果
        for (const result of results) {
            // 跳过无效结果
            if (!result?.results) continue;
            
            // 处理有机搜索结果
            const organic = result.results.organic;
            if (Array.isArray(organic)) {
                for (const item of organic) {
                    if (!item?.link) continue;
                    
                    totalLinks++;
                    if (getResultQualityScore(item) > 5) {
                        highQualityCount++;
                    }
                }
            }
            
            // 收集特殊结果类型
            const anyResult = result.results;
            if (anyResult.dictionary) specialTypes.add("字典解释");
            if (anyResult.translate) specialTypes.add("翻译结果");
            if (anyResult.time) specialTypes.add("时间信息");
            if (anyResult.currency) specialTypes.add("货币转换");
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
        log.error(`统计搜索结果时出错: ${e}`);
        return "搜索结果";
    }
}

export default plugin; 
