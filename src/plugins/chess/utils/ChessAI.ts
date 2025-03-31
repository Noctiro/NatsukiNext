import { Board } from '../models/Board';
import { Piece } from '../models/Piece';
import { PieceColor, PieceType } from '../models/ChessTypes';
import type { Position } from '../models/ChessTypes';
import { MoveValidator } from './MoveValidator';
import { Game } from '../models/Game';
import { log } from '../../../log';
import { ZobristHash } from './ZobristHash';

// 置换表节点类型
enum NodeType {
    EXACT,  // 精确值
    LOWER,  // 下界(Alpha截断)
    UPPER   // 上界(Beta截断)
}

// 改进置换表接口
interface TranspositionEntry {
    hash: bigint;        // 完整哈希值（用于检测冲突）
    depth: number;       // 搜索深度
    score: number;       // 节点评分
    flag: NodeType;      // 节点类型
    bestMove?: { from: Position, to: Position } | null; // 最佳走法
    age: number;         // 搜索年龄（用于替换策略）
}

// 时间控制接口
interface TimeControl {
    startTime: number;      // 开始时间
    maxTime: number;        // 最大思考时间（毫秒）
    checkInterval: number;  // 检查间隔（节点数）
    nodesSearched: number;  // 已搜索节点数
    timeoutReached: boolean;// 是否达到时间限制
}

// 云库API地址
const CLOUD_API_URL = 'http://www.chessdb.cn/chessdb.php';

/**
 * 棋子价值表
 * 不同棋子的基础价值和位置价值评估
 */
// 中国象棋棋子价值表（根据《象棋入门》调整）
const PIECE_VALUES = {
    [PieceType.GENERAL]: 100000, // 将/帅（不可丢失）
    [PieceType.CHARIOT]: 1000,   // 车（最强进攻棋子）
    [PieceType.CANNON]: 500,     // 炮（需要炮架发挥威力）
    [PieceType.HORSE]: 450,      // 马（盘面越开阔价值越高）
    [PieceType.ELEPHANT]: 200,   // 象（防守型棋子）
    [PieceType.ADVISOR]: 200,    // 士（贴身防守）
    [PieceType.SOLDIER]: 150,    // 兵（过河后价值提升）
};

/**
 * 兵/卒过河后的额外价值
 */
const SOLDIER_CROSS_RIVER_BONUS = 70;

/**
 * 象棋AI引擎
 * 负责AI走棋策略的实现
 */
export class ChessAI {
    private moveValidator: MoveValidator;
    private difficultyLevel: number;
    private maxDepth: number;
    private useCloudLibrary: boolean;
    private zobristHash: ZobristHash;
    private transpositionTable: TranspositionEntry[] = [];
    private readonly TT_SIZE = 1024 * 1024; // 置换表大小
    private searchAge: number = 0; // 当前搜索的年龄
    private timeControl: TimeControl;
    private maxThinkingTime: number;
    private historyTable: number[][][][] = [];
    private killerMoves: Array<Array<{from: Position, to: Position} | null>> = [];

    /**
     * 创建象棋AI实例
     * @param difficultyLevel 难度等级(1-6)，默认为3（初级）
     * @param useCloudLibrary 是否使用云库API (仅对最高难度有效)
     * @param maxThinkingTime 最大思考时间（毫秒），默认1分钟
     */
    constructor(difficultyLevel: number = 3, useCloudLibrary: boolean = true, maxThinkingTime: number = 60000) {
        this.moveValidator = new MoveValidator();
        this.difficultyLevel = Math.min(Math.max(difficultyLevel, 3), 6);
        this.useCloudLibrary = useCloudLibrary && this.difficultyLevel >= 6; // 仅最高难度时使用云库
        this.zobristHash = new ZobristHash();
        this.transpositionTable = new Array(this.TT_SIZE);
        this.maxThinkingTime = maxThinkingTime;
        
        // 初始化时间控制
        this.timeControl = {
            startTime: 0,
            maxTime: this.maxThinkingTime,
            checkInterval: 1000, // 每1000个节点检查一次时间
            nodesSearched: 0,
            timeoutReached: false
        };

        // 根据难度设置搜索深度
        switch (this.difficultyLevel) {
            case 3: // 初级 - 5步思考
                this.maxDepth = 5;
                break;
            case 5: // 中级 - 9步思考
                this.maxDepth = 9;
                break;
            case 6: // 高级 - 12步思考或使用云库
                this.maxDepth = 12;
                break;
            default:
                this.maxDepth = 5; // 默认使用初级深度
        }

        // 初始化历史表 (10行×9列×10行×9列)
        this.historyTable = Array(10).fill(0).map(() => 
            Array(9).fill(0).map(() => 
                Array(10).fill(0).map(() => 
                    Array(9).fill(0))));

        // 假设最大深度为50
        this.killerMoves = Array(50).fill(0).map(() => [null, null]);
    }

    /**
     * 获取AI行动
     * @param game 当前游戏实例
     * @returns 移动的起始和目标位置
     */
    async getMove(game: Game): Promise<{ from: Position, to: Position } | null> {
        // 增加搜索年龄
        this.searchAge++;
        
        const board = game.getBoardObject();
        const aiColor = PieceColor.BLACK; // AI总是使用黑方

        // 高级难度且启用云库时，优先使用云库API
        if (this.useCloudLibrary && this.difficultyLevel >= 6) {
            try {
                const cloudMove = await this.getCloudLibraryMove(game);
                if (cloudMove) {
                    return cloudMove;
                }
            } catch (error) {
                log.error("云库API请求失败，回退到本地算法", error);
                // 云库请求失败，回退到本地算法
            }
        }

        // 重置时间控制
        this.timeControl = {
            startTime: Date.now(),
            maxTime: this.maxThinkingTime,
            checkInterval: 1000,
            nodesSearched: 0,
            timeoutReached: false
        };

        // 重置杀手表
        this.killerMoves = Array(50).fill(0).map(() => [null, null]);

        // 使用迭代深化搜索
        return this.iterativeDeepeningSearch(board, aiColor);
    }

    /**
     * 从云库获取最佳着法
     * @param game 当前游戏
     * @returns 最佳着法，如果无法获取则返回null
     */
    private async getCloudLibraryMove(game: Game): Promise<{ from: Position, to: Position } | null> {
        try {
            // 将棋盘转换为FEN格式
            const fen = this.convertBoardToFEN(game);
            if (!fen) return null;

            // 构建API请求URL
            const url = `${CLOUD_API_URL}?action=querybest&board=${encodeURIComponent(fen)}`;

            // 发送请求到云库API
            // 移除timeout选项，使用默认超时设置
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`云库API请求失败: ${response.status}`);
            }

            const data = await response.text();

