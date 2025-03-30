import { GameStatus, PieceColor, PieceType } from './ChessTypes';
import type { IGame, IPiece, Position, IMoveResult } from './ChessTypes';
import { Board } from './Board';
import { MoveValidator } from '../utils/MoveValidator.js';
import { MoveNotation } from '../utils/MoveNotation.js';

/**
 * 象棋游戏类
 */
export class Game implements IGame {
    id: string;
    redPlayer: number;
    blackPlayer: number | 'AI';
    status: GameStatus;
    board: (IPiece | null)[][];
    currentTurn: PieceColor;
    chatId: number;
    lastMove?: string;
    lastMovePositions?: { from: Position, to: Position };
    history: string[];
    startTime: number;
    winner?: PieceColor;

    private boardObj: Board;
    private moveValidator: MoveValidator;
    private moveNotation: MoveNotation;

    /**
     * 创建新游戏
     */
    constructor(redPlayer: number, blackPlayer: number | 'AI', chatId: number) {
        this.id = `game_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        this.redPlayer = redPlayer;
        this.blackPlayer = blackPlayer;
        this.status = GameStatus.PLAYING;
        this.currentTurn = PieceColor.RED; // 红方先行
        this.chatId = chatId;
        this.history = [];
        this.startTime = Date.now();

        // 初始化棋盘
        this.boardObj = new Board();
        this.boardObj.initializeStandardLayout();
        this.board = this.boardObj.getBoardData();

        // 创建走法验证器和记号解析器
        this.moveValidator = new MoveValidator();
        this.moveNotation = new MoveNotation();
    }

    /**
     * 尝试移动棋子
     */
    move(from: Position, to: Position): IMoveResult {
        // 检查游戏是否正在进行
        if (this.status !== GameStatus.PLAYING) {
            return {
                success: false,
                message: '游戏已经结束'
            };
        }

        // 获取起始位置的棋子
        const piece = this.boardObj.getPiece(from);
        if (!piece) {
            return {
                success: false,
                message: '起始位置没有棋子'
            };
        }

        // 检查是否是当前玩家的回合
        if (piece.color !== this.currentTurn) {
            return {
                success: false,
                message: `当前是${this.currentTurn === PieceColor.RED ? '红方' : '黑方'}的回合`
            };
        }

        // 验证走法是否合法
        if (!this.moveValidator.isValidMove(this.boardObj, from, to)) {
            return {
                success: false,
                message: '无效的走法'
            };
        }

        // 如果合法，执行移动
        const capturedPiece = this.boardObj.movePiece(from, to);

        // 检查走法执行后将帅是否面对面
        if (this.boardObj.areGeneralsFacing()) {
            // 撤销移动
            this.boardObj.movePiece(to, from);
            if (capturedPiece) {
                this.boardObj.placePiece(capturedPiece);
            }
            return {
                success: false,
                message: '该走法会导致将帅面对面，不合法'
            };
        }

        // 生成走法记号
        const moveNotation = this.moveNotation.generateMoveNotation(piece, from, to);

        // 更新游戏状态
        this.lastMove = moveNotation;
        this.lastMovePositions = { from: [...from], to: [...to] };
        this.history.push(moveNotation);
        this.board = this.boardObj.getBoardData();

        // 切换回合
        this.currentTurn = this.currentTurn === PieceColor.RED ? PieceColor.BLACK : PieceColor.RED;

        // 检查游戏是否结束
        if (capturedPiece && capturedPiece.type === PieceType.GENERAL) {
            this.status = GameStatus.FINISHED;
            this.winner = piece.color;
        }

        return {
            success: true,
            from,
            to,
            capturedPiece
        };
    }

    /**
     * 根据中文走法表示执行移动
     */
    moveByNotation(notation: string): IMoveResult {
        try {
            // 解析中文走法
            const { from, to } = this.moveNotation.parseChineseNotation(notation, this.boardObj, this.currentTurn);
            if (!from || !to) {
                return {
                    success: false,
                    message: '无法解析走法，请使用标准的中国象棋走法表示，例如：炮二平五'
                };
            }

            // 执行移动
            return this.move(from, to);
        } catch (error) {
            return {
                success: false,
                message: `走法解析错误: ${error instanceof Error ? error.message : '未知错误'}`
            };
        }
    }

    /**
     * 获取当前游戏状态的文本描述
     */
    getStatusText(): string {
        if (this.status === GameStatus.FINISHED) {
            const winnerText = this.winner === PieceColor.RED ? '红方' : '黑方';
            return `游戏已结束，${winnerText}获胜！`;
        } else {
            const turnText = this.currentTurn === PieceColor.RED ? '红方' : '黑方';
            return `游戏进行中，轮到${turnText}行动`;
        }
    }

    /**
     * 让玩家认输
     */
    resign(playerId: number): boolean {
        if (this.status !== GameStatus.PLAYING) {
            return false;
        }

        // 确认玩家是游戏参与者
        if (playerId !== this.redPlayer && playerId !== this.blackPlayer) {
            return false;
        }

        // 设置游戏结束
        this.status = GameStatus.FINISHED;
        
        // 设置对方为获胜者
        if (playerId === this.redPlayer) {
            this.winner = PieceColor.BLACK;
        } else {
            this.winner = PieceColor.RED;
        }

        return true;
    }

    /**
     * 获取指定玩家的颜色
     */
    getPlayerColor(playerId: number): PieceColor | null {
        if (playerId === this.redPlayer) {
            return PieceColor.RED;
        } else if (playerId === this.blackPlayer) {
            return PieceColor.BLACK;
        }
        return null;
    }

    /**
     * 获取Board对象的引用
     */
    getBoardObject(): Board {
        return this.boardObj;
    }
} 