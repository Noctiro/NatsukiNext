import type { BotPlugin, CommandContext, CallbackEventContext } from '../../features';
import { html } from '@mtcute/bun';
import { BotKeyboard } from '@mtcute/bun';

// 导入类型和类
import { GameStatus, PieceColor } from './models/ChessTypes';
import { Game } from './models/Game';
import { GameManager } from './utils/GameManager';
import { ChessAI } from './utils/ChessAI';
import { BoardRenderer } from './utils/BoardRenderer';
import {
    AIDifficultyCB,
    GameControlCB,
    MenuCB
} from './utils/CallbackManager';

/**
 * 中国象棋游戏插件
 * 支持玩家对战和AI对战模式
 */

// 游戏管理器
const gameManager = GameManager.getInstance();

// AI难度
const AI_DIFFICULTY_LEVELS = {
    easy: 3,   // 简单 (5步思考)
    normal: 5, // 普通 (9步思考)
    hard: 6    // 困难 (12步思考)
};

/**
 * 中国象棋插件
 */
const plugin: BotPlugin = {
    name: 'chess',
    description: '中国象棋游戏，支持玩家对战和AI对战',
    version: '1.0.0',

    // 添加onLoad钩子，初始化BoardRenderer的logger
    async onLoad() {
        // 初始化BoardRenderer的logger
        BoardRenderer.setLogger(this.logger);
    },

    commands: [
        {
            name: 'chess',
            description: '开始一局中国象棋游戏',
            async handler(ctx: CommandContext) {
                const subCommand = ctx.args[0]?.toLowerCase();

                if (!subCommand) {
                    await showChessMenu(ctx);
                    return;
                }

                if (subCommand === 'help') {
                    await showHelp(ctx);
                    return;
                }

                const handlers: Record<string, (ctx: CommandContext) => Promise<void>> = {
                    challenge: challengePlayer,
                    ai: showAiDifficultySelection,
                    accept: acceptChallenge,
                    decline: declineChallenge,
                    move: moveCommand,
                    resign: resignGame,
                    status: showGameStatus
                };

                const handler = handlers[subCommand];
                if (handler) {
                    await handler(ctx);
                } else {
                    await ctx.message.replyText(`未知命令：${subCommand}\n请使用 /chess help 查看帮助。`);
                }
            }
        },
        {
            name: 'm',
            description: '移动棋子 (游戏内快捷方式)',
            async handler(ctx: CommandContext) {
                const userId = ctx.message.sender.id;
                const game = gameManager.getPlayerActiveGame(userId);

                if (game) {
                    const adjustedCtx: CommandContext = {
                        ...ctx,
                        args: ['move', ...ctx.args.slice(0)]
                    };
                    await moveCommand(adjustedCtx);
                }
            }
        }
    ],

    // 添加事件处理
    events: [
        {
            type: 'callback',
            name: 'ai',
            async handler(ctx: CallbackEventContext) {
                await handleAIDifficultyCallback(ctx);
            }
        },
        {
            type: 'callback',
            name: 'control',
            async handler(ctx: CallbackEventContext) {
                await handleGameControlCallback(ctx);
            }
        },
        {
            type: 'callback',
            name: 'menu',
            async handler(ctx: CallbackEventContext) {
                await handleMenuCallback(ctx);
            }
        }
    ]
};

/**
 * 显示帮助信息
 */
async function showHelp(ctx: CommandContext) {
    await ctx.message.replyText(html`
<b>🎮 中国象棋游戏帮助</b><br>
<br>
<b>基本命令:</b><br>
• /chess - 显示象棋游戏菜单<br>
• /chess help - 显示游戏规则及帮助<br>
• /chess ai [难度] - 与AI对战（难度可选：easy, normal, hard）<br>
• /chess accept - 接受挑战<br>
• /chess decline - 拒绝挑战<br>
• /chess resign - 认输并结束当前游戏<br>
• /chess status - 显示当前游戏状态<br>
<br>
<b>行棋命令:</b><br>
• /chess move <走法> 或者 /m [走法] - 移动棋子，如"炮二平五"或"马3进4"<br>
<br>
<b>走法规则:</b><br>
走法使用传统中文(支持简体繁体阿拉伯数字)表示法，例如:<br>
• 车九进一 (直线移动)<br>
• 马八进七 (马的移动)<br>
• 炮二平五 (平移)<br>
• 相七退五 (斜线移动)<br>
<br>
<b>对局使用:</b><br>
• AI人机对局: /chess ai [难度] - 与AI对战（难度可选：easy, normal, hard） 例如: /chess ai hard<br>
• 玩家对战: /chess challenge @用户名 - 挑战其他玩家 例如: /chess challenge @user<br>
( 接受挑战: /chess accept - 接受挑战 )<br>
`);
}