            // 解析响应，格式可能是 "move:c3c4" 或 "egtb:c3c4"
            if (data && (data.startsWith('move:') || data.startsWith('egtb:'))) {
                const parts = data.split(':');
                if (parts.length < 2 || !parts[1]) {
                    log.error('云库返回的着法格式无效:', data);
                    return null;
                }

                const moveText = parts[1];

                // 将云库的走法文本转换为位置
                const move = this.convertCloudMoveToPositions(moveText);
                if (move) {
                    return move;
                } else {
                    // Handle cases where move parsing failed but format was initially correct
                    log.error('无法解析云库返回的着法:', moveText);
                    return null;
                }
            } else if (data === 'nobestmove' || data === 'unknown') {
                // Explicitly handle 'nobestmove' and 'unknown'
                log.info('云库没有最佳着法推荐或局面未知:', data);
                return null;
            } else {
                // Log any other unexpected format
                log.warn('云库返回未知格式:', data);
                return null;
            }
        } catch (error) {
            log.error('访问云库API时出错:', error);
            return null;
        }
    }

    /**
     * 将棋盘转换为FEN格式
     * FEN格式: rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w
     */
    private convertBoardToFEN(game: Game): string | null {
        const board = game.getBoardObject();
        let fen = '';

        // 生成棋盘部分
        for (let row = 0; row < Board.ROWS; row++) {
            let emptyCount = 0;

            for (let col = 0; col < Board.COLS; col++) {
                const piece = board.getPiece([row, col]);

                if (piece) {
                    // 如果前面有空格，先加上空格数
                    if (emptyCount > 0) {
                        fen += emptyCount;
                        emptyCount = 0;
                    }

                    // 添加棋子字符
                    fen += this.getPieceFENChar(piece);
                } else {
                    emptyCount++;
                }
            }

            // 处理每行末尾的空格
            if (emptyCount > 0) {
                fen += emptyCount;
            }

            // 除了最后一行，每行加上 '/'
            if (row < Board.ROWS - 1) {
                fen += '/';
            }
        }

        // 添加当前行动方
        // 云库中w代表红方，b代表黑方，与我们的实现相反
        fen += game.currentTurn === PieceColor.RED ? ' w' : ' b';

        return fen;
    }

    /**
     * 获取棋子的FEN字符表示
     */
    private getPieceFENChar(piece: Piece): string {
        let char = '';

        // 根据棋子类型确定基本字符
        switch (piece.type) {
            case PieceType.GENERAL:
                char = 'k'; // 将/帅
                break;
            case PieceType.ADVISOR:
                char = 'a'; // 士/仕
                break;
            case PieceType.ELEPHANT:
                char = 'b'; // 象/相
                break;
            case PieceType.HORSE:
                char = 'n'; // 马
                break;
            case PieceType.CHARIOT:
                char = 'r'; // 车
                break;
            case PieceType.CANNON:
                char = 'c'; // 炮
                break;
            case PieceType.SOLDIER:
                char = 'p'; // 兵/卒
                break;
            default:
                return '.'; // 未知棋子
        }

        // 根据颜色确定大小写（红方大写，黑方小写）
        // 注意：这里的逻辑需要与云库的FEN表示保持一致
        return piece.color === PieceColor.RED ? char.toUpperCase() : char;
    }

    /**
     * 将云库API返回的着法转换为位置
     * 云库格式: "c3c4" 表示从c3移动到c4
     */
    private convertCloudMoveToPositions(moveText: string): { from: Position, to: Position } | null {
        if (!moveText || moveText.length !== 4) {
            return null;
        }

        // 统一转换为小写处理字母坐标
        moveText = moveText.toLowerCase();

        try {
            // 棋盘坐标系转换
            // 云库中列(a-i)对应0-8，行(0-9)对应9-0（翻转的）
            const fromCol = moveText.charCodeAt(0) - 'a'.charCodeAt(0);

            // 确保字符存在并是有效数字
            const fromRowChar = moveText.charAt(1);
            if (!/[0-9]/.test(fromRowChar)) {
                log.error('无效的行坐标:', fromRowChar);
                return null;
            }
            const fromRow = 9 - parseInt(fromRowChar, 10);

            const toCol = moveText.charCodeAt(2) - 'a'.charCodeAt(0);

            // 确保字符存在并是有效数字
            const toRowChar = moveText.charAt(3);
            if (!/[0-9]/.test(toRowChar)) {
                log.error('无效的行坐标:', toRowChar);
                return null;
            }
            const toRow = 9 - parseInt(toRowChar, 10);

            // 检查转换后的坐标是否有效
            if (
                fromCol < 0 || fromCol >= Board.COLS || fromRow < 0 || fromRow >= Board.ROWS ||
                toCol < 0 || toCol >= Board.COLS || toRow < 0 || toRow >= Board.ROWS
            ) {
                return null;
            }

            return {
                from: [fromRow, fromCol],
                to: [toRow, toCol]
            };
        } catch (e) {
            log.error('解析着法时出错:', moveText, e);
            return null;
        }
    }

    /**
     * 迭代深化搜索
     * 从低深度逐渐增加搜索深度，确保在时间限制内返回最佳结果
     */
    private iterativeDeepeningSearch(board: Board, aiColor: PieceColor): { from: Position, to: Position } | null {
        const possibleMoves = this.getAllPossibleMoves(board, aiColor);
        
        if (possibleMoves.length === 0) {
            return null;
        }
        
        // 先检查高级策略
        const strategicMove = this.applyAdvancedStrategies(board, aiColor, possibleMoves);
        if (strategicMove) {
            return strategicMove;
        }
        
        // 保存当前最佳走法
        let bestMove: { from: Position, to: Position } | null = null;
        
        // 初始深度（确保至少有一个结果）
        const initialDepth = Math.min(3, this.maxDepth);
        
        // 获取一个随机走法作为备选（避免时间用尽时没有走法可用）
        const randomIndex = Math.floor(Math.random() * possibleMoves.length);
        bestMove = possibleMoves[randomIndex] || null; // 使用 || null 确保类型是 Position | null
        
        // 使用迭代深化搜索
        // 初始深度为较小值，然后逐渐增加，最大到设定的maxDepth
        for (let depth = initialDepth; depth <= this.maxDepth; depth++) {
            // 如果已经超时，中断搜索
            if (this.timeControl.timeoutReached) {
                log.info(`迭代深化搜索在深度${depth-1}时超时，返回当前最佳走法`);
                break;
            }
            
            // 对根节点进行Alpha-Beta搜索
            const result = this.rootAlphaBeta(board, depth, aiColor);
            
            // 如果不是因为超时而返回的有效结果，更新最佳走法
            if (result && !this.timeControl.timeoutReached) {
                bestMove = result;
                log.info(`深度${depth}搜索完成，找到最佳走法: ${JSON.stringify(bestMove.from)} -> ${JSON.stringify(bestMove.to)}`);
            } else if (this.timeControl.timeoutReached) {
                // 超时了，使用上一层深度的结果
                log.info(`深度${depth}搜索超时，使用深度${depth-1}的结果`);
                break;
            }
        }
        
        return bestMove;
    }
    
    /**
     * 根节点Alpha-Beta搜索
     * 针对根节点的特殊处理，返回最佳走法
     */
    private rootAlphaBeta(board: Board, depth: number, aiColor: PieceColor): { from: Position, to: Position } | null {
        let alpha = -Infinity;
        let beta = Infinity;
        let bestMove: { from: Position, to: Position } | null = null;
        
        // 获取所有可能的走法
        const moves = this.getAllPossibleMoves(board, aiColor);
        
        // 对走法进行启发式排序
        this.sortMovesByHeuristic(moves, board, depth);
        
        // 限制搜索的走法数量，提高效率（只对根节点有效）
        const movesToSearch = this.difficultyLevel >= 5 
            ? moves 
            : moves.slice(0, Math.min(10, moves.length));
        
        // 对每个走法进行搜索
        for (const move of movesToSearch) {
            // 检查是否超时
            if (this.timeControl.timeoutReached) {
                return bestMove;
            }
            
            // 模拟走棋
            const boardCopy = board.clone();
            boardCopy.movePiece(move.from, move.to);
            
            // 执行Alpha-Beta搜索（Min节点）
            const score = this.alphaBeta(boardCopy, depth - 1, alpha, beta, false, aiColor);
            
            // 更新最佳走法
            if (score > alpha) {
                alpha = score;
                bestMove = move;
            }
        }
        
        return bestMove;
    }
    
    /**
     * Alpha-Beta搜索算法
     * 带超时检查和置换表
     */
    private alphaBeta(board: Board, depth: number, alpha: number, beta: number, 
                     isMaximizing: boolean, aiColor: PieceColor, 
                     allowNullMove: boolean = true): number {
        // 增加搜索节点计数
        this.timeControl.nodesSearched++;
        
        // 定期检查是否超时
        if (this.timeControl.nodesSearched % this.timeControl.checkInterval === 0) {
            if (Date.now() - this.timeControl.startTime > this.timeControl.maxTime) {
                this.timeControl.timeoutReached = true;
                return isMaximizing ? -Infinity : Infinity; // 返回一个对当前方不利的极端值
            }
        }
        
        // 如果已经超时，立即返回
        if (this.timeControl.timeoutReached) {
            return isMaximizing ? -Infinity : Infinity;
        }
        
        // 当前局面的哈希值
        const currentHash = this.zobristHash.calculateHash(board);
        
        // 查询置换表
        const ttEntry = this.probeTranspositionTable(currentHash);
        if (ttEntry && ttEntry.depth >= depth) {
            if (ttEntry.flag === NodeType.EXACT) {
                return ttEntry.score;
            } else if (ttEntry.flag === NodeType.LOWER && ttEntry.score > alpha) {
                alpha = ttEntry.score;
            } else if (ttEntry.flag === NodeType.UPPER && ttEntry.score < beta) {
                beta = ttEntry.score;
            }
            
            if (alpha >= beta) {
                return ttEntry.score;
            }
        }
        
        // 空步裁剪（只在非根节点、非极限节点、Beta节点使用）
        if (depth >= 3 && allowNullMove && !isMaximizing && !this.isInCheck(board, aiColor)) {
            // R为缩减因子，通常为2或3
            const R = 2;
            
            // 跳过一步，让对方继续走
            const nullScore = -this.alphaBeta(
                board, 
                depth - 1 - R,  // 减少深度+缩减因子
                -beta, 
                -beta + 1,      // 零窗口搜索
                true,          // 轮到对方走
                aiColor, 
                false          // 禁止连续使用空步裁剪
            );
            
            // 如果跳过一步后仍能保持优势，则不需深入搜索
            if (nullScore >= beta) {
                // 防止错过将军
                if (this.isInCheck(board, aiColor)) {
                    // 不能用空步裁剪，继续正常搜索
                } else {
                    return beta;  // 剪枝
                }
            }
        }
        
        // 达到叶子节点或搜索深度上限
        if (depth === 0) {
            // 不直接返回评估值，而是进行静态评估搜索
            return this.quiescenceSearch(board, alpha, beta, isMaximizing, aiColor);
        }
        
        const opponentColor = aiColor === PieceColor.BLACK ? PieceColor.RED : PieceColor.BLACK;
        const currentColor = isMaximizing ? aiColor : opponentColor;
        
        // 获取所有可能的走法
        const moves = this.getAllPossibleMoves(board, currentColor);
        
        // 无子可走，对方胜利
        if (moves.length === 0) {
            return isMaximizing ? -10000 : 10000;
        }
        
        // 排序走法以提高剪枝效率
        this.sortMovesByHeuristic(moves, board, depth);
        
        let bestScore = isMaximizing ? -Infinity : Infinity;
        let originalAlpha = alpha;
        let currentBestMove: { from: Position, to: Position } | null = null;
        
        if (isMaximizing) {
            for (const move of moves) {
                const boardCopy = board.clone();
                boardCopy.movePiece(move.from, move.to);
                
                const score = this.alphaBeta(boardCopy, depth - 1, alpha, beta, false, aiColor);
                
                if (score > bestScore) {
                    bestScore = score;
                    currentBestMove = move;
                }
                
                alpha = Math.max(alpha, score);
                if (beta <= alpha) {
                    // 如果是非吃子走法导致的剪枝，记录为杀手着法
                    if (!board.getPiece(move.to)) {
                        this.recordKillerMove(depth, move);
                    }
                    break;
                }
            }
        } else {
            for (const move of moves) {
                const boardCopy = board.clone();
                boardCopy.movePiece(move.from, move.to);
                
                const score = this.alphaBeta(boardCopy, depth - 1, alpha, beta, true, aiColor);
                
                if (score < bestScore) {
                    bestScore = score;
                    currentBestMove = move;
                }
                
                beta = Math.min(beta, score);
                if (beta <= alpha) {
                    // 如果是非吃子走法导致的剪枝，记录为杀手着法
                    if (!board.getPiece(move.to)) {
                        this.recordKillerMove(depth, move);
                    }
                    break;
                }
            }
        }
        
        // 保存到置换表
        let flag = NodeType.EXACT;
        if (bestScore <= originalAlpha) {
            flag = NodeType.UPPER;
        } else if (bestScore >= beta) {
            flag = NodeType.LOWER;
        }
        
        this.storeTranspositionEntry(
            currentHash,
            depth,
            bestScore,
            flag,
            currentBestMove
        );
        
        return bestScore;
    }

    /**
     * 检查是否被将军
     */
    private isInCheck(board: Board, color: PieceColor): boolean {
        // 找到将/帅
        const generals = board.getPiecesByTypeAndColor(PieceType.GENERAL, color);
        if (generals.length === 0 || !generals[0]) return false;
        
        const generalPos = generals[0].position;
        const opponentColor = color === PieceColor.RED ? PieceColor.BLACK : PieceColor.RED;
        
        // 检查是否有对方棋子可以吃到将/帅
        const opponentPieces = board.getPiecesByColor(opponentColor);
        for (const piece of opponentPieces) {
            if (this.moveValidator.isValidMove(board, piece.position, generalPos)) {
                return true;
            }
        }
        
        return false;
    }

    /**
     * 对走法按启发式规则进行排序以提高剪枝效率
     * 吃子走法排在前面，按被吃棋子价值从高到低排序
     */
    private sortMovesByHeuristic(moves: { from: Position, to: Position }[], 
                                board: Board, depth: number): void {
        // 类型安全地定义moveScores数组
        const moveScores: Array<{move: { from: Position, to: Position }, score: number}> = [];
        
        // 处理每个走法
        for (const move of moves) {
            const [fromRow, fromCol] = move.from;
            const [toRow, toCol] = move.to;
            let score = 0;
            
            // 吃子走法优先
            const targetPiece = board.getPiece(move.to);
            if (targetPiece) {
                score = 10000 + PIECE_VALUES[targetPiece.type];
            }
            
            // 杀手着法表
            if (depth >= 0 && depth < this.killerMoves.length && this.killerMoves[depth]) {
                // 第一个杀手着法
                if (this.killerMoves[depth]![0] && this.equalMove(move, this.killerMoves[depth]![0])) {
                    score = 9000;
                }
                // 第二个杀手着法
                else if (this.killerMoves[depth]![1] && this.equalMove(move, this.killerMoves[depth]![1])) {
                    score = 8000;
                }
            }
            
            // 历史启发式分数 - 安全地访问嵌套数组
            const historyTable = this.historyTable;
            if (fromRow >= 0 && fromRow < historyTable.length) {
                const fromRowTable = historyTable[fromRow];
                if (fromRowTable && fromCol >= 0 && fromCol < fromRowTable.length) {
                    const fromColTable = fromRowTable[fromCol];
                    if (fromColTable && toRow >= 0 && toRow < fromColTable.length) {
                        const toRowTable = fromColTable[toRow];
                        if (toRowTable && toCol >= 0 && toCol < toRowTable.length) {
                            score += toRowTable[toCol] ?? 0;
                        }
                    }
                }
            }
            
            moveScores.push({ move, score });
        }
        
        // 按分数排序
        moveScores.sort((a, b) => b.score - a.score);
        
        // 更新moves数组
        for (let i = 0; i < Math.min(moves.length, moveScores.length); i++) {
            moves[i] = moveScores[i]!.move;
        }
    }

    /**
     * 获取所有可能的合法走法
     */
    private getAllPossibleMoves(board: Board, color: PieceColor): { from: Position, to: Position }[] {
        const possibleMoves: { from: Position, to: Position }[] = [];

        // 获取指定颜色的所有棋子
        const pieces = board.getPiecesByColor(color);

        // 对于每个棋子，尝试所有可能的目标位置
        for (const piece of pieces) {
            const [fromRow, fromCol] = piece.position;

            // 尝试棋盘上的每个位置作为目标
            for (let toRow = 0; toRow < Board.ROWS; toRow++) {
                for (let toCol = 0; toCol < Board.COLS; toCol++) {
                    const to: Position = [toRow, toCol];

                    // 跳过己方棋子位置
                    const targetPiece = board.getPiece(to);
                    if (targetPiece && targetPiece.color === color) {
                        continue;
                    }

                    // 检查走法是否合法
                    if (this.moveValidator.isValidMove(board, piece.position, to)) {
                        possibleMoves.push({
                            from: piece.position,
                            to: to
                        });
                    }
                }
            }
        }

        return possibleMoves;
    }

    /**
     * 评估当前局面
     * 返回对AI有利的正分数或不利的负分数
     */
    private evaluateBoard(board: Board, aiColor: PieceColor): number {
        const opponentColor = aiColor === PieceColor.BLACK ? PieceColor.RED : PieceColor.BLACK;

        // 获取双方棋子并检查将帅存在性
        const [aiPieces, opponentPieces] = [board.getPiecesByColor(aiColor), board.getPiecesByColor(opponentColor)];
        if (!opponentPieces.some(p => p.type === PieceType.GENERAL)) return 9999;
        if (!aiPieces.some(p => p.type === PieceType.GENERAL)) return -9999;

        // 统一评估双方棋子价值
        const evaluateSide = (pieces: Piece[], color: PieceColor) => {
            let total = 0;
            for (const piece of pieces) {
                total += PIECE_VALUES[piece.type];
                
                // 兵过河奖励
                if (piece.type === PieceType.SOLDIER) {
                    const isCrossed = (color === PieceColor.RED && piece.position[0] < 5) || 
                                    (color === PieceColor.BLACK && piece.position[0] > 4);
                    if (isCrossed) {
                        total += SOLDIER_CROSS_RIVER_BONUS;
                        // 距离对方将帅奖励
                        const generalPos = board.getPiecesByTypeAndColor(PieceType.GENERAL, 
                            color === aiColor ? opponentColor : aiColor)[0]?.position;
                        if (generalPos) {
                            const distance = Math.abs(generalPos[0] - piece.position[0]) + 
                                          Math.abs(generalPos[1] - piece.position[1]);
                            total += Math.max(0, (10 - distance) * 15);
                        }
                    }
                }
                
                total += this.getPositionValue(piece, color, board) * 1.5;
                total += this.countPossibleMoves(board, piece.position) * 8;
                total += this.evaluateCoordination(board, piece.position, color);
            }
            return total;
        };

        // 计算双方得分
        let aiScore = evaluateSide(aiPieces, aiColor);
        let opponentScore = evaluateSide(opponentPieces, opponentColor);

        // 检查将军状态（进攻性评分）
        aiScore += this.checkAttackBonus(board, aiColor, opponentColor) * 1.5; // 提高进攻奖励
        opponentScore += this.checkAttackBonus(board, opponentColor, aiColor) * 1.5;

        // 子力保护关系评估
        aiScore += this.evaluateProtection(board, aiColor) * 20; // 提高保护价值
        opponentScore += this.evaluateProtection(board, opponentColor) * 20;

        // 中央控制权评估
        aiScore += this.evaluateCenterControl(board, aiColor) * 25; // 提高中央控制价值
        opponentScore += this.evaluateCenterControl(board, opponentColor) * 25;

        // 在高难度级别下，增加战略评估
        if (this.difficultyLevel >= 5) {
            // 将军路径评估
            aiScore += this.evaluateCheckingPaths(board, aiColor, opponentColor) * 30;
            opponentScore += this.evaluateCheckingPaths(board, opponentColor, aiColor) * 30;

            // 进攻性发展评估
            aiScore += this.evaluateAggression(board, aiColor, opponentColor) * 25;
            opponentScore += this.evaluateAggression(board, opponentColor, aiColor) * 25;
        }

        // 返回双方分数差
        return aiScore - opponentScore;
    }

    /**
     * 评估进攻加分，检查对对方将/帅的威胁
     */
    private checkAttackBonus(board: Board, attackerColor: PieceColor, defenderColor: PieceColor): number {
        let bonus = 0;

        // 找到对方的将/帅
        const generalPieces = board.getPiecesByTypeAndColor(PieceType.GENERAL, defenderColor);
        if (generalPieces.length === 0) return 0;

        const generalPiece = generalPieces[0];
        if (!generalPiece) return 0;

        const generalPos = generalPiece.position;

        // 检查是否对将/帅形成威胁
        const attackerPieces = board.getPiecesByColor(attackerColor);

        for (const piece of attackerPieces) {
            if (this.moveValidator.isValidMove(board, piece.position, generalPos)) {
                // 将军！给予高额奖励
                bonus += 500;
                break;
            }

            // 检查是否控制了将/帅周围的格子
            const [gRow, gCol] = generalPos;
            const surroundingPositions: Position[] = [
                [gRow - 1, gCol], [gRow + 1, gCol],
                [gRow, gCol - 1], [gRow, gCol + 1]
            ];

            for (const pos of surroundingPositions) {
                // 确保位置在棋盘内且在九宫格内
                if (board.isValidPosition(pos[0], pos[1]) &&
                    ((defenderColor === PieceColor.RED && pos[0] >= 7 && pos[0] <= 9 && pos[1] >= 3 && pos[1] <= 5) ||
                        (defenderColor === PieceColor.BLACK && pos[0] >= 0 && pos[0] <= 2 && pos[1] >= 3 && pos[1] <= 5))) {

                    if (this.moveValidator.isValidMove(board, piece.position, pos)) {
                        // 控制将/帅周围格子，给予奖励
                        bonus += 100;
                    }
                }
            }
        }

        return bonus;
    }

    /**
     * 评估棋子位置价值
     */
    private getPositionValue(piece: Piece, color: PieceColor, board: Board): number {
        const [row, col] = piece.position;
        let positionBonus = 0;

        switch (piece.type) {
            case PieceType.GENERAL:
                // 将帅安全评估：位于九宫中心+50，边缘+30
                if ((color === PieceColor.RED && row === 9) || (color === PieceColor.BLACK && row === 0)) {
                    if (col === 4) positionBonus += 50;
                    else if (col >= 3 && col <= 5) positionBonus += 30;
                }
                break;

            case PieceType.SOLDIER:
                // 过河兵价值提升，并根据位置给予奖励
                if ((color === PieceColor.RED && row < 5) || (color === PieceColor.BLACK && row > 4)) {
                    positionBonus += SOLDIER_CROSS_RIVER_BONUS;
                    // 兵临九宫奖励
                    if ((color === PieceColor.RED && row < 3) || (color === PieceColor.BLACK && row > 6)) {
                        positionBonus += 50;
                    }
                }
                // 控制敌方肋道奖励
                if (col === 3 || col === 5) positionBonus += 20;
                break;

            case PieceType.CANNON:
                // 炮在中线奖励，且有炮架时额外奖励
                if (col === 4) positionBonus += 30;
                // 检查炮架数量
                const screenCount = this.countScreens(board, [row, col], color);
                positionBonus += screenCount * 15;
                break;

            case PieceType.HORSE:
                // 马腿限制评估，计算活跃位置数量
                const activePositions = this.countHorseActivePositions(board, [row, col]);
                positionBonus += activePositions * 20;
                // 控制中心区域奖励
                if (row >= 3 && row <= 6 && col >= 2 && col <= 6) {
                    positionBonus += 30;
                }
                break;

            case PieceType.CHARIOT:
                // 车占要道奖励：巡河车+50，霸王车+80
                if ((color === PieceColor.RED && row === 7) || (color === PieceColor.BLACK && row === 2)) {
                    positionBonus += 50; // 巡河车
                }
                if ((color === PieceColor.RED && row === 8) || (color === PieceColor.BLACK && row === 1)) {
                    positionBonus += 80; // 霸王车
                }
                // 控制敌方卒林奖励
                if ((color === PieceColor.RED && row === 4) || (color === PieceColor.BLACK && row === 5)) {
                    positionBonus += 40;
                }
                break;

            case PieceType.ADVISOR:
                // 士的贴身保护奖励
                const generals = board.getPiecesByTypeAndColor(PieceType.GENERAL, color);
                const general = generals.length > 0 ? generals[0] : null;
                if (general && Math.abs(row - general.position[0]) <= 1 && Math.abs(col - general.position[1]) <= 1) {
                    positionBonus += 50;
                }
                break;

            case PieceType.ELEPHANT:
                // 象的联防奖励
                if (this.checkElephantConnection(board, [row, col], color)) {
                    positionBonus += 30;
                }
                break;
        }

        return positionBonus;
    }

    /**
     * 评估防守奖励
     * 避免将我方重要棋子置于危险之中
     */
    // 新增炮架检测方法
    private countScreens(board: Board, position: Position, color: PieceColor): number {
        const [row, col] = position;
        let screenCount = 0;

        // 检测四个方向的炮架
        const directions: Array<[number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        for (const [dx, dy] of directions) {
            let x = row + dx;
            let y = col + dy;
            while (board.isValidPosition(x, y)) {
                const piece = board.getPiece([x, y]);
                if (piece) {
                    if (piece.color !== color) break;
                    screenCount++;
                }
                x += dx;
                y += dy;
            }
        }
        return screenCount;
    }

    // 新增马腿检测方法
    private countHorseActivePositions(board: Board, position: Position): number {
        const [row, col] = position;
        let activeCount = 0;
        const moves: Array<[number, number]> = [
            [-2, -1], [-2, 1],
            [-1, -2], [-1, 2],
            [1, -2], [1, 2],
            [2, -1], [2, 1]
        ];

        for (const [dx, dy] of moves) {
            const targetRow = row + dx;
            const targetCol = col + dy;
            const legRow = row + Math.sign(dx) * (Math.abs(dx) > 1 ? 1 : 0);
            const legCol = col + Math.sign(dy) * (Math.abs(dy) > 1 ? 1 : 0);

            // Add bounds checking for board positions
            if (isNaN(targetRow) || isNaN(targetCol) || isNaN(legRow) || isNaN(legCol)) {
                continue;
            }

            if (board.isValidPosition(targetRow, targetCol) &&
                !board.getPiece([legRow, legCol])) {
                activeCount++;
            }
        }
        return activeCount;
    }

    // 新增象眼检测方法
    private checkElephantConnection(board: Board, position: Position, color: PieceColor): boolean {
        const [row, col] = position;
        const directions: Array<[number, number]> = [[-2, -2], [-2, 2], [2, -2], [2, 2]];

        for (const [dx, dy] of directions) {
            const midRow = row + Math.floor(dx / 2);
            const midCol = col + Math.floor(dy / 2);
            if (board.isValidPosition(midRow, midCol) &&
                !board.getPiece([midRow, midCol])) {
                return true;
            }
        }
        return false;
    }

    /**
     * 评估棋子可能的移动位置数量
     * 用于衡量棋子的灵活性
     */
    private countPossibleMoves(board: Board, position: Position): number {
        const piece = board.getPiece(position);
        if (!piece) return 0;

        let count = 0;
        for (let row = 0; row < Board.ROWS; row++) {
            for (let col = 0; col < Board.COLS; col++) {
                const targetPos: Position = [row, col];
                const targetPiece = board.getPiece(targetPos);

                // 跳过己方棋子位置
                if (targetPiece && targetPiece.color === piece.color) {
                    continue;
                }

                // 检查走法是否合法
                if (this.moveValidator.isValidMove(board, position, targetPos)) {
                    count++;
                }
            }
        }

        return count;
    }

    /**
     * 评估子力协同性
     * 检查棋子是否有同伴的支持和保护
     */
    private evaluateCoordination(board: Board, position: Position, color: PieceColor): number {
        const piece = board.getPiece(position);
        if (!piece) return 0;

        let score = 0;
        const allies = board.getPiecesByColor(color);

        // 计算该棋子与其他己方棋子的平均曼哈顿距离
        // 距离适中最好，不宜过远或过近
        let totalDistance = 0;
        for (const ally of allies) {
            if (ally.position[0] === position[0] && ally.position[1] === position[1]) continue;

            const distance = Math.abs(ally.position[0] - position[0]) +
                Math.abs(ally.position[1] - position[1]);
            totalDistance += distance;
        }

        const avgDistance = allies.length > 1 ? totalDistance / (allies.length - 1) : 0;
        score += Math.max(0, 5 - Math.abs(avgDistance - 5)) * 2;

        return score;
    }

    /**
     * 评估子力保护关系
     * 检查有多少棋子受到保护
     */
    private evaluateProtection(board: Board, color: PieceColor): number {
        const pieces = board.getPiecesByColor(color);
        let protectedCount = 0;

        for (const piece of pieces) {
            // 检查该棋子是否有己方棋子可以走到其位置进行保护
            for (const ally of pieces) {
                if (ally.position[0] === piece.position[0] && ally.position[1] === piece.position[1]) continue;

                if (this.moveValidator.isValidMove(board, ally.position, piece.position)) {
                    protectedCount++;
                    break;
                }
            }
        }

        return protectedCount;
    }

    /**
     * 评估中央控制权
     * 检查己方在棋盘中央区域的势力
     */
    private evaluateCenterControl(board: Board, color: PieceColor): number {
        // 定义中央区域
        const centerArea: Position[] = [];
        for (let row = 3; row <= 6; row++) {
            for (let col = 3; col <= 5; col++) {
                centerArea.push([row, col]);
            }
        }

        let controlScore = 0;
        const pieces = board.getPiecesByColor(color);

        // 计算中央区域有多少格可以被己方棋子控制
        for (const centerPos of centerArea) {
            for (const piece of pieces) {
                if (this.moveValidator.isValidMove(board, piece.position, centerPos)) {
                    controlScore++;
                    break;
                }
            }
        }

        return controlScore;
    }

    /**
     * 检查是否处于开局阶段
     * 通过检查移动的子数量判断
     */
    private isOpeningPhase(board: Board): boolean {
        let movedPieceCount = 0;

        // 统计已经移动的棋子数量
        for (let row = 0; row < Board.ROWS; row++) {
            for (let col = 0; col < Board.COLS; col++) {
                const piece = board.getPiece([row, col]);
                if (!piece) continue;

                // 通过位置判断棋子是否已移动（简单判断法）
                if (piece.type === PieceType.SOLDIER) {
                    // 兵卒的初始位置是第3行和第6行
                    if ((piece.color === PieceColor.RED && row !== 6) ||
                        (piece.color === PieceColor.BLACK && row !== 3)) {
                        movedPieceCount++;
                    }
                } else if (piece.type === PieceType.CANNON) {
                    // 炮的初始位置是第2行和第7行，列是1和7
                    if ((piece.color === PieceColor.RED && (row !== 7 || (col !== 1 && col !== 7))) ||
                        (piece.color === PieceColor.BLACK && (row !== 2 || (col !== 1 && col !== 7)))) {
                        movedPieceCount++;
                    }
                } else if (piece.type === PieceType.HORSE || piece.type === PieceType.CHARIOT) {
                    // 马和车的初始位置在边角
                    if ((piece.color === PieceColor.RED && row !== 9) ||
                        (piece.color === PieceColor.BLACK && row !== 0)) {
                        movedPieceCount++;
                    }
                }
            }
        }

        // 如果移动的棋子少于6个，认为是开局阶段
        return movedPieceCount < 6;
    }

    /**
     * 检查是否处于残局阶段
     * 通过检查剩余的子数量判断
     */
    private isEndgamePhase(board: Board): boolean {
        let totalPieces = 0;

        // 统计剩余的棋子数量
        for (let row = 0; row < Board.ROWS; row++) {
            for (let col = 0; col < Board.COLS; col++) {
                if (board.getPiece([row, col])) {
                    totalPieces++;
                }
            }
        }

        // 如果剩余棋子少于12个，认为是残局
        return totalPieces < 12;
    }

    /**
     * 应用高级策略，根据局面阶段选择合适的走法
     * 用于顶级难度级别的AI
     */
    private applyAdvancedStrategies(board: Board, aiColor: PieceColor, moves: { from: Position, to: Position }[]): { from: Position, to: Position } | null {
        // 如果没有可行的走法，直接返回null
        if (moves.length === 0) return null;

        // 开局阶段策略
        if (this.isOpeningPhase(board)) {
            return this.applyOpeningStrategy(board, aiColor, moves);
        }

        // 残局阶段策略
        if (this.isEndgamePhase(board)) {
            return this.applyEndgameStrategy(board, aiColor, moves);
        }

        // 中局阶段，使用常规评估
        return null;
    }

    /**
     * 应用开局策略
     * 包括控制中心、快速展开等
     */
    private applyOpeningStrategy(board: Board, aiColor: PieceColor, moves: { from: Position, to: Position }[]): { from: Position, to: Position } | null {
        // 优先考虑的开局走法
        const priorityMoves = [];

        for (const move of moves) {
            const piece = board.getPiece(move.from);
            if (!piece) continue;

            const [fromRow, fromCol] = move.from;
            const [toRow, toCol] = move.to;
            let moveScore = 0;

            // 优先走马和炮
            if (piece.type === PieceType.HORSE || piece.type === PieceType.CANNON) {
                // 优先向中央区域移动
                if (toCol >= 2 && toCol <= 6) {
                    // 更偏好中心区域的走法
                    moveScore += 5 - Math.abs(toCol - 4);
                }

                // 如果是从初始位置移动，增加分数
                if (aiColor === PieceColor.BLACK) {
                    if (piece.type === PieceType.HORSE && fromRow === 0) {
                        moveScore += 2;
                    } else if (piece.type === PieceType.CANNON && fromRow === 2) {
                        moveScore += 2;
                    }
                } else {
                    if (piece.type === PieceType.HORSE && fromRow === 9) {
                        moveScore += 2;
                    } else if (piece.type === PieceType.CANNON && fromRow === 7) {
                        moveScore += 2;
                    }
                }
            }

            // 优先走边上的兵/卒和中间的兵/卒
            if (piece.type === PieceType.SOLDIER) {
                // 优先走两边的兵/卒和中央的兵/卒
                if (fromCol === 0 || fromCol === 2 || fromCol === 4 || fromCol === 6 || fromCol === 8) {
                    moveScore += 2;

                    // 向前移动优先
                    if ((aiColor === PieceColor.BLACK && toRow > fromRow) ||
                        (aiColor === PieceColor.RED && toRow < fromRow)) {
                        moveScore += 1;
                    }
                }
            }

            // 分数足够高的走法才加入优先队列
            if (moveScore > 2) {
                priorityMoves.push({ move, score: moveScore });
            }
        }

        // 如果有优先走法，按得分排序并返回最高分的走法
        if (priorityMoves.length > 0) {
            priorityMoves.sort((a, b) => b.score - a.score);
            if (priorityMoves[0] && priorityMoves[0].move) {
                return priorityMoves[0].move;
            }
        }

        // 如果没有找到合适的开局走法，返回null使用常规评估
        return null;
    }

    /**
     * 应用残局策略
     * 包括将军对杀、子力配合等
     */
    private applyEndgameStrategy(board: Board, aiColor: PieceColor, moves: { from: Position, to: Position }[]): { from: Position, to: Position } | null {
        const opponentColor = aiColor === PieceColor.BLACK ? PieceColor.RED : PieceColor.BLACK;

        // 寻找对方的将/帅
        const generalPieces = board.getPiecesByTypeAndColor(PieceType.GENERAL, opponentColor);
        if (generalPieces.length === 0 || !generalPieces[0]) return null;

        const opponentGeneral = generalPieces[0];
        const [genRow, genCol] = opponentGeneral.position;

        // 检查是否有直接将军的走法
        for (const move of moves) {
            const piece = board.getPiece(move.from);
            if (!piece) continue;

            // 看这步棋是否能直接攻击到对方将/帅
            if (move.to[0] === genRow && move.to[1] === genCol) {
                return move; // 直接吃将/帅
            }

            // 模拟走棋，看是否能将军
            const boardCopy = board.clone();
            boardCopy.movePiece(move.from, move.to);

            // 检查这步棋后是否能将军
            for (const aiPiece of boardCopy.getPiecesByColor(aiColor)) {
                const opponentGeneralPieces = boardCopy.getPiecesByTypeAndColor(PieceType.GENERAL, opponentColor);
                if (opponentGeneralPieces.length === 0 || !opponentGeneralPieces[0]) continue;

                if (this.moveValidator.isValidMove(boardCopy, aiPiece.position, opponentGeneralPieces[0].position)) {
                    return move; // 这步棋可以导致将军
                }
            }
        }

        // 如果没有直接将军的走法，优先考虑接近对方将/帅的走法
        let bestMove = null;
        let minDistance = Infinity;

        for (const move of moves) {
            const [toRow, toCol] = move.to;
            const distance = Math.abs(toRow - genRow) + Math.abs(toCol - genCol);

            if (distance < minDistance) {
                minDistance = distance;
                bestMove = move;
            }
        }

        if (bestMove && minDistance <= 3) {
            return bestMove;
        }

        // 如果没有找到合适的残局走法，返回null使用常规评估
        return null;
    }

    /**
     * 评估将军路径
     * 检查有多少路径可以将军
     */
    private evaluateCheckingPaths(board: Board, attackerColor: PieceColor, defenderColor: PieceColor): number {
        const generalPieces = board.getPiecesByTypeAndColor(PieceType.GENERAL, defenderColor);
        if (generalPieces.length === 0 || !generalPieces[0]) return 0;

        const generalPos = generalPieces[0].position;
        let pathCount = 0;

        // 检查每个棋子可能的走法，是否有多种路径可以将军
        const attackerPieces = board.getPiecesByColor(attackerColor);

        for (const piece of attackerPieces) {
            for (let row = 0; row < Board.ROWS; row++) {
                for (let col = 0; col < Board.COLS; col++) {
                    const targetPos: Position = [row, col];

                    // 跳过无效位置
                    const targetPiece = board.getPiece(targetPos);
                    if (targetPiece && targetPiece.color === attackerColor) continue;

                    // 检查走法是否合法
                    if (this.moveValidator.isValidMove(board, piece.position, targetPos)) {
                        // 模拟移动
                        const boardCopy = board.clone();
                        boardCopy.movePiece(piece.position, targetPos);

                        // 检查是否可以将军
                        for (const p of boardCopy.getPiecesByColor(attackerColor)) {
                            const newGeneralPieces = boardCopy.getPiecesByTypeAndColor(PieceType.GENERAL, defenderColor);
                            if (newGeneralPieces.length === 0 || !newGeneralPieces[0]) continue;

                            if (this.moveValidator.isValidMove(boardCopy, p.position, newGeneralPieces[0].position)) {
                                pathCount++;
                                break;
                            }
                        }
                    }
                }
            }
        }

        return Math.min(5, pathCount); // 限制最大值，避免过高的评分
    }

    /**
     * 评估进攻性发展
     * 检查棋子是否向对方阵营推进
     */
    private evaluateAggression(board: Board, attackerColor: PieceColor, defenderColor: PieceColor): number {
        let aggressionScore = 0;
        const attackerPieces = board.getPiecesByColor(attackerColor);

        // 定义对方阵营区域
        const enemyTerritory = attackerColor === PieceColor.RED ?
            { minRow: 0, maxRow: 4 } : { minRow: 5, maxRow: 9 };

        // 计算有多少己方棋子在对方阵营内或接近对方阵营
        for (const piece of attackerPieces) {
            const [row, col] = piece.position;

            // 完全在对方阵营内
            if (row >= enemyTerritory.minRow && row <= enemyTerritory.maxRow) {
                // 根据棋子类型给予不同分数
                switch (piece.type) {
                    case PieceType.CHARIOT:
                    case PieceType.CANNON:
                        aggressionScore += 3;
                        break;
                    case PieceType.HORSE:
                        aggressionScore += 2;
                        break;
                    case PieceType.SOLDIER:
                        aggressionScore += 1;
                        break;
                }
            }
            // 接近对方阵营
            else if (attackerColor === PieceColor.RED && row <= 6 ||
                attackerColor === PieceColor.BLACK && row >= 3) {
                aggressionScore += 0.5;
            }
        }

        return aggressionScore;
    }

    /**
     * AI算法改进总结
     * 
     * 1. 增加了迭代深化搜索（Iterative Deepening）
     *    - 从低深度开始，逐步增加搜索深度
     *    - 确保在任何时间限制条件下都有一个可用的走法
     *    - 利用浅层搜索的结果优化深层搜索的效率
     * 
     * 2. 添加了时间控制机制
     *    - 设定最大思考时间限制，默认为10秒
     *    - 在搜索过程中定期检查是否超时
     *    - 超时后立即返回当前最佳结果，避免思考过久
     * 
     * 3. 改进了置换表实现
     *    - 使用Zobrist哈希存储已评估的局面
     *    - 支持精确值、上界值和下界值三种节点类型
     *    - 可以存储最佳走法，加速相同局面的再次搜索
     * 
     * 4. 增强了Alpha-Beta剪枝算法
     *    - 更智能的走法排序策略，提高剪枝效率
     *    - 优先考虑吃子走法和有威胁的走法
     *    - 保存子节点的最佳走法信息，增强搜索深度
     * 
     * 这些改进使得AI能够在有限的时间内进行更深层次的搜索，
     * 同时保证了响应的流畅性，避免了因思考过久而导致的用户体验问题。
     */

    // 存储置换表条目
    private storeTranspositionEntry(hash: bigint, depth: number, score: number, 
                                   flag: NodeType, bestMove: { from: Position, to: Position } | null): void {
        const index = Number(hash % BigInt(this.TT_SIZE));
        const entry = this.transpositionTable[index];
        
        // 安全检查，确保bestMove不为undefined
        const safeBestMove = bestMove === undefined ? null : bestMove;
        
        // 替换策略：总是替换旧条目，深度更大的优先
        if (!entry || entry.age < this.searchAge || 
            (entry.age === this.searchAge && entry.depth <= depth)) {
            this.transpositionTable[index] = {
                hash,
                depth,
                score,
                flag,
                bestMove: safeBestMove,
                age: this.searchAge
            };
        }
    }

    // 查找置换表条目
    private probeTranspositionTable(hash: bigint): TranspositionEntry | null {
        const index = Number(hash % BigInt(this.TT_SIZE));
        const entry = this.transpositionTable[index];
        
        // 验证哈希值是否匹配（避免冲突）
        if (entry && entry.hash === hash) {
            return entry;
        }
        
        return null;
    }

    // 静态评估搜索
    private quiescenceSearch(board: Board, alpha: number, beta: number, 
                             isMaximizing: boolean, aiColor: PieceColor, 
                             depth: number = 0): number {
        // 每隔一定节点检查时间
        this.timeControl.nodesSearched++;
        if (this.timeControl.nodesSearched % this.timeControl.checkInterval === 0) {
            if (Date.now() - this.timeControl.startTime > this.timeControl.maxTime) {
                this.timeControl.timeoutReached = true;
                return isMaximizing ? -Infinity : Infinity;
            }
        }
        
        // 检查递归深度，避免无限递归
        if (depth > 10) {
            return this.evaluateBoard(board, aiColor);
        }
        
        // 先进行局面静态评估
        const standPat = this.evaluateBoard(board, aiColor);
        
        // 根据节点类型处理alpha/beta值
        if (isMaximizing) {
            if (standPat >= beta) return beta; // 剪枝
            if (alpha < standPat) alpha = standPat;
        } else {
            if (standPat <= alpha) return alpha; // 剪枝
            if (beta > standPat) beta = standPat;
        }
        
        // 获取所有吃子走法
        const currentColor = isMaximizing ? aiColor : 
                            (aiColor === PieceColor.RED ? PieceColor.BLACK : PieceColor.RED);
        const captureMoves = this.getCaptureMoves(board, currentColor);
        
        // 根据节点类型继续搜索
        if (isMaximizing) {
            let maxEval = standPat;
            for (const move of captureMoves) {
                const boardCopy = board.clone();
                boardCopy.movePiece(move.from, move.to);
                
                const evalScore = this.quiescenceSearch(boardCopy, alpha, beta, false, aiColor, depth + 1);
                maxEval = Math.max(maxEval, evalScore);
                alpha = Math.max(alpha, evalScore);
                if (beta <= alpha) break;
            }
            return maxEval;
        } else {
            let minEval = standPat;
            for (const move of captureMoves) {
                const boardCopy = board.clone();
                boardCopy.movePiece(move.from, move.to);
                
                const evalScore = this.quiescenceSearch(boardCopy, alpha, beta, true, aiColor, depth + 1);
                minEval = Math.min(minEval, evalScore);
                beta = Math.min(beta, evalScore);
                if (beta <= alpha) break;
            }
            return minEval;
        }
    }

    // 获取所有吃子走法
    private getCaptureMoves(board: Board, color: PieceColor): { from: Position, to: Position }[] {
        const moves: { from: Position, to: Position }[] = [];
        const pieces = board.getPiecesByColor(color);
        
        for (const piece of pieces) {
            for (let row = 0; row < Board.ROWS; row++) {
                for (let col = 0; col < Board.COLS; col++) {
                    const targetPos: Position = [row, col];
                    const targetPiece = board.getPiece(targetPos);
                    
                    // 只考虑吃子走法
                    if (targetPiece && targetPiece.color !== color && 
                        this.moveValidator.isValidMove(board, piece.position, targetPos)) {
                        // 可以加上启发式评估，优先考虑更有价值的吃子
                        moves.push({
                            from: piece.position,
                            to: targetPos
                        });
                    }
                }
            }
        }
        
        // 按吃子价值排序
        moves.sort((a, b) => {
            const pieceA = board.getPiece(a.to);
            const pieceB = board.getPiece(b.to);
            if (pieceA && pieceB) {
                return (PIECE_VALUES[pieceB.type] || 0) - (PIECE_VALUES[pieceA.type] || 0);
            }
            return 0;
        });
        
        return moves;
    }

    // 记录杀手着法
    private recordKillerMove(depth: number, move: {from: Position, to: Position}): void {
        // 确保深度在范围内
        if (depth >= this.killerMoves.length) {
            return;
        }
        
        // 初始化当前深度的杀手着法数组，如果不存在
        if (!this.killerMoves[depth]) {
            this.killerMoves[depth] = [null, null];
        }

        // 获取当前深度的杀手走法数组（已确认存在）
        const killerMovesAtDepth = this.killerMoves[depth]!;
        
        // 确保不重复记录，使用类型安全的方式比较
        const firstMove = killerMovesAtDepth[0] ?? null;
        if (!this.equalMove(move, firstMove)) {
            // 将第一个杀手走法移到第二位
            killerMovesAtDepth[1] = firstMove;
            // 记录新的杀手走法
            killerMovesAtDepth[0] = move;
        }
    }

    // 检查两个走法是否相同
    private equalMove(a: {from: Position, to: Position} | null, 
                     b: {from: Position, to: Position} | null): boolean {
        if (!a || !b) return false;
        return a.from[0] === b.from[0] && a.from[1] === b.from[1] && 
               a.to[0] === b.to[0] && a.to[1] === b.to[1];
    }
}
