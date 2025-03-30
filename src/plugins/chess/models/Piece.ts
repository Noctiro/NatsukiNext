import { PieceType, PieceColor } from './ChessTypes';
import type { IPiece, Position } from './ChessTypes';

/**
 * 棋子类
 */
export class Piece implements IPiece {
    type: PieceType;
    color: PieceColor;
    position: Position;
    name: string;

    constructor(type: PieceType, color: PieceColor, position: Position, name?: string) {
        this.type = type;
        this.color = color;
        this.position = position;
        this.name = name || this.getDefaultName();
    }

    /**
     * 获取棋子默认名称
     */
    private getDefaultName(): string {
        switch (this.type) {
            case PieceType.GENERAL:
                return this.color === PieceColor.RED ? '帅' : '将';
            case PieceType.ADVISOR:
                return this.color === PieceColor.RED ? '仕' : '士';
            case PieceType.ELEPHANT:
                return this.color === PieceColor.RED ? '相' : '象';
            case PieceType.HORSE:
                return '马';
            case PieceType.CHARIOT:
                return '车';
            case PieceType.CANNON:
                return '炮';
            case PieceType.SOLDIER:
                return this.color === PieceColor.RED ? '兵' : '卒';
            default:
                return '?';
        }
    }

    /**
     * 创建一个棋子的复制
     */
    clone(): Piece {
        return new Piece(this.type, this.color, [...this.position], this.name);
    }

    /**
     * 移动棋子到新位置
     */
    moveTo(newPosition: Position): void {
        this.position = [...newPosition];
    }

    /**
     * 获取棋子在繁体字中的名称
     */
    getTraditionalName(): string {
        switch (this.type) {
            case PieceType.GENERAL:
                return this.color === PieceColor.RED ? '帥' : '將';
            case PieceType.ADVISOR:
                return this.color === PieceColor.RED ? '仕' : '士';
            case PieceType.ELEPHANT:
                return this.color === PieceColor.RED ? '相' : '象';
            case PieceType.HORSE:
                return '馬';
            case PieceType.CHARIOT:
                return '車';
            case PieceType.CANNON:
                return '砲';
            case PieceType.SOLDIER:
                return this.color === PieceColor.RED ? '兵' : '卒';
            default:
                return '?';
        }
    }
} 