/**
 * 挑战其他玩家
 */
async function challengePlayer(ctx: CommandContext) {
    const targetUsername = ctx.args[1];
    if (!targetUsername) {
        await ctx.message.replyText('请指定要挑战的玩家，例如：/chess challenge @用户名');
        return;
    }

    let targetUserId: number | null = null;

    if (targetUsername.startsWith('@')) {
        try {
            const username = targetUsername.substring(1);
            const user = await ctx.client.getUser(username);
            targetUserId = user.id;
        } catch (error) {
            await ctx.message.replyText(`找不到用户 ${targetUsername}`);
            return;
        }
    } else if (/^\d+$/.test(targetUsername)) {
        targetUserId = parseInt(targetUsername);
    } else {
        await ctx.message.replyText('请使用有效的@用户名或用户ID');
        return;
    }

    if (targetUserId === ctx.message.sender.id) {
        await ctx.message.replyText('不能挑战自己');
        return;
    }

    if (targetUserId !== null) {
        if (gameManager.getPlayerActiveGame(targetUserId)) {
            await ctx.message.replyText('对方已经在进行一场游戏');
            return;
        }

        gameManager.addInvite(targetUserId, ctx.message.sender.id);
        await ctx.message.replyText(
            html`<a href="tg://user?id=${ctx.message.sender.id}">${ctx.message.sender.displayName || '玩家'}</a> 邀请您下象棋！\n使用 /chess accept 接受挑战，或 /chess decline 拒绝挑战。`
        );
    }
}

/**
 * 开始与AI的游戏 命令版
 */
async function startAiGame(ctx: CommandContext) {
    const userId = ctx.message.sender.id;

    if (gameManager.getPlayerActiveGame(userId)) {
        await ctx.message.replyText('您已经在进行一场游戏了，请先完成当前游戏');
        return;
    }

    let aiDifficulty = AI_DIFFICULTY_LEVELS.normal;
    const difficultyArg = ctx.args[1]?.toLowerCase();

    if (difficultyArg) {
        if (Object.keys(AI_DIFFICULTY_LEVELS).includes(difficultyArg)) {
            aiDifficulty = AI_DIFFICULTY_LEVELS[difficultyArg as keyof typeof AI_DIFFICULTY_LEVELS];
            plugin.logger?.info(`用户${userId}选择了${difficultyArg}难度(${aiDifficulty})的AI游戏`);
        } else {
            await ctx.message.replyText(
                `无效的难度等级。有效的选项: ${Object.keys(AI_DIFFICULTY_LEVELS).join(', ')}`
            );
            return;
        }
    } else {
        plugin.logger?.info(`用户${userId}未指定难度，使用默认难度(${aiDifficulty})`);
    }

    const game = gameManager.createGame(userId, 'AI', ctx.message.chat.id);
    (game as any).aiDifficulty = aiDifficulty;
    plugin.logger?.info(`成功创建AI游戏，ID: ${game.id}，难度: ${getDifficultyText(aiDifficulty)}(${aiDifficulty})`);

    await renderAndSendBoard(game, ctx, `第 1 回合 - 红方（您）VS ${getDifficultyText(aiDifficulty)}AI<br>请输入您的走法，例如：/m 炮二平五`);
}

/**
 * 接受挑战
 */
