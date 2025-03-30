/**
 * 象棋游戏基本类型定义
 */

// 游戏状态枚举
export enum GameStatus {
    WAITING = 'waiting',  // 等待玩家加入
    PLAYING = 'playing',  // 游戏进行中
    FINISHED = 'finished' // 游戏已结束
}

// 棋子类型枚举
export enum PieceType {
    GENERAL = 'general',   // 将/帅
    ADVISOR = 'advisor',   // 士/仕
    ELEPHANT = 'elephant', // 象/相
    HORSE = 'horse',       // 马
    CHARIOT = 'chariot',   // 车
    CANNON = 'cannon',     // 炮
    SOLDIER = 'soldier'    // 卒/兵
}

// 棋子颜色枚举
export enum PieceColor {
    RED = 'red',     // 红方
    BLACK = 'black'  // 黑方
}

// 棋子位置类型
export type Position = [number, number]; // [row, column]

// 棋子接口
export interface IPiece {
    type: PieceType;
    color: PieceColor;
    position: Position;
    name: string; // 中文名称
}

// 游戏对局接口
export interface IGame {
    id: string;
    redPlayer: number; // 红方玩家的用户ID
    blackPlayer: number | 'AI'; // 黑方玩家的用户ID或AI
    status: GameStatus;
    board: (IPiece | null)[][]; // 9x10的棋盘
    currentTurn: PieceColor;
    chatId: number; // 对局所在的聊天ID
    messageId?: number; // 当前棋盘消息的ID
    lastMove?: string; // 上一步的走法描述
    history: string[]; // 历史走法
    startTime: number; // 游戏开始时间
    winner?: PieceColor; // 获胜方
}

// 走法结果接口
export interface IMoveResult {
    success: boolean;
    message?: string;
    from?: Position;
    to?: Position;
    capturedPiece?: IPiece | null;
}

// 邀请信息接口
export interface IInvite {
    inviter: number;
    gameId: string;
    expires: number;
} 