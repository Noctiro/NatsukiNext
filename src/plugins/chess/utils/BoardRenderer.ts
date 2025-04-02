import { Board } from '../models/Board';
import { PieceColor, PieceType } from '../models/ChessTypes';
import { Game } from '../models/Game';
import { createCanvas, loadImage, Canvas, GlobalFonts } from '@napi-rs/canvas'; // Removed registerFont, CanvasRenderingContext2D, added GlobalFonts
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import { log } from '../../../log';

// 获取当前文件目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 棋盘渲染器
 * 用于生成中国象棋棋盘的HTML表示和图片表示
 */
export class BoardRenderer {
    // 缓存棋子图片
    private static fontLoaded = false;
    
    // 棋盘尺寸和样式
    private static readonly CELL_SIZE = 60;
    private static readonly BORDER_WIDTH = 30;
    private static readonly COORDINATE_WIDTH = 30;
    
    // 颜色配置
    private static readonly BOARD_BG_COLOR = '#F0D3A7';     // 棋盘背景色（更温暖的木色）
    private static readonly BOARD_BORDER_COLOR = '#8B4513'; // 棋盘边框色
    private static readonly BOARD_GRID_COLOR = '#8B4513';   // 棋盘网格线色
    private static readonly RIVER_BG_COLOR = '#CCE6FF';     // 河界背景色（更清澈的蓝色）
    private static readonly RIVER_TEXT_COLOR = '#2E5984';   // 河界文字色（更深的蓝色）
    private static readonly DOT_COLOR = '#8B4513';          // 棋盘点色
    private static readonly COORD_COLOR = '#8B4513';        // 坐标文字色
    private static readonly RED_PIECE_COLOR = '#CD0000';    // 红方棋子色
    private static readonly BLACK_PIECE_COLOR = '#000000';  // 黑方棋子色
    private static readonly PIECE_BG_GRAD_START = '#F8EFE0'; // 棋子背景渐变开始色（更亮）
    private static readonly PIECE_BG_GRAD_END = '#E8C19A';   // 棋子背景渐变结束色
    private static readonly PIECE_BORDER_COLOR = '#8B4513';  // 棋子边框色
    private static readonly LAST_MOVE_COLOR = 'rgba(255, 140, 0, 0.4)'; // 最后移动位置标记色（橙色半透明）
    private static readonly ARROW_COLOR = 'rgba(255, 60, 0, 0.75)';      // 走法箭头色
    private static readonly PIECE_TEXT_STROKE = '#F8F8FF';  // 棋子文字描边色（浅灰色）
    
    // 信息栏样式常量
    private static readonly INFO_PANEL_BG_START = 'rgba(252, 252, 252, 0.94)';   // 信息栏背景渐变开始色（更亮）
    private static readonly INFO_PANEL_BG_END = 'rgba(246, 246, 246, 0.94)';     // 信息栏背景渐变结束色
    private static readonly INFO_PANEL_BORDER = 'rgba(210, 210, 210, 0.6)';      // 信息栏边框色（更亮）
    private static readonly INFO_PANEL_SHADOW = 'rgba(0, 0, 0, 0.15)';           // 信息栏阴影色
    private static readonly INFO_RED_BADGE_BG = 'rgba(205, 0, 0, 0.05)';         // 红方标记背景（更淡）
    private static readonly INFO_BLACK_BADGE_BG = 'rgba(0, 0, 0, 0.04)';         // 黑方标记背景（更淡）
    private static readonly INFO_RED_BADGE_GLOW = 'rgba(205, 0, 0, 0.15)';       // 红方徽章光晕（减弱）
    private static readonly INFO_BLACK_BADGE_GLOW = 'rgba(0, 0, 0, 0.1)';        // 黑方徽章光晕（减弱）
    private static readonly INFO_TEXT_COLOR = '#444444';                         // 信息文本颜色（更深）
    private static readonly INFO_MOVE_TEXT_COLOR = '#505050';                    // 走法文本颜色
    private static readonly INFO_LABEL_BG = 'rgba(230, 230, 230, 0.5)';          // 标签背景色
    private static readonly INFO_DIVIDER_COLOR = 'rgba(200, 200, 200, 0.5)';     // 分隔线颜色
    
