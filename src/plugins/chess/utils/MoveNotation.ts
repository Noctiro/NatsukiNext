import { Board } from '../models/Board';
import { Piece } from '../models/Piece';
import { PieceColor, PieceType } from '../models/ChessTypes';
import type { Position } from '../models/ChessTypes';

/**
 * 中国象棋走法标记类
 * 负责解析和生成中文走法
 */
export class MoveNotation {
    // 数字转中文数字映射
    private readonly NUM_TO_CHINESE: Record<number, string> = {
        1: '一',
        2: '二',
        3: '三',
        4: '四',
        5: '五',
        6: '六',
        7: '七',
        8: '八',
        9: '九'
    };
    
    // 数字转繁体中文数字映射
    private readonly NUM_TO_TRAD_CHINESE: Record<number, string> = {
        1: '壹',
        2: '贰',
        3: '叁',
        4: '肆',
        5: '伍',
        6: '陆',
        7: '柒',
        8: '捌',
        9: '玖'
    };
    
    // 中文数字转数字映射
    private readonly CHINESE_TO_NUM: Record<string, number> = {
        '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
        '壹': 1, '贰': 2, '叁': 3, '肆': 4, '伍': 5, '陆': 6, '柒': 7, '捌': 8, '玖': 9,
        '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
        // 修正黑方数字映射（棋盘从右往左）
        '１': 8, '２': 7, '３': 6, '４': 5, '５': 4, '６': 3, '７': 2, '８': 1, '９': 0  
    };
    
    // 简体到繁体字符映射
    private readonly SIMPLIFIED_TO_TRADITIONAL: Record<string, string> = {
        '车': '車',
        '马': '馬',
        '炮': '砲',
        '相': '相',
        '象': '象',
        '士': '士',
        '仕': '仕',
        '将': '將',
        '帅': '帥',
        '兵': '兵',
        '卒': '卒',
        '进': '進',
        '退': '退',
        '平': '平'
    };
    
    // 繁体到简体字符映射
    private readonly TRADITIONAL_TO_SIMPLIFIED: Record<string, string> = {
        '車': '车',
        '馬': '马',
        '砲': '炮',
        '相': '相',
        '象': '象',
        '士': '士',
        '仕': '仕',
        '將': '将',
        '帥': '帅',
        '兵': '兵',
        '卒': '卒',
        '進': '进',
        '退': '退',
        '平': '平'
    };
    