async function acceptChallenge(ctx: CommandContext) {
    try {
        const targetUserId = ctx.message.sender.id;

        const invite = gameManager.getInvite(targetUserId);

        if (!invite) {
            await ctx.message.replyText('您没有收到任何象棋邀请');
            return;
        }

        if (invite.expires < Date.now()) {
            gameManager.removeInvite(targetUserId);
            await ctx.message.replyText('邀请已过期');
            return;
        }

        const game = gameManager.createGame(invite.inviter, targetUserId, ctx.message.chat.id);
        gameManager.removeInvite(targetUserId);

        await renderAndSendBoard(game, ctx, `第 1 回合 - 游戏开始！红方先行，请输入您的走法，例如：/m 炮二平五`);
    } catch (error) {
        await ctx.message.replyText('接受挑战时出错，请稍后再试').catch(() => { });
    }
}

/**
 * 拒绝挑战
 */
async function declineChallenge(ctx: CommandContext) {
    const targetUserId = ctx.message.sender.id;
    const invite = gameManager.getInvite(targetUserId);

    if (!invite) {
        await ctx.message.replyText('您没有收到任何象棋邀请');
        return;
    }

    gameManager.removeInvite(targetUserId);
    await ctx.message.replyText(`您已拒绝了象棋邀请`);
}

/**
 * 移动棋子命令
 */
async function moveCommand(ctx: CommandContext) {
    try {
        const userId = ctx.message.sender.id;
        const moveText = ctx.args.slice(1).join('');

        if (!moveText) {
            await ctx.message.replyText('请输入有效的走法，例如：炮二平五');
            return;
        }

        const game = gameManager.getPlayerTurnGame(userId);
        if (!game) {
            await ctx.message.replyText('您当前没有轮到您行动的游戏');
            return;
        }

        const moveResult = game.moveByNotation(moveText);

        if (!moveResult.success) {
            await ctx.message.replyText(`走法无效: ${moveResult.message}`);
            return;
        }

        if (game.status === GameStatus.FINISHED) {
            const winner = game.winner === PieceColor.RED ? '红方' : '黑方';
            await renderAndSendBoard(game, ctx, `游戏结束！${winner}获胜！`);
            return;
        }

        await updateGameBoard(game, ctx);

        if (game.blackPlayer === 'AI' && game.currentTurn === PieceColor.BLACK) {
            await processAIMove(game, ctx);
        }
    } catch (error) {
        await ctx.message.replyText('处理走棋时出错，请稍后再试').catch(() => { });
    }
}

/**
 * 渲染并发送棋盘
 */
async function renderAndSendBoard(game: Game, ctx: CommandContext | CallbackEventContext, caption: string) {
    try {
        const boardBuffer = await BoardRenderer.drawBoardImage(game);

        // 区分不同类型的上下文
        if (ctx.type === 'command') {
            await ctx.message.replyMedia(
                {
                    type: 'photo',
                    file: boardBuffer,
                    fileName: `chess_${game.id}.png`
                },
                { caption: html(caption) }
            );
        } else {
            // 回调上下文 - 始终发送新消息而不是编辑
            await ctx.client.sendMedia(ctx.chatId, {
                type: 'photo',
                file: boardBuffer,
                fileName: `chess_${game.id}.png`
            }, { caption: html(caption) });
        }
    } catch (error) {
        // 图片渲染失败，尝试使用HTML作为回退方案
        try {
            const boardHtml = BoardRenderer.renderBoardHTML(game);
            const fullContent = boardHtml + '<br>' + caption;

            if (ctx.type === 'command') {
                await ctx.message.replyText(html(fullContent));
            } else {
                // 回调上下文 - 始终发送新消息而不是编辑
                await ctx.client.sendText(ctx.chatId, html(fullContent));
            }
        } catch (fallbackError) {
            // 即使HTML渲染也失败，发送简单的错误消息
            const errorMessage = '无法显示棋盘，请使用 /chess status 重试';

            if (ctx.type === 'command') {
                await ctx.message.replyText(errorMessage).catch(() => { });
            } else {
                await ctx.client.sendText(ctx.chatId, errorMessage).catch(() => { });
            }
        }
    }
}

