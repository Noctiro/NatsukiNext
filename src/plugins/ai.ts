import { md } from '@mtcute/bun';
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

// 使用频率限制：每个用户每天可以使用的次数
// 实现一个简单的Map代替SuperMap
class UserCount {
    private map = new Map<number, number>();
    private defaultValue: number;

    constructor(defaultValue: number) {
        this.defaultValue = defaultValue;
    }

    get(key: number): number {
        return this.map.has(key) ? this.map.get(key)! : this.defaultValue;
    }

    set(key: number, value: number): void {
        this.map.set(key, value);
    }

    getDefaultValue(): number {
        return this.defaultValue;
    }
}

const userCount = new UserCount(5); // 默认每个用户5次

// 帮助信息
const HELP = `🤖 AI助手

**使用方法:**
1. 直接使用 /ai 问题内容
2. 回复一条消息并使用 /ai 可以让AI分析该消息

**示例:**
/ai 简要介绍一下人工智能的发展历程
/ai 能帮我解释一下这段代码吗？(作为回复消息)`;

// 用于提取搜索关键词的提示词
const extractPrompt = `作为搜索意图助手，您的任务是从用户输入中提取出最核心的搜索关键词。

指南:
1. 分析用户问题的核心意图
2. 生成3-5个高度相关的关键词或短语
3. 将问题重新表述为行动导向的搜索短语
4. 优先考虑专有名词、关键术语、事件、日期或与意图直接相关的位置
5. 如果输入缺乏明确性或有意义的上下文，输出 [CANCEL]

输出规则:
- 只输出关键词或 [CANCEL]
- 不要添加额外解释、格式或注释

输入文本: `;

const plugin: BotPlugin = {
    name: 'ai',
    description: 'AI智能助手',
    version: '1.0.0',
    
    // 定义权限
    permissions: [
        {
            name: 'ai.use',
            description: '使用AI助手的权限',
            isSystem: false,
            allowedUsers: []
        }
    ],
    
    // 命令处理
    commands: [
        {
            name: 'ai',
            description: '使用AI助手回答问题，支持联网搜索',
            aliases: ['ask', 'bot'],
            requiredPermission: 'ai.use',
            async handler(ctx: CommandContext) {
                // 检查用户使用次数
                const userId = ctx.message.sender.id;
                const count = userCount.get(userId);
                
                if (count < 1) {
                    await ctx.message.replyText("⚠️ 您今日的AI使用次数已耗尽，每天会自动重置");
                    return;
                }
                
                // 减少使用次数
                userCount.set(userId, count - 1);
                
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
                    await ctx.message.replyText(md(HELP));
                    return;
                }
                
                // 开始处理请求
                const waitMsg = await ctx.message.replyText(`🔍 正在分析您的问题...${slowModeTip}`);
                if (!waitMsg?.id) {
                    log.error('Failed to send initial message');
                    return;
                }
                
                try {
                    // 提取搜索关键词
                    const fastAI = getFastAI();
                    const extractKeywords = await fastAI.get(`${extractPrompt}${question}`, false);
                    
                    if (!extractKeywords.trim() || extractKeywords.trim() === '[CANCEL]') {
                        // 不需要搜索，直接回答
                        await ctx.client.editMessage({
                            chatId: ctx.chatId,
                            message: waitMsg.id,
                            text: `🧠 思考中...${slowModeTip}`
                        });
                        
                        const ai = getHighQualityAI();
                        await ai.stream(
                            (content, done, thinking) => {
                                // 格式化内容，添加思考过程
                                let displayText = content;
                                if (thinking && thinking.trim()) {
                                    displayText += `\n\n---\n\n💭 **思考过程:**\n${thinking}`;
                                }
                                
                                ctx.client.editMessage({
                                    chatId: ctx.chatId,
                                    message: waitMsg.id,
                                    text: md(displayText)
                                }).catch(e => log.error(`更新消息失败: ${e}`));
                            },
                            question,
                            true
                        );
                    } else {
                        // 需要搜索，先进行搜索
                        const keywords = extractKeywords.trim();
                        let searchPreview = keywords.length > 30 ? keywords.slice(0, 27) + '...' : keywords;
                        
                        await ctx.client.editMessage({
                            chatId: ctx.chatId,
                            message: waitMsg.id,
                            text: `🔎 正在搜索: ${searchPreview} ${slowModeTip}`
                        });
                        
                        // 分行处理多个关键词
                        const keywordLines = keywords.split('\n').filter(line => line.trim());
                        let searchResults = [];
                        
                        for (const keyword of keywordLines) {
                            try {
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
                                    requestConfig: { params: { safe: 'off' } }
                                });
                                
                                // 只保留有用的搜索结果
                                searchResults.push({
                                    keyword,
                                    results: result
                                });
                            } catch (err) {
                                log.error(`Search failed for "${keyword}":`, err);
                            }
                        }
                        
                        // 格式化搜索结果
                        await ctx.client.editMessage({
                            chatId: ctx.chatId,
                            message: waitMsg.id,
                            text: `🧠 分析搜索结果中...${slowModeTip}`
                        });
                        
                        // 将搜索结果转化为提示词的一部分
                        const searchResultText = formatSearchResults(searchResults);
                        const prompt = getSearchPrompt(question, searchResultText);
                        
                        // 使用高质量AI回答问题
                        const ai = getHighQualityAI();
                        await ai.stream(
                            (content, done, thinking) => {
                                // 格式化内容，添加思考过程
                                let displayText = content;
                                if (thinking && thinking.trim()) {
                                    displayText += `\n\n---\n\n💭 **思考过程:**\n${thinking}`;
                                }
                                
                                ctx.client.editMessage({
                                    chatId: ctx.chatId,
                                    message: waitMsg.id,
                                    text: md(displayText)
                                }).catch(e => log.error(`更新消息失败: ${e}`));
                            },
                            prompt,
                            true
                        );
                    }
                } catch (error) {
                    log.error('AI processing error:', error);
                    await ctx.client.editMessage({
                        chatId: ctx.chatId,
                        message: waitMsg.id,
                        text: '❌ 处理请求时出错: ' + (error instanceof Error ? error.message : String(error))
                    }).catch(e => log.error(`更新错误消息失败: ${e}`));
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
                const count = userCount.get(userId);
                // 每条有效消息增加0.2次使用机会，最多到初始值的2倍
                userCount.set(userId, Math.min(userCount.getDefaultValue() * 2, count + 0.2));
            }
        }
    ]
};