    /**
     * 解析中文走法
     * @returns 起始和目标位置
     */
    parseChineseNotation(notation: string, board: Board, currentTurn: PieceColor): { from?: Position, to?: Position } {
        // 将繁体字转换为简体
        notation = this.convertToSimplified(notation);
        
        // 将数字替换为中文数字
        notation = notation.replace(/([车马炮象相仕士将帅兵卒])(\d)/g, (_, piece, num) => {
            const chineseNum = this.NUM_TO_CHINESE[parseInt(num)] || '';
            return piece + chineseNum;
        });
        
        // 分解走法文本
        if (notation.length < 4) {
            throw new Error('走法格式不正确，应为"炮二平五"这样的格式');
        }
        
        const pieceChar = notation.charAt(0);
        const positionChar = notation.charAt(1);
        const actionChar = notation.charAt(2);
        const targetChar = notation.charAt(3);
        
        // 确定棋子类型
        let pieceType: PieceType;
        switch (pieceChar) {
            case '车':
                pieceType = PieceType.CHARIOT;
                break;
            case '马':
                pieceType = PieceType.HORSE;
                break;
            case '象':
            case '相':
                pieceType = PieceType.ELEPHANT;
                break;
            case '士':
            case '仕':
                pieceType = PieceType.ADVISOR;
                break;
            case '将':
            case '帅':
                pieceType = PieceType.GENERAL;
                break;
            case '炮':
                pieceType = PieceType.CANNON;
                break;
            case '兵':
            case '卒':
                pieceType = PieceType.SOLDIER;
                break;
            default:
                throw new Error(`未知的棋子类型: ${pieceChar}`);
        }
        
        // 找到起始位置的棋子
        const sourcePiece = this.findPieceByNotation(board, pieceType, currentTurn, positionChar);
        if (!sourcePiece) {
            throw new Error(`找不到符合条件的${pieceChar}${positionChar}棋子`);
        }
        
        const [sourceRow, sourceCol] = sourcePiece.position;
        
        // 计算目标位置
        let targetRow: number | undefined = undefined;
        let targetCol: number | undefined = undefined;
        
        const targetNum = this.CHINESE_TO_NUM[targetChar];
        if (!targetNum) {
            throw new Error(`无效的目标数字/列: ${targetChar}`);
        }

        // 根据动作计算目标位置
        switch (actionChar) {
            case '平':
                targetRow = sourceRow;
                // 目标列根据颜色转换视角
                targetCol = currentTurn === PieceColor.RED ? 
                    targetNum - 1 : 
                    8 - (targetNum - 1);
                break;
            
            case '进':
            case '退':
                const isForward = actionChar === '进';
                const isRed = currentTurn === PieceColor.RED;

                // 线性移动棋子 (车, 炮, 兵, 将/帅)
                if ([PieceType.CHARIOT, PieceType.CANNON, PieceType.SOLDIER, PieceType.GENERAL].includes(pieceType)) {
                    targetCol = sourceCol; // 列不变
                    const steps = targetNum;
                    if (isRed) {
                        targetRow = isForward ? sourceRow - steps : sourceRow + steps;
                    } else {
                        targetRow = isForward ? sourceRow + steps : sourceRow - steps;
                    }
                } 
                // 非线性移动棋子 (马, 象, 士)
                else {
                    // 目标列根据颜色转换视角
                    targetCol = isRed ? targetNum - 1 : 8 - (targetNum - 1);
                    
                    // 查找唯一匹配的几何移动
                    const possibleMoves = this.getGeometricMoves(pieceType, [sourceRow, sourceCol]);
                    const matchingMoves = possibleMoves.filter(move => {
                        const [tRow, tCol] = move;
                        // 检查目标列是否匹配
                        if (tCol !== targetCol) return false;
                        // 检查方向是否匹配
                        const movingForward = isRed ? tRow < sourceRow : tRow > sourceRow;
                        return movingForward === isForward;
                    });

                    if (matchingMoves.length === 1) {
                        const theMove = matchingMoves[0];
                        // Use non-null assertion '!' as we know theMove is defined here
                        targetRow = theMove![0]; 
                    } else if (matchingMoves.length === 0) {
                        throw new Error(`找不到从 (${sourceRow},${sourceCol}) ${actionChar} 到列 ${targetNum} 的合法 ${pieceChar} 走法`);
                    } else {
                        throw new Error(`从 (${sourceRow},${sourceCol}) ${actionChar} 到列 ${targetNum} 的 ${pieceChar} 走法不明确`);
                    }
                }
                break;

            default:
                throw new Error(`无效的动作: ${actionChar}`);
        }

        // 检查计算出的目标位置
        if (targetRow === undefined || targetCol === undefined) {
             throw new Error('无法计算目标位置');
        }
        
        // 检查目标位置是否在棋盘范围内 (必须在计算后检查)
        if (!board.isValidPosition(targetRow, targetCol)) {
            throw new Error('目标位置超出棋盘范围');
        }

        return {
            from: [sourceRow, sourceCol],
            to: [targetRow, targetCol]
        };
    }
    
    /**
     * 生成走法标记
     */
    generateMoveNotation(piece: Piece, from: Position, to: Position): string {
        const [fromRow, fromCol] = from;
        const [toRow, toCol] = to;
        
        // 棋子名称
        let pieceText = piece.name;
        
        // 确定棋子的位置描述
        let positionText = this.getPositionText(piece, fromCol);
        
        // 确定移动方向和距离
        let actionText: string;
        let targetText: string;
        
        if (fromRow === toRow) {
            // 水平移动("平")
            actionText = '平';
            targetText = this.NUM_TO_CHINESE[toCol + 1] || '一';
        } else if ((piece.color === PieceColor.RED && toRow < fromRow) ||
                  (piece.color === PieceColor.BLACK && toRow > fromRow)) {
            // 向前移动("进")
            actionText = '进';
            targetText = this.NUM_TO_CHINESE[Math.abs(toRow - fromRow)] || '一';
        } else {
            // 向后移动("退")
            actionText = '退';
            targetText = this.NUM_TO_CHINESE[Math.abs(toRow - fromRow)] || '一';
        }
        
        return pieceText + positionText + actionText + targetText;
    }
    
