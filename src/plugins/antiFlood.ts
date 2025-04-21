import { html, Long } from '@mtcute/bun';
import type { BotPlugin, CommandContext, EventContext, MessageEventContext, PluginEvent } from '../features';
import DynamicMap from '../utils/DynamicMap';

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
        historyTimeWindow: number;    // 重复消息历史记录的时间窗口（毫秒）
        exponentialBase: number;      // 指数惩罚的基数
        maxRepetitionMultiplier: number; // 重复惩罚的最大倍数
    };
    highFrequency: {
        limit: number;
        window: number; // seconds
        penalty: number; // Penalty score for triggering high frequency
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
        rate: 0.1, // 分数每次衰减的比例 (e.g., 0.1 = 10%)
    },
    length: {
        threshold: 150, // 消息长度的阈值
        weight: 0.2, // 消息长度得分的权重
    },
    repeat: {
        penalty: 5, // 重复消息的基础惩罚分数
        historyTimeWindow: 180000, // 重复消息历史记录的时间窗口（3分钟）
        exponentialBase: 1.5, // 指数惩罚的基数
        maxRepetitionMultiplier: 5.0 // 重复惩罚的最大倍数
    },
    highFrequency: {
        limit: 3, // 高频检测的分数阈值
        window: 4, // 高频检测的时间窗口（秒）
        penalty: 8, // 触发高频的惩罚分数
        forgivenessScore: {
            mediaGroup: 0.11, // 媒体组
            forward: 0.18, // 转发
            default: 1.0, // 默认消息分数
        },
    },
    warningMessageInterval: 10, // 警告消息发送的间隔时间（秒）
    warningMessageDeleteAfter: 30, // 警告消息自动删除时间（秒）
};

// 插件配置状态（运行时）
let config: AntiFloodConfig = { ...defaultConfig };

/**
 * 用户活动数据接口 - 结构优化，按功能分组
 * 存储用户的消息状态和行为特征
 */
interface UserData {
    // 核心评分数据
    score: {
        current: number;                    // 当前累计分数
        lastIncrease: number;               // 上次分数增加值（用于调试）
    };

    // 消息内容特征
    content: {
        lastMessage: string;                // 上一条消息内容
        lastMessageTime: number;            // 最后一条消息的时间戳（秒）
        lastMediaGroupID?: Long;            // 上一条媒体组ID
        consecutiveSimilarityCount: number; // 连续相似消息计数
    };

    // 重复检测数据 - 简化为仅保留最近一条消息和时间列表
    repetition: {
        lastMessage: string;                // 最后一条消息记录
        timestamps: number[];               // 消息时间戳列表（毫秒）
    };

    // 高频检测数据
    frequency: {
        timestamps: [number, number][];     // [时间戳, 分数贡献]
        scoreSum: number;                   // 当前窗口内的分数总和
    };

    // 警告消息状态
    warnings: {
        messageId?: number;                 // 当前警告消息的ID
        lastSentTime: number;               // 上次发送警告的时间戳（秒）
    };
}

// 扩展DynamicMap类型以包含delete方法
interface UserDynamicMap<K, V> {
    get(key: K): Promise<V>;
    forEach(fn: (value: V, key: K) => void): void;
    delete?(key: K): void;
    reset(key: K): void;
}

// 用户数据存储 - 使用新的结构初始化
const userActivityMap = new DynamicMap<number, UserData>(() => ({
    score: {
        current: 0,
        lastIncrease: 0
    },
    content: {
        lastMessage: '',
        lastMessageTime: 0,
        consecutiveSimilarityCount: 0
    },
    repetition: {
        lastMessage: null,
        timestamps: []
    },
    frequency: {
        timestamps: [],
        scoreSum: 0
    },
    warnings: {
        lastSentTime: 0
    }
})) as UserDynamicMap<number, UserData>;

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
 * @param currentTimeMs 当前时间戳（毫秒）
 * @returns 触发高频检测时应增加的分数 (penalty or 0)
 */