// 格式化搜索结果
function formatSearchResults(results: any[]): string {
    let formatted = '';
    
    for (const item of results) {
        formatted += `关键词: ${item.keyword}\n`;
        
        if (item.results) {
            // 处理字典结果
            if (item.results.dictionary) {
                formatted += `字典解释: ${item.results.dictionary.term} - ${item.results.dictionary.definition}\n`;
            }
            
            // 处理翻译结果
            if (item.results.translate) {
                formatted += `翻译: ${item.results.translate.source} -> ${item.results.translate.target}\n`;
                formatted += `原文: ${item.results.translate.sourceText}\n`;
                formatted += `译文: ${item.results.translate.targetText}\n`;
            }
            
            // 处理时间结果
            if (item.results.time) {
                formatted += `时间信息: ${item.results.time.display}\n`;
            }
            
            // 处理货币结果
            if (item.results.currency) {
                formatted += `货币转换: ${item.results.currency.fromAmount} ${item.results.currency.fromCode} = ${item.results.currency.toAmount} ${item.results.currency.toCode}\n`;
            }
            
            // 处理有机搜索结果
            if (item.results.organic) {
                formatted += `网络搜索结果:\n`;
                
                for (const organic of item.results.organic.slice(0, 5)) { // 只取前5个结果
                    formatted += `- 标题: ${organic.title}\n`;
                    formatted += `  链接: ${organic.link}\n`;
                    formatted += `  摘要: ${organic.snippet}\n\n`;
                }
            }
        }
        
        formatted += '----------\n';
    }
    
    return formatted;
}

// 包含搜索结果的提示词
function getSearchPrompt(question: string, searchResults: string): string {
    return `问题：${question}

以下是基于自动搜索结果整理的相关信息。请根据用户的提问进行准确、具体的回答，确保内容全面且直击问题核心。

回答规则：
1. 如果引用了外部信息，请在引用内容后标注来源，格式：(来源: [媒体名](链接))
2. 当引用多个来源或复杂内容时，使用上标数字标注，如 [¹](link1)、[²](link2)，并在文末列出所有引用
3. 回答必须清晰准确，突出重点，确保内容简洁明了
4. 避免使用Markdown标题语法
5. 添加适当的表情符号，使回答更加生动

搜索结果:
\`\`\`
${searchResults}
\`\`\`

请基于以上信息回答问题，如不确定或无相关信息，请明确说明。`;
}

// 普通提示词
function getNormalPrompt(question: string): string {
    return `请对以下问题提供详细的回答，确保内容既有吸引力又信息丰富。在适当的地方可以加入轻松或幽默的元素使回答更加生动。当问题涉及专业或技术知识时，确保你的回答准确、精确且逻辑合理。

问题内容:  
${question}`;
}

export default plugin; 