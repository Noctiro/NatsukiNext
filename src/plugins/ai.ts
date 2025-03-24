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
    CurrencyResult,
    ResultTypes
} from 'google-sr';
import { slowModeState } from '../ai/provider/BaseProvider';
import DynamicMap from '../utils/DynamicMap';

// 使用频率限制：每个用户每天可以使用的次数
const userCount = new DynamicMap(5); // 默认每个用户5次

// 搜索结果缓存 - 避免重复搜索相同内容
const searchCache = new Map<string, { timestamp: number, results: any }>();
const CACHE_EXPIRY = 30 * 60 * 1000; // 缓存有效期：30分钟

// 状态消息格式
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

// 搜索限制保护
const searchLimits = {
    maxQueriesPerUser: 20,       // 每个用户每天的最大搜索次数
    maxQueriesTotal: 100,        // 所有用户每天的最大搜索次数
    currentTotal: 0,             // 当前所有用户的总搜索次数
    userSearchCounts: new Map<number, number>(), // 用户搜索次数跟踪
    lastReset: Date.now()        // 上次重置计数的时间
};

// 添加全局消息更新节流机制
const MESSAGE_UPDATE_INTERVAL = 5000; // 消息更新间隔，单位毫秒
let lastGlobalUpdateTime = 0; // 全局最后一次更新时间
let pendingUpdates = new Map<string, { ctx: CommandContext, chatId: string | number, messageId: number, text: string }>(); // 待处理的更新
let lastMessageContents = new Map<string, string>(); // 记录每个消息的最后内容