function calculateHighFrequencyPenalty(userData: UserData, messageContext: MessageEventContext, currentTimeMs: number): number {
    const windowMillis = config.highFrequency.window * 1000;
    const windowStart = currentTimeMs - windowMillis;

    // 1. Remove expired timestamps and subtract their score from the sum
    let expiredScoreSum = 0;
    let firstValidIndex = 0;
    for (let i = 0; i < userData.frequency.timestamps.length; i++) {
        const timestampEntry = userData.frequency.timestamps[i];
        // Although the loop condition should prevent this, adding a check for robustness
        // and to satisfy stricter compiler checks.
        if (!timestampEntry) continue;

        if (timestampEntry[0] <= windowStart) {
            expiredScoreSum += timestampEntry[1];
            firstValidIndex = i + 1;
        } else {
            break; // Timestamps are ordered, no need to check further
        }
    }
    if (firstValidIndex > 0) {
        userData.frequency.timestamps.splice(0, firstValidIndex); // Efficiently remove expired entries
        userData.frequency.scoreSum -= expiredScoreSum;
    }
    // Ensure sum doesn't drift due to potential floating point issues
    userData.frequency.scoreSum = Math.max(0, userData.frequency.scoreSum);


    // 2. Determine score contribution of the current message
    const msg = messageContext.message;
    let currentMessageScore = config.highFrequency.forgivenessScore.default;
    if (msg.groupedId) {
        // Optimization: If part of the same media group as the last message, maybe score it 0?
        // This prevents penalizing rapid uploads within a single group.
        if (userData.content.lastMediaGroupID && userData.content.lastMediaGroupID.equals(msg.groupedId)) {
            currentMessageScore = 0; // No penalty for subsequent messages in the *same* group
        } else {
            currentMessageScore = config.highFrequency.forgivenessScore.mediaGroup;
            userData.content.lastMediaGroupID = msg.groupedId; // Update last seen group ID
        }
    } else if (msg.forward) {
        currentMessageScore = config.highFrequency.forgivenessScore.forward;
        userData.content.lastMediaGroupID = undefined; // Reset last media group ID
    } else {
        userData.content.lastMediaGroupID = undefined; // Reset last media group ID
    }


    // 3. Add current message's timestamp and score
    if (currentMessageScore > 0) { // Only add if it contributes score
        userData.frequency.timestamps.push([currentTimeMs, currentMessageScore]);
        userData.frequency.scoreSum += currentMessageScore;
    }

    // 4. Check if the limit is exceeded
    if (userData.frequency.scoreSum > config.highFrequency.limit) {
        // Return the penalty, but don't apply it directly to userData.score here.
        // Let the main processing logic handle the total score increase.
        return config.highFrequency.penalty;
    }

    return 0; // No high-frequency penalty triggered
}

/**
 * 尝试删除消息，错误时记录日志但不抛出异常
 * @param client The mtcute client instance
 * @param chatId The chat ID where the message exists
 * @param messageId 要删除的消息ID
 */
