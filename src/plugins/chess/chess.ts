import type { BotPlugin, CommandContext } from '../../features';
import { html } from '@mtcute/bun';

// 导入类型和类
import { GameStatus, PieceColor } from './models/ChessTypes';
import { Game } from './models/Game';
import { GameManager } from './utils/GameManager';
import { ChessAI } from './utils/ChessAI';
import { BoardRenderer } from './utils/BoardRenderer';

/**
 * 中国象棋游戏插件
 * 支持玩家对战和AI对战模式
 */

// 游戏管理器
const gameManager = GameManager.getInstance();

// AI难度
const AI_DIFFICULTY_LEVELS = {
    easy: 3,   // 初级 (5步思考)
    normal: 5, // 中级 (9步思考)
    hard: 6    // 高级 (12步思考)
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

                if (!subCommand || subCommand === 'help') {
                    await showHelp(ctx);
                    return;
                }

                const handlers: Record<string, (ctx: CommandContext) => Promise<void>> = {
                    challenge: challengePlayer,
                    ai: startAiGame,
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
• /chess challenge @用户名 - 挑战其他玩家<br>
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
 * 开始与AI的游戏
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
        } else {
            await ctx.message.replyText(
                `无效的难度等级。有效的选项: ${Object.keys(AI_DIFFICULTY_LEVELS).join(', ')}`
            );
            return;
        }
    }

    const game = gameManager.createGame(userId, 'AI', ctx.message.chat.id);
    (game as any).aiDifficulty = aiDifficulty;

    await renderAndSendBoard(game, ctx, `第 1 回合 - 红方（您）VS ${getDifficultyText(aiDifficulty)}AI<br>请输入您的走法，例如：/m 炮二平五`);
}

/**
 * 接受挑战
 */
async function acceptChallenge(ctx: CommandContext) {
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
}

/**
 * 渲染并发送棋盘
 */
async function renderAndSendBoard(game: Game, ctx: CommandContext, caption: string) {
    try {
        const boardBuffer = await BoardRenderer.drawBoardImage(game);
        await ctx.message.replyMedia(
            {
                type: 'photo',
                file: boardBuffer,
                fileName: `chess_${game.id}.png`
            },
            { caption: html(caption) }
        );
    } catch (error) {
        plugin.logger?.error('棋盘图片渲染失败:', error);
        const boardHtml = BoardRenderer.renderBoardHTML(game);
        await ctx.message.replyText(html`${html(boardHtml)}<br>${caption}`);
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
        [AI_DIFFICULTY_LEVELS.easy]: '初级',
        [AI_DIFFICULTY_LEVELS.normal]: '中级',
        [AI_DIFFICULTY_LEVELS.hard]: '高级'
    };
    return difficultyMap[difficulty] || '初级';
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

export default plugin;