// 执行待处理的消息更新
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
            // 检查是否与上次内容相同
            const lastContent = lastMessageContents.get(key);
            if (lastContent === update.text) {
                // 内容相同，跳过更新
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

// 节流函数，控制消息更新频率
async function throttledEditMessage(ctx: CommandContext, chatId: string | number, messageId: number, text: string): Promise<void> {
    const key = `${chatId}:${messageId}`;
    
    // 检查内容是否与上次相同
    const lastContent = lastMessageContents.get(key);
    if (lastContent === text) {
        // 内容完全相同，直接跳过
        return;
    }
    
    // 记录待处理的更新
    pendingUpdates.set(key, { ctx, chatId, messageId, text });
    
    // 执行更新（如果符合时间间隔要求）
    await executeUpdates();
}

// 设置定时器，确保消息定期更新
setInterval(executeUpdates, MESSAGE_UPDATE_INTERVAL);

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

// 用于提取搜索关键词的提示词
const extractPrompt = `作为搜索意图助手，您的任务是为用户问题生成最有效的搜索关键词，以获取最相关的信息。

指南:
1. 为每个问题创建3-5个高质量的搜索查询（每行一个）
2. 查询应包含关键概念、术语、实体，避免一般性词汇
3. 对于复杂问题，拆分为多个具体的子查询
4. 针对需要最新信息的问题，添加时间相关词汇
5. 考虑添加"最佳实践"、"教程"、"官方"等修饰词以获取权威信息
6. 对于任何问题都应尝试生成搜索关键词，除非是明显的闲聊或问候

查询格式规则:
- 每个查询放在单独一行
- 优先使用完整短语而非单个词
- 对于需要比较的问题，生成针对每个选项的查询

输入文本: `;

// 搜索关键词优化提示词
const optimizeSearchPrompt = `分析以下提取的搜索关键词，将其优化为更有效的搜索查询，确保能获取最精准、最新的信息：

${0}

优化规则：
1. 移除模糊或过于笼统的词语，使查询更具体和精确
2. 添加特定的技术术语、专业词汇或领域标识词
3. 考虑不同的表达方式和同义词，确保覆盖全面
4. 对于多语言内容，添加语言指示词（如"中文教程"或"英文文档"）
5. 按相关性和重要性排序关键词
6. 合并相似的查询并删除重复内容
7. 为需要最新信息的查询添加年份（如"2025"、"最新"）
8. 限制在4个最优质的查询，确保质量优于数量

输出格式：
- 每行一个优化后的查询
- 不要添加任何额外注释或编号
- 不要使用引号或特殊符号`;

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
                    const extractKeywords = await fastAI.get(`${extractPrompt}${question}`, false);
                    
                    // 检查是否有关键词且不为空
                    if (!extractKeywords.trim()) {
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
                    const keywords = extractKeywords.trim();
                    
                    // 优化搜索关键词
                    const optimizedKeywords = await optimizeSearchKeywords(fastAI, keywords);
                    let searchPreview = formatSearchPreview(optimizedKeywords);
                    
                    await updateMessageStatus(ctx, waitMsg.id, 'searching', `${searchPreview} ${slowModeTip}`);
                    
                    // 执行批量搜索
                    const searchResults = await performBatchSearch(optimizedKeywords);
                    
                    // 格式化搜索结果
                    await updateMessageStatus(ctx, waitMsg.id, 'processing', slowModeTip);
                    
                    // 将搜索结果转化为提示词的一部分
                    const searchResultText = formatSearchResults(searchResults);
                    const prompt = getSearchPrompt(question, searchResultText);
                    
                    // 使用高质量AI回答问题
                    const ai = getHighQualityAI();
                    
                    // 初始化变量跟踪最新内容
                    let latestContent = '';
                    let latestThinking = '';
                    
                    try {
                        await ai.stream(
                            (content, done, thinking) => {
                                // 更新最新内容
                                latestContent = content;
                                if (thinking) latestThinking = thinking;
                                
                                // 如果流结束，进行最终更新不受节流限制
                                if (done) {
                                    // 最终更新直接发送，不使用节流机制
                                    const finalDisplayText = formatAIResponse(content, thinking);
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
                                } else {
                                    // 使用节流机制更新中间消息
                                    const displayText = formatAIResponse(content, thinking);
                                    throttledEditMessage(ctx, ctx.chatId, waitMsg.id, displayText);
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
    const emoji = STATUS_EMOJIS[status];
    let text = '';
    
    switch (status) {
        case 'thinking':
            text = `${emoji} 思考中...`;
            break;
        case 'analyzing':
            text = `${emoji} 正在分析您的问题...`;
            break;
        case 'searching':
            text = `${emoji} 正在搜索: ${additionalText}`;
            break;
        case 'processing':
            text = `${emoji} 分析搜索结果中...`;
            break;
        case 'cached':
            text = `${emoji} 使用缓存数据: ${additionalText}`;
            break;
        case 'error':
            text = `${emoji} ${additionalText}`;
            break;
        case 'limited':
            text = `${emoji} ${additionalText}`;
            break;
        default:
            text = `${emoji} ${additionalText}`;
    }
    
    // 检查状态消息是否变化
    const key = `${ctx.chatId}:${messageId}`;
    const lastContent = lastMessageContents.get(key);
    if (lastContent === text) {
        // 内容相同，跳过更新
        return;
    }
    
    // 状态消息直接更新，不受全局节流限制影响
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

// 执行搜索的辅助函数
async function performSearch(keyword: string) {
    // 使用更多的结果类型和更严格的选择器
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
                num: 8 // 请求更多结果以获得更好的筛选效果
            } 
        }
    });
    
    return {
        keyword,
        results: result
    };
}

// 格式化搜索预览
function formatSearchPreview(keywords: string): string {
    // 如果有多行关键词，只展示第一行，添加"等X个关键词"的提示
    const keywordLines = keywords.split('\n').filter(line => line.trim());
    if (keywordLines.length > 1) {
        const firstKeyword = keywordLines[0] || '';
        const preview = firstKeyword.length > 25 ? firstKeyword.slice(0, 22) + '...' : firstKeyword;
        return `${preview} 等${keywordLines.length}个关键词`;
    } else {
        // 单行关键词，如果太长就截断
        return keywords.length > 30 ? keywords.slice(0, 27) + '...' : keywords;
    }
}

// Markdown到HTML的转换辅助函数
function markdownToHtml(text: string): string {
    // 检查文本是否已经包含HTML标签，如果包含则不进行转换
    if (text.includes('<b>') || text.includes('<i>') || text.includes('<a href=')) {
        return text;
    }

    // 替换Markdown标记为HTML标记
    let htmlText = text
        // 替换标题
        .replace(/^# (.+)$/gm, '<b>$1</b>')
        .replace(/^## (.+)$/gm, '<b>$1</b>')
        .replace(/^### (.+)$/gm, '<b>$1</b>')
        
        // 替换粗体和斜体
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/\*(.+?)\*/g, '<i>$1</i>')
        .replace(/__(.+?)__/g, '<u>$1</u>')
        .replace(/~~(.+?)~~/g, '<s>$1</s>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
        
        // 替换链接
        .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
        
        // 替换列表项
        .replace(/^- (.+)$/gm, '• $1')
        .replace(/^\d+\. (.+)$/gm, '$1')
        
        // 替换水平分隔线
        .replace(/^---+$/gm, '<hr>')
        
        // 替换引用块
        .replace(/^> (.+)$/gm, '❝ <i>$1</i>')
        
        // 替换特殊字符
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        
        // 修复已经转换的HTML标签
        .replace(/&lt;b&gt;/g, '<b>')
        .replace(/&lt;\/b&gt;/g, '</b>')
        .replace(/&lt;i&gt;/g, '<i>')
        .replace(/&lt;\/i&gt;/g, '</i>')
        .replace(/&lt;u&gt;/g, '<u>')
        .replace(/&lt;\/u&gt;/g, '</u>')
        .replace(/&lt;s&gt;/g, '<s>')
        .replace(/&lt;\/s&gt;/g, '</s>')
        .replace(/&lt;code&gt;/g, '<code>')
        .replace(/&lt;\/code&gt;/g, '</code>')
        .replace(/&lt;a href=/g, '<a href=')
        .replace(/&lt;\/a&gt;/g, '</a>')
        .replace(/&lt;hr&gt;/g, '<hr>')
        .replace(/&lt;br&gt;/g, '<br>')
        .replace(/&lt;blockquote collapsible&gt;/g, '<blockquote collapsible>')
        .replace(/&lt;\/blockquote&gt;/g, '</blockquote>')
        
        // 替换换行符 (保留段落分隔)
        .replace(/\n\n/g, '<br><br>')
        .replace(/\n/g, '<br>');
    
    return htmlText;
}

// 格式化AI响应，优化思考过程显示，并转换为HTML格式
function formatAIResponse(content: string, thinking?: string): string {
    let displayText = "";
    
    // 添加思考过程（如果有），并放在最前面
    if (thinking && thinking.trim()) {
        // 清理思考过程，移除过于冗长的部分
        const cleanedThinking = cleanThinkingProcess(thinking);
        if (cleanedThinking.trim()) {
            // 为思考过程添加更清晰的结构 - 使用可折叠的blockquote
            displayText += `<blockquote collapsible>\n<b>💭 思考过程</b><br><br>${cleanedThinking}\n</blockquote><br><br>`;
        }
    }
    
    // 添加正文内容
    displayText += markdownToHtml(content);
    
    return displayText;
}

// 清理思考过程，移除过于冗长或重复的内容
function cleanThinkingProcess(thinking: string): string {
    // 预处理，替换markdown格式为HTML
    let processedThinking = thinking
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/\*(.+?)\*/g, '<i>$1</i>');
        
    // 按段落分割
    const paragraphs = processedThinking.split('\n\n').filter(p => p.trim().length > 0);
    
    // 如果段落太少，直接返回处理后的内容
    if (paragraphs.length <= 5) {
        return processedThinking;
    }
    
    // 对于较长的思考过程，进行智能筛选
    const keyParagraphs = [];
    
    // 保留第一段（通常是问题分析）
    if (paragraphs[0]) {
        keyParagraphs.push(paragraphs[0]);
    }
    
    // 查找包含关键信息的段落
    const infoKeywords = ['搜索结果', '信息', '数据', '分析', '关键点', '结论', '总结'];
    
    // 从中间段落中选择包含关键词的段落（最多2个）
    const middleParagraphs = paragraphs.slice(1, -2);
    const selectedMiddle = middleParagraphs
        .filter(p => infoKeywords.some(keyword => p.includes(keyword)))
        .slice(0, 2);
    
    keyParagraphs.push(...selectedMiddle);
    
    // 如果没有找到包含关键词的中间段落，至少选择一个中间段落
    if (selectedMiddle.length === 0 && middleParagraphs.length > 0) {
        keyParagraphs.push(middleParagraphs[Math.floor(middleParagraphs.length / 2)]);
    }
    
    // 保留最后两段（通常包含结论）
    if (paragraphs.length >= 2) {
        keyParagraphs.push(...paragraphs.slice(-2));
    }
    
    // 去重并按原始顺序排序
    const uniqueParagraphs = [...new Set(keyParagraphs)];
    
    // 在段落之间添加突出的分隔符，使思考过程更加清晰
    return uniqueParagraphs.join('<br><br><i>• • •</i><br><br>');
}

// 执行批量搜索
async function performBatchSearch(keywords: string): Promise<any[]> {
    // 分行处理多个关键词
    const keywordLines = keywords.split('\n').filter(line => line.trim());
    const results = [];
    const searchStats = {
        total: keywordLines.length,
        cached: 0,
        failed: 0,
        successful: 0
    };
    
    // 将关键词分成批次，每批次最多3个关键词
    const batches = [];
    for (let i = 0; i < keywordLines.length; i += 3) {
        batches.push(keywordLines.slice(i, i + 3));
    }
    
    // 按批次串行处理以避免过多的并行请求导致请求被限制
    for (const batch of batches) {
        const batchPromises = batch.map(keyword => {
            // 检查缓存
            const cacheKey = keyword.trim().toLowerCase();
            const cachedResult = searchCache.get(cacheKey);
            
            if (cachedResult && (Date.now() - cachedResult.timestamp) < CACHE_EXPIRY) {
                // 使用缓存结果
                log.info(`Using cached search result for: ${keyword}`);
                searchStats.cached++;
                return Promise.resolve({
                    keyword,
                    results: cachedResult.results,
                    fromCache: true
                });
            }
            
            // 执行新搜索
            return performSearch(keyword)
                .then(result => {
                    // 缓存结果
                    searchCache.set(cacheKey, {
                        timestamp: Date.now(),
                        results: result.results
                    });
                    searchStats.successful++;
                    return { ...result, fromCache: false };
                })
                .catch(err => {
                    log.error(`Search failed for "${keyword}":`, err);
                    searchStats.failed++;
                    return { keyword, results: null, fromCache: false };
                });
        });
        
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        
        // 添加短暂延迟以避免触发搜索服务的限制
        if (batches.length > 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    // 记录搜索统计信息
    log.info(`Search stats: Total=${searchStats.total}, Cached=${searchStats.cached}, Failed=${searchStats.failed}, Successful=${searchStats.successful}`);
    
    return evaluateSearchResults(results.filter(result => result.results !== null));
}

// 评估和增强搜索结果
function evaluateSearchResults(results: any[]): any[] {
    if (!results || results.length === 0) {
        return [];
    }
    
    // 对结果进行质量评估和增强
    const enhancedResults = results.map(result => {
        // 如果没有有机搜索结果，直接返回原始结果
        if (!result.results?.organic || result.results.organic.length === 0) {
            return result;
        }
        
        // 计算结果集的整体质量分数
        const qualityScores = result.results.organic.map((item: any) => getResultQualityScore(item));
        const avgScore = qualityScores.reduce((sum: number, score: number) => sum + score, 0) / qualityScores.length;
        
        // 添加结果集的质量评估
        return {
            ...result,
            quality: {
                avgScore,
                highQualityCount: qualityScores.filter((score: number) => score > 5).length,
                topScore: Math.max(...qualityScores),
                resultCount: result.results.organic.length
            }
        };
    });
    
    // 按结果质量对关键词排序
    return enhancedResults.sort((a, b) => {
        // 首先考虑缓存状态
        if (a.fromCache !== b.fromCache) {
            return a.fromCache ? 1 : -1;
        }
        
        // 如果两者都有质量评分，则按评分排序
        if (a.quality && b.quality) {
            return b.quality.avgScore - a.quality.avgScore;
        }
        
        // 如果只有一个有质量评分，优先考虑有评分的
        if (a.quality) return -1;
        if (b.quality) return 1;
        
        return 0;
    });
}

// 格式化搜索结果
function formatSearchResults(results: any[]): string {
    if (!results || results.length === 0) {
        return "未找到相关搜索结果";
    }
    
    let formatted = '';
    const processedLinks = new Set<string>(); // 用于去重，避免重复内容
    let totalQualityResults = 0;
    
    // 对每个关键词的搜索结果进行处理
    for (const item of results) {
        if (!item.results) continue;
        
        const qualityInfo = item.quality ? 
            `(平均质量: ${item.quality.avgScore.toFixed(1)}/10, 高质量结果: ${item.quality.highQualityCount}/${item.quality.resultCount})` : '';
            
        formatted += `关键词: ${item.keyword}${item.fromCache ? ' (⚡已缓存)' : ''} ${qualityInfo}\n`;
        
        // 处理特殊结果类型（字典、翻译、时间等）
        const specialResults = processSpecialResults(item.results, '');
        if (specialResults) {
            formatted += specialResults;
        }
        
        // 处理有机搜索结果
        if (item.results.organic && item.results.organic.length > 0) {
            // 优先选择更高质量的结果
            const organicResults = [...item.results.organic]
                .sort((a, b) => {
                    const aScore = getResultQualityScore(a);
                    const bScore = getResultQualityScore(b);
                    return bScore - aScore;
                });
            
            // 添加搜索结果摘要
            formatted += `网络搜索结果:\n`;
            
            // 只取高质量且非重复的结果
            let resultCount = 0;
            for (const organic of organicResults) {
                if (resultCount >= 5) break; // 最多显示5个结果
                
                // 检查链接是否已处理过（去重）
                if (processedLinks.has(organic.link)) continue;
                processedLinks.add(organic.link);
                
                // 格式化结果
                formatted += formatOrganicResult(organic);
                resultCount++;
                
                // 统计高质量结果
                const score = getResultQualityScore(organic);
                if (score > 5) totalQualityResults++;
            }
        }
        
        formatted += '----------\n';
    }
    
    // 只添加有实际帮助的质量评估信息
    if (totalQualityResults === 0 && processedLinks.size > 0) {
        formatted += `\n⚠️ 警告：未找到高质量的搜索结果，信息可能不够准确或不够全面。\n`;
    }
    
    return formatted;
}

// 处理特殊结果类型
function processSpecialResults(results: any, formattedText: string = ''): string {
    let text = formattedText;
    
    // 处理字典结果
    if (results.dictionary) {
        text += `📚 字典解释: ${results.dictionary.term} - ${results.dictionary.definition}\n`;
    }
    
    // 处理翻译结果
    if (results.translate) {
        text += `🌐 翻译: ${results.translate.source} → ${results.translate.target}\n`;
        text += `原文: ${results.translate.sourceText}\n`;
        text += `译文: ${results.translate.targetText}\n`;
    }
    
    // 处理时间结果
    if (results.time) {
        text += `⏰ 时间信息: ${results.time.display}\n`;
    }
    
    // 处理货币结果
    if (results.currency) {
        text += `💱 货币转换: ${results.currency.fromAmount} ${results.currency.fromCode} = ${results.currency.toAmount} ${results.currency.toCode}\n`;
    }
    
    return text;
}

// 格式化有机搜索结果
function formatOrganicResult(organic: any): string {
    let result = '';
    const qualityScore = getResultQualityScore(organic);
    const qualityIndicator = qualityScore > 7 ? '⭐' : (qualityScore > 4 ? '✓' : '');
    
    result += `- ${qualityIndicator} 标题: ${organic.title}\n`;
    result += `  链接: ${organic.link}\n`;
    
    // 改进摘要的处理，确保有用的部分被保留
    if (organic.snippet) {
        // 如果摘要过长，智能截断
        let snippet = organic.snippet;
        if (snippet.length > 200) {
            // 找到完整句子的结束位置进行截断
            const endPos = snippet.substr(0, 200).lastIndexOf('。');
            if (endPos > 100) {
                snippet = snippet.substr(0, endPos + 1) + '...';
            } else {
                snippet = snippet.substr(0, 197) + '...';
            }
        }
        result += `  摘要: ${snippet}\n`;
    }
    
    // 添加额外信息（如果有）
    if (organic.sitelinks && organic.sitelinks.length > 0) {
        result += `  相关链接: ${organic.sitelinks.map((link: any) => link.title).join(', ')}\n`;
    }
    
    result += '\n';
    return result;
}

// 改进：计算搜索结果质量分数
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
    if (
        link.includes('wikipedia') || 
        link.includes('baike.baidu')
    ) {
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
    const topDomains = [
        // 开发和技术网站
        'github.com', 'stackoverflow.com', 'gitlab.com', 'gitee.com', 
        'npmjs.com', 'pypi.org', 'maven.org', 'nuget.org',
        'developer.mozilla.org', 'docs.microsoft.com', 'developer.android.com',
        'developer.apple.com', 'cloud.google.com', 'aws.amazon.com',
        'codepen.io', 'replit.com', 'codesandbox.io',
        
        // 专业技术社区
        'medium.com', 'dev.to', 'hashnode.com', 'hackernoon.com',
        'zhihu.com', 'csdn.net', 'juejin.cn', 'segmentfault.com',
        'jianshu.com', 'infoq.cn', 'oschina.net', '51cto.com',
        'freecodecamp.org', 'codeproject.com', 'codecademy.com',
        
        // 大型科技公司
        'microsoft.com', 'apple.com', 'google.com', 'amazon.com',
        'ibm.com', 'oracle.com', 'intel.com', 'nvidia.com',
        'meta.com', 'facebook.com', 'twitter.com', 'linkedin.com',
        
        // 技术标准和文档
        'w3.org', 'ietf.org', 'iso.org', 'ieee.org',
        'ecma-international.org', 'whatwg.org', 'khronos.org',
        
        // 编程语言官网
        'python.org', 'javascript.info', 'ruby-lang.org', 'php.net',
        'golang.org', 'rust-lang.org', 'dart.dev', 'kotlinlang.org',
        'scala-lang.org', 'cppreference.com', 'isocpp.org',
        
        // 框架官网
        'reactjs.org', 'vuejs.org', 'angular.io', 'djangoproject.com',
        'laravel.com', 'rubyonrails.org', 'nodejs.org', 'spring.io',
        'flask.palletsprojects.com', 'svelte.dev', 'nextjs.org',
        
        // 学术和教育网站
        'researchgate.net', 'academia.edu', 'arxiv.org', 'ssrn.com',
        'jstor.org', 'sciencedirect.com', 'ieee.org', 'acm.org',
        'coursera.org', 'edx.org', 'udemy.com', 'khanacademy.org',
        'mit.edu', 'stanford.edu', 'harvard.edu', 'berkeley.edu',
        
        // 新闻和媒体
        'reuters.com', 'bloomberg.com', 'nytimes.com', 'wsj.com', 
        'washingtonpost.com', 'bbc.com', 'cnn.com', 'economist.com',
        'theguardian.com', 'time.com', 'ft.com', 'techcrunch.com',
        'wired.com', 'zdnet.com', 'theverge.com', 'engadget.com',
        'sina.com.cn', 'qq.com', 'people.com.cn', 'xinhuanet.com',
        
        // 百科和参考资料
        'wikipedia.org', 'baike.baidu.com', 'britannica.com',
        'investopedia.com', 'howstuffworks.com', 'webmd.com',
        'mayoclinic.org', 'nih.gov', 'cdc.gov', 'who.int'
    ];
    
    return topDomains.some(domain => link.includes(domain));
}

// 包含搜索结果的提示词
function getSearchPrompt(question: string, searchResults: string): string {
    return `问题：${question}

以下是基于互联网搜索整理的相关信息。请根据这些搜索结果和你的知识，提供一个全面、准确且直击问题核心的回答。

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

搜索结果:
\`\`\`
${searchResults}
\`\`\`

若搜索结果不足以全面回答问题，请基于你的知识补充必要信息，但请明确区分哪些是基于搜索结果的信息，哪些是你的知识补充。如果问题涉及最新发展或变化，请说明现有信息可能已过时。`;
}

// 优化搜索关键词 - 增强版
async function optimizeSearchKeywords(ai: any, keywords: string): Promise<string> {
    try {
        // 使用AI优化关键词
        const optimized = await ai.get(optimizeSearchPrompt.replace('${0}', keywords), false);
        
        if (optimized && optimized.trim()) {
            const optimizedKeywords = optimized.trim();
            
            // 日志记录优化效果
            log.info(`Keywords optimization: Original: "${keywords.replace(/\n/g, '; ')}" → Optimized: "${optimizedKeywords.replace(/\n/g, '; ')}"`);
            
            return optimizedKeywords;
        }
    } catch (err) {
        log.error('Failed to optimize search keywords:', err);
    }
    
    // 如果优化失败，返回原始关键词但进行基本处理
    return keywords.split('\n')
        .filter(k => k.trim().length > 0)
        .map(k => k.trim())
        .join('\n');
}

export default plugin; 