    /**
     * 绘制箭头的辅助方法
     * @param ctx Canvas上下文
     * @param fromX 起点X坐标
     * @param fromY 起点Y坐标
     * @param toX 终点X坐标
     * @param toY 终点Y坐标
     * @param color 箭头颜色
     * @param headLength 箭头头部长度
     * @param headWidth 箭头头部宽度
     * @param lineWidth 箭头线宽
     */
    private static drawArrow(
        ctx: any, // Let TS infer the context type
        fromX: number,
        fromY: number,
        toX: number,
        toY: number,
        color: string = this.ARROW_COLOR,
        headLength: number = 15,
        headWidth: number = 10,
        lineWidth: number = 4
    ) {
        // 计算角度和距离
        const angle = Math.atan2(toY - fromY, toX - fromX);
        const distance = Math.sqrt(Math.pow(toX - fromX, 2) + Math.pow(toY - fromY, 2));
        
        // 缩短箭头线段，避免盖住棋子
        const shortenRatio = 0.2;
        const shortenedFromX = fromX + Math.cos(angle) * (this.CELL_SIZE * 0.3);
        const shortenedFromY = fromY + Math.sin(angle) * (this.CELL_SIZE * 0.3);
        const shortenedToX = toX - Math.cos(angle) * (this.CELL_SIZE * 0.3);
        const shortenedToY = toY - Math.sin(angle) * (this.CELL_SIZE * 0.3);
        
        // 保存当前上下文状态
        ctx.save();
        
        // 设置样式
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = lineWidth;
        
        // 绘制箭头线
        ctx.beginPath();
        ctx.moveTo(shortenedFromX, shortenedFromY);
        ctx.lineTo(shortenedToX, shortenedToY);
        ctx.stroke();
        
        // 绘制箭头头部
        ctx.beginPath();
        ctx.moveTo(shortenedToX, shortenedToY);
        ctx.lineTo(
            shortenedToX - headLength * Math.cos(angle - Math.PI / 6),
            shortenedToY - headLength * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
            shortenedToX - headLength * Math.cos(angle + Math.PI / 6),
            shortenedToY - headLength * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fill();
        
        // 恢复上下文状态
        ctx.restore();
    }
    
    /**
     * 创建圆角矩形路径
     * @param ctx Canvas上下文
     * @param x 左上角X坐标
     * @param y 左上角Y坐标
     * @param width 宽度
     * @param height 高度
     * @param radius 圆角半径
     */
    private static roundRect(
        ctx: any, // Let TS infer the context type
        x: number,
        y: number,
        width: number,
        height: number,
        radius: number = 5
    ) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }
    
    /**
     * 加载字体和图片资源（如果有）
     */
    private static async loadResources() {
        if (!this.fontLoaded) {
            try {
                // 尝试按优先级查找字体
                // 1. 项目内置字体
                const fontPath = join(__dirname, '..', '..', '..', 'assets', 'fonts', 'MiSans-Regular.ttf');
                
                // 2. 系统字体目录（Windows）
                const winFontPath = process.platform === 'win32' 
                    ? 'C:\\Windows\\Fonts\\simsun.ttc'
                    : '';
                    
                // 3. 系统字体目录（macOS）
                const macFontPath = process.platform === 'darwin'
                    ? '/Library/Fonts/Arial Unicode.ttf'
                    : '';

                let registeredFontFamily = '';
                
                // 按优先级尝试注册字体
                if (fs.existsSync(fontPath)) {
                    GlobalFonts.registerFromPath(fontPath, 'MiSans-Regular');
                    registeredFontFamily = 'MiSans-Regular';
                    log.info('使用项目内置 MiSans-Regular 字体');
                } else if (process.platform === 'win32' && fs.existsSync(winFontPath)) {
                    GlobalFonts.registerFromPath(winFontPath, 'SimSun');
                    registeredFontFamily = 'SimSun';
                    log.info('使用系统 SimSun 字体');
                } else if (process.platform === 'darwin' && fs.existsSync(macFontPath)) {
                    GlobalFonts.registerFromPath(macFontPath, 'Arial Unicode');
                    registeredFontFamily = 'Arial Unicode';
                    log.info('使用系统 Arial Unicode 字体');
                } else {
                    log.warn('未找到适合的中文字体，将使用系统默认字体');
                    // Fallback font family might be needed here depending on the system
                }
                
                this.fontLoaded = true;
            } catch (err) {
                log.error('字体加载错误:', err);
                // 即使字体加载出错，也标记为已加载，避免重复尝试
                this.fontLoaded = true;
            }
        }
    }
    
