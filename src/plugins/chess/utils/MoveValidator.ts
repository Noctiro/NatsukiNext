import { Board } from '../models/Board';
import { PieceType } from '../models/ChessTypes';
import type { Position } from '../models/ChessTypes';
import { Piece } from '../models/Piece';

/**
 * 走法验证器类
 * 用于验证象棋中各种棋子的走法是否合法
 */
export class MoveValidator {
    /**
     * 验证走法是否合法
     */
    isValidMove(board: Board, from: Position, to: Position): boolean {
        const piece = board.getPiece(from);
        
        // 没有棋子可移动
        if (!piece) {
            return false;
        }
        
        // 目标位置是否有己方棋子
        const targetPiece = board.getPiece(to);
        if (targetPiece && targetPiece.color === piece.color) {
            return false;
        }
        
        // 根据棋子类型验证走法
        switch (piece.type) {
            case PieceType.GENERAL:
                return this.validateGeneralMove(piece, from, to);
            case PieceType.ADVISOR:
                return this.validateAdvisorMove(piece, from, to);
            case PieceType.ELEPHANT:
                return this.validateElephantMove(board, piece, from, to);
            case PieceType.HORSE:
                return this.validateHorseMove(board, from, to);
            case PieceType.CHARIOT:
                return this.validateChariotMove(board, from, to);
            case PieceType.CANNON:
                return this.validateCannonMove(board, from, to);
            case PieceType.SOLDIER:
                return this.validateSoldierMove(piece, from, to);
            default:
                return false;
        }
    }
    
    /**
     * 验证将/帅的走法
     * 将/帅只能在九宫格内移动，每次只能走一格（上下左右）
     */
    private validateGeneralMove(piece: Piece, from: Position, to: Position): boolean {
        const [fromRow, fromCol] = from;
        const [toRow, toCol] = to;
        
        // 检查是否在九宫格内
        if (!this.isInPalace(piece.color, toRow, toCol)) {
            return false;
        }
        
        // 检查移动距离是否为一格
        const rowDiff = Math.abs(toRow - fromRow);
        const colDiff = Math.abs(toCol - fromCol);
        
        // 只能上下左右移动一格
        return (rowDiff === 1 && colDiff === 0) || (rowDiff === 0 && colDiff === 1);
    }
    
    /**
     * 验证士/仕的走法
     * 士/仕只能在九宫格内斜走一格
     */
    private validateAdvisorMove(piece: Piece, from: Position, to: Position): boolean {
        const [fromRow, fromCol] = from;
        const [toRow, toCol] = to;
        
        // 检查是否在九宫格内
        if (!this.isInPalace(piece.color, toRow, toCol)) {
            return false;
        }
        
        // 检查是否斜走一格
        return Math.abs(toRow - fromRow) === 1 && Math.abs(toCol - fromCol) === 1;
    }
    
    /**
     * 验证象/相的走法
     * 象/相走田字，即斜走两格，且象不能过河，同时中间不能有棋子（蹩象腿）
     */
    private validateElephantMove(board: Board, piece: Piece, from: Position, to: Position): boolean {
        const [fromRow, fromCol] = from;
        const [toRow, toCol] = to;
        
        // 检查是否在己方区域（象不能过河）
        if (piece.color === 'red' && toRow < 5) {
            return false;  // 红方象不能过河
        }
        
        if (piece.color === 'black' && toRow > 4) {
            return false;  // 黑方象不能过河
        }
        
        // 检查是否走田字
        if (Math.abs(toRow - fromRow) !== 2 || Math.abs(toCol - fromCol) !== 2) {
            return false;
        }
        
        // 检查象眼是否被塞住（蹩象腿）
        const eyeRow = (fromRow + toRow) / 2;
        const eyeCol = (fromCol + toCol) / 2;
        return board.getPiece([eyeRow, eyeCol]) === null;
    }
    
    /**
     * 验证马的走法
     * 马走日字，即一格直线加一格斜线，且马腿不能有棋子
     */
    private validateHorseMove(board: Board, from: Position, to: Position): boolean {
        const [fromRow, fromCol] = from;
        const [toRow, toCol] = to;
        
        // 马走日字
        const rowDiff = Math.abs(toRow - fromRow);
        const colDiff = Math.abs(toCol - fromCol);
        
        if (!((rowDiff === 2 && colDiff === 1) || (rowDiff === 1 && colDiff === 2))) {
            return false;
        }
        
        // 检查马腿
        let legRow = fromRow;
        let legCol = fromCol;
        
        if (rowDiff === 2) {
            // 沿行走，检查垂直马腿
            legRow = fromRow + (toRow > fromRow ? 1 : -1);
        } else {
            // 沿列走，检查水平马腿
            legCol = fromCol + (toCol > fromCol ? 1 : -1);
        }
        
        return board.getPiece([legRow, legCol]) === null;
    }
    