async function safeDeleteMessage(client: MessageEventContext['client'], chatId: number | string, messageId: number): Promise<void> {
    try {
        await client.deleteMessagesById(chatId, [messageId]);
    } catch (error) {
        plugin.logger?.error(`删除消息失败: ${error}`);
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

    if (userData.score.current > config.limitScore) {
        // 删除触发刷屏的消息
        await safeDeleteMessage(ctx.client, ctx.chatId, ctx.message.id);

        // 检查是否需要发送新的警告消息
        const timeSinceLastWarning = currentTimeSec - userData.warnings.lastSentTime;
        if (timeSinceLastWarning >= config.warningMessageInterval) {
            // 删除旧警告消息（如果存在）
            if (userData.warnings.messageId) {
                await safeDeleteMessage(ctx.client, ctx.chatId, userData.warnings.messageId);
                userData.warnings.messageId = undefined;
            }

            // 计算预计恢复时间 (using multiplicative decay logic)
            let timeToRecoverSec: string | number = '永久'; // Default to permanent if decay rate is 0 or less

            if (config.decay.rate > 0 && config.decay.rate < 1) {
                // Formula derivation:
                // We want to find the number of intervals 'n' such that:
                // final_score = initial_score * (1 - decay_rate)^n
                // We need final_score <= limitScore
                // initial_score * (1 - decay_rate)^n <= limitScore
                // (1 - decay_rate)^n <= limitScore / initial_score
                // Taking logarithm (base e or 10, doesn't matter):
                // n * log(1 - decay_rate) <= log(limitScore / initial_score)
                // Since (1 - decay_rate) is between 0 and 1, its logarithm is negative.
                // Dividing by a negative number flips the inequality sign:
                // n >= log(limitScore / initial_score) / log(1 - decay_rate)
                // We need the smallest integer n satisfying this, so we use Math.ceil().
                const decayFactor = 1 - config.decay.rate;
                // Ensure score is actually above limit and decay factor is valid for calculation
                if (userData.score.current > config.limitScore && decayFactor > 0 && decayFactor < 1) {
                    const numerator = Math.log(config.limitScore / userData.score.current);
                    const denominator = Math.log(decayFactor);
                    // Check for potential division by zero or invalid log results, though decayFactor check helps
                    if (denominator !== 0 && isFinite(numerator) && isFinite(denominator)) {
                        const numIntervals = Math.ceil(numerator / denominator);
                        const timeToRecoverMs = numIntervals * config.decay.interval;
                        // Ensure result is non-negative and finite
                        timeToRecoverSec = (isFinite(timeToRecoverMs) && timeToRecoverMs >= 0) ? (timeToRecoverMs / 1000).toFixed(1) : '计算错误';
                    } else {
                        timeToRecoverSec = '计算错误'; // Error case
                    }
                } else if (userData.score.current <= config.limitScore) {
                    timeToRecoverSec = 0; // Already below limit
                }
                // If decay rate is 0 or >= 1, timeToRecoverSec remains '永久' unless already below limit
            } else if (userData.score.current <= config.limitScore) {
                timeToRecoverSec = 0; // Already below limit
            }


            try {
                // 发送新的警告消息
                const warningText = html`<a href="tg://user?id=${ctx.message.sender.id}">${ctx.message.sender.displayName}</a> 你已触发刷屏保护<br>预计 ${timeToRecoverSec} 秒后解除限制<br>#防刷屏保护`;
                const warningMsg = await ctx.message.answerText(warningText);

                userData.warnings.messageId = warningMsg.id; // 存储新警告消息的 ID
                userData.warnings.lastSentTime = currentTimeSec; // 更新上次发送警告的时间

                // 设置定时删除警告消息
                setTimeout(async () => {
                    // Need client and chatId again for the delayed deletion
                    if (userData.warnings.messageId === warningMsg.id) {
                        await safeDeleteMessage(ctx.client, ctx.chatId, warningMsg.id);
                        userData.warnings.messageId = undefined; // Clear ID only after successful deletion attempt
                    }
                }, config.warningMessageDeleteAfter * 1000);
            } catch (error) {
                plugin.logger?.error(`发送警告消息失败: ${error}`);
            }
        }
    } else if (userData.warnings.messageId) {
        // 如果分数降到阈值以下，并且有警告消息，则删除
        await safeDeleteMessage(ctx.client, ctx.chatId, userData.warnings.messageId);
        userData.warnings.messageId = undefined;
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

    // --- 统一计算分数增量 ---
    let scoreIncrease = 0;
    let highFrequencyPenalty = 0;

    // 1. 高频发送检测 - 不论消息内容，任何消息都应计入发送频率
    highFrequencyPenalty = calculateHighFrequencyPenalty(userData, ctx, currentTimeMs);
    scoreIncrease += highFrequencyPenalty;

    // 2. 基于文本内容的评分 (only if message has text)
    if (messageText) {
        // 2a. 长度得分
        scoreIncrease += calculateLengthScore(messageText.length);

        // 2b. 重复消息历史处理 - 简化版本
        const historyWindowStart = currentTimeMs - config.repeat.historyTimeWindow;

        // 清理过期时间戳
        userData.repetition.timestamps = userData.repetition.timestamps.filter(
            timestamp => timestamp >= historyWindowStart
        );

        // 检查当前消息是否与记录的最后一条消息相同
        if (userData.repetition.lastMessage && userData.repetition.timestamps.length > 0) {
            // 重复消息检测
            if (userData.repetition.lastMessage === messageText) {
                // 添加当前消息时间戳
                userData.repetition.timestamps.push(currentTimeMs);

                // 计算指数增长惩罚值 - 基于连续重复次数
                const repetitionFactor = Math.min(
                    Math.pow(config.repeat.exponentialBase, userData.repetition.timestamps.length - 1),
                    config.repeat.maxRepetitionMultiplier
                );

                // 计算短时间内消息密度 - 基于时间窗口内消息数量
                const messageDensity = Math.min(2.0, userData.repetition.timestamps.length / 3);

                // 最终重复惩罚分数 - 结合重复次数和消息密度
                const repetitionPenalty = config.repeat.penalty * repetitionFactor * messageDensity;
                scoreIncrease += repetitionPenalty;

                // 记录本次增加的分数，用于调试
                userData.score.lastIncrease = repetitionPenalty;
            } else {
                // 消息内容不同，创建新记录
                userData.repetition.lastMessage = messageText;
                userData.repetition.timestamps = [currentTimeMs];
            }
        } else {
            // 没有最近记录或记录已过期，创建新记录
            userData.repetition.lastMessage = messageText;
            userData.repetition.timestamps = [currentTimeMs];
        }
    }

    // --- 更新用户总分 ---
    // Only apply increase if it's positive to avoid score reduction from checks alone
    if (scoreIncrease > 0) {
        userData.score.current += scoreIncrease;
        // Clamp score between 0 and maxScore
        userData.score.current = Math.min(Math.max(0, userData.score.current), config.maxScore);
    }

    // --- 轻度警告 ---
    // Trigger if score is approaching the limit AND this message contributed significantly
    const mildWarningThreshold = config.limitScore * 0.7; // 70% threshold
    if (userData.score.current > mildWarningThreshold && scoreIncrease >= 1 && userData.score.current < config.limitScore) {
        try {
            const percentage = (userData.score.current / config.limitScore * 100).toFixed(1);
            const warningText = html`检测到风险行为，请注意发言频率 ${userData.score.current.toFixed(1)}/${config.limitScore.toFixed(1)} (${percentage}%)`;
            const mildWarningMsg = await ctx.message.replyText(warningText);

            // 短时间显示后自动删除
            setTimeout(() => safeDeleteMessage(ctx.client, ctx.chatId, mildWarningMsg.id), 5000);
        } catch (error) {
            plugin.logger?.error(`发送轻度警告失败: ${error}`);
        }
    }

    // --- 执行防刷屏核心逻辑 (删除消息/发送主警告) ---
    await defend(ctx, userData);

    // --- 更新用户最后消息状态 ---
    // 仅当消息有文本内容时更新lastMessage，避免相似度检查出错
    if (messageText) {
        userData.content.lastMessage = messageText;
    }
    // 更新消息时间戳
    userData.content.lastMessageTime = Math.floor(currentTimeMs / 1000);
    // 注：lastMediaGroupID在calculateHighFrequencyPenalty函数中已更新
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
        this.logger?.info('防刷屏插件加载中...');

        // 加载配置
        config = await client.features.getPluginConfig<AntiFloodConfig>('antiflood', defaultConfig);

        // 初始化分数衰减定时任务 (Multiplicative Decay)
        decayIntervalId = setInterval(async () => { // Make async if map deletion is async
            const decayFactor = 1 - config.decay.rate;
            if (decayFactor <= 0 || decayFactor >= 1) {
                if (config.decay.rate !== 0) { // Avoid logging if decay is intentionally off
                    this.logger?.warn(`Invalid decay rate: ${config.decay.rate}. Decay disabled.`);
                }
                return; // Stop decay process if rate is invalid
            }

            const usersToRemove: number[] = [];
            userActivityMap.forEach((userData, userId) => {
                // Decay score
                userData.score.current *= decayFactor;

                // Optimization: If score is very close to 0, set it to 0.
                // Also, check if other state relevant to keeping the user entry active is default.
                // If score is 0 and other state is default, mark for potential removal.
                if (userData.score.current < 0.001) {
                    userData.score.current = 0;
                    // Check if user state is effectively "reset" (can be removed from map)
                    if (userData.content.consecutiveSimilarityCount === 0 &&
                        userData.frequency.timestamps.length === 0 &&
                        userData.frequency.scoreSum === 0 &&
                        !userData.warnings.messageId) // Check if no active warning
                    {
                        // Mark user for removal after iteration (modifying map during iteration is risky)
                        // This depends on DynamicMap allowing explicit deletion.
                        // If DynamicMap handles cleanup automatically based on inactivity, this might be redundant.
                        // Assuming DynamicMap has a .delete() method for this example.
                        usersToRemove.push(userId);
                    }
                }
            });

            // Remove inactive users (if DynamicMap supports it)
            if (usersToRemove.length > 0 && typeof userActivityMap.delete === 'function') {
                this.logger?.debug(`[Decay] Removing ${usersToRemove.length} inactive users from map.`);
                for (const userId of usersToRemove) {
                    if (userActivityMap.delete) {
                        userActivityMap.delete(userId);
                    }
                }
            }

        }, config.decay.interval);

        this.logger?.info(`防刷屏插件已加载，当前状态: ${config.enabled ? '已启用' : '已禁用'}`);
    },

    // 卸载时执行
    async onUnload() {
        // 清除定时任务
        if (decayIntervalId) {
            clearInterval(decayIntervalId);
            decayIntervalId = undefined;
        }
        this.logger?.info('防刷屏插件已卸载');
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
                        // Also delete existing warning message if any
                        const existingUserData = await userActivityMap.get(targetUserId);
                        if (existingUserData.warnings.messageId) {
                            // Pass client and chatId from CommandContext
                            await safeDeleteMessage(ctx.client, ctx.chatId, existingUserData.warnings.messageId);
                        }
                        userActivityMap.reset(targetUserId); // Resets score and other fields
                        await ctx.message.replyText(`${targetName} 的警报值和状态已重置。`);
                        break;

                    case "detail":
                        if (!isAdmin) {
                            await ctx.message.replyText("⚠️ 需要管理员权限");
                            return;
                        }

                        try {
                            const { frequency, ...simpleUserData } = targetUserData;
                            const displayData = {
                                ...simpleUserData,
                                timestampCount: frequency.timestamps.length,
                                lastTimestamp: frequency.timestamps.length > 0
                                    ? (() => {
                                        // Access the first element (index 0) for the timestamp
                                        const lastTime = frequency.timestamps[frequency.timestamps.length - 1]?.[0];
                                        return lastTime ? new Date(lastTime).toISOString() : 'N/A';
                                    })()
                                    : 'N/A'
                            };

                            await ctx.message.replyText(JSON.stringify(displayData, null, 2));
                        } catch (error) {
                            plugin.logger?.error(`检查用户数据时出错: ${error}`);
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
                        const score = targetUserData.score.current;
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
