import type { BotPlugin, CommandContext } from '../../features';
import { html } from '@mtcute/bun';
import { log } from '../../log';

// 导入类型和类
import { GameStatus, PieceColor } from './models/ChessTypes';
import { Game } from './models/Game';
import { Board } from './models/Board';
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

    commands: [
        {
            name: 'chess',
            description: '开始一局中国象棋游戏',
            async handler(ctx: CommandContext) {
                // 根据参数处理不同的子命令
                const subCommand = ctx.args[0]?.toLowerCase();

                if (!subCommand || subCommand === 'help') {
                    // 显示帮助信息
                    await showHelp(ctx);
                    return;
                }

                switch (subCommand) {
                    case 'challenge':
                        // 挑战其他玩家
                        await challengePlayer(ctx);
                        break;
                    case 'ai':
                        // 与AI对战
                        await startAiGame(ctx);
                        break;
                    case 'accept':
                        // 接受挑战
                        await acceptChallenge(ctx);
                        break;
                    case 'decline':
                        // 拒绝挑战
                        await declineChallenge(ctx);
                        break;
                    case 'move':
                        // 移动棋子
                        await moveCommand(ctx);
                        break;
                    case 'resign':
                        // 认输
                        await resignGame(ctx);
                        break;
                    case 'status':
                        // 显示当前游戏状态
                        await showGameStatus(ctx);
                        break;
                    default:
                        await ctx.message.replyText(`未知命令：${subCommand}\n请使用 /chess help 查看帮助。`);
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
• /chess move <走法> - 移动棋子，如"炮二平五"或"马3进4"<br>
<br>
<b>走法规则:</b><br>
走法使用传统中文表示法，例如:<br>
• 车九进一 (直线移动)<br>
• 马八进七 (马的移动)<br>
• 炮二平五 (平移)<br>
• 相七退五 (斜线移动)<br>
<br>
<b>AI难度说明:</b><br>
• easy - 初级模式，思考5步后的局势<br>
• normal - 中级模式，思考9步后的局势，具有更强的战略分析能力<br>
• hard - 高级模式，思考12步后的局势，有极其强大的攻防策略，优先使用象棋云库
`);
}

/**
 * 挑战其他玩家
 */
async function challengePlayer(ctx: CommandContext) {
    // 获取目标用户
    const targetUsername = ctx.args[1];
    if (!targetUsername) {
        await ctx.message.replyText('请指定要挑战的玩家，例如：/chess challenge @用户名');
        return;
    }

    // 提取用户ID（如果是@用户的形式）
    let targetUserId: number | null = null;

    if (targetUsername.startsWith('@')) {
        // 尝试通过用户名找到用户
        try {
            const username = targetUsername.substring(1);
            const user = await ctx.client.getUser(username);
            targetUserId = user.id;
        } catch (error) {
            await ctx.message.replyText(`找不到用户 ${targetUsername}`);
            return;
        }
    } else if (/^\d+$/.test(targetUsername)) {
        // 如果直接输入用户ID
        targetUserId = parseInt(targetUsername);
    } else {
        await ctx.message.replyText('请使用有效的@用户名或用户ID');
        return;
    }

    // 不能挑战自己
    if (targetUserId === ctx.message.sender.id) {
        await ctx.message.replyText('不能挑战自己');
        return;
    }

    // 检查对方是否已经有活跃游戏
    if (targetUserId !== null) {
        const opponentGame = gameManager.getPlayerActiveGame(targetUserId);

        if (opponentGame) {
            await ctx.message.replyText('对方已经在进行一场游戏');
            return;
        }

        // 创建邀请
        const gameId = gameManager.addInvite(targetUserId, ctx.message.sender.id);

        // 发送邀请消息，使用正确的用户链接格式
        await ctx.message.replyText(
            html`<a href="tg://user?id=${ctx.message.sender.id}">${ctx.message.sender.displayName || '玩家'}</a> 邀请您下象棋！\n使用 /chess accept 接受挑战，或 /chess decline 拒绝挑战。`
        );
    } else {
        await ctx.message.replyText('无法获取有效的用户ID');
    }
}

/**
 * 开始与AI的游戏
 */
async function startAiGame(ctx: CommandContext) {
    const userId = ctx.message.sender.id;

    // 检查玩家是否已经有活跃游戏
    const playerGame = gameManager.getPlayerActiveGame(userId);

    if (playerGame) {
        await ctx.message.replyText('您已经在进行一场游戏了，请先完成当前游戏');
        return;
    }

    // 检查是否指定了AI难度（如 /chess ai hard）
    let aiDifficulty = AI_DIFFICULTY_LEVELS.normal; // 默认普通难度
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

    // 创建新游戏
    const game = gameManager.createGame(userId, 'AI', ctx.message.chat.id);

    // 在游戏对象中保存AI难度
    (game as any).aiDifficulty = aiDifficulty;

    // 获取难度文本
    const difficultyText = getDifficultyText(aiDifficulty);

    try {
        // 生成棋盘图片
        const boardBuffer = await BoardRenderer.drawBoardImage(game);

        // 发送游戏消息
        await ctx.message.replyMedia(
            {
                type: 'photo',
                file: boardBuffer,
                fileName: `chess_${game.id}.png`
            },
            {
                caption: html`第 1 回合 - 红方（您）VS ${difficultyText}AI<br>请输入您的走法，例如：/chess move 炮二平五`
            }
        );
    } catch (error) {
        // 如果图片渲染失败，fallback到HTML渲染
        console.error('棋盘图片渲染失败:', error);

        // 使用HTML作为备用
        const boardHtml = BoardRenderer.renderBoardHTML(game);
        await ctx.message.replyText(
            html`${html(boardHtml)}<br>红方（您）VS ${difficultyText}AI<br>请输入您的走法，例如：/chess move 炮二平五`
        );
    }
}

/**
 * 接受挑战
 */
async function acceptChallenge(ctx: CommandContext) {
    const targetUserId = ctx.message.sender.id;

    // 检查是否有等待中的邀请
    const invite = gameManager.getInvite(targetUserId);
    if (!invite) {
        await ctx.message.replyText('您没有收到任何象棋邀请');
        return;
    }

    // 检查邀请是否过期
    if (invite.expires < Date.now()) {
        gameManager.removeInvite(targetUserId);
        await ctx.message.replyText('邀请已过期');
        return;
    }

    // 创建新游戏
    const game = gameManager.createGame(invite.inviter, targetUserId, ctx.message.chat.id);

    // 清除邀请
    gameManager.removeInvite(targetUserId);

    try {
        // 生成棋盘图片
        const boardBuffer = await BoardRenderer.drawBoardImage(game);

        // 发送游戏消息
        await ctx.message.replyMedia(
            {
                type: 'photo',
                file: boardBuffer,
                fileName: `chess_${game.id}.png`
            },
            {
                caption: html`第 1 回合 - 游戏开始！红方先行，请输入您的走法，例如：/chess move 炮二平五`
            }
        );
    } catch (error) {
        // 如果图片渲染失败，fallback到HTML渲染
        console.error('棋盘图片渲染失败:', error);

        // 使用HTML作为备用
        const boardHtml = BoardRenderer.renderBoardHTML(game);
        await ctx.message.replyText(
            html`${html(boardHtml)}<br>游戏开始！红方先行，请输入您的走法，例如：/chess move 炮二平五`
        );
    }
}

/**
 * 拒绝挑战
 */
async function declineChallenge(ctx: CommandContext) {
    const targetUserId = ctx.message.sender.id;

    // 检查是否有等待中的邀请
    const invite = gameManager.getInvite(targetUserId);
    if (!invite) {
        await ctx.message.replyText('您没有收到任何象棋邀请');
        return;
    }

    // 清除邀请
    gameManager.removeInvite(targetUserId);

    // 通知发起者
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

    // 查找玩家当前的游戏
    const game = gameManager.getPlayerTurnGame(userId);

    if (!game) {
        await ctx.message.replyText('您当前没有轮到您行动的游戏');
        return;
    }

    // 执行走法
    const moveResult = game.moveByNotation(moveText);

    if (!moveResult.success) {
        await ctx.message.replyText(`走法无效: ${moveResult.message}`);
        return;
    }

    // 更新游戏棋盘
    await updateGameBoard(game, ctx);

    // 如果游戏结束，显示胜利信息
    if (game.status === GameStatus.FINISHED) {
        const winner = game.winner === PieceColor.RED ? '红方' : '黑方';
        await ctx.message.replyText(`游戏结束！${winner}获胜！`);
        return;
    }

    // 如果是AI对战，让AI行动
    if (game.blackPlayer === 'AI' && game.currentTurn === PieceColor.BLACK) {
        // 让AI行动，处理可能的异步操作
        await processAIMove(game, ctx);
    }
}

/**
 * 更新游戏棋盘消息
 */
async function updateGameBoard(game: Game, ctx: CommandContext) {
    // 如果轮到AI行动，直接返回，不发送新消息
    if (game.currentTurn === PieceColor.BLACK && game.blackPlayer === 'AI') {
        return;
    }

    // 处理显示当前玩家
    let currentPlayer: string;
    if (game.currentTurn === PieceColor.RED) {
        // 红方玩家显示：使用ID作为链接但显示玩家名
        currentPlayer = `<a href="tg://user?id=${game.redPlayer}">红方玩家</a>`;
    } else {
        currentPlayer = game.blackPlayer === 'AI'
            ? 'AI'
            : `<a href="tg://user?id=${game.blackPlayer}">黑方玩家</a>`;
    }

    try {
        // 生成棋盘图片
        const boardBuffer = await BoardRenderer.drawBoardImage(game);

        // 发送图片消息
        await ctx.message.replyMedia(
            {
                type: 'photo',
                file: boardBuffer,
                fileName: `chess_${game.id}.png`
            },
            {
                caption: html`第 ${Math.floor(game.history.length / 2) + 1} 回合 - 轮到${html(currentPlayer)}行动${game.lastMove ? ` | 上一步：${game.lastMove}` : ''}`
            }
        );
    } catch (error) {
        // 如果图片渲染失败，fallback到HTML渲染
        console.error('棋盘图片渲染失败:', error);

        // 使用HTML作为备用
        const boardHtml = BoardRenderer.renderBoardHTML(game);
        await ctx.message.replyText(
            html`${html(boardHtml)}<br>轮到${html(currentPlayer)}行动`
        );
    }
}

/**
 * 处理AI走棋
 */
async function processAIMove(game: Game, ctx: CommandContext) {
    // 发送“思考中”提示
    const thinkingMessage = await ctx.message.replyText('AI 正在思考中...');
    let thinkingMessageId: number | undefined;
    if (thinkingMessage) {
        thinkingMessageId = thinkingMessage.id;
    }

    try {
        // 获取AI难度等级
        const aiDifficulty = (game as any).aiDifficulty || AI_DIFFICULTY_LEVELS.normal;

        // 创建AI实例，高级难度时启用云库
        const useCloudLibrary = aiDifficulty === AI_DIFFICULTY_LEVELS.hard;
        const chessAI = new ChessAI(aiDifficulty, useCloudLibrary);

        // 获取AI走法（现在是异步的）
        const aiMove = await chessAI.getMove(game);

        // 删除“思考中”提示
        if (thinkingMessageId) {
            ctx.client.deleteMessagesById(ctx.chatId, [thinkingMessageId]);
        }

        if (!aiMove) {
            // AI无法行动，认输
            game.status = GameStatus.FINISHED;
            game.winner = PieceColor.RED;

            try {
                // 生成棋盘图片
                const boardBuffer = await BoardRenderer.drawBoardImage(game);

                // 发送最终棋盘和结果
                await ctx.message.replyMedia(
                    {
                        type: 'photo',
                        file: boardBuffer,
                        fileName: `chess_${game.id}_final.png`
                    },
                    {
                        caption: html`AI无法行动，您获胜了！`
                    }
                );
            } catch (error) {
                // 如果图片渲染失败，fallback到HTML渲染
                console.error('棋盘图片渲染失败:', error);

                // 使用HTML作为备用
                const boardHtml = BoardRenderer.renderBoardHTML(game);
                await ctx.message.replyText(
                    html`${html(boardHtml)}<br>AI无法行动，您获胜了！`
                );
            }
            return;
        }

        // 执行AI移动
        game.move(aiMove.from, aiMove.to);

        // 确定状态消息
        let statusMessage: string;

        // 如果游戏结束，显示胜利信息
        if (game.status === GameStatus.FINISHED) {
            statusMessage = 'AI获胜了！';
        } else {
            statusMessage = '轮到您行动';
        }

        try {
            // 生成棋盘图片
            const boardBuffer = await BoardRenderer.drawBoardImage(game);

            // 发送AI走子结果
            await ctx.message.replyMedia(
                {
                    type: 'photo',
                    file: boardBuffer,
                    fileName: `chess_${game.id}_ai.png`
                },
                {
                    caption: html`第 ${Math.floor(game.history.length / 2) + 1} 回合 - ${statusMessage}${game.lastMove ? ` | AI走法：${game.lastMove}` : ''}`
                }
            );
        } catch (error) {
            // 如果图片渲染失败，fallback到HTML渲染
            console.error('棋盘图片渲染失败:', error);

            // 使用HTML作为备用
            const boardHtml = BoardRenderer.renderBoardHTML(game);
            await ctx.message.replyText(
                html`${html(boardHtml)}<br>${statusMessage}`
            );
        }
    } catch (error) {
        // 确保即使在AI计算或发送消息出错时也删除“思考中”提示
        // 确保即使在AI计算或发送消息出错时也删除“思考中”提示
        if (thinkingMessageId) {
            try {
                await ctx.client.deleteMessagesById(ctx.chatId, [thinkingMessageId]);
            } catch (deleteError) {
                log.error('Failed to delete thinking message:', deleteError);
            }
        }
        // 重新抛出原始错误
        throw error;
    }
}

/**
 * 获取难度文本描述
 */
function getDifficultyText(difficulty: number): string {
    switch (difficulty) {
        case AI_DIFFICULTY_LEVELS.easy:
            return '初级';
        case AI_DIFFICULTY_LEVELS.normal:
            return '中级';
        case AI_DIFFICULTY_LEVELS.hard:
            return '高级(云库)';
        default:
            return '初级';
    }
}

/**
 * 认输
 */
async function resignGame(ctx: CommandContext) {
    const userId = ctx.message.sender.id;

    // 查找玩家当前的游戏
    const game = gameManager.getPlayerActiveGame(userId);

    if (!game) {
        await ctx.message.replyText('您当前没有进行中的游戏');
        return;
    }

    // 执行认输
    const success = game.resign(userId);

    if (!success) {
        await ctx.message.replyText('无法认输，可能游戏已经结束');
        return;
    }

    // 处理获胜者显示
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

    try {
        // 生成棋盘图片
        const boardBuffer = await BoardRenderer.drawBoardImage(game);

        // 发送认输结果
        await ctx.message.replyMedia(
            {
                type: 'photo',
                file: boardBuffer,
                fileName: `chess_${game.id}_resign.png`
            },
            {
                caption: html`第 ${Math.floor(game.history.length / 2) + 1} 回合 - 游戏结束，${winner}获胜！`
            }
        );
    } catch (error) {
        // 如果图片渲染失败，fallback到HTML渲染
        console.error('棋盘图片渲染失败:', error);

        // 使用HTML作为备用
        const boardHtml = BoardRenderer.renderBoardHTML(game);
        await ctx.message.replyText(html`${html(boardHtml)}<br>游戏结束，${winner}获胜！`);
    }

    // 移除游戏
    gameManager.endGame(game.id);
}

/**
 * 显示当前游戏状态
 */
async function showGameStatus(ctx: CommandContext) {
    const userId = ctx.message.sender.id;

    // 查找玩家当前的游戏
    const game = gameManager.getPlayerActiveGame(userId);

    if (!game) {
        await ctx.message.replyText('您当前没有进行中的游戏');
        return;
    }

    // 获取游戏状态文本
    const statusText = game.getStatusText();

    try {
        // 生成棋盘图片
        const boardBuffer = await BoardRenderer.drawBoardImage(game);

        // 发送游戏状态
        await ctx.message.replyMedia(
            {
                type: 'photo',
                file: boardBuffer,
                fileName: `chess_${game.id}_status.png`
            },
            {
                caption: html`第 ${Math.floor(game.history.length / 2) + 1} 回合 - ${statusText}`
            }
        );
    } catch (error) {
        // 如果图片渲染失败，fallback到HTML渲染
        console.error('棋盘图片渲染失败:', error);

        // 使用HTML作为备用
        const boardHtml = BoardRenderer.renderBoardHTML(game);
        await ctx.message.replyText(
            html`${html(boardHtml)}<br>${statusText}`
        );
    }
}

export default plugin;
