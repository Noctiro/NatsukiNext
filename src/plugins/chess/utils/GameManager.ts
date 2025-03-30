import { Game } from '../models/Game';
import { PieceColor } from '../models/ChessTypes';
import type { IInvite } from '../models/ChessTypes';

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

    // 私有构造函数，确保只能通过 getInstance 创建实例
    private constructor() {}

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
     * 创建新游戏
     */
    createGame(redPlayer: number, blackPlayer: number | 'AI', chatId: number): Game {
        const game = new Game(redPlayer, blackPlayer, chatId);
        this.activeGames.set(game.id, game);
        return game;
    }

    /**
     * 根据ID获取游戏
     */
    getGame(gameId: string): Game | undefined {
        return this.activeGames.get(gameId);
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
     */
    endGame(gameId: string): boolean {
        const game = this.activeGames.get(gameId);
        if (game) {
            this.activeGames.delete(gameId);
            return true;
        }
        return false;
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
} 