    /**
     * 绘制棋盘图片
     * @param game 当前游戏实例
     * @param showCoordinates 是否显示坐标
     * @returns 包含棋盘图片的Buffer
     */
    static async drawBoardImage(game: Game, showCoordinates: boolean = true): Promise<Buffer> {
        await this.loadResources();
        
        const board = game.getBoardObject();
        
        // 重新计算画布尺寸（确保对称性）
        const coordOffset = showCoordinates ? this.COORDINATE_WIDTH : 0;
        const width = 
            Board.COLS * this.CELL_SIZE + 
            this.BORDER_WIDTH * 2 + 
            coordOffset * 2;

        const height = 
            Board.ROWS * this.CELL_SIZE + 
            this.BORDER_WIDTH * 2 + 
            coordOffset * 2;

        // 创建画布后立即居中处理
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        
        // 计算棋盘主体居中偏移量
        const boardWidth = Board.COLS * this.CELL_SIZE + coordOffset * 2;
        const boardHeight = Board.ROWS * this.CELL_SIZE + coordOffset * 2;
        const offsetX = (width - boardWidth) / 2 + this.BORDER_WIDTH;
        const offsetY = (height - boardHeight) / 2 + this.BORDER_WIDTH;

        // 修正坐标起始位置计算
        const startX = offsetX + (showCoordinates ? this.COORDINATE_WIDTH : 0);
        const startY = offsetY + (showCoordinates ? this.COORDINATE_WIDTH : 0);

        // 设置中文字体，使用加载的字体或回退
        const fontFamily = GlobalFonts.families.some(f => f.family === 'MiSans-Regular') ? '"MiSans-Regular"' : 
                           GlobalFonts.families.some(f => f.family === 'SimSun') ? '"SimSun"' :
                           GlobalFonts.families.some(f => f.family === 'Arial Unicode') ? '"Arial Unicode"' :
                           '"宋体", "Microsoft YaHei", "微软雅黑", sans-serif'; // Fallback fonts
        
        // 绘制棋盘背景 - 添加木纹质感
        const bgGradient = ctx.createLinearGradient(0, 0, width, height);
        bgGradient.addColorStop(0, '#E8C19A');
        bgGradient.addColorStop(0.5, this.BOARD_BG_COLOR);
        bgGradient.addColorStop(1, '#E8C19A');
        ctx.fillStyle = bgGradient;
        ctx.fillRect(0, 0, width, height);
        
        // 添加木纹纹理
        ctx.save();
        ctx.globalAlpha = 0.1;
        for (let i = 0; i < width; i += 10) {
            ctx.beginPath();
            ctx.moveTo(i, 0);
            ctx.lineTo(i, height);
            ctx.strokeStyle = i % 20 === 0 ? '#A67D5D' : '#D2B48C';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        ctx.restore();
        
        // 绘制边框 - 使用直角边框（不再使用圆角）
        ctx.fillStyle = this.BOARD_BORDER_COLOR;
        
        // 使用普通矩形替代圆角矩形
        ctx.fillRect(0, 0, width, height);
        
        // 绘制内部棋盘区域（浅色背景，保留圆角）
        ctx.fillStyle = this.BOARD_BG_COLOR;
        const innerBorderRadius = 5;
        this.roundRect(
            ctx, 
            this.BORDER_WIDTH / 2, 
            this.BORDER_WIDTH / 2, 
            width - this.BORDER_WIDTH, 
            height - this.BORDER_WIDTH, 
            innerBorderRadius
        );
        ctx.fill();
        
        // 绘制网格线
        ctx.strokeStyle = this.BOARD_GRID_COLOR;
        ctx.lineWidth = 1;
        
        // 绘制横线
        for (let row = 0; row < Board.ROWS; row++) {
            ctx.beginPath();
            ctx.moveTo(startX, startY + row * this.CELL_SIZE);
            // 修正：减去1像素避免溢出
            ctx.lineTo(startX + (Board.COLS-1) * this.CELL_SIZE, startY + row * this.CELL_SIZE);
            ctx.stroke();
        }
        
        // 绘制竖线
        for (let col = 0; col < Board.COLS; col++) {
            ctx.beginPath();
            ctx.moveTo(startX + col * this.CELL_SIZE, startY);
            // 修正：减去1像素避免溢出
            ctx.lineTo(startX + col * this.CELL_SIZE, startY + (Board.ROWS-1) * this.CELL_SIZE);
            ctx.stroke();
        }
        
        // 绘制九宫格对角线
        this.drawPalaceDiagonals(ctx, startX, startY);
        
        // 绘制棋盘点（兵位和炮位）
        const drawPoint = (x: number, y: number) => {
            const pointSize = 6;
            ctx.fillStyle = this.DOT_COLOR;
            ctx.beginPath();
            ctx.arc(
                startX + x * this.CELL_SIZE, 
                startY + y * this.CELL_SIZE, 
                pointSize / 2, 
                0, 
                Math.PI * 2
            );
            ctx.fill();
        };
        
        // 绘制点位
        // 兵位
        for (let col = 0; col < Board.COLS; col += 2) {
            drawPoint(col, 3); // 黑方
            drawPoint(col, 6); // 红方
        }
        
        // 炮位
        drawPoint(1, 2); // 黑方左炮
        drawPoint(7, 2); // 黑方右炮
        drawPoint(1, 7); // 红方左炮
        drawPoint(7, 7); // 红方右炮
        
        // 绘制河界
        ctx.fillStyle = this.RIVER_BG_COLOR;
        ctx.fillRect(
            startX,
            startY + 4 * this.CELL_SIZE + 2, // 下移2像素
            (Board.COLS-1) * this.CELL_SIZE,
            this.CELL_SIZE - 4 // 高度减少4像素
        );
        
        // 在河界上绘制"楚河汉界"文字
        ctx.font = `bold ${this.CELL_SIZE * 0.4}px ${fontFamily}`;
        ctx.fillStyle = this.RIVER_TEXT_COLOR;
        ctx.shadowColor = 'rgba(255, 255, 255, 0.7)';
        ctx.shadowBlur = 2;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle'; // 确保垂直居中

        // 计算河界中心位置
        const riverCenterX = startX + (Board.COLS-1) * this.CELL_SIZE / 2;
        const riverCenterY = startY + 4.5 * this.CELL_SIZE + 3; // 增加3px垂直偏移

        // 使用中间点分隔符替代斜线
        ctx.fillText('楚 汉', riverCenterX - this.CELL_SIZE * 1.2, riverCenterY);
        ctx.fillText('河 界', riverCenterX + this.CELL_SIZE * 1.2, riverCenterY);

        // 绘制中央分隔符
        ctx.beginPath();
        ctx.arc(riverCenterX, riverCenterY, 3, 0, Math.PI * 2);
        ctx.fillStyle = this.RIVER_TEXT_COLOR;
        ctx.fill();
        
        // 重置文字基线设置
        ctx.textBaseline = 'alphabetic';
        
        // 绘制坐标
        if (showCoordinates) {
            ctx.fillStyle = this.COORD_COLOR;
            ctx.font = `bold 13px ${fontFamily}`;
            ctx.shadowColor = 'rgba(255, 255, 255, 0.6)';
            ctx.shadowBlur = 2;
            
            // 列坐标绘制优化 (标准：下方1-9，上方9-1)
            for (let col = 0; col < Board.COLS; col++) {
                const xPos = startX + col * this.CELL_SIZE;
                const yPosTop = offsetY - 8; // Y position for top coordinates
                const yPosBottom = startY + (Board.ROWS - 1) * this.CELL_SIZE + coordOffset + 12; // Adjusted Y position further down

                // 上方坐标 (黑方视角 9-1)
                ctx.fillText((Board.COLS - col).toString(), xPos, yPosTop);
                // 下方坐标 (红方视角 1-9)
                ctx.fillText((col + 1).toString(), xPos, yPosBottom);
            }

            // 重置阴影
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
        }
        
        // 绘制棋子 - 确保棋子在交叉点正中央
        for (let row = 0; row < Board.ROWS; row++) {
            for (let col = 0; col < Board.COLS; col++) {
                const piece = board.getPiece([row, col]);
                if (piece) {
                    // 绘制棋子背景（圆形）- 确保棋子在交叉点上
                    const pieceX = startX + col * this.CELL_SIZE;
                    const pieceY = startY + row * this.CELL_SIZE;
                    const pieceRadius = this.CELL_SIZE * 0.4;
                    
                    // 棋子底色
                    const gradient = ctx.createRadialGradient(
                        pieceX, pieceY, pieceRadius * 0.5,
                        pieceX, pieceY, pieceRadius
                    );
                    gradient.addColorStop(0, this.PIECE_BG_GRAD_START);
                    gradient.addColorStop(1, this.PIECE_BG_GRAD_END);
                    
                    ctx.fillStyle = gradient;
                    ctx.beginPath();
                    ctx.arc(pieceX, pieceY, pieceRadius, 0, Math.PI * 2);
                    ctx.fill();
                    
                    // 棋子边框
                    ctx.strokeStyle = this.PIECE_BORDER_COLOR;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(pieceX, pieceY, pieceRadius, 0, Math.PI * 2);
                    ctx.stroke();
                    
                    // 棋子内圆（装饰效果）
                    ctx.strokeStyle = piece.color === PieceColor.RED ? 
                        this.RED_PIECE_COLOR : this.BLACK_PIECE_COLOR;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.arc(pieceX, pieceY, pieceRadius * 0.85, 0, Math.PI * 2);
                    ctx.stroke();
                    
                    // 设置棋子文字颜色
                    ctx.fillStyle = piece.color === PieceColor.RED ? 
                        this.RED_PIECE_COLOR : this.BLACK_PIECE_COLOR;
                    ctx.font = `bold ${pieceRadius}px ${fontFamily}`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    
                    // 先绘制文字描边（白色边框）增加可读性
                    ctx.strokeStyle = this.PIECE_TEXT_STROKE;
                    ctx.lineWidth = 1.5;
                    ctx.lineJoin = 'round';
                    ctx.miterLimit = 2;
                    ctx.strokeText(piece.name, pieceX, pieceY);
                    
                    // 绘制棋子文字
                    ctx.fillText(piece.name, pieceX, pieceY);
                    
                    // 添加阴影效果
                    ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
                    ctx.shadowBlur = 6;
                    ctx.shadowOffsetX = 2;
                    ctx.shadowOffsetY = 2;
                }
            }
        }
        
        // 重置阴影
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        
        // 绘制上一步移动的位置标记 - 确保标记在交叉点上
        if (game.lastMovePositions) {
            const { from, to } = game.lastMovePositions;
            
            // 计算位置坐标 - 确保是在网格交叉点
            const fromX = startX + from[1] * this.CELL_SIZE;
            const fromY = startY + from[0] * this.CELL_SIZE;
            const toX = startX + to[1] * this.CELL_SIZE;
            const toY = startY + to[0] * this.CELL_SIZE;
            
            // 绘制位置标记
            ctx.fillStyle = this.LAST_MOVE_COLOR;
            
            // 绘制起始位置标记
            ctx.beginPath();
            ctx.arc(fromX, fromY, this.CELL_SIZE * 0.45, 0, Math.PI * 2);
            ctx.fill();
            
            // 绘制目标位置标记
            ctx.beginPath();
            ctx.arc(toX, toY, this.CELL_SIZE * 0.45, 0, Math.PI * 2);
            ctx.fill();
            
            // 绘制从起始位置到目标位置的箭头
            this.drawArrow(ctx, fromX, fromY, toX, toY);
        }
        
        // 绘制游戏信息面板 - 单行布局，主体居中
        const infoPanelHeight = 36; // 更紧凑的单行高度（从40改为36）
        // 计算底部坐标位置
        const bottomCoordY = showCoordinates ? 
            (startY + (Board.ROWS - 1) * this.CELL_SIZE + coordOffset + 12) : 
            (startY + (Board.ROWS - 1) * this.CELL_SIZE + this.CELL_SIZE * 0.5);
        
        // 计算信息栏位置（更靠近棋盘底部但留有间距）
        const spaceBelowBoard = height - bottomCoordY - (this.BORDER_WIDTH / 2);
        const infoPanelY = bottomCoordY + (spaceBelowBoard - infoPanelHeight) / 2 + 8; // 增加下移到8
        
        // 信息栏宽度和X坐标（略窄于棋盘，更居中）
        const infoPanelWidth = (Board.COLS - 1) * this.CELL_SIZE - 20;
        const infoPanelX = startX + 10; // 左右各缩进10像素，增加留白
        
        // 保存当前绘图状态
        ctx.save();
        
        // 设置阴影效果 - 更精致的阴影
        ctx.shadowColor = this.INFO_PANEL_SHADOW;
        ctx.shadowBlur = 12;
        ctx.shadowOffsetY = 3;
        
        // 绘制信息栏背景 - 使用更大的圆角和柔和的渐变
        const infoPanelGradient = ctx.createLinearGradient(
            infoPanelX, 
            infoPanelY, 
            infoPanelX, 
            infoPanelY + infoPanelHeight
        );
        infoPanelGradient.addColorStop(0, this.INFO_PANEL_BG_START);
        infoPanelGradient.addColorStop(1, this.INFO_PANEL_BG_END);
        
        ctx.fillStyle = infoPanelGradient;
        this.roundRect(ctx, infoPanelX, infoPanelY, infoPanelWidth, infoPanelHeight, 12);
        ctx.fill();
        
        // 绘制信息栏边框 - 更精致的边框（半透明）
        ctx.strokeStyle = this.INFO_PANEL_BORDER;
        ctx.lineWidth = 1;
        this.roundRect(ctx, infoPanelX, infoPanelY, infoPanelWidth, infoPanelHeight, 12);
        ctx.stroke();
        
        // 重置阴影
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        
        // 添加微妙的面板纹理（点状纹理）
        ctx.save();
        ctx.globalAlpha = 0.03;
        ctx.fillStyle = '#000000';
        for (let x = infoPanelX + 5; x < infoPanelX + infoPanelWidth - 5; x += 4) {
            for (let y = infoPanelY + 5; y < infoPanelY + infoPanelHeight - 5; y += 4) {
                ctx.beginPath();
                ctx.arc(x, y, 0.5, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
        
        // 计算移动数（成对的走法）
        const moveNumber = Math.floor(game.history.length / 2) + 1;
        
        // 计算面板中心点（垂直方向）
        const panelCenterY = infoPanelY + infoPanelHeight / 2;
        
        // 单行布局 - 均匀分布三个主要元素
        // 计算整个面板的可用宽度
        const usableWidth = infoPanelWidth - 40; // 左右各留20px边距
        
        // 三个元素的实际宽度
        const badgeElementWidth = 65;  // 回合徽章元素宽度（从60增加到65）
        const playerElementWidth = 85; // 当前方元素宽度（从80增加到85）
        const moveElementWidth = game.lastMove ? 95 : 0; // 上一步元素宽度（从90增加到95）
        
        // 总元素宽度
        const totalElementsWidth = badgeElementWidth + playerElementWidth + moveElementWidth;
        
        // 计算元素之间的间距 (总可用宽度减去元素宽度，然后在n-1个间隙中平均分配)
        // 如果有上一步，则有2个间隙；如果没有上一步，则有1个间隙
        const elementsCount = game.lastMove ? 3 : 2;
        const elementSpacing = (usableWidth - totalElementsWidth) / (elementsCount - 1);
        
        // 计算各元素的起始X坐标
        const startPaddingX = (infoPanelWidth - (totalElementsWidth + (elementsCount - 1) * elementSpacing)) / 2;
        const badgeElementX = infoPanelX + startPaddingX;
        const playerElementX = badgeElementX + badgeElementWidth + elementSpacing;
        const moveElementX = playerElementX + playerElementWidth + elementSpacing;
        
        // ===== 左侧：回合显示 =====
        // 绘制回合数徽章 - 更精致的设计
        const badgeRadius = 13; // 从14减小到13
        const badgeX = badgeElementX + badgeElementWidth / 2 + 3; // 向右偏移3像素
        const badgeY = panelCenterY;
        
        // 绘制徽章光晕效果
        const badgeGlowColor = game.currentTurn === PieceColor.RED ? 
            this.INFO_RED_BADGE_GLOW : this.INFO_BLACK_BADGE_GLOW;
            
        ctx.save();
        ctx.shadowColor = badgeGlowColor;
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        
        // 徽章背景（主体）
        ctx.fillStyle = game.currentTurn === PieceColor.RED ? 
            this.INFO_RED_BADGE_BG : this.INFO_BLACK_BADGE_BG;
        ctx.beginPath();
        ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
        ctx.fill();
        
        // 徽章边框
        ctx.strokeStyle = game.currentTurn === PieceColor.RED ? 
            this.RED_PIECE_COLOR : this.BLACK_PIECE_COLOR;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
        ctx.stroke();
        
        ctx.restore(); // 结束光晕效果
        
        // 徽章内部高光效果
        ctx.save();
        ctx.globalAlpha = 0.3;
        const highlightGradient = ctx.createRadialGradient(
            badgeX - 3, badgeY - 3, 2,
            badgeX, badgeY, badgeRadius
        );
        highlightGradient.addColorStop(0, 'rgba(255,255,255,0.8)');
        highlightGradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = highlightGradient;
        ctx.beginPath();
        ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        
        // 绘制回合数
        ctx.font = `bold 15px ${fontFamily}`;
        ctx.fillStyle = game.currentTurn === PieceColor.RED ? 
            this.RED_PIECE_COLOR : this.BLACK_PIECE_COLOR;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(moveNumber.toString(), badgeX, badgeY);
        
        // 绘制"回合"文本 - 放在左侧，增加与边框的距离
        ctx.fillStyle = this.INFO_TEXT_COLOR;
        ctx.font = `bold 13px ${fontFamily}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText('回合', badgeX - badgeRadius - 8, badgeY); // 从-12改为-8更靠右
        
        // 只有当有多个元素时才绘制分隔线
        if (elementsCount > 1) {
            // 绘制垂直分隔线1（在左侧元素和中间元素之间）
            const dividerX1 = badgeX + badgeElementWidth / 2 - 8; // 左移8像素
            ctx.strokeStyle = this.INFO_DIVIDER_COLOR;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]); // 设置虚线样式
            ctx.beginPath();
            ctx.moveTo(dividerX1, infoPanelY + 8); // 从12改为8
            ctx.lineTo(dividerX1, infoPanelY + infoPanelHeight - 8); // 从12改为8
            ctx.stroke();
        }
        
        // ===== 中间：当前方显示 =====
        const currentTurnText = game.currentTurn === PieceColor.RED ? '红方' : '黑方';
        const playerBadgeX = playerElementX;
        const playerBadgeY = panelCenterY;
        const playerBadgeWidth = 70;
        const playerBadgeHeight = 28; // 从32减小为28
        
        // 绘制"当前"文本 - 放在左侧，增加与边框的距离
        ctx.fillStyle = this.INFO_TEXT_COLOR;
        ctx.font = `bold 13px ${fontFamily}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText('当前', playerBadgeX - 8, playerBadgeY); // 从-12改为-8更靠右
        
        // 绘制当前方徽章背景
        ctx.save();
        ctx.shadowColor = badgeGlowColor;
        ctx.shadowBlur = 3;
        ctx.fillStyle = game.currentTurn === PieceColor.RED ? 
            this.INFO_RED_BADGE_BG : this.INFO_BLACK_BADGE_BG;
        this.roundRect(
            ctx, 
            playerBadgeX, 
            playerBadgeY - playerBadgeHeight/2, 
            playerBadgeWidth, 
            playerBadgeHeight, 
            8
        );
        ctx.fill();
        
        // 徽章边框
        ctx.strokeStyle = game.currentTurn === PieceColor.RED ? 
            this.RED_PIECE_COLOR : this.BLACK_PIECE_COLOR;
        ctx.lineWidth = 1;
        this.roundRect(
            ctx, 
            playerBadgeX, 
            playerBadgeY - playerBadgeHeight/2, 
            playerBadgeWidth, 
            playerBadgeHeight, 
            8
        );
        ctx.stroke();
        ctx.restore();
        
        // 绘制当前方文本
        ctx.fillStyle = game.currentTurn === PieceColor.RED ? 
            this.RED_PIECE_COLOR : this.BLACK_PIECE_COLOR;
        ctx.font = `bold 15px ${fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(currentTurnText, playerBadgeX + playerBadgeWidth/2, playerBadgeY);
        
        if (game.lastMove) {
            // 绘制垂直分隔线2（在中间元素和右侧元素之间）
            const dividerX2 = playerBadgeX + playerBadgeWidth + elementSpacing / 2;
            ctx.setLineDash([3, 3]); // 设置虚线样式
            ctx.beginPath();
            ctx.moveTo(dividerX2, infoPanelY + 8); // 从12改为8
            ctx.lineTo(dividerX2, infoPanelY + infoPanelHeight - 8); // 从12改为8
            ctx.stroke();
            ctx.setLineDash([]); // 重置为实线
            
            // ===== 右侧：上一步显示 =====
            const moveBgWidth = 90;
            const moveBgHeight = 28; // 从32减小为28
            
            // 绘制"上一步"文本 - 放在左侧，增加与边框的距离
            ctx.fillStyle = this.INFO_TEXT_COLOR;
            ctx.font = `bold 13px ${fontFamily}`;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText('上一步', moveElementX - 8, playerBadgeY); // 从-12改为-8更靠右
            
            // 绘制走法背景
            ctx.fillStyle = this.INFO_LABEL_BG;
            this.roundRect(
                ctx,
                moveElementX,
                playerBadgeY - moveBgHeight/2,
                moveBgWidth,
                moveBgHeight,
                6
            );
            ctx.fill();
            
            // 走法边框 - 半透明
            ctx.strokeStyle = 'rgba(180, 180, 180, 0.3)';
            ctx.lineWidth = 1;
            this.roundRect(
                ctx,
                moveElementX,
                playerBadgeY - moveBgHeight/2,
                moveBgWidth,
                moveBgHeight,
                6
            );
            ctx.stroke();
            
            // 绘制走法文本 - 使用对方颜色
            ctx.fillStyle = game.currentTurn === PieceColor.RED ? 
                this.BLACK_PIECE_COLOR : this.RED_PIECE_COLOR;
            ctx.font = `bold 15px ${fontFamily}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(
                game.lastMove, 
                moveElementX + moveBgWidth/2, 
                playerBadgeY
            );
        }
        
        // 恢复绘图状态
        ctx.restore();
        
        try {
            // 将画布转换为Buffer
            return canvas.toBuffer('image/png');
        } catch (error) {
            log.error('创建图片缓冲区失败:', error);
            throw new Error('无法生成图片');
        }
    }
    
    /**
     * 生成简单的文本表示的棋盘（兼容旧版本）
     * @param game 当前游戏实例
     * @returns 文本字符串表示的棋盘
     */
    static renderBoardHTML(game: Game): string {
        const board = game.getBoardObject();
        let result = '';

        // 添加CSS样式，确保棋盘更美观
        result += '<div style="font-family: monospace; line-height: 1.2; white-space: pre;">';
        
        // 列标识（上方９-１，下方１-９）- 改进对齐
        result += '　　 ９　８　７　６　５　４　３　２　１<br>'; // Top coordinates (Black's view)
        result += '　 ┌───┬───┬───┬───┬───┬───┬───┬───┬───┐<br>'; // Top border

        for (let row = 0; row < Board.ROWS; row++) {
            // Add left coordinate (Red's perspective 1-9)
            const leftCoord = (row + 1).toString().padStart(2, ' '); // Pad with space for alignment
            result += `${leftCoord} │`; // Add coordinate and separator

            // 棋盘内容
            for (let col = 0; col < Board.COLS; col++) {
                const piece = board.getPiece([row, col]);
                let symbol = '　';
                
                if (piece) {
                    // 确保piece存在再访问其属性
                    const styleColor = piece.color === PieceColor.RED ? 
                        `style="color:${this.RED_PIECE_COLOR}; font-weight:bold;"` : 
                        `style="color:${this.BLACK_PIECE_COLOR};"`;
                    symbol = `<span ${styleColor}>${piece.name}</span>`;
                } else {
                    // 交叉点符号 - 使用中点字符"·"表示交叉点
                    if (row === 4) {
                        // 河界可视化（第4行）- 楚河汉界
                        if (col === 1) symbol = '楚';
                        else if (col === 2) symbol = '河';
                        else if (col === 6) symbol = '汉';
                        else if (col === 7) symbol = '界';
                        else symbol = '　';
                    } else {
                        symbol = '·'; // 使用中点表示交叉点
                    }
                }
                result += symbol;
                
                // 列分隔符
                result += col < Board.COLS - 1 ? '│' : '';
            }

            // Add right coordinate (Red's perspective 1-9)
            const rightCoord = (row + 1).toString();
            result += `│ ${rightCoord}<br>`; // Add separator and coordinate

            // 行分隔符 (Add padding for side coordinates)
            if (row < Board.ROWS - 1) {
                if (row === 4) { // River separator
                    result += '　 ├═══┴═══┴═══┴═══┴═══┴═══┴═══┴═══┴═══┤<br>';
                } else if (row === 3) { // River top border
                    result += '　 ├═══┴═══┴═══┴═══┴═══┴═══┴═══┴═══┴═══┤<br>';
                } else { // Normal row separator
                    result += '　 ├───┼───┼───┼───┼───┼───┼───┼───┼───┤<br>';
                }
            }
        }

        // 底部边框 (Add padding)
        result += '　 └───┴───┴───┴───┴───┴───┴───┴───┴───┘<br>'; // Bottom border
        // 列标识（下方１-９） (Add padding)
        result += '　　 １　２　３　４　５　６　７　８　９<br>'; // Bottom coordinates (Red's view)

        // 游戏信息区域 (Add padding to center it relative to the board grid)
        result += `<div style="margin-left: 2em; margin-top:10px;padding:8px;background:#f5f5f5;border-radius:5px;border:1px solid #ddd; display: inline-block;">`; // Use inline-block and margin for centering
        
        // Calculate move number
        const moveNumber = Math.floor(game.history.length / 2) + 1; // Use game.history
        
        result += `<span style="color:${game.currentTurn === PieceColor.RED ? this.RED_PIECE_COLOR : this.BLACK_PIECE_COLOR};font-weight:bold;">`;
        result += `第 ${moveNumber} 回合 - 当前：${game.currentTurn === PieceColor.RED ? '红方' : '黑方'}</span><br>`;

        if (game.lastMove) {
            result += `上一步：${game.lastMove}<br>`;
        }
        result += `</div>`;
        
        result += '</div>'; // 关闭最外层div
        
        return result;
    }

    private static drawPalaceDiagonals(ctx: any, startX: number, startY: number) { // Let TS infer the context type
        // 上方九宫格（调整为绝对坐标计算）
        this.drawDiagonal(
            ctx,
            startX + 3 * this.CELL_SIZE,  // 修正起始X坐标
            startY,                        // 起始Y坐标
            startX + 5 * this.CELL_SIZE,   // 结束X坐标
            startY + 2 * this.CELL_SIZE    // 结束Y坐标
        );
        
        // 下方九宫格
        this.drawDiagonal(
            ctx,
            startX + 3 * this.CELL_SIZE,
            startY + 7 * this.CELL_SIZE,
            startX + 5 * this.CELL_SIZE,
            startY + 9 * this.CELL_SIZE
        );
    }

    private static drawDiagonal(
        ctx: any, // Let TS infer the context type
        fromX: number,  // 使用绝对坐标
        fromY: number,
        toX: number,
        toY: number
    ) {
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();
        
        // 绘制另一条对角线
        ctx.beginPath();
        ctx.moveTo(toX, fromY);
        ctx.lineTo(fromX, toY);
        ctx.stroke();
    }
}