    /**
     * 生成繁体走法标记
     */
    generateTraditionalMoveNotation(piece: Piece, from: Position, to: Position): string {
        const simplifiedNotation = this.generateMoveNotation(piece, from, to);
        return this.convertToTraditional(simplifiedNotation);
    }
    
    /**
     * 根据列号获取棋子位置描述
     */
    private getPositionText(piece: Piece, col: number): string {
        // 获取列号（基于1的索引）
        const colNum = col + 1;
        
        // 对于"帅"和"将"，使用"中"表示
        if (piece.type === PieceType.GENERAL) {
            return '中';
        }
        
        return this.NUM_TO_CHINESE[colNum] || '一';
    }
    
    /**
     * 将繁体字转换为简体字
     */
    private convertToSimplified(text: string): string {
        return [...text].map(char => this.TRADITIONAL_TO_SIMPLIFIED[char] || char).join('');
    }
    
    /**
     * 将简体字转换为繁体字
     */
    private convertToTraditional(text: string): string {
        return [...text].map(char => this.SIMPLIFIED_TO_TRADITIONAL[char] || char).join('');
    }
    
    /**
     * 根据位置描述找到对应的棋子
     */
    private findPieceByNotation(board: Board, type: PieceType, color: PieceColor, positionChar: string): Piece | null {
        // 获取所有匹配类型和颜色的棋子
        const pieces = board.getPiecesByTypeAndColor(type, color);
        
        if (pieces.length === 0) {
            return null;
        }
        
        if (pieces.length === 1) {
            // 只有一个这种类型的棋子
            return pieces[0] || null;
        }
        
        // 如果是相对位置描述（前、中、后）
        if (['前', '中', '后'].includes(positionChar)) {
            // 根据颜色不同，前后的定义不同
            const sortedPieces = [...pieces].sort((a, b) => {
                if (color === PieceColor.RED) {
                    // 红方：前(0) -> 后(9)
                    return a.position[0] - b.position[0];
                } else {
                    // 黑方：前(9) -> 后(0)
                    return b.position[0] - a.position[0];
                }
            });
            
            switch (positionChar) {
                case '前':
                    return sortedPieces[0] || null;
                case '中':
                    return sortedPieces.length >= 3 ? sortedPieces[1] || null : null;
                case '后':
                    return sortedPieces[sortedPieces.length - 1] || null;
                default:
            }
        }
        
        // 如果是数字位置描述 (一到九 / １到９)
        const colNum = this.CHINESE_TO_NUM[positionChar];
        if (colNum !== undefined) {
            // 根据颜色转换列索引
            // 红方: '一' (1) -> 0, '九' (9) -> 8 => colNum - 1
            // 黑方: '１' (mapped to 8) -> 8, '９' (mapped to 0) -> 0 => colNum (map handles conversion)
            const targetCol = color === PieceColor.RED ? colNum - 1 : colNum;

            // 查找指定列的棋子 (使用 find)
            const foundPiece = pieces.find(piece => piece.position[1] === targetCol);
            return foundPiece || null; // Return the found piece or null if none in that column
        }

        // 如果 positionChar 不是 前/中/后 也不是有效数字
        return null;
    }

    /**
     * 获取指定棋子类型从某位置出发的所有几何可能移动（不考虑棋盘状态）
     */
    private getGeometricMoves(type: PieceType, from: Position): Position[] {
        const [r, c] = from;
        const moves: Position[] = [];

        switch (type) {
            case PieceType.HORSE: // 马
                moves.push(
                    [r - 2, c - 1], [r - 2, c + 1], [r - 1, c - 2], [r - 1, c + 2],
                    [r + 1, c - 2], [r + 1, c + 2], [r + 2, c - 1], [r + 2, c + 1]
                );
                break;
            case PieceType.ELEPHANT: // 象/相
                moves.push(
                    [r - 2, c - 2], [r - 2, c + 2], [r + 2, c - 2], [r + 2, c + 2]
                );
                break;
            case PieceType.ADVISOR: // 士/仕
                moves.push(
                    [r - 1, c - 1], [r - 1, c + 1], [r + 1, c - 1], [r + 1, c + 1]
                );
                break;
            // 其他棋子类型在此方法中不处理，因为它们的进/退是线性的
        }

        // 过滤掉棋盘外的坐标 (简单过滤，更严格的验证在isValidMove中)
        return moves.filter(([tr, tc]) => tr >= 0 && tr <= 9 && tc >= 0 && tc <= 8);
    }
}
