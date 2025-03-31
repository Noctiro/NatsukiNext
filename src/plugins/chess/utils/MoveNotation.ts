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
        // 标准化：所有数字表示都映射到 1-9
        '１': 1, '２': 2, '３': 3, '４': 4, '５': 5, '６': 6, '７': 7, '８': 8, '９': 9
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
        '平': '平',
        '前': '前',
        '中': '中',
        '后': '後',
        '右': '右',
        '左': '左'
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
        '平': '平',
        '前': '前',
        '中': '中',
        '後': '后',
        '右': '右',
        '左': '左'
    };

    /**
     * 解析中文走法
     * @returns 起始和目标位置
     */
    parseChineseNotation(notation: string, board: Board, currentTurn: PieceColor): { from?: Position, to?: Position } {
        try {
            // 将繁体字转换为简体
            notation = this.convertToSimplified(notation.trim());
    
            // 分解走法文本
            if (notation.length < 2) {
                throw new Error('走法格式不正确，应为"炮二平五"或类似格式');
            }
    
            // 提取走法各部分
            const parts = this.extractNotationParts(notation);
            if (!parts) {
                throw new Error(`无法解析走法: ${notation}`);
            }
    
            const { pieceChar, positionChar, actionChar, targetChar, directionChar } = parts;
    
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
            const sourcePiece = this.findPieceByNotation(board, pieceType, currentTurn, positionChar, directionChar);
            if (!sourcePiece) {
                throw new Error(`找不到符合条件的${directionChar || ''}${pieceChar}${positionChar}棋子`);
            }
    
            const [sourceRow, sourceCol] = sourcePiece.position;
    
            // 计算目标位置
            let targetRow: number | undefined = undefined;
            let targetCol: number | undefined = undefined;
    
            // 将数字字符转为对应的数值
            let targetNum = 0; // 初始化为0，避免undefined
            if (/\d/.test(targetChar)) {
                targetNum = parseInt(targetChar);
            } else {
                const num = this.CHINESE_TO_NUM[targetChar];
                if (num === undefined) {
                    throw new Error(`无效的目标数字/列: ${targetChar}`);
                }
                targetNum = num;
            }
    
            // 验证目标数字的合理性
            if (targetNum <= 0 || targetNum > 9) {
                throw new Error(`目标数字/列无效: ${targetNum}，应在1-9之间`);
            }
    
            // 根据动作计算目标位置
            switch (actionChar) {
                case '平':
                    targetRow = sourceRow;
                    // 目标列根据颜色转换视角 (num 1-9 -> col 0-8)
                    // Red: col = num - 1
                    // Black: col = 9 - num
                    targetCol = currentTurn === PieceColor.RED ?
                        targetNum - 1 :
                        9 - targetNum;
                    
                    if (targetCol < 0 || targetCol >= Board.COLS) {
                        throw new Error(`目标列超出棋盘范围: ${targetCol}，应在0-8之间`);
                    }
                    break;
    
                case '进':
                case '退':
                    const isForward = actionChar === '进';
                    const isRed = currentTurn === PieceColor.RED;
    
                    // 线性移动棋子 (车, 炮, 兵, 将/帅)
                    if ([PieceType.CHARIOT, PieceType.CANNON, PieceType.SOLDIER, PieceType.GENERAL].includes(pieceType)) {
                        targetCol = sourceCol; // 列不变
                        const steps = targetNum;
                        
                        // 检查步数是否合理
                        if (pieceType === PieceType.GENERAL && steps > 1) {
                            throw new Error(`将/帅一次只能走一步，不能走${steps}步`);
                        }
                        
                        if (pieceType === PieceType.SOLDIER && steps > 1) {
                            throw new Error(`兵/卒一次只能走一步，不能走${steps}步`);
                        }
                        
                        // 计算目标行
                        if (isRed) {
                            targetRow = isForward ? sourceRow - steps : sourceRow + steps;
                        } else {
                            targetRow = isForward ? sourceRow + steps : sourceRow - steps;
                        }
                        
                        // 检查行范围
                        if (targetRow < 0 || targetRow >= Board.ROWS) {
                            throw new Error(`目标行超出棋盘范围: ${targetRow}，应在0-9之间`);
                        }
                        
                        // 特殊检查：兵卒的移动限制
                        if (pieceType === PieceType.SOLDIER) {
                            const crossedRiver = isRed ? sourceRow < 5 : sourceRow > 4;
                            
                            // 未过河只能前进，已过河可以左右平移（但在MoveValidator中验证）
                            if (!crossedRiver && !isForward) {
                                throw new Error('兵/卒未过河前只能前进，不能后退');
                            }
                        }
                    }
                    // 非线性移动棋子 (马, 象, 士)
                    else {
                        // 目标列根据颜色转换视角 (num 1-9 -> col 0-8)
                        targetCol = isRed ? targetNum - 1 : 9 - targetNum;
                        
                        if (targetCol < 0 || targetCol >= Board.COLS) {
                            throw new Error(`目标列超出棋盘范围: ${targetCol}，应在0-8之间`);
                        }
    
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
                            
                            // 额外检查（例如象不能过河等）
                            if (pieceType === PieceType.ELEPHANT) {
                                const crossedRiver = isRed ? targetRow < 5 : targetRow > 4;
                                if (crossedRiver) {
                                    throw new Error('象/相不能过河');
                                }
                            } else if (pieceType === PieceType.ADVISOR) {
                                const inPalace = isRed 
                                    ? (targetRow >= 7 && targetRow <= 9 && targetCol >= 3 && targetCol <= 5)
                                    : (targetRow >= 0 && targetRow <= 2 && targetCol >= 3 && targetCol <= 5);
                                if (!inPalace) {
                                    throw new Error('士/仕必须在九宫格内移动');
                                }
                            }
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
                throw new Error(`目标位置 [${targetRow},${targetCol}] 超出棋盘范围，棋盘大小为 ${Board.ROWS}×${Board.COLS}`);
            }
    
            return {
                from: [sourceRow, sourceCol],
                to: [targetRow, targetCol]
            };
        } catch (error) {
            // 重新抛出错误，保持原始错误信息
            throw error;
        }
    }

    /**
     * 提取走法文本中的各部分
     * 支持多种格式：
     * 1. 标准格式：炮二平五
     * 2. 带位置标记：前炮退二、中兵进一
     * 3. 带方向标记：左马进三、右车平四
     * 4. 简化格式：马3（默认为进）、车四（默认为平）
     */
    private extractNotationParts(notation: string): {
        pieceChar: string,
        positionChar: string,
        actionChar: string,
        targetChar: string,
        directionChar?: string
    } | null {
        // 最小长度检查
        if (notation.length < 2) {
            return null;
        }

        let index = 0;
        let pieceChar = '';
        let positionChar = '';
        let actionChar = '';
        let targetChar = '';
        let directionChar: string | undefined = undefined;

        // 检查是否以方向或位置标记开头
        if (['前', '中', '后', '左', '右'].includes(notation.charAt(0))) {
            if (['左', '右'].includes(notation.charAt(0))) {
                directionChar = notation.charAt(0);
            } else {
                positionChar = notation.charAt(0);
            }
            index = 1;
        }

        // 获取棋子类型
        pieceChar = notation.charAt(index++);

        // 如果只有两个字符，例如"马3"，默认为"进"
        if (notation.length === 2) {
            actionChar = '进';
            targetChar = notation.charAt(index);
            return { pieceChar, positionChar, actionChar, targetChar, directionChar };
        }

        // 处理特殊格式："相进三"等简化记法
        if (notation.length === 3 && 
            (pieceChar === '象' || pieceChar === '相' || pieceChar === '士' || pieceChar === '仕') && 
            (notation.charAt(index) === '进' || notation.charAt(index) === '退')) {
            positionChar = notation.charAt(index); // 进/退 作为位置标识
            actionChar = notation.charAt(index++);   // 进/退 也是动作
            targetChar = notation.charAt(index);   // 目标位置
            return { pieceChar, positionChar, actionChar, targetChar, directionChar };
        }

        // 处理位置标记（如果还没有）
        if (!positionChar && index < notation.length) {
            // 如果下一个字符是动作标记，则没有位置标记
            if (!['进', '退', '平'].includes(notation.charAt(index))) {
                positionChar = notation.charAt(index++);
            }
        }

        // 处理动作标记
        if (index < notation.length) {
            if (['进', '退', '平'].includes(notation.charAt(index))) {
                actionChar = notation.charAt(index++);
            } else if (/[\d一二三四五六七八九壹贰叁肆伍陆柒捌玖１２３４５６７８９]/.test(notation.charAt(index))) {
                // 如果下一个字符是数字且没有动作标记，根据棋子类型默认动作
                actionChar = pieceChar === '车' || pieceChar === '炮' ? '平' : '进';
            } else {
                // 无法识别的动作
                return null;
            }
        }

        // 处理目标位置
        if (index < notation.length) {
            targetChar = notation.charAt(index);
        } else {
            // 没有目标位置
            return null;
        }

        return { pieceChar, positionChar, actionChar, targetChar, directionChar };
    }

    /**
     * 生成走法标记
     */
    generateMoveNotation(piece: Piece, from: Position, to: Position, board: Board): string {
        const [fromRow, fromCol] = from;
        const [toRow, toCol] = to;

        // 棋子名称
        let pieceText = piece.name;

        // 确定棋子的位置描述
        let positionText = this.getPositionText(piece, fromCol, fromRow, board); // 列描述（考虑颜色和特殊情况）

        // 确定移动方向和距离
        let actionText: string;
        let targetDesc: string; // 目标列或步数描述（考虑颜色）

        if (fromRow === toRow) {
            // 水平移动("平")
            actionText = '平';
            // 目标列描述 (col 0-8 -> num 1-9 based on color)
            const targetColNum = piece.color === PieceColor.RED ? toCol + 1 : 9 - toCol;
            targetDesc = this.NUM_TO_CHINESE[targetColNum] || '?';
        } else {
            // 垂直或斜向移动 ("进" 或 "退")
            const isForward = (piece.color === PieceColor.RED && toRow < fromRow) ||
                (piece.color === PieceColor.BLACK && toRow > fromRow);
            actionText = isForward ? '进' : '退';

            // 线性移动棋子 (车, 炮, 兵, 将/帅) - 描述为步数
            if ([PieceType.CHARIOT, PieceType.CANNON, PieceType.SOLDIER, PieceType.GENERAL].includes(piece.type)) {
                targetDesc = this.NUM_TO_CHINESE[Math.abs(toRow - fromRow)] || '?';
            }
            // 非线性移动棋子 (马, 象, 士) - 描述为目标列
            else {
                const targetColNum = piece.color === PieceColor.RED ? toCol + 1 : 9 - toCol;
                targetDesc = this.NUM_TO_CHINESE[targetColNum] || '?';
            }
        }

        // 为仕(士)和相(象)使用简化记法
        if ((piece.type === PieceType.ADVISOR || piece.type === PieceType.ELEPHANT) &&
            fromRow !== toRow) {
            
            // 获取同类型的所有棋子
            const pieces = board.getPiecesByTypeAndColor(piece.type, piece.color);
            
            // 如果有两个相同类型的棋子且它们在同一纵线上
            if (pieces.length === 2) {
                const otherPiece = pieces.find(p => p !== piece && p.position[1] === piece.position[1]);
                
                // 如果在同一纵线上，可以使用简化记法
                if (otherPiece) {
                    return pieceText + actionText + targetDesc;
                }
            }
        }

        return pieceText + positionText + actionText + targetDesc;
    }

    /**
     * 生成繁体走法标记
     */
    generateTraditionalMoveNotation(piece: Piece, from: Position, to: Position, board: Board): string {
        const simplifiedNotation = this.generateMoveNotation(piece, from, to, board);
        return this.convertToTraditional(simplifiedNotation);
    }

    /**
     * 根据列号获取棋子位置描述 (考虑颜色视角和特殊情况)
     */
    private getPositionText(piece: Piece, col: number, row: number, board: Board): string {
        // 获取列号（基于1-9的索引，根据颜色调整）
        // Red: col 0 -> num 1, col 8 -> num 9 => num = col + 1
        // Black: col 0 -> num 9, col 8 -> num 1 => num = 9 - col
        const colNum = piece.color === PieceColor.RED ? col + 1 : 9 - col;

        // 对于"帅"和"将"，通常不需要位置标识
        if (piece.type === PieceType.GENERAL) {
            return '';
        }

        // 获取同类型棋子
        const pieces = board.getPiecesByTypeAndColor(piece.type, piece.color);

        // 如果只有一个这种类型的棋子，不需要位置标识
        if (pieces.length === 1) {
            return '';
        }

        // 兵(卒)的特殊处理
        if (piece.type === PieceType.SOLDIER) {
            // 按列分组
            const piecesByColumn = new Map<number, Piece[]>();
            
            for (const p of pieces) {
                const pieceCol = p.position[1];
                if (!piecesByColumn.has(pieceCol)) {
                    piecesByColumn.set(pieceCol, []);
                }
                const piecesArray = piecesByColumn.get(pieceCol);
                if (piecesArray) {
                    piecesArray.push(p);
                }
            }
            
            // 情况1: 三个兵在一条纵线上，使用前中后
            if (piecesByColumn.size === 1 && pieces.length === 3) {
                const sortedPieces = [...pieces].sort((a, b) => {
                    if (piece.color === PieceColor.RED) {
                        // 红方：前(0) -> 后(9)
                        return a.position[0] - b.position[0];
                    } else {
                        // 黑方：前(9) -> 后(0)
                        return b.position[0] - a.position[0];
                    }
                });
                
                if (piece === sortedPieces[0]) return '前';
                if (piece === sortedPieces[1]) return '中';
                if (piece === sortedPieces[2]) return '后';
            }
            
            // 情况2: 三个以上兵在一条纵线上，最前用"一"，依次是"二"、"三"等
            if (piecesByColumn.size === 1 && pieces.length > 3) {
                const sortedPieces = [...pieces].sort((a, b) => {
                    if (piece.color === PieceColor.RED) {
                        // 红方：前(0) -> 后(9)
                        return a.position[0] - b.position[0];
                    } else {
                        // 黑方：前(9) -> 后(0)
                        return b.position[0] - a.position[0];
                    }
                });
                
                for (let i = 0; i < sortedPieces.length; i++) {
                    if (piece === sortedPieces[i]) {
                        return this.NUM_TO_CHINESE[i + 1] || '?';
                    }
                }
            }
            
            // 情况3: 两条纵线上各有兵，按照"先从右到左，再从前到后"标记
            if (piecesByColumn.size === 2) {
                // 获取列并排序（从右到左）
                const columns = Array.from(piecesByColumn.keys()).sort((a, b) => b - a);
                
                let index = 1;
                // 先从右到左处理列
                for (const c of columns) {
                    const piecesInCol = piecesByColumn.get(c);
                    if (piecesInCol) {
                        // 再从前到后排序每列中的棋子
                        const sortedPiecesInCol = [...piecesInCol].sort((a, b) => {
                            if (piece.color === PieceColor.RED) {
                                // 红方：前(0) -> 后(9)
                                return a.position[0] - b.position[0];
                            } else {
                                // 黑方：前(9) -> 后(0)
                                return b.position[0] - a.position[0];
                            }
                        });
                        
                        // 检查当前棋子是否在此排序中
                        for (let i = 0; i < sortedPiecesInCol.length; i++) {
                            if (piece === sortedPiecesInCol[i]) {
                                return this.NUM_TO_CHINESE[index] || '?';
                            }
                            index++;
                        }
                    }
                }
            }
        }

        // 默认返回列号的中文表示
        return this.NUM_TO_CHINESE[colNum] || '?';
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
    private findPieceByNotation(
        board: Board, 
        type: PieceType, 
        color: PieceColor, 
        positionChar: string,
        directionChar?: string
    ): Piece | null {
        // 获取所有匹配类型和颜色的棋子
        let pieces = board.getPiecesByTypeAndColor(type, color);

        if (pieces.length === 0) {
            return null;
        }

        if (pieces.length === 1) {
            // 只有一个这种类型的棋子
            return pieces[0] || null;
        }

        // 处理左右方向标记
        if (directionChar) {
            // 按列排序
            const sortedByCol = [...pieces].sort((a, b) => {
                if (directionChar === '右') {
                    // 右侧的棋子列号较大
                    return b.position[1] - a.position[1];
                } else {
                    // 左侧的棋子列号较小
                    return a.position[1] - b.position[1];
                }
            });

            // 返回最靠左/右的一个
            return sortedByCol[0] || null;
        }

        // 为仕(士)和相(象)的特殊处理
        if (type === PieceType.ADVISOR || type === PieceType.ELEPHANT) {
            // 如果有"进"或"退"的提示，不需要用前后区分
            // 能退的一定在前，能进的一定在后
            if (positionChar === '进' || positionChar === '退') {
                const sortedPieces = [...pieces].sort((a, b) => {
                    if (color === PieceColor.RED) {
                        // 红方：前(0) -> 后(9)
                        return a.position[0] - b.position[0];
                    } else {
                        // 黑方：前(9) -> 后(0)
                        return b.position[0] - a.position[0];
                    }
                });
                
                return positionChar === '进' ? sortedPieces[sortedPieces.length - 1] || null : sortedPieces[0] || null;
            }
        }

        // 兵(卒)的特殊处理
        if (type === PieceType.SOLDIER) {
            // 按列分组
            const piecesByColumn = new Map<number, Piece[]>();
            
            for (const piece of pieces) {
                const col = piece.position[1];
                if (!piecesByColumn.has(col)) {
                    piecesByColumn.set(col, []);
                }
                const piecesArray = piecesByColumn.get(col);
                if (piecesArray) {
                    piecesArray.push(piece);
                }
            }
            
            // 情况1: 三个兵在一条纵线上，使用前中后
            if (piecesByColumn.size === 1 && pieces.length === 3) {
                if (['前', '中', '后'].includes(positionChar)) {
                    const col = pieces[0]?.position[1];
                    if (col !== undefined) {
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
                            case '前': return sortedPieces[0] || null;
                            case '中': return sortedPieces[1] || null;
                            case '后': return sortedPieces[2] || null;
                        }
                    }
                }
            }
            
            // 情况2: 三个以上兵在一条纵线上，最前用"一"，依次是"二"、"三"等
            if (piecesByColumn.size === 1 && pieces.length > 3) {
                const colNum = this.CHINESE_TO_NUM[positionChar];
                if (colNum !== undefined && colNum >= 1 && colNum <= pieces.length) {
                    const col = pieces[0]?.position[1];
                    if (col !== undefined) {
                        const sortedPieces = [...pieces].sort((a, b) => {
                            if (color === PieceColor.RED) {
                                // 红方：前(0) -> 后(9)
                                return a.position[0] - b.position[0];
                            } else {
                                // 黑方：前(9) -> 后(0)
                                return b.position[0] - a.position[0];
                            }
                        });
                        
                        return sortedPieces[colNum - 1] || null;
                    }
                }
            }
            
            // 情况3: 两条纵线上各有兵，从右到左，从前到后标记
            if (piecesByColumn.size === 2) {
                const colNum = this.CHINESE_TO_NUM[positionChar];
                if (colNum !== undefined && colNum >= 1 && colNum <= pieces.length) {
                    // 获取列并排序（从右到左）
                    const columns = Array.from(piecesByColumn.keys()).sort((a, b) => b - a);
                    
                    let pieceIndex = 0;
                    const orderedPieces: Piece[] = [];
                    
                    // 先从右到左处理列
                    for (const col of columns) {
                        const piecesInCol = piecesByColumn.get(col);
                        if (piecesInCol) {
                            // 再从前到后排序每列中的棋子
                            const sortedPiecesInCol = [...piecesInCol].sort((a, b) => {
                                if (color === PieceColor.RED) {
                                    // 红方：前(0) -> 后(9)
                                    return a.position[0] - b.position[0];
                                } else {
                                    // 黑方：前(9) -> 后(0)
                                    return b.position[0] - a.position[0];
                                }
                            });
                            
                            // 将排序后的棋子添加到统一列表
                            orderedPieces.push(...sortedPiecesInCol);
                        }
                    }
                    
                    // 返回对应序号的棋子
                    if (colNum > 0 && colNum <= orderedPieces.length) {
                        return orderedPieces[colNum - 1] || null;
                    }
                }
            }
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
            // 根据颜色转换列索引 (colNum is 1-9 from CHINESE_TO_NUM)
            // Red: col = num - 1
            // Black: col = 9 - num
            const targetCol = color === PieceColor.RED ? colNum - 1 : 9 - colNum;

            // 查找指定列的棋子 (使用 find)
            const foundPiece = pieces.find(piece => piece.position[1] === targetCol);
            return foundPiece || null; // Return the found piece or null if none in that column
        }

        // 如果 positionChar 为空且没有方向标记，尝试使用默认的第一个棋子
        if (!positionChar && !directionChar && pieces.length > 0) {
            return pieces[0] || null;
        }

        // 如果 positionChar 不是 前/中/后 也不是有效数字，且没有其他条件匹配
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

        // 过滤掉棋盘外的坐标 (严格过滤，确保在棋盘范围内)
        return moves.filter(([tr, tc]) => 
            tr >= 0 && tr < Board.ROWS && 
            tc >= 0 && tc < Board.COLS
        );
    }
}