/**
 * 更新游戏棋盘消息
 */
async function updateGameBoard(game: Game, ctx: CommandContext) {
    if (game.currentTurn === PieceColor.BLACK && game.blackPlayer === 'AI') {
        return;
    }

    let currentPlayer: string;
    if (game.currentTurn === PieceColor.RED) {
        currentPlayer = `<a href="tg://user?id=${game.redPlayer}">红方玩家</a>`;
    } else {
        currentPlayer = game.blackPlayer === 'AI'
            ? 'AI'
            : `<a href="tg://user?id=${game.blackPlayer}">黑方玩家</a>`;
    }

    const caption = `第 ${Math.floor(game.history.length / 2) + 1} 回合 - 轮到${currentPlayer}行动${game.lastMove ? ` | 上一步：${game.lastMove}` : ''}`;
    await renderAndSendBoard(game, ctx, caption);
}

/**
 * 处理AI走棋
 */
async function processAIMove(game: Game, ctx: CommandContext) {
    const thinkingMessage = await ctx.message.replyText('AI 正在思考中...');
    let thinkingMessageId: number | undefined = thinkingMessage?.id;

    try {
        const aiDifficulty = (game as any).aiDifficulty || AI_DIFFICULTY_LEVELS.normal;
        const useCloudLibrary = aiDifficulty === AI_DIFFICULTY_LEVELS.hard;
        // 创建AI实例时传入logger
        const chessAI = new ChessAI(aiDifficulty, useCloudLibrary, 60000, plugin.logger);
        const aiMove = await chessAI.getMove(game);

        if (thinkingMessageId) {
            ctx.client.deleteMessagesById(ctx.chatId, [thinkingMessageId]);
            thinkingMessageId = undefined;
        }

        if (!aiMove) {
            game.status = GameStatus.FINISHED;
            game.winner = PieceColor.RED;
            await renderAndSendBoard(game, ctx, `AI无法行动，您获胜了！`);
            return;
        }

        game.move(aiMove.from, aiMove.to);

        const statusMessage = game.status === GameStatus.FINISHED
            ? 'AI获胜了！'
            : '轮到您行动';

        const caption = `第 ${Math.floor(game.history.length / 2) + 1} 回合 - ${statusMessage}${game.lastMove ? ` | AI走法：${game.lastMove}` : ''}`;
        await renderAndSendBoard(game, ctx, caption);
    } catch (error) {
        if (thinkingMessageId) {
            try {
                await ctx.client.deleteMessagesById(ctx.chatId, [thinkingMessageId]);
            } catch (deleteError) {
                plugin.logger?.error('Failed to delete thinking message:', deleteError);
            }
        }
        throw error;
    }
}

/**
 * 获取难度文本描述
 */
function getDifficultyText(difficulty: number): string {
    const difficultyMap: Record<number, string> = {
        [AI_DIFFICULTY_LEVELS.easy]: '简单',
        [AI_DIFFICULTY_LEVELS.normal]: '普通',
        [AI_DIFFICULTY_LEVELS.hard]: '困难'
    };
    return difficultyMap[difficulty] || '简单';
}

/**
 * 认输
 */
async function resignGame(ctx: CommandContext) {
    const userId = ctx.message.sender.id;
    const game = gameManager.getPlayerActiveGame(userId);

    if (!game) {
        await ctx.message.replyText('您当前没有进行中的游戏');
        return;
    }

    if (!game.resign(userId)) {
        await ctx.message.replyText('无法认输，可能游戏已经结束');
        return;
    }

    let winner: string;
    if (game.winner === PieceColor.RED) {
        winner = typeof game.redPlayer === 'string' && game.redPlayer === 'AI'
            ? 'AI'
            : `<a href="tg://user?id=${game.redPlayer}">红方玩家</a>`;
    } else {
        winner = typeof game.blackPlayer === 'string' && game.blackPlayer === 'AI'
            ? 'AI'
            : `<a href="tg://user?id=${game.blackPlayer}">黑方玩家</a>`;
    }

    await renderAndSendBoard(game, ctx, `第 ${Math.floor(game.history.length / 2) + 1} 回合 - 游戏结束，${winner}获胜！`);
    gameManager.endGame(game.id);
}

