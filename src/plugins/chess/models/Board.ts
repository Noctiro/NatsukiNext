import { PieceType, PieceColor } from './ChessTypes';
import type { IPiece, Position } from './ChessTypes';
import { Piece } from './Piece';

/**
 * 棋盘类
 */
export class Board {
    // 棋盘尺寸常量
    static readonly ROWS = 10;
    static readonly COLS = 9;

    // 棋盘数据
    private data: (Piece | null)[][] = [];

    /**
     * 创建一个棋盘实例
     */
    constructor() {
        // 创建空棋盘
        this.data = [];
        for (let i = 0; i < Board.ROWS; i++) {
            this.data[i] = Array(Board.COLS).fill(null);
        }
    }

    /**
     * 初始化标准象棋布局
     */
    initializeStandardLayout(): void {
        // 清空棋盘
        this.clear();

        // 红方（下方）
        // 车
        this.placePiece(new Piece(PieceType.CHARIOT, PieceColor.RED, [9, 0]));
        this.placePiece(new Piece(PieceType.CHARIOT, PieceColor.RED, [9, 8]));
        // 马
        this.placePiece(new Piece(PieceType.HORSE, PieceColor.RED, [9, 1]));
        this.placePiece(new Piece(PieceType.HORSE, PieceColor.RED, [9, 7]));
        // 相
        this.placePiece(new Piece(PieceType.ELEPHANT, PieceColor.RED, [9, 2]));
        this.placePiece(new Piece(PieceType.ELEPHANT, PieceColor.RED, [9, 6]));
        // 士
        this.placePiece(new Piece(PieceType.ADVISOR, PieceColor.RED, [9, 3]));
        this.placePiece(new Piece(PieceType.ADVISOR, PieceColor.RED, [9, 5]));
        // 帅
        this.placePiece(new Piece(PieceType.GENERAL, PieceColor.RED, [9, 4]));
        // 炮
        this.placePiece(new Piece(PieceType.CANNON, PieceColor.RED, [7, 1]));
        this.placePiece(new Piece(PieceType.CANNON, PieceColor.RED, [7, 7]));
        // 兵
        for (let col = 0; col < Board.COLS; col += 2) {
            this.placePiece(new Piece(PieceType.SOLDIER, PieceColor.RED, [6, col]));
        }

        // 黑方（上方）
        // 车
        this.placePiece(new Piece(PieceType.CHARIOT, PieceColor.BLACK, [0, 0]));
        this.placePiece(new Piece(PieceType.CHARIOT, PieceColor.BLACK, [0, 8]));
        // 马
        this.placePiece(new Piece(PieceType.HORSE, PieceColor.BLACK, [0, 1]));
        this.placePiece(new Piece(PieceType.HORSE, PieceColor.BLACK, [0, 7]));
        // 象
        this.placePiece(new Piece(PieceType.ELEPHANT, PieceColor.BLACK, [0, 2]));
        this.placePiece(new Piece(PieceType.ELEPHANT, PieceColor.BLACK, [0, 6]));
        // 士
        this.placePiece(new Piece(PieceType.ADVISOR, PieceColor.BLACK, [0, 3]));
        this.placePiece(new Piece(PieceType.ADVISOR, PieceColor.BLACK, [0, 5]));
        // 将
        this.placePiece(new Piece(PieceType.GENERAL, PieceColor.BLACK, [0, 4]));
        // 炮
        this.placePiece(new Piece(PieceType.CANNON, PieceColor.BLACK, [2, 1]));
        this.placePiece(new Piece(PieceType.CANNON, PieceColor.BLACK, [2, 7]));
        // 卒
        for (let col = 0; col < Board.COLS; col += 2) {
            this.placePiece(new Piece(PieceType.SOLDIER, PieceColor.BLACK, [3, col]));
        }
    }

    /**
     * 清空棋盘
     */
    clear(): void {
        for (let row = 0; row < Board.ROWS; row++) {
            // 确保行数组存在
            if (!this.data[row]) {
                this.data[row] = Array(Board.COLS).fill(null);
            } else {
                // 清空现有行
                for (let col = 0; col < Board.COLS; col++) {
                    this.data[row]![col] = null;
                }
            }
        }
    }

