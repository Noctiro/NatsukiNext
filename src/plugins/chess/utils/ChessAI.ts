import { Board } from '../models/Board';
import { Piece } from '../models/Piece';
import { PieceColor, PieceType } from '../models/ChessTypes';
import type { Position } from '../models/ChessTypes';
import { MoveValidator } from './MoveValidator';
import { Game } from '../models/Game';
import { log } from '../../../log';

// 云库API地址
const CLOUD_API_URL = 'http://www.chessdb.cn/chessdb.php';

/**
 * 棋子价值表
 * 不同棋子的基础价值和位置价值评估
 */
const PIECE_VALUES = {
    [PieceType.GENERAL]: 10000,  // 将/帅价值最高
    [PieceType.CHARIOT]: 900,    // 车价值很高
    [PieceType.CANNON]: 450,     // 炮价值中等偏上
    [PieceType.HORSE]: 400,      // 马价值中等偏上
    [PieceType.ELEPHANT]: 250,   // 象/相价值中等
    [PieceType.ADVISOR]: 250,    // 士/仕价值中等
    [PieceType.SOLDIER]: 100,    // 兵/卒基础价值最低
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

    /**
     * 创建象棋AI实例
     * @param difficultyLevel 难度等级(1-6)，默认为3（初级）
     * @param useCloudLibrary 是否使用云库API (仅对最高难度有效)
     */
    constructor(difficultyLevel: number = 3, useCloudLibrary: boolean = true) {
        this.moveValidator = new MoveValidator();
        this.difficultyLevel = Math.min(Math.max(difficultyLevel, 3), 6);
        this.useCloudLibrary = useCloudLibrary && this.difficultyLevel >= 6; // 仅最高难度时使用云库

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
    }

    /**
     * 获取AI行动
     * @param game 当前游戏实例
     * @returns 移动的起始和目标位置
     */
    async getMove(game: Game): Promise<{ from: Position, to: Position } | null> {
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

        // 所有难度都使用极小化极大算法，深度不同
        return this.getMiniMaxMove(board, aiColor, this.maxDepth);
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
     * 极小化极大算法
     * 通过深度搜索来评估多步后的局面
     */
    private getMiniMaxMove(board: Board, aiColor: PieceColor, depth: number): { from: Position, to: Position } | null {
        const possibleMoves = this.getAllPossibleMoves(board, aiColor);

        if (possibleMoves.length === 0) {
            return null;
        }

        // 对所有难度级别，优先考虑高级策略
        const strategicMove = this.applyAdvancedStrategies(board, aiColor, possibleMoves);
        if (strategicMove) {
            return strategicMove;
        }

        let bestMove: { from: Position, to: Position } | null = null;
        let bestScore = -Infinity;

        // 对走法进行启发式排序
        this.sortMovesByHeuristic(possibleMoves, board, aiColor);

        // 难度级别越高，策略越复杂
        if (this.difficultyLevel >= 5) { // 中级和高级
            // 使用迭代深化搜索 - 先浅搜索获取较好走法，再深搜索
            for (let currentDepth = 2; currentDepth <= depth; currentDepth += 2) {
                let iterationBestMove = null;
                let iterationBestScore = -Infinity;

                // 深度越大，评估的走法越少
                const movesToEvaluate = possibleMoves.slice(0, Math.max(6, 24 - currentDepth * 2));

                for (const move of movesToEvaluate) {
                    const boardCopy = board.clone();
                    boardCopy.movePiece(move.from, move.to);

                    // 计算这步棋的得分
                    const moveScore = this.minimax(boardCopy, currentDepth - 1, -Infinity, Infinity, false, aiColor);

                    // 如果这步棋比当前最佳得分高，更新最佳走法
                    if (moveScore > iterationBestScore) {
                        iterationBestScore = moveScore;
                        iterationBestMove = move;
                    }
                }

                // 更新整体最佳走法
                if (iterationBestMove) {
                    bestMove = iterationBestMove;
                    bestScore = iterationBestScore;
                }
            }
        } else { // 初级
            const eatMoves = possibleMoves.filter(move => board.getPiece(move.to) !== null);
            const nonEatMoves = possibleMoves.filter(move => board.getPiece(move.to) === null);

            // 优先评估吃子走法和有威胁的走法
            const movesToEvaluate = [
                ...eatMoves,
                ...nonEatMoves.slice(0, Math.min(20, nonEatMoves.length))
            ];

            for (const move of movesToEvaluate) {
                const boardCopy = board.clone();
                boardCopy.movePiece(move.from, move.to);

                // 计算这步棋的得分
                const moveScore = this.minimax(boardCopy, depth - 1, -Infinity, Infinity, false, aiColor);

                // 如果这步棋比当前最佳得分高，更新最佳走法
                if (moveScore > bestScore) {
                    bestScore = moveScore;
                    bestMove = move;
                }
            }
        }

        return bestMove;
    }

    /**
     * 极小化极大搜索算法（带Alpha-Beta剪枝）
     */
    private minimax(board: Board, depth: number, alpha: number, beta: number, isMaximizing: boolean, aiColor: PieceColor): number {
        // 如果达到搜索深度或游戏结束，评估当前局面
        if (depth === 0) {
            return this.evaluateBoard(board, aiColor);
        }

        const opponentColor = aiColor === PieceColor.BLACK ? PieceColor.RED : PieceColor.BLACK;
        const currentColor = isMaximizing ? aiColor : opponentColor;

        // 获取当前玩家的所有可能走法
        const possibleMoves = this.getAllPossibleMoves(board, currentColor);

        if (possibleMoves.length === 0) {
            // 无子可走，对方胜利
            return isMaximizing ? -10000 : 10000;
        }

        // 对走法进行启发式排序以提高剪枝效率
        this.sortMovesByHeuristic(possibleMoves, board, currentColor);

        if (isMaximizing) {
            let maxScore = -Infinity;
            for (const move of possibleMoves) {
                const boardCopy = board.clone();
                boardCopy.movePiece(move.from, move.to);

                const score = this.minimax(boardCopy, depth - 1, alpha, beta, false, aiColor);
                maxScore = Math.max(maxScore, score);
                alpha = Math.max(alpha, score);

                // Alpha-Beta剪枝
                if (beta <= alpha) {
                    break;
                }
            }
            return maxScore;
        } else {
            let minScore = Infinity;
            for (const move of possibleMoves) {
                const boardCopy = board.clone();
                boardCopy.movePiece(move.from, move.to);

                const score = this.minimax(boardCopy, depth - 1, alpha, beta, true, aiColor);
                minScore = Math.min(minScore, score);
                beta = Math.min(beta, score);

                // Alpha-Beta剪枝
                if (beta <= alpha) {
                    break;
                }
            }
            return minScore;
        }
    }

    /**
     * 对走法按启发式规则进行排序以提高剪枝效率
     * 吃子走法排在前面，按被吃棋子价值从高到低排序
     */
    private sortMovesByHeuristic(moves: { from: Position, to: Position }[], board: Board, color: PieceColor): void {
        moves.sort((a, b) => {
            const pieceA = board.getPiece(a.to);
            const pieceB = board.getPiece(b.to);

            // 如果两者都是吃子走法，按被吃棋子价值排序
            if (pieceA && pieceB) {
                return (PIECE_VALUES[pieceB.type] || 0) - (PIECE_VALUES[pieceA.type] || 0);
            }

            // 吃子走法排在前面
            if (pieceA && !pieceB) return -1;
            if (!pieceA && pieceB) return 1;

            return 0;
        });
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

        // 计算双方棋子的总价值
        const aiPieces = board.getPiecesByColor(aiColor);
        const opponentPieces = board.getPiecesByColor(opponentColor);

        let aiScore = 0;
        let opponentScore = 0;

        // 如果对方的将/帅被吃，直接返回最高分
        if (!opponentPieces.some(p => p.type === PieceType.GENERAL)) {
            return 9999;
        }

        // 如果己方的将/帅被吃，直接返回最低分
        if (!aiPieces.some(p => p.type === PieceType.GENERAL)) {
            return -9999;
        }

        // 计算AI棋子价值
        for (const piece of aiPieces) {
            // 基础棋子价值
            aiScore += PIECE_VALUES[piece.type];

            // 兵/卒过河加分，并且越接近对方将/帅越加分
            if (piece.type === PieceType.SOLDIER) {
                if ((aiColor === PieceColor.RED && piece.position[0] < 5) ||
                    (aiColor === PieceColor.BLACK && piece.position[0] > 4)) {
                    aiScore += SOLDIER_CROSS_RIVER_BONUS;

                    // 接近将/帅的兵价值更高
                    const generalPieces = board.getPiecesByTypeAndColor(PieceType.GENERAL, opponentColor);
                    if (generalPieces.length > 0 && generalPieces[0]) {
                        const generalPos = generalPieces[0].position;
                        const distance = Math.abs(generalPos[0] - piece.position[0]) +
                            Math.abs(generalPos[1] - piece.position[1]);
                        aiScore += Math.max(0, (10 - distance) * 15); // 提高接近将军的奖励
                    }
                }
            }

            // 考虑棋子的位置价值
            aiScore += this.getPositionValue(piece, aiColor) * 1.5; // 提高位置价值权重

            // 考虑棋子的灵活性（可移动的位置数量）
            const moveCount = this.countPossibleMoves(board, piece.position);
            aiScore += moveCount * 8; // 提高棋子灵活性的权重

            // 子力统筹（不宜过于集中）
            aiScore += this.evaluateCoordination(board, piece.position, aiColor);
        }

        // 计算对手棋子价值
        for (const piece of opponentPieces) {
            opponentScore += PIECE_VALUES[piece.type];

            if (piece.type === PieceType.SOLDIER) {
                if ((opponentColor === PieceColor.RED && piece.position[0] < 5) ||
                    (opponentColor === PieceColor.BLACK && piece.position[0] > 4)) {
                    opponentScore += SOLDIER_CROSS_RIVER_BONUS;

                    const generalPieces = board.getPiecesByTypeAndColor(PieceType.GENERAL, aiColor);
                    if (generalPieces.length > 0 && generalPieces[0]) {
                        const generalPos = generalPieces[0].position;
                        const distance = Math.abs(generalPos[0] - piece.position[0]) +
                            Math.abs(generalPos[1] - piece.position[1]);
                        opponentScore += Math.max(0, (10 - distance) * 15);
                    }
                }
            }

            opponentScore += this.getPositionValue(piece, opponentColor) * 1.5;
            const moveCount = this.countPossibleMoves(board, piece.position);
            opponentScore += moveCount * 8;

            opponentScore += this.evaluateCoordination(board, piece.position, opponentColor);
        }

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
    private getPositionValue(piece: Piece, color: PieceColor): number {
        const [row, col] = piece.position;
        let positionBonus = 0;

        switch (piece.type) {
            case PieceType.GENERAL:
                // 将/帅在九宫格中央更安全
                if ((color === PieceColor.RED && row === 9 && col === 4) ||
                    (color === PieceColor.BLACK && row === 0 && col === 4)) {
                    positionBonus += 50;
                }
                break;

            case PieceType.SOLDIER:
                // 兵/卒越靠近对方越有价值
                if (color === PieceColor.RED) {
                    positionBonus += (Board.ROWS - 1 - row) * 10;
                } else {
                    positionBonus += row * 10;
                }

                // 中间列的兵/卒略有优势
                positionBonus += (4 - Math.abs(col - 4)) * 5;
                break;

            case PieceType.CANNON:
                // 炮在中间位置有优势
                positionBonus += (4 - Math.abs(col - 4)) * 7;
                break;

            case PieceType.HORSE:
                // 马在中间位置有优势
                positionBonus += (4 - Math.abs(col - 4)) * 5;
                break;

            case PieceType.CHARIOT:
                // 车控制中间列和边列有优势
                if (col === 0 || col === 8 || col === 4) {
                    positionBonus += 10;
                }
                break;

            case PieceType.ADVISOR:
                // 士/仕在对角线位置更有价值（保护将/帅）
                if ((color === PieceColor.RED &&
                    ((row === 9 && col === 3) || (row === 9 && col === 5) || (row === 8 && col === 4))) ||
                    (color === PieceColor.BLACK &&
                        ((row === 0 && col === 3) || (row === 0 && col === 5) || (row === 1 && col === 4)))) {
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
    private evaluateDefensiveBonus(board: Board, aiColor: PieceColor, moveToPos: Position): number {
        const opponentColor = aiColor === PieceColor.BLACK ? PieceColor.RED : PieceColor.BLACK;
        let bonus = 0;

        // 检查此走法是否能保护我方重要棋子
        const aiPieces = board.getPiecesByColor(aiColor);

        for (const piece of aiPieces) {
            if (piece.type === PieceType.GENERAL || piece.type === PieceType.CHARIOT) {
                // 如果重要棋子周围有我方棋子保护，加分
                const [row, col] = piece.position;
                const adjacentPositions: Position[] = [
                    [row - 1, col], [row + 1, col], [row, col - 1], [row, col + 1]
                ];

                for (const pos of adjacentPositions) {
                    if (pos[0] === moveToPos[0] && pos[1] === moveToPos[1]) {
                        bonus += 50; // 保护重要棋子
                        break;
                    }
                }
            }
        }

        return bonus;
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
}
