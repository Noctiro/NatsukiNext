import { html, Long, type Message } from '@mtcute/bun';
import type { BotPlugin, CommandContext, EventContext, MessageEventContext, PluginEvent } from '../features';
import { log } from '../log';
import DynamicMap from '../utils/DynamicMap';
import { detectRepeatedSubstrings } from '../utils/MsgRepeatedCheck';

/**
 * 防刷屏插件配置接口
 * 定义插件的所有可配置选项
 */
interface AntiFloodConfig {
    enabled: boolean;
    maxScore: number;
    limitScore: number;
    decay: {
        interval: number; // ms
        rate: number;
    };
    length: {
        threshold: number;
        weight: number;
    };
    repeat: {
        penalty: number;
    };
    similarity: {
        threshold: number;
        penaltyBase: number;
        incrementalFactor: number;
    };
    highFrequency: {
        limit: number;
        window: number; // seconds
        forgivenessScore: {
            mediaGroup: number;
            forward: number;
            default: number;
        };
    };
    warningMessageInterval: number; // seconds
    warningMessageDeleteAfter: number; // seconds
}

/**
 * 默认配置值
 */
const defaultConfig: AntiFloodConfig = {
    enabled: true,
    maxScore: 30, // 用户分数的最大值
    limitScore: 15, // 触发刷屏保护的分数阈值
    decay: {
        interval: 15000, // 分数衰减的时间间隔（毫秒）
        rate: 0.7, // 每次分数衰减的值
    },
    length: {
        threshold: 150, // 消息长度的阈值
        weight: 0.2, // 消息长度得分的权重
    },
    repeat: {
        penalty: 5, // 重复消息的惩罚分数
    },
    similarity: {
        threshold: 0.8, // 消息相似度阈值
        penaltyBase: 5, // 相似度惩罚的基础常量
        incrementalFactor: 0.2, // 连续相似消息的递增惩罚比例
    },
    highFrequency: {
        limit: 3, // 高频检测的分数阈值
        window: 4, // 高频检测的时间窗口（秒）
        forgivenessScore: {
            mediaGroup: 0.11, // 媒体组
            forward: 0.18, // 转发
            default: 1.0, // 默认消息分数
        },
    },
    warningMessageInterval: 10, // 警告消息发送的间隔时间（秒）
    warningMessageDeleteAfter: 30, // 警告消息自动删除时间（秒）
};

/**
 * 用户活动数据接口
 * 存储用户的消息状态和行为特征
 */
interface UserData {
    score: number;                      // 当前累计分数
    consecutiveSimilarityCount: number; // 连续相似消息计数
    lastMessageTime: number;            // 最后一条消息的时间戳（秒）
    lastMessage: string;                // 上一条消息内容
    lastMediaGroupID?: Long;            // 上一条媒体组ID
    timestamps: { time: number; score: number; }[]; // 消息时间戳队列，用于高频检测
    warningMessageId?: number;          // 当前警告消息的ID
    lastWarningSentTime: number;        // 上次发送警告的时间戳（秒）
}

// 插件配置状态（运行时）
let config: AntiFloodConfig = { ...defaultConfig };

// 用户数据存储
const userActivityMap = new DynamicMap<number, UserData>(() => ({
    score: 0,
    consecutiveSimilarityCount: 0,
    lastMessageTime: 0,
    lastMessage: '',
    timestamps: [],
    lastWarningSentTime: 0,
}));

// 分数衰减任务的间隔ID
let decayIntervalId: NodeJS.Timeout | undefined;

/**
 * 计算消息长度得分
 * 使用对数增长平滑长度影响，避免极长消息得分暴涨
 * @param length 消息长度
 * @returns 长度得分
 */
function calculateLengthScore(length: number): number {
    return length > config.length.threshold
        ? config.length.weight * Math.log(length - config.length.threshold + 1)
        : 0;
}

/**
 * 检测高频发送消息行为
 * @param userData 用户数据
 * @param messageContext 消息上下文
 * @param currentTime 当前时间戳（毫秒）
 * @returns 是否为高频发送
 */
function isHighFrequency(userData: UserData, messageContext: MessageEventContext, currentTime: number): boolean {
    // 根据消息类型确定分数
    const msg = messageContext.message;
    let messageScore = config.highFrequency.forgivenessScore.default;
    
    if (msg.groupedId) {
        messageScore = config.highFrequency.forgivenessScore.mediaGroup;
    } else if (msg.forward) {
        messageScore = config.highFrequency.forgivenessScore.forward;
    }

    // 清理过期时间戳并添加新时间戳
    const windowStart = currentTime - config.highFrequency.window * 1000;
    userData.timestamps = userData.timestamps.filter(entry => entry.time > windowStart);
    userData.timestamps.push({ time: currentTime, score: messageScore });

    // 计算时间窗口内的总分数
    const totalScoreInWindow = userData.timestamps.reduce((sum, entry) => sum + entry.score, 0);

    return totalScoreInWindow > config.highFrequency.limit;
}