    /**
     * 放置棋子
     */
    placePiece(piece: Piece): void {
        const [row, col] = piece.position;
        if (this.isValidPosition(row, col) && this.data[row]) {
            this.data[row][col] = piece;
        }
    }

    /**
     * 移动棋子
     * @returns 被吃掉的棋子（如果有）
     */
    movePiece(from: Position, to: Position): Piece | null {
        const [fromRow, fromCol] = from;
        const [toRow, toCol] = to;

        // 检查位置是否有效
        if (!this.isValidPosition(fromRow, fromCol) || !this.isValidPosition(toRow, toCol)) {
            return null;
        }

        if (!this.data[fromRow] || !this.data[toRow]) {
            return null;
        }

        // 获取要移动的棋子
        const piece = this.data[fromRow][fromCol];
        if (!piece) {
            return null;
        }

        // 保存目标位置可能存在的棋子（被吃掉的）
        const capturedPiece = this.data[toRow][toCol];

        // 更新棋子位置
        piece.moveTo(to);
        this.data[toRow][toCol] = piece;
        this.data[fromRow][fromCol] = null;

        return capturedPiece || null;
    }

    /**
     * 获取指定位置的棋子
     */
    getPiece(position: Position): Piece | null {
        const [row, col] = position;
        if (this.isValidPosition(row, col) && this.data[row]) {
            return this.data[row][col] || null;
        }
        return null;
    }

    /**
     * 获取指定颜色的所有棋子
     */
    getPiecesByColor(color: PieceColor): Piece[] {
        const pieces: Piece[] = [];
        for (let row = 0; row < Board.ROWS; row++) {
            if (!this.data[row]) continue;
            for (let col = 0; col < Board.COLS; col++) {
                const piece = this.data[row]?.[col];
                if (piece && piece.color === color) {
                    pieces.push(piece);
                }
            }
        }
        return pieces;
    }

    /**
     * 获取特定类型和颜色的棋子
     */
    getPiecesByTypeAndColor(type: PieceType, color: PieceColor): Piece[] {
        return this.getPiecesByColor(color).filter(piece => piece.type === type);
    }

    /**
     * 检查位置是否在棋盘范围内
     */
    isValidPosition(row: number, col: number): boolean {
        return row >= 0 && row < Board.ROWS && col >= 0 && col < Board.COLS;
    }

    /**
     * 获取棋盘数据的副本
     */
    getBoardData(): (Piece | null)[][] {
        return this.data.map(row => [...row]);
    }

    /**
     * 创建棋盘副本
     */
    clone(): Board {
        const newBoard = new Board();
        for (let row = 0; row < Board.ROWS; row++) {
            if (!this.data[row]) continue;

            // 确保目标板上的行数组存在
            if (!newBoard.data[row]) {
                newBoard.data[row] = Array(Board.COLS).fill(null);
            }

            for (let col = 0; col < Board.COLS; col++) {
                const piece = this.data[row]![col];
                if (piece) {
                    newBoard.data[row]![col] = piece.clone();
                }
            }
        }
        return newBoard;
    }

    /**
     * 检查将帅是否面对面
     */
    areGeneralsFacing(): boolean {
        // 找到红方帅
        const redGeneral = this.getPiecesByTypeAndColor(PieceType.GENERAL, PieceColor.RED)[0];
        // 找到黑方将
        const blackGeneral = this.getPiecesByTypeAndColor(PieceType.GENERAL, PieceColor.BLACK)[0];

        if (!redGeneral || !blackGeneral) {
            return false;
        }

        // 检查是否在同一列
        if (redGeneral.position[1] !== blackGeneral.position[1]) {
            return false;
        }

        // 检查它们之间是否有其他棋子
        const col = redGeneral.position[1];
        const startRow = Math.min(redGeneral.position[0], blackGeneral.position[0]);
        const endRow = Math.max(redGeneral.position[0], blackGeneral.position[0]);

        for (let row = startRow + 1; row < endRow; row++) {
            const rowData = this.data[row];
            if (rowData && rowData[col] !== null) {
                return false;
            }
        }

        return true;
    }
} 