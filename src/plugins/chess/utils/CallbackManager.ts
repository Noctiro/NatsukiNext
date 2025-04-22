import { CallbackDataBuilder } from "../../../utils/callback";

/**
 * 中国象棋插件的回调数据管理器
 * 用于处理AI难度选择和游戏控制功能
 */

// 创建AI难度选择回调构建器 - 任何人都可以点击
export const AIDifficultyCB = new CallbackDataBuilder<{
    difficulty: string; // 'easy', 'normal', 'hard'
}>('chess', 'ai', ['difficulty']);

// 创建游戏控制回调构建器 (认输、和棋请求等)
export const GameControlCB = new CallbackDataBuilder<{
    gameId: string;
    action: string;   // 'resign', 'draw', 'review', 'help', 'commands', 'status', 'accept', 'decline', 'restart', 'start_ai_game', 'start_player_game'
    userId: number;   // 仅当操作需要用户身份验证时才检查此字段
}>('chess', 'control', ['gameId', 'action', 'userId']);

// 创建菜单回调构建器 (用于返回主菜单等操作)
export const MenuCB = new CallbackDataBuilder<{
    action: string;  // 特殊操作类型，通常是0
}>('chess', 'menu', ['action']); 