/**
 * 计算两个词频映射的余弦相似度
 * @param freqMap1 第一个词频映射
 * @param freqMap2 第二个词频映射
 * @returns 相似度分数 (0-1)
 */
function cosineSimilarity(freqMap1: Record<string, number>, freqMap2: Record<string, number>): number {
    // 获取所有不重复的词
    const allWords = new Set([...Object.keys(freqMap1), ...Object.keys(freqMap2)]);
    
    // 边缘情况处理：任意一个映射为空时返回0
    if (allWords.size === 0) return 0;
    
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    // 计算点积和向量范数
    allWords.forEach(word => {
        const count1 = freqMap1[word] || 0;
        const count2 = freqMap2[word] || 0;
        dotProduct += count1 * count2;
        norm1 += count1 ** 2;
        norm2 += count2 ** 2;
    });

    // 计算余弦相似度
    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
    return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * 计算消息相似度并评估惩罚分数
 * @param message 当前消息
 * @param lastMessage 上一条消息
 * @param userData 用户数据
 * @returns 相似度惩罚分数
 */
function calculateSimilarityPenalty(message: string, lastMessage: string, userData: UserData): number {
    // 消息太短或上一条消息不存在时不计算
    if (!lastMessage || message.length < 8 || lastMessage.length < 8) {
        userData.consecutiveSimilarityCount = 0;
        return 0;
    }

    // 简单的分词和词频统计
    const getWordFrequency = (text: string): Record<string, number> => {
        const words = text.trim().split(/\s+/); // 按空白符分割
        const freqMap: Record<string, number> = {};
        
        for (const word of words) {
            if (word) {
                freqMap[word] = (freqMap[word] || 0) + 1;
            }
        }
        
        return freqMap;
    };

    const freqMap1 = getWordFrequency(message);
    const freqMap2 = getWordFrequency(lastMessage);

    // 如果任一消息没有有效词语，则不计算相似度
    if (Object.keys(freqMap1).length === 0 || Object.keys(freqMap2).length === 0) {
        userData.consecutiveSimilarityCount = 0;
        return 0;
    }

    const similarityScore = cosineSimilarity(freqMap1, freqMap2);

    if (similarityScore > config.similarity.threshold) {
        // 基础惩罚分，使用对数平滑
        let penalty = Math.log(similarityScore + 1) * config.similarity.penaltyBase;
        // 连续相似惩罚加成
        penalty *= 1 + userData.consecutiveSimilarityCount * config.similarity.incrementalFactor;
        userData.consecutiveSimilarityCount++;
        return penalty;
    } else {
        userData.consecutiveSimilarityCount = 0; // 重置连续相似计数
        return 0;
    }
}

/**
 * 尝试删除消息，错误时记录日志但不抛出异常
 * @param ctx 消息上下文
 * @param messageId 要删除的消息ID
 * @param logPrefix 日志前缀
 */
async function safeDeleteMessage(ctx: MessageEventContext, messageId: number, logPrefix: string): Promise<void> {
    try {
        await ctx.client.deleteMessagesById(ctx.chatId, [messageId]);
    } catch (error) {
        log.error(`${logPrefix} 删除消息失败: ${error}`);
    }
}

/**
 * 防刷屏核心逻辑
 * 根据用户分数判断是否触发限制并处理警告消息
 * @param ctx 消息上下文
 * @param userData 用户数据
 */
async function defend(ctx: MessageEventContext, userData: UserData): Promise<void> {
    if (!config.enabled) return;

    const currentTimeSec = Math.floor(Date.now() / 1000);

    if (userData.score > config.limitScore) {
        // 删除触发刷屏的消息
        await safeDeleteMessage(ctx, ctx.message.id, "[AntiFlood]");

        // 检查是否需要发送新的警告消息
        const timeSinceLastWarning = currentTimeSec - userData.lastWarningSentTime;
        if (timeSinceLastWarning >= config.warningMessageInterval) {
            // 删除旧警告消息（如果存在）
            if (userData.warningMessageId) {
                await safeDeleteMessage(ctx, userData.warningMessageId, "[AntiFlood]");
                userData.warningMessageId = undefined;
            }

            // 计算预计恢复时间
            const excessScore = userData.score - config.limitScore;
            // 确保 decay.rate 不为 0，避免除零错误
            const timeToRecoverMs = config.decay.rate > 0
                ? Math.ceil((excessScore * config.decay.interval) / config.decay.rate)
                : Infinity; // 如果不衰减，则永不恢复
            const timeToRecoverSec = isFinite(timeToRecoverMs) ? (timeToRecoverMs / 1000).toFixed(1) : '永久';

            try {
                // 发送新的警告消息
                const warningText = html`<a href="tg://user?id=${ctx.message.sender.id}">${ctx.message.sender.displayName}</a> 你已触发刷屏保护<br>预计 ${timeToRecoverSec} 秒后解除限制<br>#防刷屏保护`;
                const warningMsg = await ctx.message.answerText(warningText);

                userData.warningMessageId = warningMsg.id; // 存储新警告消息的 ID
                userData.lastWarningSentTime = currentTimeSec; // 更新上次发送警告的时间

                // 设置定时删除警告消息
                setTimeout(async () => {
                    if (userData.warningMessageId === warningMsg.id) {
                        await safeDeleteMessage(ctx, warningMsg.id, "[AntiFlood]");
                        userData.warningMessageId = undefined;
                    }
                }, config.warningMessageDeleteAfter * 1000);
            } catch (error) {
                log.error(`[AntiFlood] 发送警告消息失败: ${error}`);
            }
        }
    } else if (userData.warningMessageId) {
        // 如果分数降到阈值以下，并且有警告消息，则删除
        await safeDeleteMessage(ctx, userData.warningMessageId, "[AntiFlood]");
        userData.warningMessageId = undefined;
    }
}

/**
 * 主消息处理逻辑
 * 检测消息并更新用户状态，调用防刷屏处理
 * @param ctx 消息上下文
 */
async function processMessage(ctx: MessageEventContext): Promise<void> {
    if (!config.enabled) return;

    // 忽略编辑过的消息
    if (ctx.message.editDate) return;

    const userId = ctx.message.sender.id;
    const messageText = ctx.message.text || '';
    const currentTimeMs = Date.now();

    // 获取用户数据
    const userData = await userActivityMap.get(userId);
    const beforeScore = userData.score;

    // --- 分数计算 ---
    let scoreIncrease = 0;
    
    // 1. 长度得分
    if (messageText) {
        scoreIncrease += calculateLengthScore(messageText.length);
        
        // 2. 完全重复惩罚
        if (userData.lastMessage === messageText) {
            scoreIncrease += config.repeat.penalty;
        }
        
        // 3. 相似度惩罚
        scoreIncrease += calculateSimilarityPenalty(messageText, userData.lastMessage, userData);
        
        // 4. 消息内重复子串惩罚
        scoreIncrease += detectRepeatedSubstrings(messageText);
    }
    
    // 5. 高频发送检测
    if (isHighFrequency(userData, ctx, currentTimeMs)) {
        scoreIncrease += config.limitScore; // 高频消息直接添加阈值分数
    }

    // 更新用户分数
    let afterScore = userData.score + scoreIncrease;

    // 首次高分增长惩罚减免（防止误报）
    if (scoreIncrease > config.limitScore * 0.2 && beforeScore < config.limitScore * 0.6) {
        const reduction = scoreIncrease * 0.3;
        afterScore = Math.min(beforeScore + scoreIncrease - reduction, config.limitScore - 0.1);
        log.info(`[AntiFlood] 用户 ${userId}: 首次高分增长缓解已应用. 分数: ${beforeScore.toFixed(2)} -> ${afterScore.toFixed(2)}`);
    }

    // 限制分数范围
    userData.score = Math.min(Math.max(0, afterScore), config.maxScore);

    // 轻度警告（分数接近阈值时）
    if (userData.score > config.limitScore * 0.6 && scoreIncrease >= 1 && userData.score < config.limitScore) {
        try {
            const warningText = html`检测到风险行为，请停止刷屏/重复消息 ${userData.score.toFixed(1)}/${config.limitScore.toFixed(1)} (${(userData.score / config.limitScore * 100).toFixed(1)}%)`;
            const mildWarningMsg = await ctx.message.replyText(warningText);

            // 短暂显示后删除
            setTimeout(() => safeDeleteMessage(ctx, mildWarningMsg.id, "[AntiFlood]"), 3000);
        } catch (error) {
            log.error(`[AntiFlood] 发送轻度警告失败: ${error}`);
        }
    }

    // 执行防刷屏核心逻辑
    await defend(ctx, userData);

    // 更新用户状态
    userData.lastMessage = messageText;
    userData.lastMessageTime = Math.floor(currentTimeMs / 1000);
    
    if (ctx.message.groupedId) {
        userData.lastMediaGroupID = ctx.message.groupedId; // 更新媒体组 ID
    }
}

// 插件定义
const plugin: BotPlugin = {
    name: 'antiflood',
    description: '防刷屏插件，检测并限制消息刷屏行为',
    version: '1.0.0',

    // 声明权限
    permissions: [
        {
            name: 'antiflood.admin',
            description: '防刷屏插件管理权限',
            isSystem: true,
            parent: 'admin'
        },
        {
            name: 'antiflood.exempt',
            description: '免除防刷屏检测的权限',
            isSystem: false,
            allowedUsers: []
        }
    ],

    // 加载时执行
    async onLoad(client) {
        log.info('防刷屏插件加载中...');

        // 加载配置
        config = await client.features.getPluginConfig<AntiFloodConfig>('antiflood', defaultConfig);

        // 初始化分数衰减定时任务
        decayIntervalId = setInterval(() => {
            userActivityMap.forEach(userData => {
                userData.score = Math.max(0, userData.score - config.decay.rate);
            });
        }, config.decay.interval);

        log.info(`防刷屏插件已加载，当前状态: ${config.enabled ? '已启用' : '已禁用'}`);
    },

    // 卸载时执行
    async onUnload() {
        // 清除定时任务
        if (decayIntervalId) {
            clearInterval(decayIntervalId);
            decayIntervalId = undefined;
        }
        log.info('防刷屏插件已卸载');
    },

    // 命令处理
    commands: [
        {
            name: 'antiflood',
            aliases: ['flood'],
            description: '防刷屏设置和查询',
            async handler(ctx: CommandContext) {
                const subCommand = ctx.args[0]?.toLowerCase() || '';

                // 确定目标用户ID和名称
                let targetUserId = ctx.message.sender.id;
                let targetName = ctx.message.sender.displayName;

                // 如果是回复消息，获取被回复用户的名称
                if (ctx.message.replyToMessage && ctx.message.replyToMessage.sender) {
                    const replyMsg = ctx.message.replyToMessage;
                    if (replyMsg.sender) {
                        // 使用类型安全的方式检查sender类型并获取ID
                        if ('id' in replyMsg.sender) {
                            targetUserId = replyMsg.sender.id;
                        }
                        targetName = replyMsg.sender.displayName;
                    }
                }

                const targetUserData = await userActivityMap.get(targetUserId);
                const isAdmin = ctx.hasPermission('antiflood.admin');

                switch (subCommand) {
                    case "reset":
                        if (!isAdmin) {
                            await ctx.message.replyText("⚠️ 需要管理员权限");
                            return;
                        }
                        userActivityMap.reset(targetUserId);
                        await ctx.message.replyText(`${targetName} 的警报值已重置。`);
                        break;
                        
                    case "detail":
                        if (!isAdmin) {
                            await ctx.message.replyText("⚠️ 需要管理员权限");
                            return;
                        }
                        
                        try {
                            const { timestamps, ...simpleUserData } = targetUserData;
                            const displayData = {
                                ...simpleUserData,
                                timestampCount: timestamps.length,
                                lastTimestamp: timestamps.length > 0 
                                    ? (() => {
                                        const lastTime = timestamps[timestamps.length - 1]?.time;
                                        return lastTime ? new Date(lastTime).toISOString() : 'N/A';
                                      })()
                                    : 'N/A'
                            };
                            
                            await ctx.message.replyText(JSON.stringify(displayData, null, 2));
                        } catch (error) {
                            log.error(`[AntiFlood] 检查用户数据时出错: ${error}`);
                            await ctx.message.replyText("无法显示用户详细数据。");
                        }
                        break;
                        
                    case "enable":
                        if (!isAdmin) {
                            await ctx.message.replyText("⚠️ 需要管理员权限");
                            return;
                        }
                        
                        config.enabled = true;
                        await ctx.client.features.savePluginConfig('antiflood', config);
                        await ctx.message.replyText("✅ 防刷屏功能已启用");
                        break;
                        
                    case "disable":
                        if (!isAdmin) {
                            await ctx.message.replyText("⚠️ 需要管理员权限");
                            return;
                        }
                        
                        config.enabled = false;
                        await ctx.client.features.savePluginConfig('antiflood', config);
                        await ctx.message.replyText("✅ 防刷屏功能已禁用");
                        break;
                        
                    default:
                        // 默认显示分数
                        const score = targetUserData.score;
                        const status = score >= config.limitScore ? ' [限制中]' : '';
                        await ctx.message.replyText(`${targetName} 的警报值为: ${score.toFixed(3)}${status}`);
                }
            }
        }
    ],

    // 事件处理
    events: [
        {
            type: 'message',
            priority: 90, // 高优先级，确保先于大多数消息处理器执行
            filter: (ctx: EventContext) => {
                if (ctx.type !== 'message') return false;
                if (!config.enabled) return false;

                // 排除命令消息
                if (ctx.message.text?.startsWith('/')) return false;

                // 检查用户是否有豁免权限
                return !ctx.hasPermission('antiflood.exempt');
            },
            handler: async (ctx: MessageEventContext) => {
                await processMessage(ctx);
            }
        } as PluginEvent<MessageEventContext>
    ]
};

export default plugin;