    /**
     * 验证车的走法
     * 车走直线，不能越子
     */
    private validateChariotMove(board: Board, from: Position, to: Position): boolean {
        const [fromRow, fromCol] = from;
        const [toRow, toCol] = to;
        
        // 确保车走直线（行或列）
        if (fromRow !== toRow && fromCol !== toCol) {
            return false;
        }
        
        // 检查路径上是否有棋子
        return !this.hasObstacleInPath(board, from, to);
    }
    
    /**
     * 验证炮的走法
     * 炮走直线，不能越子；但吃子时必须隔一个棋子（炮架）
     */
    private validateCannonMove(board: Board, from: Position, to: Position): boolean {
        const [fromRow, fromCol] = from;
        const [toRow, toCol] = to;
        const targetPiece = board.getPiece(to);
        
        // 确保炮走直线（行或列）
        if (fromRow !== toRow && fromCol !== toCol) {
            return false;
        }
        
        // 计算路径上的棋子数
        const piecesInPath = this.countPiecesInPath(board, from, to);
        
        if (targetPiece) {
            // 吃子：路径上必须有且只有一个棋子（炮架）
            return piecesInPath === 1;
        } else {
            // 移动：路径上不能有棋子
            return piecesInPath === 0;
        }
    }
    
    /**
     * 验证兵/卒的走法
     * 兵/卒未过河前只能向前走，过河后可左右走
     * 每次只能走一格
     */
    private validateSoldierMove(piece: Piece, from: Position, to: Position): boolean {
        const [fromRow, fromCol] = from;
        const [toRow, toCol] = to;
        
        // 每次只能走一格
        if (Math.abs(toRow - fromRow) + Math.abs(toCol - fromCol) !== 1) {
            return false;
        }
        
        // 红方兵
        if (piece.color === 'red') {
            // 未过河（在己方区域）
            if (fromRow > 4) {
                // 只能向前（向上）走
                return toRow === fromRow - 1 && toCol === fromCol;
            } else {
                // 过河后，可以向前或左右走，但不能后退
                return toRow <= fromRow && (toRow === fromRow || toCol !== fromCol);
            }
        } 
        // 黑方卒
        else {
            // 未过河（在己方区域）
            if (fromRow < 5) {
                // 只能向前（向下）走
                return toRow === fromRow + 1 && toCol === fromCol;
            } else {
                // 过河后，可以向前或左右走，但不能后退
                return toRow >= fromRow && (toRow === fromRow || toCol !== fromCol);
            }
        }
    }
    
    /**
     * 检查位置是否在九宫格内
     */
    private isInPalace(color: string, row: number, col: number): boolean {
        if (color === 'red') {
            // 红方九宫格（下方）
            return row >= 7 && row <= 9 && col >= 3 && col <= 5;
        } else {
            // 黑方九宫格（上方）
            return row >= 0 && row <= 2 && col >= 3 && col <= 5;
        }
    }
    
    /**
     * 检查路径上是否有障碍
     */
    private hasObstacleInPath(board: Board, from: Position, to: Position): boolean {
        return this.countPiecesInPath(board, from, to) > 0;
    }
    
    /**
     * 计算路径上的棋子数量（不包括起点和终点）
     */
    private countPiecesInPath(board: Board, from: Position, to: Position): number {
        const [fromRow, fromCol] = from;
        const [toRow, toCol] = to;
        let count = 0;
        
        // 水平移动
        if (fromRow === toRow) {
            const minCol = Math.min(fromCol, toCol);
            const maxCol = Math.max(fromCol, toCol);
            
            for (let col = minCol + 1; col < maxCol; col++) {
                if (board.getPiece([fromRow, col])) {
                    count++;
                }
            }
        }
        // 垂直移动
        else if (fromCol === toCol) {
            const minRow = Math.min(fromRow, toRow);
            const maxRow = Math.max(fromRow, toRow);
            
            for (let row = minRow + 1; row < maxRow; row++) {
                if (board.getPiece([row, fromCol])) {
                    count++;
                }
            }
        }
        
        return count;
    }
} 