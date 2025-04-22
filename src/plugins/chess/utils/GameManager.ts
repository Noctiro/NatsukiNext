import { Game } from '../models/Game';
import { PieceColor } from '../models/ChessTypes';
import type { IInvite } from '../models/ChessTypes';
import { GameStatus } from '../models/ChessTypes';

/**
 * 游戏管理器，负责管理所有游戏和邀请
 */
export class GameManager {
    // 单例实例
    private static instance: GameManager;

    // 活跃的游戏列表
    private activeGames: Map<string, Game> = new Map();

    // 等待中的邀请
    private pendingInvites: Map<number, IInvite> = new Map();

    // 锁定状态，避免并发问题
    private operationLock: boolean = false;

    // 私有构造函数，确保只能通过 getInstance 创建实例
    private constructor() { }

    /**
     * 获取 GameManager 单例实例
     */
    public static getInstance(): GameManager {
        if (!GameManager.instance) {
            GameManager.instance = new GameManager();
        }
        return GameManager.instance;
    }

    /**
     * 获取锁，避免并发操作冲突
     * @returns 是否成功获取锁
     */
    private acquireLock(): boolean {
        if (this.operationLock) {
            return false;
        }
        this.operationLock = true;
        return true;
    }

    /**
     * 释放锁
     */
    private releaseLock(): void {
        this.operationLock = false;
    }

    /**
     * 创建新游戏
     * 在创建游戏前检查双方是否已经在其他游戏中
     * @returns 如果任一玩家已在游戏中，返回null；否则返回新游戏实例
     */
    createGame(redPlayer: number, blackPlayer: number | 'AI', chatId: number): Game | null {
        // 尝试获取锁
        if (!this.acquireLock()) {
            return null; // 无法获取锁，放弃操作
        }

        try {
            // 检查红方玩家是否已经在游戏中
            if (typeof redPlayer === 'number' && this.getPlayerActiveGame(redPlayer)) {
                return null;
            }

            // 检查黑方玩家是否已经在游戏中（如果不是AI）
            if (typeof blackPlayer === 'number' && this.getPlayerActiveGame(blackPlayer)) {
                return null;
            }

            // 如果两者都不在游戏中，创建新游戏
            const game = new Game(redPlayer, blackPlayer, chatId);
            this.activeGames.set(game.id, game);
            return game;
        } finally {
            // 确保锁一定会被释放
            this.releaseLock();
        }
    }

    /**
     * 根据ID获取游戏
     */
    getGame(gameId: string): Game | undefined {
        return this.activeGames.get(gameId);
    }

    /**
     * 根据ID获取游戏（别名方法，保持API一致性）
     */
    getGameById(gameId: string): Game | undefined {
        return this.getGame(gameId);
    }

    /**
     * 获取玩家当前参与的游戏
     */
    getPlayerActiveGame(playerId: number): Game | undefined {
        return Array.from(this.activeGames.values()).find(game =>
            (game.redPlayer === playerId || game.blackPlayer === playerId) &&
            game.status === 'playing'
        );
    }

    /**
     * 检查两个玩家是否已经在同一局游戏中对战
     */
    arePlayersInGame(player1Id: number, player2Id: number): boolean {
        return Array.from(this.activeGames.values()).some(game =>
            game.status === 'playing' &&
            ((game.redPlayer === player1Id && game.blackPlayer === player2Id) ||
                (game.redPlayer === player2Id && game.blackPlayer === player1Id))
        );
    }

    /**
     * 获取当前轮到玩家行动的游戏
     */
    getPlayerTurnGame(playerId: number): Game | undefined {
        return Array.from(this.activeGames.values()).find(game =>
            ((game.redPlayer === playerId && game.currentTurn === PieceColor.RED) ||
                (game.blackPlayer === playerId && game.currentTurn === PieceColor.BLACK)) &&
            game.status === 'playing'
        );
    }

    /**
     * 结束游戏
     * @param gameId 要结束的游戏ID
     * @returns 是否成功结束游戏
     */
    endGame(gameId: string): boolean {
        // 尝试获取锁
        if (!this.acquireLock()) {
            return false; // 无法获取锁，放弃操作
        }

        try {
            const game = this.activeGames.get(gameId);
            if (!game) {
                return false;
            }

            // 先确保游戏状态标记为已结束
            if (game.status !== GameStatus.FINISHED) {
                game.status = GameStatus.FINISHED;
            }

            // 从活跃游戏列表中移除
            this.activeGames.delete(gameId);
            return true;
        } finally {
            // 确保锁一定会被释放
            this.releaseLock();
        }
    }

    /**
     * 添加邀请
     */
    addInvite(targetUserId: number, inviterId: number): string {
        const gameId = `invite_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        this.pendingInvites.set(targetUserId, {
            inviter: inviterId,
            gameId,
            expires: Date.now() + 5 * 60 * 1000 // 5分钟有效期
        });

        return gameId;
    }

    /**
     * 获取邀请
     */
    getInvite(userId: number): IInvite | undefined {
        return this.pendingInvites.get(userId);
    }

    /**
     * 检查是否存在特定的邀请
     */
    hasInvite(targetId: number, inviterId: number): boolean {
        const invite = this.pendingInvites.get(targetId);
        return invite !== undefined && invite.inviter === inviterId;
    }

    /**
     * 移除邀请
     */
    removeInvite(userId: number): boolean {
        return this.pendingInvites.delete(userId);
    }

    /**
     * 清理过期邀请
     */
    cleanupExpiredInvites(): void {
        const now = Date.now();
        for (const [userId, invite] of this.pendingInvites.entries()) {
            if (invite.expires < now) {
                this.pendingInvites.delete(userId);
            }
        }
    }

    /**
     * 清理已完成的游戏
     * 可以在定期任务中调用此方法以回收内存
     */
    cleanupFinishedGames(): void {
        for (const [gameId, game] of this.activeGames.entries()) {
            if (game.status === 'finished') {
                this.activeGames.delete(gameId);
            }
        }
    }

    /**
     * 获取所有活跃游戏
     */
    getAllActiveGames(): Game[] {
        return Array.from(this.activeGames.values()).filter(game => game.status === 'playing');
    }

    /**
     * 获取聊天中进行的所有游戏
     */
    getChatGames(chatId: number): Game[] {
        return Array.from(this.activeGames.values()).filter(game => game.chatId === chatId);
    }

    /**
     * 检查并结束超时的游戏
     * @param timeoutHours 超时时间（小时）
     * @returns 超时并被结束的游戏列表
     */
    checkTimeoutGames(timeoutHours: number = 12): Game[] {
        const now = Date.now();
        const timeoutMs = timeoutHours * 60 * 60 * 1000; // 转换为毫秒
        const timeoutGames: Game[] = [];

        for (const game of this.activeGames.values()) {
            if (game.status === GameStatus.PLAYING && (now - game.lastActiveTime) > timeoutMs) {
                // 游戏超时，标记为已结束
                game.status = GameStatus.FINISHED;
                // 根据当前回合确定获胜方（超时方判负）
                game.winner = game.currentTurn === PieceColor.RED ? PieceColor.BLACK : PieceColor.RED;
                timeoutGames.push(game);
            }
        }

        return timeoutGames;
    }
} 