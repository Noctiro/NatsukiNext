import { html, Long, type Message } from '@mtcute/bun';
import type { BotPlugin, CommandContext, EventContext, MessageEventContext, PluginEvent } from '../features';
import { log } from '../log';
import DynamicMap from '../utils/DynamicMap';
import { detectRepeatedSubstrings } from '../utils/MsgRepeatedCheck';

// --- 配置接口 ---
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

// --- 默认配置 ---
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

// 用户活动数据接口
interface UserData {
    score: number; // 当前累计分数
    consecutiveSimilarityCount: number; // 连续相似消息计数
    lastMessageTime: number; // 最后一条消息的时间戳 (秒)
    lastMessage: string; // 上一条消息内容
    lastMediaGroupID?: Long; // 上一条媒体组 ID
    timestamps: { time: number; score: number; }[]; // 消息时间戳队列，用于高频检测
    warningMessageId?: number; // 存储警告消息的 ID
    lastWarningSentTime: number; // 上次发送警告消息的时间戳 (秒)
}

// 插件状态
let config: AntiFloodConfig = { ...defaultConfig };
// 用户数据存储 - 使用 DynamicMap
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
 * 使用对数增长来平滑长度影响，避免极长消息得分暴涨
 */
function calculateLengthScore(length: number): number {
    return length > config.length.threshold
        ? config.length.weight * Math.log(length - config.length.threshold + 1)
        : 0;
}

/**
 * 检测高频发送消息
 * 基于消息时间戳队列计算当前用户是否属于高频操作
 */
function isHighFrequency(userData: UserData, messageContext: MessageEventContext, currentTime: number): boolean {
    let messageScore = config.highFrequency.forgivenessScore.default; // 默认分数

    // 根据消息类型调整分数 (从小到大判断)
    const msg = messageContext.message;
    // 媒体组检测
    if (msg.groupedId) {
        messageScore = config.highFrequency.forgivenessScore.mediaGroup;
    }
    // 转发检测
    else if (msg.forward) {
        messageScore = config.highFrequency.forgivenessScore.forward;
    }

    // 更新时间戳队列
    const windowStart = currentTime - config.highFrequency.window * 1000; // 转换为毫秒
    userData.timestamps = userData.timestamps.filter(entry => entry.time > windowStart);
    userData.timestamps.push({ time: currentTime, score: messageScore });

    // 计算时间窗口内的总分数
    const totalScoreInWindow = userData.timestamps.reduce((sum, entry) => sum + entry.score, 0);

    return totalScoreInWindow > config.highFrequency.limit;
}

/**
 * 计算两个词频映射的余弦相似度
 */