/**
 * 显示当前游戏状态
 */
async function showGameStatus(ctx: CommandContext) {
    const userId = ctx.message.sender.id;
    const game = gameManager.getPlayerActiveGame(userId);

    if (!game) {
        await ctx.message.replyText('您当前没有进行中的游戏');
        return;
    }

    await renderAndSendBoard(game, ctx, `第 ${Math.floor(game.history.length / 2) + 1} 回合 - ${game.getStatusText()}`);
}

/**
 * 生成象棋菜单文本
 */
function getChessMenuText(): string {
    return `
<b>🎮 中国象棋游戏</b><br>
<br>
欢迎来到中国象棋游戏！您可以：<br>
• 与AI对弈 - 选择下方难度按钮<br>
• 挑战好友 - 使用命令 /chess challenge @用户名<br>
• 查看当前游戏 - 如果您有进行中的游戏<br>
<br>
输入 <code>/chess help</code> 查看完整命令列表<br>
祝您游戏愉快！
`;
}

/**
 * 创建象棋菜单键盘
 */
function createChessMenuKeyboard(userId: number): any {
    // 检查用户当前是否有活跃游戏
    const activeGame = gameManager.getPlayerActiveGame(userId);

    let gameStatusButtons: any[] = [];
    if (activeGame) {
        gameStatusButtons = [
            [
                // 查看游戏状态使用 gameId，但是不需要验证用户身份，任何人都可以查看
                BotKeyboard.callback('📋 查看当前游戏', GameControlCB.build({
                    gameId: activeGame.id,
                    action: 'status',
                    userId: 0  // 设置为0，表示任何人都可以查看
                })),
                // 认输操作需要验证用户身份
                BotKeyboard.callback('🏳️ 认输', GameControlCB.build({
                    gameId: activeGame.id,
                    action: 'resign',
                    userId: userId  // 设置为用户ID，只有该用户可以操作
                }))
            ]
        ];
    }

    // 创建AI对战难度选择按钮 - 不包含userId，任何人都可以点击
    const aiDifficultyButtons = [
        BotKeyboard.callback('🤖 简单AI', AIDifficultyCB.build({
            difficulty: 'easy'
        })),
        BotKeyboard.callback('🤖 普通AI', AIDifficultyCB.build({
            difficulty: 'normal'
        })),
        BotKeyboard.callback('🤖 困难AI', AIDifficultyCB.build({
            difficulty: 'hard'
        }))
    ];

    return BotKeyboard.inline([
        aiDifficultyButtons,
        ...gameStatusButtons,
        [
            BotKeyboard.callback('ℹ️ 游戏规则', GameControlCB.build({
                gameId: '0',
                action: 'help',
                userId: 0  // 设置为0，表示任何人都可以查看
            })),
            BotKeyboard.callback('📚 命令帮助', GameControlCB.build({
                gameId: '0',
                action: 'commands',
                userId: 0  // 设置为0，表示任何人都可以查看
            }))
        ]
    ]);
}

/**
 * 显示象棋菜单
 */
async function showChessMenu(ctx: CommandContext) {
    const userId = ctx.message.sender.id;
    const keyboard = createChessMenuKeyboard(userId);

    await ctx.message.replyText(html(getChessMenuText()), {
        replyMarkup: keyboard
    });
}

/**
 * 显示AI难度选择界面
 */
