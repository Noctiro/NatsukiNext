import { Piece } from '../models/Piece';
import { PieceColor, PieceType } from '../models/ChessTypes';
import type { Position } from '../models/ChessTypes';
import { Board } from '../models/Board';
import crypto from "crypto";

/**
 * Implements Zobrist hashing for Chinese Chess boards.
 * Used for efficient position identification in transposition tables.
 */
export class ZobristHash {
    // Explicitly type the multi-dimensional array
    // Using Record for better type safety with enums might be even better,
    // but this matches the original structure.
    private pieceKeys: bigint[][][][] = [];
    // Key for side to move (Black)
    private sideToMoveKey: bigint;
    // TODO: Add keys for castling rights, en passant target square if needed for standard chess

    constructor() {
        this.pieceKeys = [];
        this.initializeKeys();
        this.sideToMoveKey = this.randomBigInt();
    }

    /**
     * 使用Node.js crypto生成安全的64位随机BigInt
     */
    private randomBigInt(): bigint {
        // 生成8字节随机数据（64位）
        const bytes = crypto.randomBytes(8);
        if (bytes.length !== 8) {
            throw new Error("Failed to generate 8 random bytes");
        }

        // 转换为BigInt（大端序）
        let value = 0n;
        for (let i = 0; i < bytes.length; i++) {
            value = (value << 8n) | BigInt(bytes.readUInt8(i));
        }
        
        // 确保生成的是64位值
        return value & 0xFFFFFFFFFFFFFFFFn;
    }

    /**
     * Initializes the random keys for each piece type, color, and square.
     */
    private initializeKeys(): void {
        // Ensure PieceType and PieceColor enum values are treated as numbers for indexing
        // 初始化所有可能的棋子类型和颜色组合
        for (let type = 0; type < Object.keys(PieceType).length / 2; type++) {
            this.pieceKeys[type] = [];
            for (let color = 0; color < Object.keys(PieceColor).length / 2; color++) {
                this.pieceKeys[type]![color] = [];
                for (let r = 0; r < Board.ROWS; r++) {
                    this.pieceKeys[type]![color]![r] = [];
                    for (let c = 0; c < Board.COLS; c++) {
                        this.pieceKeys[type]![color]![r]![c] = this.randomBigInt();
                    }
                }
            }
        }
    }

    /**
     * Calculates the Zobrist hash for a given board state.
     * @param board The current board object.
     * @param sideToMove The color of the player whose turn it is.
     * @returns A 64-bit BigInt representing the board hash.
     */
    public calculateHash(board: Board, sideToMove: PieceColor = PieceColor.RED /* 中国象棋红方先走 */): bigint {
        let hash = 0n;

        for (let r = 0; r < Board.ROWS; r++) {
            for (let c = 0; c < Board.COLS; c++) {
                const piece = board.getPiece([r, c]);
                if (piece) {
                    // Use enum values directly as indices. TypeScript handles numeric enums.
                    // Assert numeric enum values and validate array structure
                    const typeIndex = piece.type as unknown as number;
                    const colorIndex = piece.color as unknown as number;
                    
                    // Validate the multidimensional array structure exists
                    if (!this.pieceKeys[typeIndex] || 
                        !this.pieceKeys[typeIndex][colorIndex] ||
                        !this.pieceKeys[typeIndex][colorIndex][r]) {
                        console.warn(`Zobrist lookup failed at [${typeIndex}][${colorIndex}][${r}][${c}]`);
                        continue;
                    }
                    
                    const key = this.pieceKeys[typeIndex][colorIndex]![r]![c];
                    if (key !== undefined) {
                        hash ^= key;
                    } else {
                        // This warning is important if it occurs at runtime
                        console.warn(`Zobrist key missing or undefined for piece type: ${typeIndex}, color: ${colorIndex}, pos: [${r},${c}]`);
                    }
                }
            }
        }

        // XOR with side-to-move key if it's Black's turn (or whichever color is designated)
        if (sideToMove === PieceColor.BLACK) {
            hash ^= this.sideToMoveKey;
        }

        // 中国象棋不需要处理王车易位和吃过路兵

        return hash;
    }

    /**
     * Updates the hash incrementally after a move. More efficient than recalculating.
     * @param currentHash The hash before the move.
     * @param board The board *before* the move.
     * @param move The move being made ({ from: Position, to: Position }).
     * @param pieceMoved The piece that moved.
     * @param pieceCaptured The piece captured (if any).
     * @param oldSideToMove The side to move *before* the move.
     * @returns The updated hash after the move.
     */
    public updateHash(
        currentHash: bigint,
        board: Board, // Board state *before* the move
        move: { from: Position, to: Position },
        pieceMoved: Piece,
        pieceCaptured: Piece | null,
        oldSideToMove: PieceColor
    ): bigint {
        let newHash = currentHash;
        const [fromRow, fromCol] = move.from;
        const [toRow, toCol] = move.to;
        // Use enum values directly
        const movedType = pieceMoved.type as unknown as number;
        const movedColor = pieceMoved.color as unknown as number;

        // Add checks before XORing
        const keyFrom = this.pieceKeys[movedType]?.[movedColor]?.[fromRow]?.[fromCol];
        if (keyFrom !== undefined) {
            newHash ^= keyFrom; // 1. XOR out the piece from its original square
        } else {
             console.warn(`Zobrist key missing for moved piece at from-pos: [${fromRow},${fromCol}]`);
        }

        const keyTo = this.pieceKeys[movedType]?.[movedColor]?.[toRow]?.[toCol];
         if (keyTo !== undefined) {
            newHash ^= keyTo; // 2. XOR in the piece at its destination square
        } else {
             console.warn(`Zobrist key missing for moved piece at to-pos: [${toRow},${toCol}]`);
        }


        // 3. If a piece was captured, XOR it out from the destination square
        if (pieceCaptured) {
            const capturedType = pieceCaptured.type as unknown as number;
            const capturedColor = pieceCaptured.color as unknown as number;
            const keyCaptured = this.pieceKeys[capturedType]?.[capturedColor]?.[toRow]?.[toCol];
            if (keyCaptured !== undefined) {
                 newHash ^= keyCaptured;
            } else {
                 console.warn(`Zobrist key missing for captured piece at to-pos: [${toRow},${toCol}]`);
            }
        }

        // 4. Flip the side to move key
        newHash ^= this.sideToMoveKey;

        // 中国象棋需要处理特殊规则（例如炮的吃子、兵过河等）
        // 可以根据具体规则添加额外的哈希处理

        return newHash;
    }
}