function cosineSimilarity(freqMap1: Record<string, number>, freqMap2: Record<string, number>): number {
    const allWords = new Set([...Object.keys(freqMap1), ...Object.keys(freqMap2)]);
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    allWords.forEach(word => {
        const count1 = freqMap1[word] || 0;
        const count2 = freqMap2[word] || 0;
        dotProduct += count1 * count2;
        norm1 += count1 ** 2;
        norm2 += count2 ** 2;
    });

    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
    return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * 计算消息相似度并评估惩罚分数
 * 使用余弦相似度衡量消息与上一条消息的相似性
 */
function calculateSimilarityPenalty(message: string, lastMessage: string, userData: UserData): number {
    // 消息太短或上一条消息不存在时不计算
    if (!lastMessage || message.length < 8 || lastMessage.length < 8) {
        userData.consecutiveSimilarityCount = 0; // 重置计数
        return 0;
    }

    // 简单的分词（按空格）和词频统计
    const getWordFrequency = (text: string): Record<string, number> => {
        const words = text.trim().split(/\s+/); // 按空白符分割
        const freqMap: Record<string, number> = {};
        words.forEach(word => {
            if (word) { // 忽略空字符串
                freqMap[word] = (freqMap[word] || 0) + 1;
            }
        });
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
 * 防刷屏逻辑处理核心
 * 根据用户分数判断是否触发限制并处理警告消息
 */
async function defend(ctx: MessageEventContext, userData: UserData): Promise<void> {
    if (!config.enabled) return;

    const currentTimeSec = Math.floor(Date.now() / 1000); // 当前秒级时间戳

    if (userData.score > config.limitScore) {
        try {
            // 尝试删除触发刷屏的消息
            await ctx.client.deleteMessagesById(ctx.chatId, [ctx.message.id]);
        } catch (error) {
            log.error(`[AntiFlood] 删除消息失败: ${error}`);
        }

        // 检查是否需要发送新的警告消息
        const timeSinceLastWarning = currentTimeSec - userData.lastWarningSentTime;
        if (timeSinceLastWarning >= config.warningMessageInterval) {
            // 尝试删除旧的警告消息 (如果存在)
            if (userData.warningMessageId) {
                try {
                    await ctx.client.deleteMessagesById(ctx.chatId, [userData.warningMessageId]);
                } catch (error) {
                    log.error(`[AntiFlood] 删除上一条警告消息失败: ${error}`);
                }
                userData.warningMessageId = undefined; // 清除旧 ID
            }

            // 计算预计恢复时间
            const excessScore = userData.score - config.limitScore;
            // 确保 decay.rate 不为 0，避免除零错误
            const timeToRecoverMs = config.decay.rate > 0
                ? Math.ceil((excessScore * config.decay.interval) / config.decay.rate)
                : Infinity; // 如果不衰减，则永不恢复
            const timeToRecoverSec = isFinite(timeToRecoverMs) ? (timeToRecoverMs / 1000).toFixed(1) : '永久';

            // 发送新的警告消息
            try {
                const warningText = html`<a href="tg://user?id=${ctx.message.sender.id}">${ctx.message.sender.displayName}</a> 你已触发刷屏保护<br>预计 ${timeToRecoverSec} 秒后解除限制<br>#防刷屏保护`;

                // 发送警告消息
                const warningMsg = await ctx.message.answerText(warningText);

                userData.warningMessageId = warningMsg.id; // 存储新警告消息的 ID
                userData.lastWarningSentTime = currentTimeSec; // 更新上次发送警告的时间

                // 设置定时删除新警告消息
                setTimeout(async () => {
                    try {
                        await ctx.client.deleteMessagesById(ctx.chatId, [warningMsg.id]);
                        // 如果当前删除的警告消息仍然是记录中的 ID，则清除记录
                        if (userData.warningMessageId === warningMsg.id) {
                            userData.warningMessageId = undefined;
                        }
                    } catch (error) {
                        log.error(`[AntiFlood] 自动删除警告消息失败: ${error}`);
                    }
                }, config.warningMessageDeleteAfter * 1000);
            } catch (error) {
                log.error(`[AntiFlood] 发送警告消息失败: ${error}`);
            }
        }
    } else {
        // 如果分数降到阈值以下，并且有警告消息记录，尝试删除
        if (userData.warningMessageId) {
            try {
                await ctx.client.deleteMessagesById(ctx.chatId, [userData.warningMessageId]);
                userData.warningMessageId = undefined; // 清除记录
            } catch (error) {
                log.error(`[AntiFlood] 分数降低后删除警告消息失败: ${error}`);
            }
        }
    }
}

/**
 * 主消息处理逻辑
 * 检测消息并更新用户状态，调用防刷屏处理
 */
async function processMessage(ctx: MessageEventContext): Promise<void> {
    if (!config.enabled) return;

    // 忽略编辑过的消息
    if (ctx.message.editDate) return;

    const userId = ctx.message.sender.id;
    const messageText = ctx.message.text || ''; // 获取消息文本，无则为空字符串
    const currentTimeMs = Date.now(); // 当前毫秒时间戳

    // 获取或创建用户数据
    const userData = await userActivityMap.get(userId);
    const beforeScore = userData.score;

    // --- 分数计算 ---
    let lengthScore = 0;
    let repeatPenalty = 0;
    let similarityPenalty = 0;
    let repeatInMsgPenalty = 0;
    let highFrequencyPenalty = 0; // 单独计算高频惩罚

    // 1. 长度得分
    if (messageText) {
        lengthScore = calculateLengthScore(messageText.length);
    }

    // 2. 完全重复惩罚 (仅在有消息文本时)
    if (messageText && userData.lastMessage === messageText) {
        repeatPenalty = config.repeat.penalty;
    }

    // 3. 相似度惩罚 (仅在有消息文本时)
    if (messageText) {
        similarityPenalty = calculateSimilarityPenalty(messageText, userData.lastMessage, userData);
    }

    // 4. 消息内重复子串惩罚 (仅在有消息文本时)
    if (messageText) {
        repeatInMsgPenalty = detectRepeatedSubstrings(messageText); // 返回惩罚分数
    }

    // 5. 高频发送检测 (总是执行)
    const isHighFreq = isHighFrequency(userData, ctx, currentTimeMs);
    if (isHighFreq) {
        // 直接增加大量分数，使其更容易触发限制
        highFrequencyPenalty = config.limitScore;
    }

    // --- 更新用户分数 ---
    let scoreIncrease = lengthScore + repeatPenalty + similarityPenalty + repeatInMsgPenalty + highFrequencyPenalty;
    let afterScore = userData.score + scoreIncrease;

    // 首次高分增长惩罚减免 (防止误报)
    // 条件：增长量超过阈值的20%，且增长前的分数低于阈值的60%
    if (scoreIncrease > config.limitScore * 0.2 && beforeScore < config.limitScore * 0.6) {
        const reduction = scoreIncrease * 0.3; // 减免30%的增长量
        afterScore = Math.min(beforeScore + scoreIncrease - reduction, config.limitScore - 0.1); // 确保减免后仍在限制之下一点
        log.info(`[AntiFlood] 用户 ${userId}: 首次高分增长缓解已应用. 分数: ${beforeScore.toFixed(2)} -> ${afterScore.toFixed(2)}`);
    }

    // 限制分数在 [0, maxScore] 区间
    userData.score = Math.min(Math.max(0, afterScore), config.maxScore);

    // --- 轻度警告 ---
    // 条件：分数超过阈值的60%，增长量大于等于1，且分数低于阈值
    if (userData.score > config.limitScore * 0.6 && scoreIncrease >= 1 && userData.score < config.limitScore) {
        try {
            const warningText = html`检测到风险行为，请停止刷屏/重复消息 ${userData.score.toFixed(1)}/${config.limitScore.toFixed(1)} (${(userData.score / config.limitScore * 100).toFixed(1)}%)`;
            const mildWarningMsg = await ctx.message.replyText(warningText);

            // 短暂显示后删除
            setTimeout(async () => {
                try {
                    await ctx.client.deleteMessagesById(ctx.chatId, [mildWarningMsg.id]);
                } catch (err) { /* 忽略删除错误 */ }
            }, 3000); // 显示 3 秒
        } catch (error) {
            log.error(`[AntiFlood] 发送轻度警告失败: ${error}`);
        }
    }

    // --- 执行防刷屏核心逻辑 ---
    await defend(ctx, userData);

    // --- 更新用户状态 ---
    userData.lastMessage = messageText; // 存储当前消息文本
    userData.lastMessageTime = Math.floor(currentTimeMs / 1000); // 存储当前消息时间戳 (秒)

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

                // 确定目标用户 ID 和名称
                let targetUserId = ctx.message.sender.id;
                let targetName = ctx.message.sender.displayName;

                // 如果是回复消息，获取被回复用户的ID和名称
                if (ctx.message.replyToMessage) {
                    const replyMsg = ctx.message.replyToMessage;
                    // targetUserId = replyMsg.raw.replyFrom?.fromId?.user.;
                    targetName = replyMsg.sender?.displayName!;
                }

                const targetUserData = await userActivityMap.get(targetUserId);
                const isAdmin = ctx.hasPermission('antiflood.admin');

                if (isAdmin && subCommand === "reset") {
                    userActivityMap.reset(targetUserId); // 重置目标用户数据
                    await ctx.message.replyText(`${targetName} 的警报值已重置。`);
                }
                else if (isAdmin && subCommand === "detail") {
                    // 移除循环引用或大型对象，准备序列化
                    const { timestamps, ...simpleUserData } = targetUserData;
                    const displayData = {
                        ...simpleUserData,
                        timestampCount: timestamps.length, // 显示时间戳数量代替完整列表
                        lastTimestamp: timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]!.time).toISOString() : 'N/A'
                    };

                    try {
                        // 使用 JSON.stringify 提供更简洁的输出
                        const output = JSON.stringify(displayData, null, 2);
                        await ctx.message.replyText(`${output}`);
                    } catch (error) {
                        log.error(`[AntiFlood] 检查用户数据时出错: ${error}`);
                        await ctx.message.replyText("无法显示用户详细数据。");
                    }
                }
                else if (isAdmin && subCommand === "enable") {
                    config.enabled = true;
                    await ctx.client.features.savePluginConfig('antiflood', config);
                    await ctx.message.replyText("✅ 防刷屏功能已启用");
                }
                else if (isAdmin && subCommand === "disable") {
                    config.enabled = false;
                    await ctx.client.features.savePluginConfig('antiflood', config);
                    await ctx.message.replyText("✅ 防刷屏功能已禁用");
                }
                else {
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