async function showAiDifficultySelection(ctx: CommandContext) {
    const userId = ctx.message.sender.id;

    if (gameManager.getPlayerActiveGame(userId)) {
        await ctx.message.replyText('您已经在进行一场游戏了，请先完成当前游戏');
        return;
    }

    // 检查是否有直接指定的难度参数
    const difficultyArg = ctx.args[1]?.toLowerCase();
    if (difficultyArg) {
        if (Object.keys(AI_DIFFICULTY_LEVELS).includes(difficultyArg)) {
            // 用户直接指定了难度，直接开始游戏
            await startAiGame(ctx);
            return;
        } else {
            await ctx.message.replyText(
                `无效的难度等级。有效的选项: ${Object.keys(AI_DIFFICULTY_LEVELS).join(', ')}`
            );
            return;
        }
    }

    // 没有指定难度，显示难度选择界面
    const keyboard = BotKeyboard.inline([
        [
            BotKeyboard.callback('🟢 简单', AIDifficultyCB.build({
                difficulty: 'easy'
            })),
            BotKeyboard.callback('🟡 普通', AIDifficultyCB.build({
                difficulty: 'normal'
            })),
            BotKeyboard.callback('🔴 困难', AIDifficultyCB.build({
                difficulty: 'hard'
            }))
        ]
    ]);

    await ctx.message.replyText('请选择AI难度：', {
        replyMarkup: keyboard
    });
}

/**
 * 处理AI难度选择回调
 */
async function handleAIDifficultyCallback(ctx: CallbackEventContext) {
    try {
        // 从match中提取难度参数
        const data = ctx.match;
        if (!data) {
            plugin.logger?.warn('无法获取AI难度匹配数据');
            await ctx.query.answer({
                text: '系统错误：无法解析回调数据',
                alert: true
            }).catch(() => { });
            return;
        }

        // 从_param中提取难度参数
        const difficulty = data._param0 as string || data.difficulty as string;

        if (!difficulty) {
            plugin.logger?.warn('AI回调缺少难度参数');
            await ctx.query.answer({
                text: '系统错误：缺少难度参数',
                alert: true
            }).catch(() => { });
            return;
        }

        const currentUserId = ctx.query.user.id;

        // 检查用户是否已有游戏
        if (gameManager.getPlayerActiveGame(currentUserId)) {
            plugin.logger?.warn(`用户${currentUserId}已有活跃游戏，不能创建新游戏`);
            await ctx.query.answer({
                text: '您已经在进行一场游戏，请先完成当前游戏',
                alert: true
            });
            return;
        }

        // 获取对应的AI难度值
        const aiDifficulty = AI_DIFFICULTY_LEVELS[difficulty as keyof typeof AI_DIFFICULTY_LEVELS] || AI_DIFFICULTY_LEVELS.normal;

        // 创建新游戏 - 使用当前用户ID
        const game = gameManager.createGame(currentUserId, 'AI', ctx.chatId);
        (game as any).aiDifficulty = aiDifficulty;

        plugin.logger?.info(`用户${currentUserId}创建了${getDifficultyText(aiDifficulty)}难度的AI游戏${game.id}`);

        // 回答回调查询
        await ctx.query.answer({
            text: `已选择${getDifficultyText(aiDifficulty)}难度`
        });

        // 发送游戏开始消息
        const announcementText = `<a href="tg://user?id=${currentUserId}">${ctx.query.user.firstName || '玩家'}</a> 开始了一局${getDifficultyText(aiDifficulty)}难度的AI对战`;
        await ctx.client.sendText(ctx.chatId, html(announcementText));

        await renderAndSendBoard(game, ctx, `第 1 回合 - 红方（您）VS ${getDifficultyText(aiDifficulty)}AI<br>请输入您的走法，例如：/m 炮二平五`);
    } catch (error) {
        plugin.logger?.error(`处理AI难度选择时出错: ${error}`);
        await ctx.query.answer({
            text: '处理难度选择时出错',
            alert: true
        }).catch(() => { });
    }
}

/**
 * 处理游戏控制回调
 */
async function handleGameControlCallback(ctx: CallbackEventContext) {
    try {
        // 检查回调数据格式是否正确
        const data = ctx.match;
        if (!data) {
            plugin.logger?.warn('无法获取匹配数据，请检查回调数据结构');
            await ctx.query.answer({
                text: '系统错误：无法解析回调数据',
                alert: true
            }).catch(() => { });
            return;
        }

        // 从_param中提取参数
        const gameId = data._param0 as string;
        const action = data._param1 as string;
        const userId = data._param2 as number;

        // 检查必要参数是否存在
        if (!action) {
            plugin.logger?.warn('控制回调缺少action参数');
            await ctx.query.answer({
                text: '系统错误：缺少操作类型',
                alert: true
            }).catch(() => { });
            return;
        }

        // 无需身份验证的公共操作
        if (action === 'help' || action === 'commands' || action === 'status') {
            if (action === 'help') {
                // 显示帮助信息
                await ctx.query.answer({
                    text: '显示游戏规则'
                });

                // 准备帮助内容
                const helpText = `
<b>中国象棋游戏规则简介</b><br>
<br>
<b>棋子走法：</b><br>
• 将/帅：一次走一格，不能出九宫<br>
• 士/仕：一次走一格，斜走，不能出九宫<br>
• 象/相：一次走两格，斜走，不能过河，不能象眼有子<br>
• 车：直走，行列均可，不能跳子<br>
• 马：走"日"字，不能蹩马腿<br>
• 炮：直走，行列均可，不吃子时不能跳子，吃子时必须跳过一子<br>
• 兵/卒：只能向前走，过河后可左右走，一次一格<br>
<br>
<b>基本规则：</b><br>
• 红方先行，黑方后行，轮流移动<br>
• 将帅不能直接对面<br>
• 长将/长捉判负<br>
• 困毙(无子可走)判负<br>
• 将/帅被吃判负<br>
<br>
使用 <code>/chess</code> 命令可以开始新游戏。<br>
输入走法时使用中文(简体或繁体)表示，例如"炮二平五"、"马3进5"等。<br>
`;

                // 尝试编辑消息，而不是发送新消息
                try {
                    await ctx.client.editMessage({
                        chatId: ctx.chatId,
                        message: ctx.query.messageId,
                        text: html(helpText),
                        replyMarkup: BotKeyboard.inline([[
                            BotKeyboard.callback('返回菜单', MenuCB.build({
                                action: '0'
                            }))
                        ]])
                    });
                } catch (error) {
                    // 如果编辑失败，回退到发送新消息
                    plugin.logger?.error(`编辑消息显示帮助失败: ${error}`);
                    await ctx.client.sendText(ctx.chatId, html(helpText));
                }
                return;
            }

            if (action === 'commands') {
                // 显示命令帮助
                await ctx.query.answer({
                    text: '显示命令帮助'
                });

                const commandHelp = `
<b>🎮 中国象棋命令列表</b><br>
<br>
<b>基本命令：</b><br>
• /chess - 显示象棋游戏菜单<br>
• /chess help - 显示游戏规则及帮助<br>
• /chess ai [难度] - 开始AI对战 (可选难度：easy/normal/hard)<br>
<br>
<b>移动命令：</b><br>
• /chess move <走法> - 移动棋子，例如 "炮二平五"<br>
• /m <走法> - 同上，快捷命令<br>
<br>
<b>游戏控制：</b><br>
• /chess status - 查看当前游戏状态<br>
• /chess resign - 认输当前游戏<br>
<br>
<b>挑战命令：</b><br>
• /chess challenge @用户名 - 向指定用户发起挑战<br>
• /chess accept - 接受挑战<br>
• /chess decline - 拒绝挑战<br>
`;

                // 尝试编辑消息，而不是发送新消息
                try {
                    await ctx.client.editMessage({
                        chatId: ctx.chatId,
                        message: ctx.query.messageId,
                        text: html(commandHelp),
                        replyMarkup: BotKeyboard.inline([[
                            BotKeyboard.callback('返回菜单', MenuCB.build({
                                action: '0'
                            }))
                        ]])
                    });
                } catch (error) {
                    // 如果编辑失败，回退到发送新消息
                    plugin.logger?.error(`编辑消息显示命令帮助失败: ${error}`);
                    await ctx.client.sendText(ctx.chatId, html(commandHelp));
                }
                return;
            }

            if (action === 'status') {
                // 获取游戏
                let game;

                try {
                    // 如果 gameId 有效，直接获取该游戏
                    if (gameId && gameId !== '0') {
                        game = gameManager.getGameById(gameId);
                    }

                    // 如果没有找到游戏，尝试获取当前用户的活跃游戏
                    if (!game) {
                        game = gameManager.getPlayerActiveGame(ctx.query.user.id);
                    }

                    if (!game) {
                        await ctx.query.answer({
                            text: '找不到相关游戏',
                            alert: true
                        });
                        return;
                    }

                    // 显示游戏状态
                    await ctx.query.answer({
                        text: '更新游戏状态'
                    });

                    // 棋盘始终使用新消息
                    await renderAndSendBoard(game, ctx, `第 ${Math.floor(game.history.length / 2) + 1} 回合 - ${game.getStatusText()}`);
                } catch (error) {
                    plugin.logger?.error(`显示游戏状态失败: ${error}`);
                    await ctx.query.answer({
                        text: '获取游戏状态时出错',
                        alert: true
                    }).catch(() => { });
                }
                return;
            }
        }

        // 需要进行身份验证的专属操作
        if (userId !== 0 && ctx.query.user.id !== userId) {
            // 获取用户昵称，使提示更友好
            const userNickname = ctx.query.user.firstName || '用户';
            await ctx.query.answer({
                text: `${userNickname}，请使用自己的菜单进行操作`,
                alert: true
            });
            return;
        }

        // 获取游戏
        try {
            // 检查gameId是否有效
            if (!gameId) {
                await ctx.query.answer({
                    text: '无效的游戏ID',
                    alert: true
                });
                return;
            }

            const game = gameManager.getGameById(gameId);
            if (!game) {
                await ctx.query.answer({
                    text: '找不到相关游戏',
                    alert: true
                });
                return;
            }

            if (action === 'resign') {
                // 认输
                await ctx.query.answer({
                    text: '您已认输'
                });

                if (!game.resign(userId)) {
                    await ctx.client.sendText(ctx.chatId, '无法认输，可能游戏已经结束');
                    return;
                }

                let winner: string;
                if (game.winner === PieceColor.RED) {
                    winner = typeof game.redPlayer === 'string' && game.redPlayer === 'AI'
                        ? 'AI'
                        : `<a href="tg://user?id=${game.redPlayer}">红方玩家</a>`;
                } else {
                    winner = typeof game.blackPlayer === 'string' && game.blackPlayer === 'AI'
                        ? 'AI'
                        : `<a href="tg://user?id=${game.blackPlayer}">黑方玩家</a>`;
                }

                await renderAndSendBoard(game, ctx, `第 ${Math.floor(game.history.length / 2) + 1} 回合 - 游戏结束，${winner}获胜！`);
                gameManager.endGame(game.id);
            } else {
                await ctx.query.answer({
                    text: `未知操作: ${action}`,
                    alert: true
                });
            }
        } catch (error) {
            plugin.logger?.error(`处理操作${action}时出错: ${error}`);
            await ctx.query.answer({
                text: '处理操作时出错',
                alert: true
            }).catch(() => { });
        }
    } catch (error) {
        plugin.logger?.error(`处理游戏控制回调时出错: ${error}`);
        await ctx.query.answer({
            text: '处理游戏操作时出错',
            alert: true
        }).catch(() => { });
    }
}

/**
 * 处理菜单回调
 */
async function handleMenuCallback(ctx: CallbackEventContext) {
    try {
        await ctx.query.answer({
            text: '返回主菜单'
        });

        // 重建主菜单并编辑消息
        const userId = ctx.query.user.id;
        const keyboard = createChessMenuKeyboard(userId);

        try {
            await ctx.client.editMessage({
                chatId: ctx.chatId,
                message: ctx.query.messageId,
                text: html(getChessMenuText()),
                replyMarkup: keyboard
            });
        } catch (error) {
            plugin.logger?.error(`编辑消息返回主菜单失败: ${error}`);
            // 如果编辑失败，尝试发送新消息
            await ctx.client.sendText(ctx.chatId, html(getChessMenuText()), { replyMarkup: keyboard });
        }
    } catch (error) {
        plugin.logger?.error(`处理菜单回调时出错: ${error}`);
        await ctx.query.answer({
            text: '返回菜单时出错',
            alert: true
        }).catch(() => { });
    }
}

export default plugin;