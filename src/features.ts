import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { TelegramClient } from '@mtcute/bun';
import {
    Dispatcher,
    filters,
    type MessageContext,
    type CallbackQueryContext
} from '@mtcute/dispatcher';
import { log } from './log';
import { enableChats, managerIds } from './app';
import { PermissionManager, type Permission } from './permissions';
import { embeddedPlugins, embeddedPluginsList } from './embedded-plugins';

// 扩展 TelegramClient 类型，以便在整个应用中访问features实例
declare module '@mtcute/bun' {
    interface TelegramClient {
        features: Features;
    }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 跨平台路径处理工具
 * 处理不同操作系统的路径差异，确保代码在所有平台上都能正常工作
 */
const pathUtils = {
    /**
     * 标准化路径，统一使用正斜杠
     * @param p 原始路径
     * @returns 标准化后的路径
     */
    normalize(p: string): string {
        return p?.replace(/\\/g, '/') || '';
    },

    /**
     * 检查文件是否存在
     * @param filePath 文件路径
     * @returns 布尔值，表示文件是否存在
     */
    async fileExists(filePath: string): Promise<boolean> {
        if (!filePath) return false;
        try {
            const stat = await fs.stat(filePath);
            return stat.isFile();
        } catch (err) {
            return false;
        }
    },

    /**
     * 检查目录是否存在
     * @param dirPath 目录路径
     * @returns 布尔值，表示目录是否存在
     */
    async dirExists(dirPath: string): Promise<boolean> {
        if (!dirPath) return false;
        try {
            const stat = await fs.stat(dirPath);
            return stat.isDirectory();
        } catch (err) {
            return false;
        }
    },

    /**
     * 确保目录存在，如果不存在则创建
     * @param dirPath 目录路径
     */
    async ensureDir(dirPath: string): Promise<void> {
        if (!dirPath) {
            throw new Error('目录路径不能为空');
        }

        try {
            // 先检查目录是否已存在
            if (await this.dirExists(dirPath)) {
                return;
            }

            // 创建目录，包括所有不存在的父目录
            await fs.mkdir(dirPath, { recursive: true });
        } catch (err) {
            // 捕获可能的错误
            // EEXIST错误可以忽略（目录已存在）
            const error = err instanceof Error ? err : new Error(String(err));
            if ('code' in error && error.code === 'EEXIST') {
                return;
            }

            // 其他错误需要抛出
            throw error;
        }
    }
};

// 基础事件上下文
export interface BaseContext {
    // Telegram客户端实例
    client: TelegramClient;
    // 当前聊天ID
    chatId: number;
    // 权限检查函数
    hasPermission(permission: string): boolean;
}

// 命令上下文
export interface CommandContext extends BaseContext {
    type: 'command';
    message: MessageContext;
    // 命令名，不包含/
    command: string;
    // 命令参数数组
    args: string[];
    // 命令参数拼接成字符串
    content: string;
    // 完整原始文本
    rawText: string;
    // 权限级别，用于快速检查
    permissionLevel: number;
}

// 消息上下文
export interface MessageEventContext extends BaseContext {
    type: 'message';
    message: MessageContext;
}

// 回调查询上下文
export interface CallbackEventContext extends BaseContext {
    type: 'callback';
    query: CallbackQueryContext;
    data: string;
    parseData: CallbackDataParser; // 添加回调数据解析器
    match?: {
        [key: string]: any;
        _pluginName?: string; // 匹配的插件名
        _actionType?: string; // 匹配的操作类型
    }; // 添加匹配结果属性，包含基础元数据
}

/**
 * 回调数据解析器接口
 */
export interface CallbackDataParser {
    /**
     * 检查回调数据是否以指定前缀开头
     * @param prefix 回调前缀
     * @returns 是否匹配前缀
     */
    hasPrefix(prefix: string): boolean;

    /**
     * 获取回调数据的部分
     * @param index 部分索引
     * @returns 指定索引的部分或undefined
     */
    getPart(index: number): string | undefined;

    /**
     * 获取回调数据的整数部分
     * @param index 部分索引
     * @param defaultValue 默认值，当部分不存在或无法解析为整数时返回
     * @returns 解析为整数的部分或默认值
     */
    getIntPart(index: number, defaultValue?: number): number;

    /**
     * 获取所有回调数据部分
     * @returns 所有部分数组
     */
    getParts(): string[];

    /**
     * 获取回调数据的命令部分（通常是第一部分）
     * @returns 命令部分
     */
    getCommand(): string;

    /**
     * 获取回调数据的子命令部分（通常是第二部分）
     * @returns 子命令部分
     */
    getSubCommand(): string | undefined;

    /**
     * 解析回调数据为对象
     * @param schema 解析模式，例如 {userId: 'int', text: 'string'}
     * @param startIndex 开始解析的索引，默认为1
     * @returns 解析后的对象
     */
    parseAsObject<T>(schema: Record<string, 'int' | 'string' | 'boolean'>, startIndex?: number): T;
}

// 事件上下文联合类型
export type EventContext = CommandContext | MessageEventContext | CallbackEventContext;

// 事件处理器类型
export type EventHandler<T extends EventContext = EventContext> = (context: T) => Promise<void>;

// 插件事件定义
export interface PluginEvent<T extends EventContext = EventContext> {
    type: T['type'];
    filter?: (ctx: EventContext) => boolean;
    // 对于回调事件, name用于匹配功能名（与CallbackDataBuilder中的actionType对应)
    name?: string;
    handler: EventHandler<T>;
    // 优先级，数值越大优先级越高
    priority?: number;
}

// 插件命令定义
export interface PluginCommand {
    name: string;
    description?: string;
    aliases?: string[];
    handler: (ctx: CommandContext) => Promise<void>;
    // 执行命令所需权限
    requiredPermission?: string;
    // 命令冷却时间（秒）
    cooldown?: number;
}

// 插件状态枚举
export enum PluginStatus {
    ACTIVE = 'active',
    DISABLED = 'disabled',
    ERROR = 'error'
}

// 插件接口定义
export interface BotPlugin {
    name: string;
    description?: string;
    version?: string;
    events?: PluginEvent<any>[];
    commands?: PluginCommand[];
    // 添加权限声明数组
    permissions?: Permission[];
    onLoad?(client: TelegramClient): Promise<void>;
    onUnload?(): Promise<void>;
    // 插件依赖，插件加载时会先加载其依赖
    dependencies?: string[];
    // 插件当前状态
    status?: PluginStatus;
    // 出错时的错误信息
    error?: string;
    // 插件专用日志记录器
    logger?: typeof log;
}

/**
 * 功能管理器类 (Features)
 * 
 * 功能管理器是机器人的核心组件，负责整个系统的插件管理、事件分发和命令处理。
 * 主要职责包括：
 * 
 * 1. 插件系统管理：
 *    - 加载、启用、禁用和重载插件
 *    - 管理插件依赖关系
 *    - 处理插件配置
 * 
 * 2. 事件处理系统：
 *    - 注册和分发事件（消息、命令、回调查询）
 *    - 优先级管理，支持按优先级和并行处理事件
 *    - 超时保护，防止事件处理器阻塞
 * 
 * 3. 命令处理系统：
 *    - 解析和执行命令
 *    - 命令权限和冷却时间管理
 *    - 命令队列，防止同一用户并发处理
 *    - 命令处理器缓存（LRU策略）
 * 
 * 4. 权限管理：
 *    - 集成权限管理器
 *    - 权限检查
 * 
 * 5. 性能优化：
 *    - 内存管理和垃圾回收
 *    - 缓存清理
 *    - 防止内存泄漏
 */
export class Features {
    // ===== 插件系统相关 =====
    /** 插件映射表: 插件名称 -> 插件实例 */
    private plugins = new Map<string, BotPlugin>();

    // ===== 事件系统相关 =====
    /** Telegram事件分发器 */
    private dispatcher: Dispatcher;
    /** 事件处理器映射表: 事件类型 -> 处理器集合 */
    private eventHandlers = new Map<string, Set<PluginEvent>>();

    // ===== 权限系统相关 =====
    /** 权限管理器实例 */
    private permissionManager!: PermissionManager;

    // ===== 命令系统相关 =====
    /** 命令冷却时间跟踪: 用户ID -> (命令名称 -> 时间戳) */
    private commandCooldowns: Map<number, Map<string, number>> = new Map();
    /** 命令处理器缓存，加速命令查找: 命令名称 -> 处理器数组 */
    private commandHandlersCache = new Map<string, { plugin: BotPlugin, cmd: PluginCommand }[]>();
    /** 缓存上次更新时间戳，用于定期刷新缓存 */
    private commandCacheLastUpdated = 0;
    /** 缓存过期时间（毫秒）*/
    private readonly COMMAND_CACHE_TTL = 30000; // 30秒
    /** 命令队列，防止同一用户并发处理命令: 用户ID -> Promise */
    private commandQueue = new Map<number, Promise<void>>();
    /** 最近使用的命令列表（LRU缓存） */
    private recentlyUsedCommands: string[] = [];
    /** 最近使用命令缓存的最大容量 */
    private readonly CACHE_MAX_SIZE = 50;
    /** 命令执行超时时间（毫秒） */
    private readonly COMMAND_TIMEOUT = 180000; // 3分钟
    /** 用户上次执行命令的时间: 用户ID -> 时间戳 */
    private userLastCommandTime = new Map<number, number>();
    
    /**
     * 命令频率控制系统 - 核心参数
     * 使用分层滑动窗口设计，提供更灵活的频率控制
     */
    /** 短时窗口大小（毫秒） - 防止突发命令洪水 */
    private readonly SHORT_WINDOW_SIZE = 5000; // 5秒
    /** 短时窗口内允许的最大命令数 */
    private readonly SHORT_WINDOW_MAX_COMMANDS = 3; // 5秒内最多3个命令
    
    /** 中等窗口大小（毫秒） - 防止持续的中等强度攻击 */
    private readonly MEDIUM_WINDOW_SIZE = 20000; // 20秒
    /** 中等窗口内允许的最大命令数 */
    private readonly MEDIUM_WINDOW_MAX_COMMANDS = 8; // 20秒内最多8个命令
    
    /** 长时窗口大小（毫秒） - 防止长时间的低强度攻击 */
    private readonly LONG_WINDOW_SIZE = 60000; // 60秒
    /** 长时窗口内允许的最大命令数 */
    private readonly LONG_WINDOW_MAX_COMMANDS = 15; // 60秒内最多15个命令
    
    /** 命令历史数组的初始容量 - 减少动态扩容 */
    private readonly COMMAND_HISTORY_INITIAL_CAPACITY = 20;
    
    /** 用户命令历史记录 - 用户ID -> 时间戳数组（按时间排序） */
    private userCommandHistory = new Map<number, number[]>();
    
    /** 可疑用户列表及其首次触发时间 - 用户ID -> 时间戳 */
    private suspiciousUsers = new Map<number, number>();
    
    /** 可疑用户触发计数 - 用户ID -> 触发次数 */
    private suspiciousTriggerCount = new Map<number, number>();
    
    /** 用户暂时封禁列表 - 用户ID -> 解除时间 */
    private tempBannedUsers = new Map<number, number>();
    
    /** 临时封禁时长（毫秒）- 基础值 */
    private readonly TEMP_BAN_DURATION_BASE = 300000; // 5分钟
    
    /** 封禁时长倍增因子 - 用于累进惩罚 */
    private readonly BAN_MULTIPLIER = 2;
    
    /** 用户封禁次数记录 - 计算累进惩罚 */
    private userBanCount = new Map<number, number>();
    
    /** 连续触发次数阈值，超过将被临时封禁 */
    private readonly SUSPICIOUS_THRESHOLD = 3;
    
    /** 可疑用户衰减时间（毫秒）- 多久后重置可疑状态 */
    private readonly SUSPICIOUS_DECAY_TIME = 3600000; // 1小时

    // ===== 配置系统相关 =====
    /** 插件配置缓存: 插件名称 -> 配置对象 */
    private pluginConfigs = new Map<string, any>();

    // ===== 内存管理相关 =====
    /** 内存清理间隔（毫秒） */
    private readonly MEMORY_CLEANUP_INTERVAL = 300000; // 5分钟（原为10分钟，减少以提高清理频率）
    /** 内存清理定时器 */
    private memoryCleanupTimer?: ReturnType<typeof setInterval>;
    /** 内存使用历史记录，用于计算增长率和检测潜在内存泄漏 */
    private memoryHistory: { timestamp: number; rss: number; heapTotal: number; heapUsed: number }[] = [];
    /** 内存历史记录最大数量 */
    private readonly MEMORY_HISTORY_MAX_SIZE = 10;
    /** 上次内存检查时间戳 */
    private lastMemoryCheck = Date.now();
    /** 内存历史记录间隔（毫秒） */
    private readonly MEMORY_HISTORY_INTERVAL = 3600000; // 1小时
    /** 当前时间戳缓存，用于减少Date.now()调用 */
    private currentTimestamp = 0;

    // ===== 对象池 =====
    /** 对象池：用于复用频繁创建的对象，减少GC压力 */
    private objectPools: {
        matchObjects: Array<Record<string, any>>;
        callbackContexts: Array<Partial<CallbackEventContext>>;
        commandHandlers: Array<{ plugin: BotPlugin, cmd: PluginCommand }>;
        eventTasks: Array<() => Promise<void>>;
        cooldownMaps: Array<Map<string, number>>; // 冷却时间Map对象池
    } = {
        matchObjects: [],
        callbackContexts: [],
        commandHandlers: [],
            eventTasks: [],
            cooldownMaps: [] // 添加冷却时间Map对象池
    };
    /** 对象池最大容量 */
    private readonly POOL_SIZE = 100;

    // ===== 命令冷却缓存 =====
    private _commandCooldownCache?: {
        maxCooldownSeconds: number;
        cooldownMillisMap: Map<string, number>;
        lastUpdated: number;
    };

    /**
     * 创建功能管理器实例
     * 
     * @param client Telegram客户端实例
     * @param pluginsDir 插件目录路径，默认为当前目录下的plugins目录
     * @param configDir 配置目录路径，默认为当前目录下的config目录
     */
    constructor(
        private readonly client: TelegramClient,
        private readonly pluginsDir: string = path.join(__dirname, './plugins/'),
        private readonly configDir: string = path.join(__dirname, './config/')
    ) {
        // 初始化事件分发器
        this.dispatcher = Dispatcher.for(client);
        
        // 初始化事件处理器集合
        this.eventHandlers.set('message', new Set());
        this.eventHandlers.set('command', new Set());
        this.eventHandlers.set('callback', new Set());
        
        // 初始化对象池
        this.initObjectPools();
    }

    /**
     * 初始化对象池
     * 预先分配一定数量的对象到池中，减少运行时分配
     * @private
     */
    private initObjectPools(): void {
        // 预分配一些常用对象到对象池中
        for (let i = 0; i < 20; i++) {
            this.objectPools.matchObjects.push({});
            this.objectPools.callbackContexts.push({});
            this.objectPools.commandHandlers.push({ plugin: null as any, cmd: null as any });
            this.objectPools.eventTasks.push(async () => { });
            this.objectPools.cooldownMaps.push(new Map());
        }
    }

    /**
     * 从对象池获取一个对象
     * @param poolName 池名称
     * @returns 对象池中的对象，如果池为空则新建
     * @private
     */
    private getFromPool<T>(poolName: keyof Features['objectPools']): T {
        const pool = this.objectPools[poolName];
        if (pool.length > 0) {
            return pool.pop() as T;
        }
        
        // 池为空时创建新对象
        switch (poolName) {
            case 'matchObjects':
                return {} as T;
            case 'callbackContexts':
                return {} as T;
            case 'commandHandlers':
                return { plugin: null, cmd: null } as T;
            case 'eventTasks':
                return (async () => { }) as unknown as T;
            case 'cooldownMaps':
                return new Map<string, number>() as unknown as T;
            default:
                return {} as T;
        }
    }

    /**
     * 归还对象到池中
     * @param poolName 池名称
     * @param obj 要归还的对象
     * @private
     */
    private returnToPool<T>(poolName: keyof Features['objectPools'], obj: T): void {
        const pool = this.objectPools[poolName];
        
        // 清除对象属性
        if (typeof obj === 'object' && obj !== null) {
            if (poolName === 'cooldownMaps') {
                // 清空Map
                (obj as unknown as Map<string, number>).clear();
            } else {
            // 清空对象所有属性
            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    (obj as any)[key] = null;
                    }
                }
            }
        }
        
        // 只有在池未满时才归还
        if (pool.length < this.POOL_SIZE) {
            pool.push(obj as any);
        }
    }

    /**
     * 确保配置目录存在
     * 如果配置目录不存在，会尝试创建它
     * @private
     */
    private async ensureConfigDir(): Promise<void> {
        try {
            // 使用跨平台工具确保目录存在
            await pathUtils.ensureDir(this.configDir);
            log.debug(`配置目录已确保存在: ${this.configDir}`);
        } catch (err) {
            // 处理可能的错误
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`创建配置目录失败: ${error.message}`);
            // 这里不抛出异常，让调用方决定如何处理
        }
    }

    /**
     * 获取所有已加载的插件
     * @returns 插件数组
     */
    getPlugins(): BotPlugin[] {
        return Array.from(this.plugins.values());
    }

    /**
     * 获取指定名称的插件
     * @param name 插件名称
     * @returns 插件对象，不存在则返回undefined
     */
    getPlugin(name: string): BotPlugin | undefined {
        return this.plugins.get(name);
    }

    /**
     * 获取权限管理器实例
     * @returns 权限管理器实例
     */
    getPermissionManager(): PermissionManager {
        if (!this.permissionManager) {
            throw new Error('权限管理器尚未初始化');
        }
        return this.permissionManager;
    }

    /**
     * 检查用户是否有指定权限
     * 这是唯一需要保留的权限管理方法，其他方法应直接使用权限管理器
     * @param userId 用户ID
     * @param permissionName 权限名称
     * @returns 是否有权限
     */
    hasPermission(userId: number, permissionName: string): boolean {
        // 如果权限管理器未初始化，只有管理员有权限
        if (!this.permissionManager) {
            return managerIds.includes(userId);
        }
        return this.permissionManager.hasPermission(userId, permissionName);
    }

    /**
     * 启用插件
     * @param name 插件名称
     * @param autoLoadDependencies 是否自动加载依赖
     */
    async enablePlugin(name: string, autoLoadDependencies: boolean = false): Promise<boolean> {
        try {
            // 检查插件是否存在
            const plugin = this.plugins.get(name);
            if (!plugin) {
                log.warn(`Plugin ${name} not found`);
                return false;
            }

            // 如果插件已经启用，跳过
            if (plugin.status === PluginStatus.ACTIVE) {
                plugin.logger?.debug(`插件已处于启用状态`);
                return true;
            }

            log.info(`正在启用插件: ${name}`);

            // 检查依赖
            if (plugin.dependencies && plugin.dependencies.length > 0) {
                plugin.logger?.debug(`正在检查依赖: ${plugin.dependencies.join(', ')}`);
                for (const dependency of plugin.dependencies) {
                    let dep = this.plugins.get(dependency);

                    // 如果依赖不存在并且允许自动加载
                    if (!dep && autoLoadDependencies) {
                        plugin.logger?.info(`自动加载依赖插件: ${dependency}`);
                        const loadSuccess = await this.loadPlugin(dependency, true);
                        if (loadSuccess) {
                            dep = this.plugins.get(dependency);
                        }
                    }

                    // 确认依赖存在并已启用
                    if (!dep) {
                        plugin.logger?.error(`依赖插件 ${dependency} 未找到`);
                        plugin.status = PluginStatus.ERROR;
                        plugin.error = `依赖插件 ${dependency} 未找到`;
                        return false;
                    }

                    if (dep.status !== PluginStatus.ACTIVE) {
                        // 递归启用依赖
                        plugin.logger?.debug(`启用依赖插件: ${dependency}`);
                        const success = await this.enablePlugin(dependency, autoLoadDependencies);
                        if (!success) {
                            plugin.logger?.error(`启用依赖插件 ${dependency} 失败`);
                            plugin.status = PluginStatus.ERROR;
                            plugin.error = `启用依赖插件 ${dependency} 失败`;
                            return false;
                        }
                    }
                }
            }

            // 执行插件的onLoad方法
            try {
                plugin.logger?.debug(`正在初始化插件...`);
                if (plugin.onLoad) {
                    await plugin.onLoad(this.client);
                }

                // 注册插件事件处理器
                this.registerPluginEvents(plugin);

                // 如果有命令，注册命令处理器
                if (plugin.commands?.length) {
                    plugin.logger?.debug(`注册了 ${plugin.commands.length} 个命令`);
                }

                // 设置插件状态为启用
                plugin.status = PluginStatus.ACTIVE;
                plugin.error = undefined;

                plugin.logger?.info(`插件已成功启用 ${plugin.version ? `v${plugin.version}` : ''}`);
                return true;
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                plugin.logger?.error(`初始化失败: ${error.message}`);
                if (error.stack) {
                    plugin.logger?.debug(`错误堆栈: ${error.stack}`);
                }

                plugin.status = PluginStatus.ERROR;
                plugin.error = error.message;
                return false;
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`启用插件 ${name} 时出错: ${error.message}`);
            return false;
        }
    }

    /**
     * 禁用插件
     * 安全地禁用插件，包括检查依赖关系、执行卸载回调和清理事件处理器
     * 
     * @param name 插件名称
     * @returns 是否成功禁用
     */
    async disablePlugin(name: string): Promise<boolean> {
        try {
            // 获取插件对象
            const plugin = this.plugins.get(name);

            // 检查插件是否存在
            if (!plugin) {
                log.warn(`插件 ${name} 未找到`);
                return false;
            }

            // 如果插件已经禁用，直接返回成功
            if (plugin.status === PluginStatus.DISABLED) {
                plugin.logger?.debug(`插件已处于禁用状态`);
                return true;
            }

            plugin.logger?.info(`正在禁用插件...`);

            // 检查其他插件依赖
            // 如果有其他启用的插件依赖于此插件，则无法禁用
            for (const [otherName, otherPlugin] of this.plugins.entries()) {
                // 跳过禁用状态的插件和当前插件自身
                if (otherPlugin.status !== PluginStatus.ACTIVE || otherName === name) {
                    continue;
                }

                // 如果另一个插件依赖此插件，无法禁用
                if (otherPlugin.dependencies?.includes(name)) {
                    plugin.logger?.warn(`无法禁用: 插件 ${otherName} 依赖于此插件`);
                    return false;
                }
            }

            // 执行禁用流程
            try {
                // 调用插件的卸载回调
                plugin.logger?.debug(`执行卸载回调...`);
                if (plugin.onUnload) {
                    await plugin.onUnload();
                }

                // 卸载事件处理器
                this.unregisterPluginEvents(plugin);

                // 更新插件状态
                plugin.status = PluginStatus.DISABLED;
                plugin.error = undefined;

                plugin.logger?.info(`插件已成功禁用`);
                return true;
            } catch (err) {
                // 捕获并处理卸载过程中的错误
                const error = err instanceof Error ? err : new Error(String(err));
                plugin.logger?.error(`禁用失败: ${error.message}`);
                if (error.stack) {
                    plugin.logger?.debug(`错误堆栈: ${error.stack}`);
                }

                // 更新插件状态为错误
                plugin.status = PluginStatus.ERROR;
                plugin.error = error.message;
                return false;
            }
        } catch (err) {
            // 捕获整个禁用流程中的错误
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`禁用插件 ${name} 时出错: ${error.message}`);
            return false;
        }
    }

    /**
     * 获取插件配置
     * 合并并返回插件的配置，按照以下优先级：
     * 1. 用户保存的配置（最高优先级）
     * 2. 传入的默认配置
     * 3. 空对象（最低优先级）
     * 
     * @param pluginName 插件名称
     * @param providedDefaultConfig 可选的默认配置对象
     * @returns 合并后的插件配置对象
     */
    async getPluginConfig<T extends Record<string, any>>(
        pluginName: string,
        providedDefaultConfig?: Partial<T>
    ): Promise<T> {
        // 1. 检查配置缓存
        if (this.pluginConfigs.has(pluginName)) {
            return this.pluginConfigs.get(pluginName) as T;
        }

        // 2. 使用传入的默认配置或空对象作为基础
        const baseDefaultConfig = providedDefaultConfig ?? {};
        let savedConfig: Partial<T> = {};

        // 3. 尝试读取保存的用户配置
        try {
            const configPath = path.join(this.configDir, `${pluginName}.json`);

            // 检查配置文件是否存在
            if (await pathUtils.fileExists(configPath)) {
                const content = await fs.readFile(configPath, 'utf-8');
                try {
                    // 解析JSON配置
                    savedConfig = JSON.parse(content) as Partial<T>;
                } catch (parseError) {
                    const pError = parseError instanceof Error ? parseError : new Error(String(parseError));
                    log.warn(`解析插件 ${pluginName} 配置文件失败: ${pError.message}。将使用默认配置。`);
                    // 解析失败时savedConfig保持为空对象
                }
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`读取插件 ${pluginName} 配置文件时出错: ${error.message}`);
            // 出错时savedConfig保持为空对象
        }

        // 4. 合并配置：默认配置 + 用户保存的配置
        // 使用深拷贝确保不修改原始默认配置对象
        const finalConfig = { ...structuredClone(baseDefaultConfig), ...savedConfig } as T;

        // 5. 缓存最终配置
        this.pluginConfigs.set(pluginName, finalConfig);

        return finalConfig;
    }

    /**
     * 保存插件配置
     * 将插件配置保存到文件系统并更新缓存
     * 
     * @param pluginName 插件名称
     * @param config 配置对象
     * @returns 是否保存成功
     */
    async savePluginConfig(pluginName: string, config: any): Promise<boolean> {
        try {
            // 1. 确保配置目录存在
            await this.ensureConfigDir();

            // 2. 构建配置文件路径
            const configPath = path.join(this.configDir, `${pluginName}.json`);

            // 3. 将配置对象序列化为JSON（格式化以便于查看和编辑）
            const configJson = JSON.stringify(config, null, 2);

            // 4. 写入配置文件
            await fs.writeFile(configPath, configJson, 'utf-8');

            // 5. 更新内存缓存
            this.pluginConfigs.set(pluginName, config);

            log.info(`插件 ${pluginName} 配置已保存`);
            return true;
        } catch (err) {
            // 错误处理
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`保存插件 ${pluginName} 配置失败: ${error.message}`);
            return false;
        }
    }

    /**
     * 处理事件分发
     * 根据事件类型和优先级，将事件分发给注册的处理器
     * 特点：
     * 1. 按优先级顺序处理，高优先级先执行
     * 2. 同一优先级的处理器并行执行
     * 3. 每个处理器都有超时保护
     * 4. 错误隔离，单个处理器错误不影响其他处理器
     * 
     * @param type 事件类型（'message'|'command'|'callback'）
     * @param context 事件上下文
     */
    private async handleEvent(type: string, context: EventContext) {
        const handlers = this.eventHandlers.get(type);
        if (!handlers || handlers.size === 0) return;

        try {
            // 优化：预先检查并缓存回调相关数据 - 减少每个处理器重复解析的成本
            let callbackData: string[] | undefined;
            if (type === 'callback' && context.type === 'callback') {
                const callbackContext = context as CallbackEventContext;
                if (callbackContext.data) {
                    callbackData = callbackContext.data.split(':');
                }
            }

            // 按优先级排序事件处理器（优先级高的先执行）
            // 优化：缓存排序结果，避免每次调用都重排
            // 添加类型验证，过滤掉无效的处理器
            const sortedHandlers = Array.from(handlers)
                .filter(handler => {
                    // 验证处理器格式是否正确
                    if (!handler || typeof handler !== 'object') {
                        log.error(`无效的事件处理器：非对象类型 (${type})`);
                        return false;
                    }
                    
                    // 验证handler属性是否为函数
                    if (typeof handler.handler !== 'function') {
                        log.error(`无效的事件处理器：handler不是函数 (${type})`);
                        return false;
                    }
                    
                    // 如果有name属性，确保它是字符串类型
                    if (handler.name !== undefined && typeof handler.name !== 'string') {
                        log.error(`无效的事件处理器：name不是字符串 (${type})`);
                        return false;
                    }
                    
                    // 确保priority是数字或未定义
                    if (handler.priority !== undefined && typeof handler.priority !== 'number') {
                        log.error(`无效的事件处理器：priority不是数字 (${type})`);
                        return false;
                    }
                    
                    return true;
                })
                .sort((a, b) => (b.priority || 0) - (a.priority || 0));

            // 将相同优先级的处理器分组，以便并行执行
            // 优化：使用Map而不是对象，提高性能
            const priorityGroups = new Map<number, PluginEvent[]>();

            // 优化：仅对可能匹配的处理器进行分组
            for (const handler of sortedHandlers) {
                // 优化：预先过滤：如果是回调事件，只考虑可能匹配的处理器
                if (type === 'callback' && handler.name && callbackData && callbackData.length >= 2) {
                    // 确保handler.name是一个有效的字符串
                    if (typeof handler.name !== 'string') {
                        log.error(`回调事件处理器name属性不是字符串: ${typeof handler.name}`);
                        continue;
                    }
                    
                    // 回调数据的第二部分是功能名，如果不匹配则跳过
                    if (callbackData[1] !== handler.name) {
                        continue;
                    }
                }

                // 应用常规过滤器（如果有）
                if (handler.filter && !handler.filter(context)) {
                    continue;
                }

                // 添加到对应优先级组
                const priority = handler.priority || 0;
                if (!priorityGroups.has(priority)) {
                    priorityGroups.set(priority, []);
                }
                priorityGroups.get(priority)!.push(handler);
            }

            // 获取所有优先级并排序（从高到低）
            const priorities = Array.from(priorityGroups.keys()).sort((a, b) => b - a);

            // 按优先级顺序处理，但每个优先级内部并行处理
            for (const priority of priorities) {
                const handlersInPriority = priorityGroups.get(priority)!;
                if (handlersInPriority.length === 0) continue;

                // 创建处理器的执行任务数组 - 提前包装好Promise以减少重复代码
                const tasks: Array<() => Promise<void>> = [];
                for (const handler of handlersInPriority) {
                    // 从对象池获取任务函数对象
                    const taskFn = this.getFromPool<() => Promise<void>>('eventTasks');
                    
                    // 重新定义任务函数内容
                    const origTaskFn = taskFn;
                    const newTaskFn = async () => {
                        try {
                            // 处理回调事件的name匹配和参数解析
                            let match: Record<string, any> | undefined;
                            if (type === 'callback' && context.type === 'callback' && callbackData && callbackData.length >= 2) {
                                const callbackContext = context as CallbackEventContext;

                                // 第一部分是插件名，第二部分是功能名
                                const pluginName = callbackData[0];
                                const actionType = callbackData[1];

                                // 解析参数（从第3个部分开始）
                                const paramParts = callbackData.slice(2);

                                // 从对象池获取match对象，避免频繁创建
                                match = this.getFromPool<Record<string, any>>('matchObjects');
                                
                                // 设置基础元数据
                                match._pluginName = pluginName;
                                match._actionType = actionType;

                                // 高效解析参数 - 一次性检查值并设置
                                for (let i = 0; i < paramParts.length; i++) {
                                    const value = paramParts[i];
                                    if (!value) continue; // 跳过空值

                                    // 参数名称
                                    const paramKey = `_param${i}`;

                                    // 自动判断参数类型 - 使用最简单的方式判断类型
                                    if (value === 'true') {
                                        match[paramKey] = true;
                                    } else if (value === 'false') {
                                        match[paramKey] = false;
                                    } else if (value.length > 0 && value.charAt(0) >= '0' && value.charAt(0) <= '9') {
                                        // 数字检查 - 使用简单检查替代正则表达式
                                        match[paramKey] = parseInt(value, 10);
                                    } else {
                                        match[paramKey] = value;
                                    }
                                }

                                // 设置match属性
                                callbackContext.match = match;
                            }

                            // 使用超时保护处理事件
                            const HANDLER_TIMEOUT = 10000; // 10秒超时
                            
                            // 查找插件名称以及处理器信息，用于错误日志
                            const pluginName = this.findPluginByEvent(handler) || '未知插件';
                            const handlerName = handler.name ? `${handler.name}` : '未命名处理器';
                            
                            // 包装处理器执行为Promise
                            const handlerPromise = handler.handler(context);
                            
                            // 设置超时控制
                            const timeoutPromise = new Promise<void>((_, reject) => {
                                setTimeout(() => {
                                    reject(new Error(`处理器执行超时(${HANDLER_TIMEOUT}ms)`));
                                }, HANDLER_TIMEOUT);
                            });

                            // 执行事件处理器（竞争超时）
                            await Promise.race([handlerPromise, timeoutPromise]);
                        } catch (err) {
                            // 捕获处理器中的错误
                            const error = err instanceof Error ? err : new Error(String(err));
                            
                            // 生成增强的错误信息
                            const errorDetails = this.enhanceErrorMessage(error, {
                                type: `优先级(${priority})事件处理错误`,
                                pluginName: this.findPluginByEvent(handler),
                                eventType: type,
                                eventContext: context
                            });
                            
                            log.error(`${errorDetails}: ${error.message}`);
                            
                            if (error.stack) {
                                log.debug(`错误堆栈: ${error.stack}`);
                            }
                        } finally {
                            // 任务完成后，回收match对象（如果是回调事件）
                            if (type === 'callback' && context.type === 'callback' && context.match) {
                                this.returnToPool('matchObjects', context.match);
                                (context as CallbackEventContext).match = undefined;
                            }
                            
                            // 任务函数完成后，返回到对象池
                            this.returnToPool('eventTasks', origTaskFn);
                        }
                    };
                    
                    // 替换任务函数内容
                    Object.defineProperty(taskFn, 'name', { value: `taskFn_${priority}_${handler.name || 'unnamed'}` });
                    Object.setPrototypeOf(newTaskFn, Object.getPrototypeOf(taskFn));
                    
                    for (const key of Object.keys(taskFn)) {
                        if (Object.prototype.hasOwnProperty.call(taskFn, key)) {
                            Object.defineProperty(newTaskFn, key, Object.getOwnPropertyDescriptor(taskFn, key)!);
                        }
                    }
                    
                    tasks.push(newTaskFn);
                }

                // 并行执行同一优先级的所有处理器
                try {
                    // 使用自定义的任务执行器替代简单的Promise.all
                    const promisesToComplete: Promise<void>[] = [];
                    
                    for (const task of tasks) {
                        // 立即执行任务但不等待完成
                        promisesToComplete.push(task());
                    }
                    
                    // 等待所有任务完成
                    await Promise.all(promisesToComplete);
                    
                    // 回收匹配对象
                    if (type === 'callback' && context.type === 'callback' && callbackData && callbackData.length >= 2) {
                        const callbackContext = context as CallbackEventContext;
                        const matchObject = callbackContext.match;
                        
                        // 将匹配对象归还到对象池
                        if (matchObject) {
                            this.returnToPool('matchObjects', matchObject);
                            callbackContext.match = undefined; // 避免引用已回收的对象
                        }
                    }
                } catch (err) {
                    // 捕获并记录错误，但不中断处理流程
                    const error = err instanceof Error ? err : new Error(String(err));
                    
                    // 创建更详细的错误日志
                    let errorDetails = `优先级 ${priority} 的事件处理组执行错误`;
                    
                    try {
                        // 尝试获取该优先级组中的插件信息
                        if (handlersInPriority && handlersInPriority.length > 0) {
                            const pluginNames = new Set<string>();
                            
                            // 收集可能的插件名称
                            for (const handler of handlersInPriority) {
                                const pluginName = this.findPluginByEvent(handler);
                                if (pluginName) {
                                    pluginNames.add(pluginName);
                                }
                            }
                            
                            if (pluginNames.size > 0) {
                                errorDetails += ` | 相关插件: ${Array.from(pluginNames).join(', ')}`;
                            }
                        }
                        
                        // 添加事件类型和上下文信息
                        errorDetails += ` | 事件类型: ${type}`;
                        
                        if (context) {
                            if (context.type === 'message' || context.type === 'command') {
                                const msgCtx = context as MessageEventContext | CommandContext;
                                const userId = msgCtx.message?.sender?.id || 'unknown';
                                errorDetails += ` | 用户ID: ${userId}`;
                            } else if (context.type === 'callback') {
                                const cbCtx = context as CallbackEventContext;
                                const userId = cbCtx.query?.user?.id || 'unknown';
                                errorDetails += ` | 用户ID: ${userId}`;
                                
                                if (callbackData && callbackData.length >= 2) {
                                    errorDetails += ` | 回调操作: ${callbackData[0]}:${callbackData[1]}`;
                                }
                            }
                        }
                        
                        // 检查特定错误类型
                        if (error.message.includes('description must be')) {
                            errorDetails += ` | 可能原因: 事件处理器使用了错误格式的Object.defineProperty`;
                        }
                    } catch (detailsErr) {
                        // 记录获取详细信息的失败
                        errorDetails += ` | 获取详细信息失败: ${String(detailsErr)}`;
                    }
                    
                    log.error(`${errorDetails}: ${error.message}`);
                    
                    // 记录完整堆栈以便调试
                    if (error.stack) {
                        log.debug(`错误堆栈: ${error.stack}`);
                    }
                }
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            
            // 尝试获取更多上下文信息以便更好地诊断问题
            let errorDetails = `事件分发处理错误 (类型: ${type})`;
            
            // 添加更详细的错误信息
            try {
                // 获取与上下文相关的信息
                if (context) {
                    if (context.type === 'message' || context.type === 'command') {
                        const msgCtx = context as MessageEventContext | CommandContext;
                        const userId = msgCtx.message?.sender?.id || 'unknown';
                        const chatId = msgCtx.chatId || 'unknown';
                        const content = msgCtx.type === 'command' 
                            ? msgCtx.command 
                            : (msgCtx.message?.text?.substring(0, 30) || 'unknown');
                            
                        errorDetails += ` | 用户: ${userId}, 聊天: ${chatId}, 内容: ${content}`;
                    } else if (context.type === 'callback') {
                        const cbCtx = context as CallbackEventContext;
                        const userId = cbCtx.query?.user?.id || 'unknown';
                        const chatId = cbCtx.chatId || 'unknown';
                        const data = cbCtx.data?.substring(0, 30) || 'unknown';
                        
                        errorDetails += ` | 用户: ${userId}, 聊天: ${chatId}, 回调数据: ${data}`;
                    }
                }
                
                // 尝试识别哪个插件导致了错误
                // 如果错误发生在特定的处理器内，应该可以从调用栈或已处理的插件中推断
                if (error.stack) {
                    // 检查是否有插件相关的堆栈信息
                    const pluginStack = error.stack.split('\n')
                        .find(line => line.includes('/plugins/'));
                        
                    if (pluginStack) {
                        // 提取插件名称
                        const pluginMatch = pluginStack.match(/\/plugins\/([^\/]+)/);
                        if (pluginMatch && pluginMatch[1]) {
                            errorDetails += ` | 可能的问题插件: ${pluginMatch[1]}`;
                        }
                    }
                }
                
                // 检查具体的错误类型和消息
                if (error.message.includes('description must be')) {
                    errorDetails += ` | 可能原因: 事件处理器定义错误，description属性类型不正确`;
                }
            } catch (detailsError) {
                // 如果获取详细信息时出错，记录原始错误
                errorDetails += ` | 无法获取更多信息: ${String(detailsError)}`;
            }
            
            // 记录错误信息
            log.error(errorDetails + `: ${error.message}`);
            
            // 记录完整堆栈以便调试
            if (error.stack) {
                log.debug(`错误堆栈: ${error.stack}`);
            }
        }
    }

    /**
     * 设置基础事件处理器
     * 注册所有基础的Telegram事件处理器，如消息、命令和回调查询等
     */
    private setupHandlers() {
        // 处理普通消息
        this.dispatcher.onNewMessage(
            filters.and(
                filters.or(
                    filters.chatId(enableChats),
                    filters.chatId(managerIds)
                ),
                filters.text
            ),
            async (ctx: MessageContext) => {
                try {
                    // 检查是否是命令
                    if (ctx.text?.startsWith('/')) {
                        await this.processCommand(ctx);
                        return;
                    }

                    // 创建消息事件上下文
                    const userId = ctx.sender.id

                    const context: MessageEventContext = {
                        type: 'message',
                        client: this.client,
                        chatId: ctx.chat.id,
                        message: ctx,
                        hasPermission: (permission) => this.hasPermission(userId, permission),
                    };

                    // 分发消息事件
                    await this.handleEvent('message', context);
                } catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    const userId = ctx.sender?.id || 'unknown';
                    const chatId = ctx.chat?.id || 'unknown';
                    const textPreview = ctx.text ? `${ctx.text.substring(0, 30)}${ctx.text.length > 30 ? '...' : ''}` : 'empty';

                    log.error(`消息处理错误 (用户: ${userId}, 聊天: ${chatId}, 文本: ${textPreview}): ${error.message}`);
                    if (error.stack) {
                        log.debug(`错误堆栈: ${error.stack}`);
                    }
                }
            }
        );

        // 处理回调查询
        this.dispatcher.onCallbackQuery(
            async (ctx: CallbackQueryContext) => {
                try {
                    const data = ctx.dataStr;
                    if (!data) return;

                    // 检查聊天ID是否允许
                    if (ctx.chat && (enableChats.length > 0 || managerIds.length > 0)) {
                        const chatId = ctx.chat.id;
                        if (!enableChats.includes(chatId) && !managerIds.includes(chatId)) {
                            return; // 聊天不在允许列表中
                        }
                    }

                    // 创建回调查询事件上下文
                    const context: CallbackEventContext = {
                        type: 'callback',
                        client: this.client,
                        chatId: ctx.chat.id,
                        query: ctx,
                        data,
                        hasPermission: (permission) => this.hasPermission(ctx.user.id, permission),
                        parseData: {
                            hasPrefix: (prefix) => data.startsWith(prefix),
                            getPart: (index) => data.split(':')[index],
                            getIntPart: (index, defaultValue = 0) => {
                                const part = data.split(':')[index];
                                return part ? parseInt(part, 10) || defaultValue : defaultValue;
                            },
                            getParts: () => data.split(':'),
                            getCommand: () => data.split(':')[0] || '',
                            getSubCommand: () => data.split(':')[1],
                            parseAsObject: <T>(schema: Record<string, 'int' | 'string' | 'boolean'>, startIndex = 1): T => {
                                const parts = data.split(':');
                                const result: Record<string, any> = {};

                                Object.entries(schema).forEach(([key, type], idx) => {
                                    const partIndex = startIndex + idx;
                                    const value = parts[partIndex];

                                    if (type === 'int') {
                                        result[key] = value ? parseInt(value, 10) || 0 : 0;
                                    } else if (type === 'boolean') {
                                        result[key] = value === 'true' || value === '1';
                                    } else {
                                        result[key] = value || '';
                                    }
                                });

                                return result as T;
                            }
                        }
                    };

                    // 分发回调查询事件
                    await this.handleEvent('callback', context);
                } catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    const userId = ctx.user.id;
                    const chatId = ctx.chat?.id || 'unknown';
                    const dataPreview = ctx.dataStr ? `${ctx.dataStr.substring(0, 30)}${ctx.dataStr.length > 30 ? '...' : ''}` : 'empty';

                    log.error(`回调查询处理错误 (用户: ${userId}, 聊天: ${chatId}, 数据: ${dataPreview}): ${error.message}`);
                    if (error.stack) {
                        log.debug(`错误堆栈: ${error.stack}`);
                    }

                    // 通知用户发生错误
                    await ctx.answer({
                        text: '❌ 系统错误',
                        alert: true
                    }).catch(() => { });
                }
            });
    }

    /**
     * 命令处理流程 - 第一层：队列管理与资源控制
     * 该方法负责:
     * 1. 管理用户命令队列，确保同一用户的命令按顺序处理
     * 2. 设置整体命令处理超时（3分钟）
     * 3. 清理资源（计时器、队列）
     * 4. 错误处理与传播
     * 
     * @param ctx 消息上下文
     */
    private async processCommand(ctx: MessageContext) {
        // 获取用户ID
        const userId = ctx.sender?.id;

        // 如果无法获取用户ID，直接处理
        if (!userId) {
            await this.executeCommandLogic(ctx);
            return;
        }
        
        // 优化：提前检查命令是否有效，避免无效命令占用队列
        const text = ctx.text;
        if (!text?.startsWith('/')) return;
        
        const commandParts = text.slice(1).trim().split(/\s+/);
        if (commandParts.length === 0 || !commandParts[0]) return;

        // 检查该用户是否有正在处理的命令
        const existingPromise = this.commandQueue.get(userId);
        if (existingPromise) {
            try {
                // 优化：设置超时等待，避免无限等待前一个命令
                const timeoutPromise = new Promise<void>((_, reject) => {
                    setTimeout(() => {
                        reject(new Error('等待前一个命令超时'));
                    }, 5000); // 5秒超时
                });
                
                // 等待前一个命令完成或超时
                await Promise.race([existingPromise, timeoutPromise]);
            } catch (err) {
                // 忽略前一个命令的错误，不影响当前命令处理
                log.debug(`前一个命令处理出错或等待超时，继续处理新命令: ${err}`);
            }
        }

        // 创建当前命令的Promise，并添加到队列
        let resolveFn: () => void = () => { };
        let rejectFn: (error: Error) => void = () => { };

        const commandPromise = new Promise<void>((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
        });

        // 添加创建时间戳，便于后续清理识别长时间未完成的命令
        (commandPromise as any).creationTime = Date.now();

        this.commandQueue.set(userId, commandPromise);

        try {
            // 创建一个超时Promise
            const timeoutId = setTimeout(() => {
                const messageText = ctx.text || '未知消息';
                const error = new Error(`用户 ${userId} 的命令处理超时: ${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}`);
                log.warn(error.message);
                rejectFn(error);
            }, this.COMMAND_TIMEOUT);

            // 执行命令逻辑
            await this.executeCommandLogic(ctx);

            // 清除超时计时器
            clearTimeout(timeoutId);

            // 命令处理完成
            resolveFn();
        } catch (err) {
            // 命令处理出错
            const error = err instanceof Error ? err : new Error(String(err));
            rejectFn(error);
            throw error; // 重新抛出以便调用者处理
        } finally {
            // 从队列中移除，如果当前处理的就是最新的
            if (this.commandQueue.get(userId) === commandPromise) {
                this.commandQueue.delete(userId);
            }
        }
    }

    /**
     * 命令处理流程 - 第二层：命令解析与执行
     * 该方法负责:
     * 1. 解析命令文本和参数
     * 2. 创建命令上下文对象
     * 3. 查找合适的命令处理器
     * 4. 检查权限和冷却时间
     * 5. 调用实际的命令处理函数
     * 6. 命令执行超时控制
     * 
     * @param ctx 消息上下文
     */
    private async executeCommandLogic(ctx: MessageContext) {
        try {
            const text = ctx.text;
            if (!text?.startsWith('/')) return;

            // 解析命令和参数
            const parts = text.slice(1).trim().split(/\s+/);
            if (parts.length === 0) return;

            const rawCommand = parts[0];
            if (!rawCommand) return;

            // 移除可能的机器人用户名后缀（如 /command@botname）
            const command = rawCommand.toLowerCase().replace(/@.*$/, '');
            const args = parts.slice(1);
            const content = args.join(' ');

            // 获取用户ID
            const userId = ctx.sender.id;

            // 首先检查用户命令频率限制 - 滑动窗口方法
            const rateLimitCheck = this.checkUserCommandRateLimit(userId);
            if (!rateLimitCheck.allowed) {
                // 用户发送命令过于频繁
                const remainingSecs = Math.ceil(rateLimitCheck.remainingMs / 1000);
                log.debug(`用户 ${userId} 命令频率超限，需等待 ${remainingSecs} 秒`);
                
                // 使用增强的错误消息机制
                const errorMessage = rateLimitCheck.reason || 
                    `⏱️ 命令发送过于频繁，请等待 ${remainingSecs} 秒后再试`;
                
                await ctx.replyText(errorMessage).catch(() => { });
                return;
            }

            // 记录命令执行时间
            this.updateUserCommandTime(userId);

            // 计算权限级别 (管理员=100，普通用户=0)
            const permissionLevel = userId && managerIds.includes(userId) ? 100 : 0;

            // 创建命令上下文
            const context: CommandContext = {
                type: 'command',
                client: this.client,
                chatId: ctx.chat.id,
                message: ctx,
                command,
                args,
                content,
                rawText: text,
                permissionLevel,
                hasPermission: (permission) => this.hasPermission(userId, permission),
            };

            // 查找命令处理器
            let commandHandlers = this.findCommandHandlers(command);

            // 如果没有找到命令处理器，直接返回
            if (commandHandlers.length === 0) {
                log.debug(`未找到命令处理器: ${command}`);
                return;
            }

            log.debug(`找到命令 ${command} 的处理器: ${commandHandlers.length} 个`);

            // 收集需要检查冷却的命令及其冷却时间
            const cooldownsToCheck = new Map<string, number>();
            for (const { cmd } of commandHandlers) {
                if (cmd.cooldown) {
                    cooldownsToCheck.set(cmd.name, cmd.cooldown);
                }
            }

            // 批量检查冷却状态
            let cooldownResults: Map<string, boolean> = new Map();
            if (cooldownsToCheck.size > 0 && userId) {
                cooldownResults = this.batchCheckCommandCooldown(userId, cooldownsToCheck);
            }

            // 优化命令的权限和冷却时间检查
            type CommandHandler = { plugin: BotPlugin, cmd: PluginCommand };
            let selectedHandler: CommandHandler | null = null;
            let cooldownInfo: { remainingSecs: number } | null = null;

            // 遍历所有命令处理器，找到第一个可执行的
            for (let i = 0; i < commandHandlers.length; i++) {
                const handler = commandHandlers[i] as CommandHandler;
                const { plugin, cmd } = handler;
                
                    // 检查权限
                    if (cmd.requiredPermission && !context.hasPermission(cmd.requiredPermission)) {
                    log.debug(`用户 ${userId} 缺少权限执行命令 ${command}: ${cmd.requiredPermission}`);
                    continue;
                    }

                    // 检查冷却时间
                    if (cmd.cooldown && userId) {
                    const canExecute = cooldownsToCheck.size > 0 ?
                        cooldownResults.get(cmd.name) ?? true :
                        this.checkCommandCooldown(userId, cmd.name, cmd.cooldown);
                        
                    if (!canExecute) {
                            const remainingSecs = this.getRemainingCooldown(userId, cmd.name, cmd.cooldown);
                        log.debug(`命令 ${command} (${cmd.name}) 冷却中，剩余时间: ${remainingSecs}s`);
                        
                        // 记录最短的冷却时间，用于后续反馈
                        if (!cooldownInfo || remainingSecs < cooldownInfo.remainingSecs) {
                            cooldownInfo = { remainingSecs };
                        }
                        
                        continue;
                    }
                }
                
                // 找到满足条件的处理器，立即选中并结束循环
                selectedHandler = handler;
                break;
            }

            // 如果没有找到可执行的处理器
            if (!selectedHandler) {
                // 如果存在冷却时间限制，反馈给用户
                if (cooldownInfo) {
                    await ctx.replyText(`⏱️ 命令冷却中，请等待 ${cooldownInfo.remainingSecs} 秒后再试`).catch(() => { });
                } else {
                    // 否则是权限问题
                    await ctx.replyText('❌ 你没有执行此命令的权限').catch(() => { });
                }
                return;
            }

            // 执行选中的命令
            const { plugin, cmd } = selectedHandler;

            try {
                // 执行命令
                log.info(`执行命令: ${command} (插件: ${plugin.name}), 用户: ${userId}`);

                // 使用Promise.race添加超时保护
                const timeoutPromise = new Promise<void>((_, reject) => {
                    setTimeout(() => {
                        reject(new Error(`命令 ${command} 执行超时 (插件: ${plugin.name})`));
                    }, this.COMMAND_TIMEOUT);
                });

                await Promise.race([
                    cmd.handler(context),
                    timeoutPromise
                ]);

                // 更新冷却时间
                if (cmd.cooldown && userId) {
                    this.updateCommandCooldown(userId, cmd.name);
                }

                // 更新用户全局命令执行时间
                this.updateUserCommandTime(userId);
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                log.error(`命令 ${command} 执行出错 (插件: ${plugin.name}, 用户: ${userId}, 聊天: ${context.chatId}, 参数: ${args.join(' ').substring(0, 30)}${args.join(' ').length > 30 ? '...' : ''}): ${error.message}`);
                if (error.stack) {
                    log.debug(`错误堆栈: ${error.stack}`);
                }

                await ctx.replyText(`❌ 命令执行出错: ${error.message}`).catch(() => { });
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            const messageText = ctx.text ? `${ctx.text.substring(0, 50)}${ctx.text.length > 50 ? '...' : ''}` : '未知消息';
            log.error(`命令处理错误 (用户: ${ctx.sender?.id || 'unknown'}, 聊天: ${ctx.chat?.id || 'unknown'}, 文本: ${messageText}): ${error.message}`);
            if (error.stack) {
                log.debug(`错误堆栈: ${error.stack}`);
            }
        }
    }

    /**
     * 查找命令处理器
     * 该方法会首先检查缓存，没有命中则遍历所有插件寻找匹配的命令
     * 结果会被缓存以提高后续查找性能
     * 优化版：减少对象创建，优化缓存管理，支持大量命令场景
     * 
     * @param command 命令名称（不含/前缀）
     * @returns 命令处理器数组，包含插件和命令信息
     */
    private findCommandHandlers(command: string): { plugin: BotPlugin, cmd: PluginCommand }[] {
        // 命令规范化为小写，确保大小写不敏感匹配
        const normalizedCommand = command.toLowerCase();

        // 1. 检查缓存是否有效
        const now = Date.now();

        // 缓存命中情况
        if (
            this.commandHandlersCache.has(normalizedCommand) &&
            now - this.commandCacheLastUpdated < this.COMMAND_CACHE_TTL
        ) {
            // 更新LRU缓存（不生成新数组，而是操作原有数组）
            this.updateRecentlyUsedCommands(normalizedCommand);
            return this.commandHandlersCache.get(normalizedCommand) || [];
        }

        // 2. 缓存未命中，需要查找处理器
        // 优化：使用预分配对象数组，避免频繁创建和垃圾回收
        const results: { plugin: BotPlugin, cmd: PluginCommand }[] = [];
        let resultCount = 0;

        // 3. 遍历所有插件查找匹配的命令或别名
        for (const plugin of this.plugins.values()) {
            // 跳过未启用的插件
            if (plugin.status !== PluginStatus.ACTIVE || !plugin.commands) {
                continue;
            }

            for (const cmd of plugin.commands) {
                // 命令名称匹配
                if (cmd.name.toLowerCase() === normalizedCommand) {
                    // 优先使用对象池获取处理器对象
                    const handler = this.getFromPool<{ plugin: BotPlugin, cmd: PluginCommand }>('commandHandlers');
                    handler.plugin = plugin;
                    handler.cmd = cmd;
                    results.push(handler);
                    resultCount++;
                    continue; // 找到后直接继续下一个命令
                }

                // 别名匹配
                if (cmd.aliases && Array.isArray(cmd.aliases)) {
                    for (const alias of cmd.aliases) {
                        if (alias.toLowerCase() === normalizedCommand) {
                            // 再次优先使用对象池
                            const handler = this.getFromPool<{ plugin: BotPlugin, cmd: PluginCommand }>('commandHandlers');
                            handler.plugin = plugin;
                            handler.cmd = cmd;
                            results.push(handler);
                            resultCount++;
                            break; // 找到别名后跳出别名循环
                        }
                    }
                }
            }
        }

        // 4. 更新缓存和最近使用命令记录
        if (resultCount > 0) {
            this.commandHandlersCache.set(normalizedCommand, results);
            this.updateRecentlyUsedCommands(normalizedCommand);
            this.commandCacheLastUpdated = now;
        }

        // 5. 根据插件加载顺序对结果进行排序
        // 优化：仅当存在多个结果时才排序
        if (resultCount > 1) {
            // 获取插件排序顺序，如果可用的话
            const pluginOrder = this.sortPluginsByDependencies();

            // 创建插件名称到顺序索引的映射，以便快速查找
            const orderMap = new Map<string, number>();
            pluginOrder.forEach((name, index) => {
                orderMap.set(name, index);
            });

            // 根据插件顺序排序结果
            results.sort((a, b) => {
                const orderA = orderMap.get(a.plugin.name) ?? Number.MAX_SAFE_INTEGER;
                const orderB = orderMap.get(b.plugin.name) ?? Number.MAX_SAFE_INTEGER;
                return orderA - orderB;
            });
        }

        return results;
    }

    /**
     * 更新最近使用的命令列表（LRU缓存策略）
     * 优化版本：更高效的内存使用，减少数组操作
     * 
     * @param command 命令名称
     */
    private updateRecentlyUsedCommands(command: string): void {
        // 查找命令在当前列表中的索引
        const existingIndex = this.recentlyUsedCommands.indexOf(command);

        // 如果命令已存在，从数组中移除
        if (existingIndex !== -1) {
            this.recentlyUsedCommands.splice(existingIndex, 1);
        }
        // 如果列表已满且命令不在当前列表中，移除最后一项并从缓存中删除
        else if (this.recentlyUsedCommands.length >= this.CACHE_MAX_SIZE) {
            const removed = this.recentlyUsedCommands.pop();
            if (removed) {
                this.commandHandlersCache.delete(removed);
            }
        }

        // 将命令添加到列表开头
        this.recentlyUsedCommands.unshift(command);
    }

    /**
     * 注册插件事件处理器
     * 将插件中定义的事件处理器添加到相应的事件类型集合中
     * 
     * @param plugin 要注册事件的插件对象
     */
    private registerPluginEvents(plugin: BotPlugin) {
        if (!plugin.events || plugin.events.length === 0) return;

        for (const event of plugin.events) {
            // 检查事件格式
            if (!event || typeof event !== 'object') {
                log.error(`插件 ${plugin.name} 注册了无效的事件处理器: 事件不是对象类型`);
                continue;
            }
            
            // 验证必须的属性
            if (!event.type) {
                log.error(`插件 ${plugin.name} 注册了无效的事件处理器: 缺少type属性`);
                continue;
            }
            
            if (typeof event.handler !== 'function') {
                log.error(`插件 ${plugin.name} 注册了无效的事件处理器: handler不是函数`);
                continue;
            }
            
            // 检查name属性（如果存在）
            if (event.name !== undefined && typeof event.name !== 'string') {
                log.error(`插件 ${plugin.name} 注册了无效的事件处理器: name属性必须是字符串，而不是 ${typeof event.name}`);
                continue;
            }
            
            // 检查优先级（如果存在）
            if (event.priority !== undefined && typeof event.priority !== 'number') {
                log.error(`插件 ${plugin.name} 注册了无效的事件处理器: priority必须是数字，而不是 ${typeof event.priority}`);
                continue;
            }

            const handlers = this.eventHandlers.get(event.type);
            if (handlers) {
                handlers.add(event);
                log.debug(`已注册插件 ${plugin.name} 的 ${event.type} 事件处理器`);
            } else {
                log.warn(`未知事件类型: ${event.type}，来自插件 ${plugin.name}`);
            }
        }
    }

    /**
     * 取消注册插件事件处理器
     * 从事件类型集合中移除指定插件的所有事件处理器
     * 通常在插件禁用或重载时调用
     * 
     * @param plugin 要取消注册事件的插件对象
     */
    private unregisterPluginEvents(plugin: BotPlugin) {
        if (!plugin.events || plugin.events.length === 0) return;

        for (const event of plugin.events) {
            const handlers = this.eventHandlers.get(event.type);
            if (handlers) {
                handlers.delete(event);
                log.debug(`已取消注册插件 ${plugin.name} 的 ${event.type} 事件处理器`);
            }
        }
    }

    /**
     * 加载插件
     * @param pluginName 插件名称或相对路径
     * @param autoEnable 是否自动启用
     * @returns 是否成功加载
     */
    async loadPlugin(pluginName: string, autoEnable: boolean = true): Promise<boolean> {
        // Note: This function uses dynamic import with a timestamp query parameter
        // to bypass the ESM cache when reloading plugins. This allows updates
        // but might lead to multiple module instances in memory if reloaded often.
        try {
            log.info(`开始加载插件: ${pluginName}`);

            // 处理可能包含子目录的路径 - 统一使用正斜杠
            const normalizedName = pathUtils.normalize(pluginName);
            log.debug(`标准化插件名: ${normalizedName}`);

            // 确定实际插件名称（无扩展名）
            let actualName = normalizedName;
            if (actualName.endsWith('.ts') || actualName.endsWith('.js')) {
                actualName = actualName.replace(/\.(ts|js)$/, '');
            }
            log.debug(`实际插件名: ${actualName}`);

            // 查找插件文件路径
            let pluginPath = '';

            // 尝试确定文件扩展名
            if (!normalizedName.endsWith('.ts') && !normalizedName.endsWith('.js')) {
                // 定义可能的扩展名列表，优先尝试.ts
                const possibleExts = ['.ts', '.js'];
                let found = false;

                for (const ext of possibleExts) {
                    // 尝试直接使用完整的相对路径（支持子目录结构）
                    const testPath = path.join(this.pluginsDir, `${normalizedName}${ext}`);

                    log.debug(`尝试查找插件文件: ${testPath}`);

                    if (await pathUtils.fileExists(testPath)) {
                        pluginPath = testPath;
                        found = true;
                        log.debug(`找到插件文件: ${testPath}`);
                        break;
                    }
                }

                // 如果没有找到直接匹配的文件，尝试查找子目录中的插件文件
                if (!found) {
                    const dirPath = path.join(this.pluginsDir, normalizedName);

                    // 检查是否存在该目录
                    if (await pathUtils.dirExists(dirPath)) {
                        log.debug(`检查子目录: ${dirPath}`);

                        try {
                            // 读取目录内容
                            const files = await fs.readdir(dirPath);
                            log.debug(`子目录中发现 ${files.length} 个文件`);

                            // 按照优先级排序文件列表（优先考虑.ts文件）
                            const sortedFiles = files.sort((a, b) => {
                                if (a.endsWith('.ts') && !b.endsWith('.ts')) return -1;
                                if (!a.endsWith('.ts') && b.endsWith('.ts')) return 1;
                                return 0;
                            });

                            // 检查目录中的每个文件
                            for (const file of sortedFiles) {
                                if (file.endsWith('.ts') || file.endsWith('.js')) {
                                    const fullPath = path.join(dirPath, file);

                                    log.debug(`尝试子目录中的文件: ${fullPath}`);

                                    // 验证是否是有效的插件文件
                                    if (await this.isValidPluginFile(fullPath)) {
                                        pluginPath = fullPath;
                                        found = true;
                                        log.debug(`在子目录中找到有效插件文件: ${fullPath}`);
                                        break;
                                    } else {
                                        log.debug(`${fullPath} 不是有效的插件文件`);
                                    }
                                }
                            }
                        } catch (err) {
                            const error = err instanceof Error ? err : new Error(String(err));
                            log.debug(`读取目录 ${dirPath} 失败: ${error.message}`);
                        }
                    } else {
                        log.debug(`子目录不存在: ${dirPath}`);
                    }
                }

                if (!found) {
                    log.warn(`找不到插件文件: ${normalizedName}，已检查直接匹配和子目录中的文件`);
                    return false;
                }
            } else {
                // 已经有扩展名，直接使用
                pluginPath = path.join(this.pluginsDir, normalizedName);
                if (!await pathUtils.fileExists(pluginPath)) {
                    log.warn(`找不到插件文件: ${pluginPath}`);
                    return false;
                }
                log.debug(`使用指定插件文件: ${pluginPath}`);
            }

            // 标准化最终路径（确保在所有平台上都使用正斜杠）
            pluginPath = pathUtils.normalize(pluginPath);
            log.debug(`最终插件路径: ${pluginPath}`);

            // 检查文件是否是有效插件
            if (!await this.isValidPluginFile(pluginPath)) {
                log.debug(`${pluginPath} 不是有效的插件文件，跳过加载`);
                return false;
            }

            // 如果已加载，先禁用
            if (this.plugins.has(actualName)) {
                log.info(`插件 ${actualName} 已存在，先禁用`);
                await this.disablePlugin(actualName);
                this.plugins.delete(actualName);
            }

            // 加载插件
            const success = await this.loadSinglePlugin(actualName, pluginPath, autoEnable);

            if (!success) {
                log.warn(`加载插件 ${pluginName} 失败`);
                return false;
            }

            return true;
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`加载插件 ${pluginName} 时出错: ${error.message}`);
            if (error.stack) {
                log.debug(`错误堆栈: ${error.stack}`);
            }
            return false;
        }
    }

    /**
     * 加载单个插件
     * @param name 插件名称或相对路径
     * @param pluginPath 插件路径
     * @param autoEnable 是否自动启用
     * @returns 是否成功加载
     */
    private async loadSinglePlugin(name: string, pluginPath: string, autoEnable: boolean = false): Promise<boolean> {
        try {
            log.info(`加载插件: ${pluginPath}`);

            // Use dynamic import with a timestamp to bypass cache
            // Node's import() generally handles file paths correctly across OS
            const importPathWithCacheBust = `${pluginPath}?update=${Date.now()}`;

            // 获取插件模块
            const module = await import(importPathWithCacheBust);
            const plugin: BotPlugin | undefined = module.default;

            // 由于scanPluginsDir已经过滤过，这里仅做一次基本验证
            if (!plugin || !plugin.name) {
                log.warn(`插件文件 ${name} 未导出有效插件对象`);
                return false;
            }

            // 为插件创建专用的日志记录器实例
            plugin.logger = log.forPlugin(plugin.name);

            // 注册时使用传入的名称（可能包含子目录）作为插件的标识符
            // 这样可以确保不同路径的插件被正确区分，即使它们的内部名称相同
            const registeredName = name;

            // 检查插件名称是否已经存在
            if (this.plugins.has(registeredName)) {
                log.warn(`插件 ${registeredName} 已加载，跳过`);
                return false;
            }

            // 设置默认状态
            plugin.status = PluginStatus.DISABLED;

            // 注册插件
            this.plugins.set(registeredName, plugin);
            plugin.logger.info(`成功加载插件: ${plugin.name} ${plugin.version || ''}`);

            // 注册插件的权限（如果有）
            if (plugin.permissions && plugin.permissions.length > 0) {
                try {
                    for (const permission of plugin.permissions) {
                        this.permissionManager.registerPermission(permission);
                    }
                    plugin.logger.debug(`注册了 ${plugin.permissions.length} 个权限`);
                } catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    plugin.logger.warn(`注册权限失败: ${error.message}`);
                }
            }

            // 自动启用插件(如果指定)
            if (autoEnable) {
                return await this.enablePlugin(registeredName, true);
            }

            return true;
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`加载插件 ${name} 失败: ${error.message}`);
            if (error.stack) {
                log.debug(`错误堆栈: ${error.stack}`);
            }
            return false;
        }
    }

    /**
     * 初始化功能管理器
     * @returns 是否成功初始化
     */
    async init(): Promise<boolean> {
        try {
            log.info('正在初始化功能管理器...');

            // 正确初始化Dispatcher
            this.dispatcher = Dispatcher.for(this.client);

            // 确保配置目录存在
            await this.ensureConfigDir();

            // 初始化权限管理器
            this.permissionManager = new PermissionManager(this.configDir);
            log.info('正在初始化权限管理器...');
            await this.permissionManager.init();
            log.info('权限管理器初始化完成');

            // 设置事件处理器
            this.setupHandlers();

            // 启动内存管理定时器
            this.startMemoryManagement();

            // 加载插件（权限管理器初始化后）
            log.info('开始加载插件...');
            await this.loadPlugins();

            log.info('功能管理器初始化完成');
            return true;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            log.error(`功能管理器初始化失败: ${err.message}`);
            if (err.stack) {
                log.debug(`错误堆栈: ${err.stack}`);
            }
            return false;
        }
    }

    /**
     * 重新加载所有插件
     * @returns 是否成功重新加载
     */
    async reload(): Promise<boolean> {
        try {
            log.info('正在重新加载所有插件...');

            // 保存当前启用的插件列表
            const enabledPlugins = Array.from(this.plugins.entries())
                .filter(([_, plugin]) => plugin.status === PluginStatus.ACTIVE)
                .map(([name]) => name);

            log.debug(`当前启用的插件: ${enabledPlugins.join(', ')}`);

            // 禁用所有插件
            for (const plugin of this.plugins.values()) {
                this.unregisterPluginEvents(plugin);
                if (plugin.onUnload) {
                    try {
                        await plugin.onUnload();
                    } catch (err) {
                        const error = err instanceof Error ? err : new Error(String(err));
                        log.error(`插件 ${plugin.name} 卸载回调执行失败: ${error.message}`);
                    }
                }
            }

            // 重新初始化事件分发器
            this.dispatcher = Dispatcher.for(this.client);
            this.eventHandlers.clear();
            this.eventHandlers.set('message', new Set());
            this.eventHandlers.set('command', new Set());
            this.eventHandlers.set('callback', new Set());

            // 清空插件列表
            this.plugins.clear();

            // 清理无用缓存
            this.commandHandlersCache.clear();
            this.recentlyUsedCommands.length = 0;
            this.commandCacheLastUpdated = Date.now();
            // 保留插件配置缓存，但清理命令冷却时间
            this.commandCooldowns.clear();

            // 重新加载插件
            await this.loadPlugins();

            // 重新启用之前启用的插件 (使用自动依赖加载)
            const enableResults = await Promise.all(
                enabledPlugins.map(async pluginName => {
                    const success = await this.enablePlugin(pluginName, true);
                    return { pluginName, success };
                })
            );

            const failedPlugins = enableResults
                .filter(r => !r.success)
                .map(r => r.pluginName);

            if (failedPlugins.length > 0) {
                log.warn(`以下插件启用失败: ${failedPlugins.join(', ')}`);
            }

            // 重新设置事件处理器
            this.setupHandlers();

            // 运行一次内存清理
            this.cleanupMemory();

            log.info('重新加载完成');
            return true;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            log.error(`重新加载失败: ${err.message}`);
            if (err.stack) {
                log.debug(`错误堆栈: ${err.stack}`);
            }
            return false;
        }
    }

    /**
     * 检查文件是否是有效的插件文件
     * @param filePath 文件路径
     * @returns 是否为有效插件文件
     * @private
     */
    private async isValidPluginFile(filePath: string): Promise<boolean> {
        try {
            // 首先检查文件是否存在
            if (!filePath || !await pathUtils.fileExists(filePath)) {
                log.debug(`文件不存在: ${filePath}`);
                return false;
            }

            log.debug(`验证插件文件: ${filePath}`);

            // Use dynamic import with a timestamp to bypass cache for checking
            const importPathWithCacheBust = `${filePath}?check=${Date.now()}`;

            // 尝试导入文件
            const module = await import(importPathWithCacheBust);

            // 检查是否有默认导出和必要属性
            const plugin = module.default;
            if (!plugin) {
                log.debug(`文件 ${filePath} 没有默认导出`);
                return false;
            }

            if (typeof plugin !== 'object') {
                log.debug(`文件 ${filePath} 的默认导出不是对象`);
                return false;
            }

            if (!plugin.name) {
                log.debug(`文件 ${filePath} 的插件对象没有name属性`);
                return false;
            }

            // 附加校验：确保事件和命令格式正确
            if (plugin.events) {
                if (!Array.isArray(plugin.events)) {
                    log.error(`插件 ${plugin.name || '未知'} 的events属性不是数组`);
                    return false;
                }
                
                // 检查每个事件对象格式
                for (const event of plugin.events) {
                    if (!event || typeof event !== 'object') {
                        log.error(`插件 ${plugin.name} 包含无效的事件对象: 不是对象类型`);
                        return false;
                    }
                    
                    if (!event.type) {
                        log.error(`插件 ${plugin.name} 包含无效的事件对象: 缺少type属性`);
                        return false;
                    }
                    
                    if (typeof event.handler !== 'function') {
                        log.error(`插件 ${plugin.name} 包含无效的事件对象: handler不是函数`);
                        return false;
                    }
                    
                    // 检查name属性类型（如果存在）
                    if (event.name !== undefined && typeof event.name !== 'string') {
                        log.error(`插件 ${plugin.name} 包含无效的事件对象: name属性必须是字符串，而不是 ${typeof event.name}`);
                        return false;
                    }
                }
            }
            
            if (plugin.commands) {
                if (!Array.isArray(plugin.commands)) {
                    log.error(`插件 ${plugin.name || '未知'} 的commands属性不是数组`);
                    return false;
                }
                
                // 检查每个命令对象格式
                for (const cmd of plugin.commands) {
                    if (!cmd || typeof cmd !== 'object') {
                        log.error(`插件 ${plugin.name} 包含无效的命令对象: 不是对象类型`);
                        return false;
                    }
                    
                    if (!cmd.name || typeof cmd.name !== 'string') {
                        log.error(`插件 ${plugin.name} 包含无效的命令对象: name不是字符串`);
                        return false;
                    }
                    
                    if (typeof cmd.handler !== 'function') {
                        log.error(`插件 ${plugin.name} 包含无效的命令对象: handler不是函数`);
                        return false;
                    }
                }
            }

            // 检查是否包含插件必要的功能
            const hasCommands = plugin.commands && Array.isArray(plugin.commands);
            const hasEvents = plugin.events && Array.isArray(plugin.events);
            const hasOnLoad = typeof plugin.onLoad === 'function';

            const hasPluginFeatures = hasCommands || hasEvents || hasOnLoad;

            if (!hasPluginFeatures) {
                log.debug(`文件 ${filePath} 的插件对象缺少必要功能属性(commands, events 或 onLoad)`);
                return false;
            }

            return true;
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            
            // 生成增强的错误信息
            const errorDetails = this.enhanceErrorMessage(error, {
                type: '插件文件验证失败',
                additionalInfo: `文件: ${filePath}`
            });
            
            log.error(`${errorDetails}: ${error.message}`);
            
            if (error.stack) {
                log.debug(`错误堆栈: ${error.stack}`);
            }
            
            return false;
        }
    }

    /**
     * 递归扫描目录，查找所有插件文件
     * @param dir 要扫描的目录
     * @returns 插件文件数组
     * @private
     */
    private async scanPluginsDir(dir: string): Promise<{ name: string; path: string }[]> {
        const results: { name: string; path: string }[] = [];

        // 检查参数有效性
        if (!dir) {
            log.warn('扫描目录路径不能为空');
            return results;
        }

        try {
            // 检查目录是否存在
            if (!await pathUtils.dirExists(dir)) {
                log.warn(`目录不存在: ${dir}`);
                return results;
            }

            // 读取目录内容
            const files = await fs.readdir(dir);

            // 调试日志 - 显示正在扫描的目录和找到的文件数
            log.debug(`扫描目录: ${dir}, 发现 ${files.length} 个项目`);

            // 并行处理所有文件和子目录，提高性能
            const processPromises = files.map(async (file) => {
                const fullPath = path.join(dir, file);
                const results: { name: string; path: string }[] = [];

                try {
                    // 检查是否是目录
                    const isDirectory = await pathUtils.dirExists(fullPath);

                    if (isDirectory) {
                        // 递归扫描子目录
                        const subDirPlugins = await this.scanPluginsDir(fullPath);
                        if (subDirPlugins.length > 0) {
                            log.debug(`在子目录 ${file} 中找到 ${subDirPlugins.length} 个插件`);
                            return subDirPlugins;
                        }

                        // 如果子目录中没有找到插件，尝试检查是否有插件文件
                        const dirFiles = await fs.readdir(fullPath);
                        for (const dirFile of dirFiles) {
                            if (dirFile.endsWith('.ts') || dirFile.endsWith('.js')) {
                                const pluginFilePath = path.join(fullPath, dirFile);
                                if (await this.isValidPluginFile(pluginFilePath)) {
                                    // 获取相对于插件根目录的路径
                                    const relativePath = path.relative(this.pluginsDir, pluginFilePath);
                                    // 统一使用正斜杠，并移除扩展名
                                    const pluginName = pathUtils.normalize(relativePath).replace(/\.(ts|js)$/, '');

                                    log.debug(`在目录 ${file} 中发现有效插件文件: ${pluginName} (${pluginFilePath})`);
                                    results.push({ name: pluginName, path: pluginFilePath });
                                }
                            }
                        }

                        if (results.length > 0) {
                            return results;
                        }
                    }
                    // 只处理.ts和.js文件
                    else if (file.endsWith('.ts') || file.endsWith('.js')) {
                        // 检查是否是实际的插件文件
                        if (await this.isValidPluginFile(fullPath)) {
                            // 是有效的插件文件
                            // 使用相对于插件根目录的路径作为名称
                            const relativePath = path.relative(this.pluginsDir, fullPath);
                            // 统一使用正斜杠，并移除扩展名
                            const pluginName = pathUtils.normalize(relativePath).replace(/\.(ts|js)$/, '');

                            log.debug(`发现有效插件: ${pluginName} (${fullPath})`);
                            return [{ name: pluginName, path: fullPath }];
                        } else {
                            log.debug(`跳过非插件文件: ${fullPath}`);
                        }
                    }
                    return []; // 如果不是目录或有效插件文件，返回空数组
                } catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    log.warn(`处理文件或目录时出错 ${fullPath}: ${error.message}`);
                    return []; // 出错时返回空数组
                }
            });

            // 等待所有处理完成
            const resultsArrays = await Promise.all(processPromises);

            // 合并所有结果
            for (const resultArray of resultsArrays) {
                if (resultArray && resultArray.length) {
                    results.push(...resultArray);
                }
            }

            // 记录此目录中找到的插件数量
            if (results.length > 0) {
                log.debug(`在目录 ${dir} 中找到 ${results.length} 个插件`);
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`读取目录 ${dir} 失败: ${error.message}`);
        }

        return results;
    }

    /**
     * 加载所有插件
     * @private
     */
    private async loadPlugins(): Promise<void> {
        const startTime = Date.now();
        log.info('开始加载插件...');

        try {
            // 检查是否为二进制环境 (兼容 Windows 的 .exe)
            const isBinaryEnvironment = process.execPath.endsWith('natsuki') || process.execPath.endsWith('natsuki.exe');

            if (isBinaryEnvironment) {
                log.info('检测到二进制环境，使用预编译插件...');
                await this.loadEmbeddedPlugins();
            } else {
                // 获取已安装的插件文件列表（包括子目录中的）
                const pluginDir = this.pluginsDir;

                // 扫描插件目录及其子目录
                const pluginFiles = await this.scanPluginsDir(pluginDir);

                if (pluginFiles.length === 0) {
                    log.warn('未找到任何插件文件');
                    return;
                }

                log.debug(`发现${pluginFiles.length}个插件文件`);

                // 第一阶段：并行加载所有插件
                log.info('阶段 1/2: 加载插件...');
                const loadStageStartTime = Date.now();

                const loadResults = await Promise.allSettled(
                    pluginFiles.map(async ({ name }) => {
                        const pluginStartTime = Date.now();
                        try {
                            // 先加载插件但不启用，只是为了获取依赖信息
                            const success = await this.loadPlugin(name, false);
                            const duration = Date.now() - pluginStartTime;

                            if (success) {
                                log.debug(`插件 ${name} 加载用时 ${duration}ms`);
                            } else {
                                log.warn(`插件 ${name} 加载失败，用时 ${duration}ms`);
                            }

                            return success;
                        } catch (err) {
                            const error = err instanceof Error ? err : new Error(String(err));
                            const duration = Date.now() - pluginStartTime;
                            log.error(`插件 ${name} 加载出错: ${error.message}，用时 ${duration}ms`);
                            return false;
                        }
                    })
                );

                // 计算有多少插件成功加载
                const loadedCount = loadResults.filter(
                    result => result.status === 'fulfilled' && result.value === true
                ).length;

                const loadStageDuration = Date.now() - loadStageStartTime;
                log.info(`成功加载 ${loadedCount}/${pluginFiles.length} 个插件，用时 ${loadStageDuration}ms`);
            }

            // 共用的启用插件逻辑
            await this.enableLoadedPlugins();
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`插件加载过程错误: ${error.message}`);
            if (error.stack) {
                log.debug(`错误堆栈: ${error.stack}`);
            }
        }
    }

    /**
     * 加载嵌入式预编译插件
     * @private
     */
    private async loadEmbeddedPlugins(): Promise<void> {
        const startTime = Date.now();
        log.info(`开始加载预编译插件，共 ${embeddedPluginsList.length} 个插件`);

        if (embeddedPluginsList.length === 0) {
            log.warn('没有找到预编译插件');
            return;
        }

        // 并行加载所有嵌入式插件
        const loadResults = await Promise.allSettled(
            embeddedPluginsList.map(async (name: string) => {
                const pluginStartTime = Date.now();
                try {
                    const plugin = embeddedPlugins.get(name);

                    if (!plugin) {
                        log.warn(`预编译插件 ${name} 不存在`);
                        return false;
                    }

                    // 设置默认状态
                    plugin.status = PluginStatus.DISABLED;

                    // 注册插件
                    this.plugins.set(name, plugin);

                    // 注册插件的权限（如果有）
                    if (plugin.permissions && plugin.permissions.length > 0) {
                        try {
                            for (const permission of plugin.permissions) {
                                this.permissionManager.registerPermission(permission);
                            }
                            log.debug(`为插件 ${name} 注册了 ${plugin.permissions.length} 个权限`);
                        } catch (err) {
                            const error = err instanceof Error ? err : new Error(String(err));
                            log.warn(`为插件 ${name} 注册权限失败: ${error.message}`);
                        }
                    }

                    const duration = Date.now() - pluginStartTime;
                    log.debug(`预编译插件 ${name} 加载用时 ${duration}ms`);

                    return true;
                } catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    const duration = Date.now() - pluginStartTime;
                    log.error(`预编译插件 ${name} 加载出错: ${error.message}，用时 ${duration}ms`);
                    return false;
                }
            })
        );

        // 计算有多少插件成功加载
        const loadedCount = loadResults.filter(
            (result: PromiseSettledResult<boolean>) => result.status === 'fulfilled' && result.value === true
        ).length;

        const loadDuration = Date.now() - startTime;
        log.info(`成功加载 ${loadedCount}/${embeddedPluginsList.length} 个预编译插件，用时 ${loadDuration}ms`);
    }

    /**
     * 启用已加载的插件
     * @private
     */
    private async enableLoadedPlugins(): Promise<void> {
        const startTime = Date.now();
        log.info('阶段 2/2: 启用插件...');

        const sortedPluginNames = this.sortPluginsByDependencies();

        // 根据依赖关系将插件分组
        const enableGroups: string[][] = [];
        const processed = new Set<string>();

        // 创建一个映射，记录每个插件的直接依赖
        const directDependencies = new Map<string, Set<string>>();

        // 收集每个插件的直接依赖
        for (const [name, plugin] of this.plugins.entries()) {
            if (!name || !plugin) continue;

            if (plugin.dependencies && plugin.dependencies.length > 0) {
                // 只记录系统中实际存在的依赖
                const existingDeps = plugin.dependencies.filter(dep => dep && this.plugins.has(dep));
                directDependencies.set(name, new Set(existingDeps));
            } else {
                directDependencies.set(name, new Set());
            }
        }

        // 最大循环次数，防止可能的无限循环
        const maxIterations = sortedPluginNames.length * 2;
        let iterations = 0;

        // 分批启用插件，每批中的插件可以并行启用
        while (processed.size < sortedPluginNames.length && iterations < maxIterations) {
            iterations++;
            const currentGroup: string[] = [];

            // 找出所有可以在当前批次启用的插件
            for (const name of sortedPluginNames) {
                if (!name || processed.has(name)) continue;

                const dependencies = directDependencies.get(name) || new Set();

                // 检查所有依赖是否已处理
                let allDepsProcessed = true;
                for (const dep of dependencies) {
                    if (!dep || !processed.has(dep)) {
                        allDepsProcessed = false;
                        break;
                    }
                }

                if (allDepsProcessed) {
                    currentGroup.push(name);
                }
            }

            if (currentGroup.length === 0) {
                // 如果没有可以启用的插件，说明可能存在循环依赖
                // 记录日志并中断循环
                const remaining = sortedPluginNames.filter(name => name && !processed.has(name));
                log.warn(`无法启用这些插件（可能存在循环依赖）: ${remaining.join(', ')}`);
                break;
            }

            // 将当前批次添加到启用组
            enableGroups.push(currentGroup);

            // 将当前批次标记为已处理
            for (const name of currentGroup) {
                if (name) processed.add(name);
            }
        }

        if (iterations >= maxIterations) {
            log.warn(`插件依赖解析达到最大迭代次数 (${maxIterations})，可能存在问题`);
        }

        // 逐批启用插件
        let totalEnabled = 0;

        for (const [groupIndex, group] of enableGroups.entries()) {
            log.debug(`启用插件组 ${groupIndex + 1}/${enableGroups.length}，包含 ${group.length} 个插件`);

            const groupStartTime = Date.now();

            // 并行启用当前批次的插件
            const enableResults = await Promise.allSettled(
                group.map(async pluginName => {
                    if (!pluginName) return false;

                    const plugin = this.plugins.get(pluginName);
                    if (!plugin || plugin.status === PluginStatus.ACTIVE) return true;

                    const pluginStartTime = Date.now();

                    try {
                        log.info(`启用插件: ${pluginName}`);
                        const success = await this.enablePlugin(pluginName, false);

                        const duration = Date.now() - pluginStartTime;
                        if (success) {
                            log.debug(`插件 ${pluginName} 启用成功，用时 ${duration}ms`);
                        } else {
                            log.warn(`插件 ${pluginName} 启用失败，用时 ${duration}ms`);
                        }

                        return success;
                    } catch (err) {
                        const error = err instanceof Error ? err : new Error(String(err));
                        const duration = Date.now() - pluginStartTime;
                        log.error(`启用插件 ${pluginName} 出错: ${error.message}，用时 ${duration}ms`);

                        if (plugin) {
                            plugin.status = PluginStatus.ERROR;
                            plugin.error = error.message;
                        }

                        return false;
                    }
                })
            );

            // 计算成功启用的插件数量
            const enabledCount = enableResults.filter(
                result => result.status === 'fulfilled' && result.value === true
            ).length;

            totalEnabled += enabledCount;

            const groupDuration = Date.now() - groupStartTime;
            log.debug(`插件组 ${groupIndex + 1} 启用完成: ${enabledCount}/${group.length} 成功，用时 ${groupDuration}ms`);
        }

        const enableStageDuration = Date.now() - startTime;
        log.info(`插件启用阶段完成，启用了 ${totalEnabled} 个插件，用时 ${enableStageDuration}ms`);

        // 统计加载的插件数量和状态
        const loadedPlugins = this.plugins.size;
        const activePlugins = Array.from(this.plugins.values()).filter(p => p && p.status === PluginStatus.ACTIVE).length;
        const errorPlugins = Array.from(this.plugins.values()).filter(p => p && p.status === PluginStatus.ERROR).length;
        const disabledPlugins = Array.from(this.plugins.values()).filter(p => p && p.status === PluginStatus.DISABLED).length;

        log.info(`插件加载完成。共加载 ${loadedPlugins} 个插件，${activePlugins} 个启用，${errorPlugins} 个错误，${disabledPlugins} 个禁用。`);
    }

    /**
     * 对插件进行拓扑排序，确保依赖在前，依赖者在后
     * 优化版：减少对象创建，提前检测循环依赖，使用更高效的集合操作
     * @returns 排序后的插件名称数组
     * @private
     */
    private sortPluginsByDependencies(): string[] {
        const visited = new Set<string>();
        const temp = new Set<string>();
        const order: string[] = [];
        const missingDeps = new Set<string>();
        const cycleDetected = { value: false }; // 使用对象引用而不是布尔值

        // 检测是否存在循环依赖 - 优化版：避免频繁数组创建和字符串连接
        const hasCycle = (pluginName: string, path: string[] = []): boolean => {
            if (!this.plugins.has(pluginName)) {
                missingDeps.add(pluginName);
                return false;
            }

            if (temp.has(pluginName)) {
                // 仅在首次检测到循环时创建和记录路径
                if (!cycleDetected.value) {
                const cycle = [...path, pluginName].join(' -> ');
                log.error(`⚠️ 检测到循环依赖: ${cycle}`);
                    cycleDetected.value = true;
                }
                return true;
            }

            if (visited.has(pluginName)) return false;

            const plugin = this.plugins.get(pluginName)!;
            if (!plugin.dependencies || plugin.dependencies.length === 0) return false;

            temp.add(pluginName);

            let hasCycleFound = false;
            // 优化：减少递归调用中的数组创建
            const newPath = path.length > 0 ? [...path, pluginName] : [pluginName];

            for (const dep of plugin.dependencies) {
                if (hasCycle(dep, newPath)) {
                    hasCycleFound = true;
                    // 如果已经找到循环，终止检查
                    if (cycleDetected.value) break;
                }
            }

            temp.delete(pluginName);
            return hasCycleFound;
        };

        // 深度优先搜索进行拓扑排序
        const visit = (pluginName: string): void => {
            if (visited.has(pluginName)) return;
            if (!this.plugins.has(pluginName)) {
                missingDeps.add(pluginName);
                log.warn(`⚠️ 未找到依赖项: ${pluginName}`);
                return;
            }

            temp.add(pluginName);

            const plugin = this.plugins.get(pluginName)!;
            if (plugin.dependencies && plugin.dependencies.length > 0) {
                // 处理依赖项
                for (const dep of plugin.dependencies) {
                    // 优化：避免重复检查
                    if (visited.has(dep)) continue;
                        if (temp.has(dep)) {
                        // 避免多次记录同一循环依赖
                        if (!cycleDetected.value) {
                            log.error(`⚠️ 循环依赖: ${pluginName} 和 ${dep}`);
                            cycleDetected.value = true;
                        }
                            continue;
                        }
                        if (!this.plugins.has(dep)) {
                            missingDeps.add(dep);
                            log.warn(`⚠️ 插件 ${pluginName} 依赖未找到的插件 ${dep}`);
                            continue;
                        }
                        visit(dep);
                }
            }

            temp.delete(pluginName);
            visited.add(pluginName);
            order.push(pluginName);
        };

        // 优化：减少大型插件集合的重复遍历
        const pluginNames = [...this.plugins.keys()];

        // 先检查循环依赖
        for (const name of pluginNames) {
            if (hasCycle(name)) {
                // 如果已检测到循环，停止进一步检查
                if (cycleDetected.value) break;
            }
        }

        if (cycleDetected.value) {
            log.warn('⚠️ 检测到循环依赖，插件可能无法正常加载');
        }

        // 对所有插件进行排序
        for (const name of pluginNames) {
            if (!visited.has(name)) {
                visit(name);
            }
        }

        // 输出排序后的插件加载顺序
        if (order.length > 0) {
            // 避免昂贵的字符串拼接
            log.debug(`插件加载顺序: ${order.join(' -> ')}`);
        }

        // 警告缺失的依赖
        if (missingDeps.size > 0) {
            log.warn(`⚠️ 缺失的依赖项: ${Array.from(missingDeps).join(', ')}，这些依赖项的插件可能无法正常工作`);
        }

        return order;
    }

    /**
     * 检查命令冷却时间
     * 判断用户是否可以执行指定的命令，基于冷却时间限制
     * 同时会清理过期的冷却记录，优化内存使用
     * 优化版：清理过期记录时将Map对象归还到对象池
     * 
     * @param userId 用户ID
     * @param command 命令名称
     * @param cooldownSeconds 冷却时间（秒）
     * @returns 如果可以执行则返回true，否则返回false
     */
    private checkCommandCooldown(userId: number, command: string, cooldownSeconds: number): boolean {
        // 快速路径：无效的参数直接允许执行
        if (!userId || !command || cooldownSeconds <= 0) {
            return true;
        }

        const userCooldowns = this.commandCooldowns.get(userId);
        if (!userCooldowns) {
            return true; // 用户没有冷却记录
        }

        const lastTimestamp = userCooldowns.get(command);
        if (!lastTimestamp) {
            return true; // 此命令没有冷却记录
        }

        const now = Date.now();
        const elapsedMillis = now - lastTimestamp;
        const cooldownMillis = cooldownSeconds * 1000;

        // 冷却已过期，清理记录
        if (elapsedMillis >= cooldownMillis) {
            userCooldowns.delete(command);
            // 如果用户没有其他冷却记录，回收Map对象
            if (userCooldowns.size === 0) {
                this.returnToPool('cooldownMaps', userCooldowns);
                this.commandCooldowns.delete(userId);
            }
            return true;
        }

        return false; // 仍在冷却中
    }

    /**
     * 获取命令剩余冷却时间（秒）
     * 优化版：添加参数检查避免无效计算
     * 
     * @param userId 用户ID
     * @param command 命令名称
     * @param cooldownSeconds 总冷却时间
     * @returns 剩余冷却秒数，如果不在冷却中则返回0
     */
    private getRemainingCooldown(userId: number, command: string, cooldownSeconds: number): number {
        // 快速路径：检查无效参数
        if (!userId || !command || cooldownSeconds <= 0) {
            return 0;
        }

        const userCooldowns = this.commandCooldowns.get(userId);
        if (!userCooldowns) return 0;

        const lastTimestamp = userCooldowns.get(command);
        if (!lastTimestamp) return 0;

        const now = Date.now();
        const elapsedMillis = now - lastTimestamp;
        const cooldownMillis = cooldownSeconds * 1000;
        const remainingMillis = cooldownMillis - elapsedMillis;

        // 使用Math.max确保不返回负值
        return remainingMillis > 0 ? Math.ceil(remainingMillis / 1000) : 0;
    }

    /**
     * 更新命令冷却时间
     * 记录用户执行命令的时间戳，用于冷却时间检查
     * 如果记录已存在则更新时间戳，否则添加新记录
     * 优化版：使用对象池来减少Map对象的创建，降低GC压力
     * 进一步优化：添加参数检查、时间缓存和预分配Map大小
     * 
     * @param userId 用户ID
     * @param command 命令名称
     */
    private updateCommandCooldown(userId: number, command: string): void {
        // 参数检查
        if (!userId || !command) {
            return; // 无效参数，直接返回
        }

        // 使用缓存的时间戳减少Date.now()调用
        // 只有当时间戳未初始化或距离上次更新超过100ms才重新获取
        if (!this.currentTimestamp || Date.now() - this.currentTimestamp > 100) {
            this.currentTimestamp = Date.now();
        }

        let userCooldowns = this.commandCooldowns.get(userId);
        if (!userCooldowns) {
            // 从对象池获取Map对象，而不是创建新的
            userCooldowns = this.getFromPool<Map<string, number>>('cooldownMaps');
            this.commandCooldowns.set(userId, userCooldowns);
        }
        userCooldowns.set(command, this.currentTimestamp);
    }

    /**
     * 启动内存管理系统
     * 定期清理过期的缓存和未使用的数据，优化内存使用
     * 增强版：自适应清理频率，根据内存压力动态调整
     */
    private startMemoryManagement(): void {
        // 清除可能存在的旧定时器
        if (this.memoryCleanupTimer) {
            clearInterval(this.memoryCleanupTimer);
            this.memoryCleanupTimer = undefined;
        }

        // 初始内存检查：决定清理频率
        const initialMemCheck = process.memoryUsage();
        const initialHeapUsage = initialMemCheck.heapUsed / initialMemCheck.heapTotal;

        // 根据初始堆使用率设置清理间隔
        // 堆使用率更高时，更频繁地清理（最短2分钟，最长10分钟）
        let cleanupInterval = this.MEMORY_CLEANUP_INTERVAL;

        if (initialHeapUsage > 0.7) {
            // 高内存压力: 2分钟清理一次
            cleanupInterval = 120000;
            log.info(`检测到高内存使用率(${(initialHeapUsage * 100).toFixed(1)}%)，设置高频清理间隔(${cleanupInterval / 60000}分钟)`);
        } else if (initialHeapUsage < 0.4) {
            // 低内存压力: 10分钟清理一次
            cleanupInterval = 600000;
            log.info(`检测到低内存使用率(${(initialHeapUsage * 100).toFixed(1)}%)，设置低频清理间隔(${cleanupInterval / 60000}分钟)`);
        } else {
            // 中等内存压力: 5分钟清理一次 (默认值)
            log.info(`检测到中等内存使用率(${(initialHeapUsage * 100).toFixed(1)}%)，使用默认清理间隔(${cleanupInterval / 60000}分钟)`);
        }

        // 使用变量存储上次清理时间，用于判断是否需要动态调整间隔
        let lastCleanupTime = Date.now();
        let consecutiveHighPressure = 0;

        // 创建清理函数，方便后续重用
        const cleanupFunction = () => {
            try {
                const now = Date.now();
                log.debug('执行内存优化清理...');

                // 获取当前内存使用情况来决定清理模式
                const memUsage = process.memoryUsage();
                const heapUsage = memUsage.heapUsed / memUsage.heapTotal;

                // 根据内存压力决定是否进行积极清理
                const aggressive = heapUsage > 0.8 || consecutiveHighPressure >= 3;

                if (heapUsage > 0.7) {
                    consecutiveHighPressure++;
                } else {
                    consecutiveHighPressure = 0;
                }

                // 执行内存清理
                this.cleanupMemory(aggressive);

                // 检查是否需要调整清理频率
                if (now - lastCleanupTime > 1800000) { // 30分钟检查一次
                    lastCleanupTime = now;

                    // 内存压力持续较高，减少清理间隔
                    if (heapUsage > 0.75) {
                        const newInterval = Math.max(120000, cleanupInterval - 60000);
                        if (newInterval < cleanupInterval) {
                            log.info(`内存压力持续较高(${(heapUsage * 100).toFixed(1)}%)，减少清理间隔: ${cleanupInterval / 60000}→${newInterval / 60000}分钟`);

                            clearInterval(this.memoryCleanupTimer);
                            cleanupInterval = newInterval;
                            this.memoryCleanupTimer = setInterval(cleanupFunction, cleanupInterval);
                        }
                    }
                    // 内存压力持续较低，增加清理间隔
                    else if (heapUsage < 0.4 && consecutiveHighPressure === 0) {
                        const newInterval = Math.min(600000, cleanupInterval + 60000);
                        if (newInterval > cleanupInterval) {
                            log.info(`内存压力持续较低(${(heapUsage * 100).toFixed(1)}%)，增加清理间隔: ${cleanupInterval / 60000}→${newInterval / 60000}分钟`);

                            clearInterval(this.memoryCleanupTimer);
                            cleanupInterval = newInterval;
                            this.memoryCleanupTimer = setInterval(cleanupFunction, cleanupInterval);
                        }
                    }
                }

                // 进行内存使用检查
                this.checkMemoryUsage();
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                log.error(`内存清理过程发生错误: ${error.message}`);
            }
        };

        // 设置定时清理任务
        this.memoryCleanupTimer = setInterval(cleanupFunction, cleanupInterval);

        // 添加一次立即清理，但延迟10秒执行，避免启动时资源竞争
        setTimeout(() => this.cleanupMemory(), 10000);
    }

    /**
     * 检查内存使用量并进行主动优化
     * 根据内存使用情况触发不同级别的内存清理和优化
     */
    private checkMemoryUsage(): void {
        try {
            // 获取当前内存使用情况
            const memoryUsage = process.memoryUsage();
            const rss = memoryUsage.rss;
            const heapTotal = memoryUsage.heapTotal;
            const heapUsed = memoryUsage.heapUsed;
            
            // 计算内存增长率
            const now = Date.now();
            const elapsed = now - this.lastMemoryCheck;
            
            // 检查是否需要记录内存用量历史
            if (elapsed > this.MEMORY_HISTORY_INTERVAL) {
                // 保存当前内存使用到历史记录中
                this.memoryHistory.push({
                    timestamp: now,
                    rss,
                    heapTotal,
                    heapUsed
                });
                
                // 保持历史记录在合理范围内
                if (this.memoryHistory.length > this.MEMORY_HISTORY_MAX_SIZE) {
                    this.memoryHistory.shift();
                }
                
                this.lastMemoryCheck = now;
            }
            
            // 多级内存阈值检查
            let cleanupLevel = 0;
            const MB = 1024 * 1024;
            
            // 轻度清理阈值 (300MB)
            if (heapUsed > 300 * MB) {
                cleanupLevel = 1;
            }
            
            // 中度清理阈值 (500MB)
            if (heapUsed > 500 * MB) {
                cleanupLevel = 2;
            }
            
            // 重度清理阈值 (800MB)
            if (heapUsed > 800 * MB) {
                cleanupLevel = 3;
            }
            
            // 危险级别清理阈值 (1200MB)
            if (heapUsed > 1200 * MB) {
                cleanupLevel = 4;
            }
            
            // 检查内存增长率，可能表明存在内存泄漏
            if (this.memoryHistory.length >= 2) {
                const oldest = this.memoryHistory[0];
                const newest = this.memoryHistory[this.memoryHistory.length - 1];
                
                // 确保记录存在并且有效
                if (oldest && newest) {
                    const timeDiffHours = (newest.timestamp - oldest.timestamp) / 3600000;

                    if (timeDiffHours > 0) {
                        const heapGrowthMB = (newest.heapUsed - oldest.heapUsed) / (1024 * 1024);
                        const rssGrowthMB = (newest.rss - oldest.rss) / (1024 * 1024);
                        const growthRateMB = heapGrowthMB / timeDiffHours;

                        log.info(`内存增长分析: ${timeDiffHours.toFixed(1)}小时内堆内存增长 ${heapGrowthMB.toFixed(2)}MB (${growthRateMB.toFixed(2)}MB/小时), RSS增长 ${rssGrowthMB.toFixed(2)}MB`);

                        if (growthRateMB > 50) {
                            log.warn(`内存增长率较高: ${growthRateMB.toFixed(2)}MB/小时，可能存在内存泄漏`);
                        }
                    }
                }
            }
            
            // 根据清理级别执行相应的清理操作
            if (cleanupLevel > 0) {
                log.info(`内存使用: ${(heapUsed / MB).toFixed(2)}MB / ${(heapTotal / MB).toFixed(2)}MB (RSS: ${(rss / MB).toFixed(2)}MB) - 执行级别${cleanupLevel}清理`);
                
                // 执行级别对应的清理操作 - 传递布尔值表示是否强制清理
                this.cleanupMemory(cleanupLevel === 4); // 仅在最高级别时强制清理
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            
            // 使用增强的错误消息
            const errorDetails = this.enhanceErrorMessage(error, {
                type: '内存使用检查错误',
                additionalInfo: `当前时间: ${new Date().toISOString()}`
            });
            
            log.error(`${errorDetails}: ${error.message}`);
            
            if (error.stack) {
                log.debug(`错误堆栈: ${error.stack}`);
            }
        }
    }

    /**
     * 全面内存清理方法
     * 根据不同的内存压力级别执行不同强度的清理策略
     * 增强版：添加更彻底的内存释放逻辑
     * 
     * @param aggressive 是否执行更积极的内存清理
     */
    public cleanupMemory(aggressive: boolean = false): void {
        const startTime = Date.now();

        try {
            // 1. 清理命令冷却记录
            const cooldownsRemoved = this.cleanupCommandCooldowns() || 0;

            // 2. 清理命令处理器缓存
            const cacheEntriesRemoved = this.cleanupCommandCache() || 0;

            // 3. 清理命令队列中悬挂的请求
            const queueEntriesRemoved = this.cleanupCommandQueue() || 0;

            // 4. 清理插件配置缓存（仅保留活跃插件的配置）
            const configEntriesRemoved = this.cleanupPluginConfigCache() || 0;

            // 5. 清理过期的用户命令时间记录
            const userTimesRemoved = this.cleanupUserCommandTimes() || 0;
            
            // 6. 清理过期的用户命令历史和临时封禁记录
            const commandHistoryRemoved = this.cleanupCommandHistory() || 0;

            // 7. 积极模式下执行额外清理
            if (aggressive) {
                // 7.1 清除所有命令缓存
                const cacheSize = this.commandHandlersCache.size;
                if (cacheSize > 0) {
                    this.commandHandlersCache.clear();
                    this.recentlyUsedCommands.length = 0;
                    this.commandCacheLastUpdated = Date.now();
                    log.debug(`积极清理: 清空所有命令处理器缓存 (${cacheSize} 个条目)`);
                }

                // 7.2 清理对象池，减少最大占用内存
                const poolCleaned = this.optimizeObjectPools(true);
                if (poolCleaned > 0) {
                    log.debug(`积极清理: 优化了对象池，移除了 ${poolCleaned} 个对象`);
                }
                
                // 7.3 重置所有临时封禁用户
                if (this.tempBannedUsers.size > 0) {
                    const bannedCount = this.tempBannedUsers.size;
                    this.tempBannedUsers.clear();
                    log.debug(`积极清理: 重置所有临时封禁用户 (${bannedCount} 个用户)`);
                }

                // 7.4 尝试运行垃圾回收（如果可用）
                if (global.gc) {
                    try {
                        log.debug('执行JavaScript垃圾回收');
                        global.gc();
                        
                        // 垃圾回收后捕获内存使用情况
                        const memAfterGC = process.memoryUsage();
                        const heapUsedAfterGC = memAfterGC.heapUsed / (1024 * 1024);
                        log.debug(`垃圾回收后堆内存: ${heapUsedAfterGC.toFixed(2)} MB`);
                    } catch (err) {
                        // 忽略GC错误
                    }
                }
            }

            // 记录内存清理统计
            const totalRemoved = cooldownsRemoved + cacheEntriesRemoved +
                queueEntriesRemoved + configEntriesRemoved + userTimesRemoved + commandHistoryRemoved;

            // 记录内存使用情况
            this.logMemoryUsage(aggressive ? '积极清理后' : '常规清理后');

            // 记录执行时间和清理统计
            const duration = Date.now() - startTime;
            if (totalRemoved > 0) {
                log.info(`内存清理完成，移除了 ${totalRemoved} 个对象，耗时 ${duration}ms ${aggressive ? '(积极模式)' : ''}`);
            } else {
                log.debug(`内存清理完成，没有需要清理的对象，耗时 ${duration}ms ${aggressive ? '(积极模式)' : ''}`);
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`内存清理过程发生错误: ${error.message}`);
        }
    }

    /**
     * 记录当前内存使用情况
     * 优化版：更高效地收集和格式化内存统计信息
     * @param prefix 日志前缀
     */
    private logMemoryUsage(prefix: string = '当前'): void {
        try {
            // 使用缓存的时间戳
            if (!this.currentTimestamp || Date.now() - this.currentTimestamp > 100) {
                this.currentTimestamp = Date.now();
            }
            
            // 获取内存使用信息
            const mem = process.memoryUsage();
            
            // 格式化内存数值的函数，在闭包内定义避免重复创建
            const formatMemory = (bytes: number): string => {
                return (bytes / 1024 / 1024).toFixed(2) + ' MB';
            };

            // 计算内存百分比 - 使用更高效的直接计算
            const heapPercent = Math.min(100, (mem.heapUsed / mem.heapTotal) * 100).toFixed(1);
            
            // 格式化内存指标并创建日志记录
            const memoryInfo = {
                heapUsed: formatMemory(mem.heapUsed),
                heapTotal: formatMemory(mem.heapTotal),
                rss: formatMemory(mem.rss),
                external: formatMemory(mem.external || 0),
                heapPercent: `${heapPercent}%`
            };
            
            // 组合主要内存信息
            log.info(`${prefix}内存使用: 堆 ${memoryInfo.heapUsed}/${memoryInfo.heapTotal} (${memoryInfo.heapPercent}), RSS ${memoryInfo.rss}, 外部 ${memoryInfo.external}`);

            // 优化：避免重复遍历Map收集统计信息
            // 计算在冷却Map中的总条目数
            let totalCooldowns = 0;
            let userCooldownEntries = 0;
            for (const userMap of this.commandCooldowns.values()) {
                userCooldownEntries++;
                totalCooldowns += userMap.size;
            }
            
            // 计算命令历史条目数
            let totalCommandHistory = 0;
            let userCommandHistoryEntries = 0;
            for (const history of this.userCommandHistory.values()) {
                userCommandHistoryEntries++;
                totalCommandHistory += history.length;
            }
            
            // 收集统计信息 - 避免重复调用size属性
            const pluginCount = this.plugins.size;
            
            // 计算事件处理器数量
            let totalEventHandlers = 0;
            for (const handlers of this.eventHandlers.values()) {
                totalEventHandlers += handlers.size;
            }
            
            // 组合缓存统计信息
            const stats = {
                plugins: pluginCount,
                eventHandlers: totalEventHandlers,
                cooldowns: `${totalCooldowns}/${userCooldownEntries}用户`,
                configCache: this.pluginConfigs.size,
                commandCache: this.commandHandlersCache.size,
                commandQueue: this.commandQueue.size,
                userCommandTimes: this.userLastCommandTime.size,
                commandHistory: `${totalCommandHistory}/${userCommandHistoryEntries}用户`,
                tempBans: this.tempBannedUsers.size,
                suspiciousUsers: `${this.suspiciousUsers.size}用户/${this.suspiciousTriggerCount.size}计数`
            };

            // 使用模板字符串简化日志输出
            log.debug(`缓存统计 - 插件: ${stats.plugins}, 事件处理器: ${stats.eventHandlers}, ` +
                `冷却记录: ${stats.cooldowns}, 命令缓存: ${stats.commandCache}, ` +
                `配置缓存: ${stats.configCache}, 命令队列: ${stats.commandQueue}, ` + 
                `用户命令时间记录: ${stats.userCommandTimes}, ` +
                `命令历史: ${stats.commandHistory}, ` +
                `临时封禁: ${stats.tempBans}, 可疑用户: ${stats.suspiciousUsers}`);
                
            // 高内存压力警告
            if ((mem.heapUsed / mem.heapTotal) > 0.85) {
                log.warn(`⚠️ 高内存压力: 堆占用率 ${heapPercent}%, 考虑执行积极清理`);
            }
        } catch (err) {
            // 处理错误，避免中断操作
            const error = err instanceof Error ? err : new Error(String(err));
            log.warn(`获取内存使用情况失败: ${error.message}`);
        }
    }

    /**
     * 清理所有过期的命令冷却记录
     * 优化版：更高效地处理冷却时间并减少临时对象创建
     * 性能增强：
     * 1. 使用循环复用数组而不是为每个用户创建新数组
     * 2. 更高效的Map操作和冷却记录清理
     * 3. 预分配数组避免频繁扩容
     * 
     * @returns 清理的过期记录数量
     */
    private cleanupCommandCooldowns(): number {
        // 更新缓存的时间戳
        this.currentTimestamp = Date.now();
        const now = this.currentTimestamp;

        let removedCount = 0;
        let pooledMapsCount = 0;

        // 获取用户数量，用于预估数组大小
        const userCount = this.commandCooldowns.size;
        if (userCount === 0) return 0; // 快速返回

        // 预分配数组，估计每个用户最多10个过期命令
        const usersToRemove: number[] = [];
        usersToRemove.length = Math.min(userCount, 100); // 预分配但限制最大大小
        let userRemoveIndex = 0;

        // 复用的命令数组，避免频繁创建新数组
        const expiredCommands: string[] = [];
        expiredCommands.length = 20; // 预分配合理大小

        // 只在首次收集所有命令的冷却时间
        if (!this._commandCooldownCache) {
            this._commandCooldownCache = {
                maxCooldownSeconds: 60,
                cooldownMillisMap: new Map<string, number>(),
                lastUpdated: now
            };

            // 收集所有命令的冷却时间
        for (const plugin of this.plugins.values()) {
            if (plugin.status === PluginStatus.ACTIVE && plugin.commands) {
                for (const cmd of plugin.commands) {
                        if (cmd.cooldown) {
                            this._commandCooldownCache.cooldownMillisMap.set(cmd.name, cmd.cooldown * 1000);
                            if (cmd.cooldown > this._commandCooldownCache.maxCooldownSeconds) {
                                this._commandCooldownCache.maxCooldownSeconds = cmd.cooldown;
                            }
                        }
                    }
                }
            }
        }
        // 如果缓存已存在但超过10分钟，更新缓存
        else if (now - this._commandCooldownCache.lastUpdated > 600000) {
            this._commandCooldownCache.lastUpdated = now;
            this._commandCooldownCache.cooldownMillisMap.clear();
            this._commandCooldownCache.maxCooldownSeconds = 60;

            // 重新收集命令冷却时间
            for (const plugin of this.plugins.values()) {
                if (plugin.status === PluginStatus.ACTIVE && plugin.commands) {
                    for (const cmd of plugin.commands) {
                        if (cmd.cooldown) {
                            this._commandCooldownCache.cooldownMillisMap.set(cmd.name, cmd.cooldown * 1000);
                            if (cmd.cooldown > this._commandCooldownCache.maxCooldownSeconds) {
                                this._commandCooldownCache.maxCooldownSeconds = cmd.cooldown;
                            }
                        }
                    }
                }
            }
        }

        // 获取缓存数据
        const maxCooldownMillis = this._commandCooldownCache.maxCooldownSeconds * 1000;
        const cooldownMillisMap = this._commandCooldownCache.cooldownMillisMap;

        // 仅进行一次遍历，直接在遍历中删除过期记录
        for (const [userId, userCooldowns] of this.commandCooldowns.entries()) {
            // 重置过期命令数组索引
            let expiredCount = 0;
            let allCommandsExpired = true;

            // 检查并标记过期的命令
            for (const [command, timestamp] of userCooldowns.entries()) {
                // 获取特定命令的冷却时间，如果不存在则使用最大值
                const cooldownMillis = cooldownMillisMap.get(command) || maxCooldownMillis;

                // 检查是否过期
                if (now - timestamp >= cooldownMillis) {
                    // 只在数组容量允许范围内添加
                    if (expiredCount < expiredCommands.length) {
                        expiredCommands[expiredCount] = command;
                    } else {
                        expiredCommands.push(command);
                    }
                    expiredCount++;
                    removedCount++;
                } else {
                    // 只要有一个命令未过期，就不能完全删除用户记录
                    allCommandsExpired = false;
                }
            }

            // 删除过期的命令记录
            for (let i = 0; i < expiredCount; i++) {
                const cmdToDelete = expiredCommands[i];
                if (cmdToDelete) { // 确保命令存在
                    userCooldowns.delete(cmdToDelete);
                }
            }

            // 如果该用户的所有命令都已过期，标记为待删除
            if (allCommandsExpired && userCooldowns.size === 0) {
                if (userRemoveIndex < usersToRemove.length) {
                    usersToRemove[userRemoveIndex] = userId;
                } else {
                    usersToRemove.push(userId);
                }
                userRemoveIndex++;

                // 将Map对象归还到对象池
                this.returnToPool('cooldownMaps', userCooldowns);
                pooledMapsCount++;
                this.commandCooldowns.delete(userId);
            }
        }

        if (removedCount > 0) {
            log.debug(`清理了 ${removedCount} 条过期命令冷却记录，回收了 ${pooledMapsCount} 个Map对象到对象池`);
        }

        return removedCount;
    }

    /**
     * 清理命令处理器缓存
     * @returns 清理的缓存条目数量 
     */
    private cleanupCommandCache(): number {
        const now = Date.now();
        let removedCount = 0;

        // 如果缓存已经过期，直接清空（减少遍历次数）
        if (now - this.commandCacheLastUpdated >= this.COMMAND_CACHE_TTL) {
            const cacheSize = this.commandHandlersCache.size;

            if (cacheSize > 0) {
                // 一次性清空Map，比逐个删除效率更高
                this.commandHandlersCache.clear();
                this.recentlyUsedCommands.length = 0; // 清空数组更高效
                this.commandCacheLastUpdated = now;

                log.debug(`清空了 ${cacheSize} 个命令处理器缓存条目`);
                removedCount = cacheSize;
            }
            return removedCount;
        }

        // 如果缓存条目超出容量限制，只保留最近使用的条目
        if (this.commandHandlersCache.size > this.CACHE_MAX_SIZE) {
            // 创建需要保留的命令集合（使用Set提高查找效率）
            const keepCommands = new Set(this.recentlyUsedCommands.slice(0, this.CACHE_MAX_SIZE));

            // 直接遍历并筛选缓存条目
            let deletedCount = 0;

            for (const cmd of this.commandHandlersCache.keys()) {
                if (!keepCommands.has(cmd)) {
                    this.commandHandlersCache.delete(cmd);
                    deletedCount++;
                }
            }

            if (deletedCount > 0) {
                log.debug(`清理了 ${deletedCount} 个过期命令处理器缓存条目`);
                removedCount = deletedCount;

                // 更新最近使用命令列表，只保留有效的条目
                this.recentlyUsedCommands = this.recentlyUsedCommands.filter(cmd => keepCommands.has(cmd));
            }
        }

        return removedCount;
    }

    /**
     * 清理挂起的命令队列
     * 增强版：添加基于时间戳的清理逻辑
     * @returns 清理的队列条目数量
     */
    private cleanupCommandQueue(): number {
        let cleanedCount = 0;
        
        // 使用当前时间作为参考点
        const now = Date.now();
        
        // 设置最大队列项存活时间，是命令超时时间的两倍
        const MAX_QUEUE_AGE = this.COMMAND_TIMEOUT * 2;
        
        // 检查并存储需要清理的项
        const keysToDelete: number[] = [];
        
        // 遍历队列项检查创建时间戳
        for (const [userId, promiseObj] of this.commandQueue.entries()) {
            // 使用反射检查promise对象是否有creationTime属性
            const anyPromise = promiseObj as any;
            
            // 检查是否存在创建时间戳属性，以及是否超时
            if (anyPromise.creationTime && (now - anyPromise.creationTime) > MAX_QUEUE_AGE) {
                keysToDelete.push(userId);
                cleanedCount++;
                log.warn(`清理了可能悬挂的命令队列项 (用户: ${userId}, 距创建已 ${((now - anyPromise.creationTime) / 1000).toFixed(1)} 秒)`);
            }
        }
        
        // 批量删除已标记的队列项
        for (const userId of keysToDelete) {
            this.commandQueue.delete(userId);
        }
        
        if (cleanedCount > 0) {
            log.debug(`清理了 ${cleanedCount} 个可能悬挂的命令队列项`);
        }
        
        return cleanedCount;
    }

    /**
     * 清理插件配置缓存
     * 只保留活跃插件的配置
     * @returns 清理的配置缓存条目数量
     */
    private cleanupPluginConfigCache(): number {
        // 获取所有活跃插件名称
        const activePlugins = new Set<string>();
        for (const [name, plugin] of this.plugins.entries()) {
            if (plugin.status === PluginStatus.ACTIVE) {
                activePlugins.add(name);
            }
        }

        // 删除非活跃插件的配置缓存
        let cleanedCount = 0;
        for (const pluginName of this.pluginConfigs.keys()) {
            if (!activePlugins.has(pluginName)) {
                this.pluginConfigs.delete(pluginName);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            log.debug(`清理了 ${cleanedCount} 个非活跃插件的配置缓存`);
        }
        return cleanedCount;
    }

    /**
     * 清理过期的用户命令时间记录
     * 删除超过一定时间（例如1小时）未活动的用户记录
     * 优化版：更高效地处理大量用户记录
     * 
     * @returns 清理的记录数量
     */
    private cleanupUserCommandTimes(): number {
        if (this.userLastCommandTime.size === 0) return 0;
        
        // 更新缓存的时间戳
        if (!this.currentTimestamp || Date.now() - this.currentTimestamp > 100) {
            this.currentTimestamp = Date.now();
        }
        const now = this.currentTimestamp;
        
        // 设置过期时间为1小时 (3600000毫秒)
        const expirationTime = 3600000;
        let removedCount = 0;
        
        // 优化：预分配合理大小的数组以避免频繁扩容
        const itemCount = this.userLastCommandTime.size;
        const estimatedExpiredCount = Math.min(itemCount, Math.ceil(itemCount * 0.25)); // 预估25%过期
        const usersToRemove: number[] = new Array(estimatedExpiredCount);
        let removeIndex = 0;
        
        // 遍历所有用户记录
        for (const [userId, timestamp] of this.userLastCommandTime.entries()) {
            if (now - timestamp > expirationTime) {
                if (removeIndex < usersToRemove.length) {
                    usersToRemove[removeIndex] = userId;
                } else {
                    usersToRemove.push(userId);
                }
                removeIndex++;
            }
        }
        
        // 只使用实际填充的部分
        const actualUsersToRemove = removeIndex === usersToRemove.length ? 
            usersToRemove : usersToRemove.slice(0, removeIndex);
        
        // 删除过期记录
        for (const userId of actualUsersToRemove) {
            this.userLastCommandTime.delete(userId);
            removedCount++;
        }
        
        if (removedCount > 0) {
            log.debug(`清理了 ${removedCount} 条过期的用户命令时间记录 (${(removedCount / itemCount * 100).toFixed(1)}%)`);
        }
        
        return removedCount;
    }

    /**
     * 清理用户命令历史记录
     * 移除过期的命令历史，释放内存
     * @returns 清理的记录数量
     */
    private cleanupCommandHistory(): number {
        if (this.userCommandHistory.size === 0) return 0;
        
        const now = Date.now();
        // 只保留最长窗口内的记录
        const oldestRelevantTime = now - this.LONG_WINDOW_SIZE;
        
        let totalRemoved = 0;
        let usersRemoved = 0;
        
        // 遍历所有用户的命令历史
        for (const [userId, history] of this.userCommandHistory.entries()) {
            // 过滤出窗口内的记录
            const newHistory = history.filter(time => time >= oldestRelevantTime);
            
            // 计算移除的记录数
            totalRemoved += history.length - newHistory.length;
            
            // 如果所有记录都过期了，直接删除这个用户的记录
            if (newHistory.length === 0) {
                this.userCommandHistory.delete(userId);
                usersRemoved++;
            } else if (newHistory.length < history.length) {
                // 否则更新为新的历史记录
                this.userCommandHistory.set(userId, newHistory);
            }
        }
        
        // 清理过期的临时封禁记录
        let bansRemoved = 0;
        for (const [userId, expireTime] of this.tempBannedUsers.entries()) {
            if (now >= expireTime) {
                this.tempBannedUsers.delete(userId);
                bansRemoved++;
            }
        }
        
        // 清理长时间未触发的可疑用户记录和计数
        let suspiciousRemoved = 0;
        for (const [userId, firstTime] of this.suspiciousUsers.entries()) {
            if (now - firstTime > this.SUSPICIOUS_DECAY_TIME && !this.tempBannedUsers.has(userId)) {
                this.suspiciousUsers.delete(userId);
                this.suspiciousTriggerCount.delete(userId); // 同时清除触发计数
                suspiciousRemoved++;
            }
        }
        
        // 清理封禁次数记录（降级）
        let banCountsReduced = 0;
        const banCountDecayTime = 24 * 3600 * 1000; // 24小时
        for (const [userId, count] of this.userBanCount.entries()) {
            // 如果用户未被封禁且最后封禁时间超过24小时
            if (!this.tempBannedUsers.has(userId)) {
                const lastBanTime = this.suspiciousUsers.get(userId) || 0;
                if (now - lastBanTime > banCountDecayTime && count > 0) {
                    // 降低封禁计数
                    this.userBanCount.set(userId, count - 1);
                    banCountsReduced++;
                }
            }
        }
        
        if (totalRemoved > 0 || usersRemoved > 0 || bansRemoved > 0 || suspiciousRemoved > 0 || banCountsReduced > 0) {
            log.debug(`命令历史清理: 移除${totalRemoved}条记录, ${usersRemoved}个用户, ${bansRemoved}个临时封禁, ${suspiciousRemoved}个可疑记录, ${banCountsReduced}个封禁次数减少`);
        }
        
        return totalRemoved + usersRemoved + bansRemoved + suspiciousRemoved + banCountsReduced;
    }

    /**
     * 更新用户命令执行时间
     * 记录用户当前执行命令的时间戳
     * 
     * @param userId 用户ID
     */
    private updateUserCommandTime(userId: number): void {
        if (!userId) return;
        
        // 使用缓存的时间戳减少Date.now()调用
        if (!this.currentTimestamp || Date.now() - this.currentTimestamp > 100) {
            this.currentTimestamp = Date.now();
        }
        
        this.userLastCommandTime.set(userId, this.currentTimestamp);
    }

    /**
     * 资源清理，用于应用退出前调用
     */
    async dispose(): Promise<void> {
        log.info('正在清理功能管理器资源...');

        // 清理内存管理定时器
        if (this.memoryCleanupTimer) {
            clearInterval(this.memoryCleanupTimer);
            this.memoryCleanupTimer = undefined;
        }

        // 禁用所有插件
        for (const [name, plugin] of this.plugins.entries()) {
            if (plugin.status === PluginStatus.ACTIVE) {
                try {
                    await this.disablePlugin(name);
                } catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    log.warn(`禁用插件 ${name} 时出错: ${error.message}`);
                }
            }
        }

        // 清空各种集合和缓存
        this.plugins.clear();
        this.eventHandlers.clear();
        this.commandCooldowns.clear();
        this.pluginConfigs.clear();
        this.commandHandlersCache.clear();
        this.recentlyUsedCommands = [];
        this.commandQueue.clear();
        this.userLastCommandTime.clear();

        log.info('功能管理器资源清理完成');
    }

    /**
     * 查找给定事件处理器所属的插件名称
     * @param event 事件处理器
     * @returns 插件名称，如果找不到则返回undefined
     * @private
     */
    private findPluginByEvent(event: PluginEvent): string | undefined {
        try {
            // 遍历所有已加载的插件
            for (const [pluginName, plugin] of this.plugins.entries()) {
                if (!plugin || !plugin.events || !Array.isArray(plugin.events)) {
                    continue;
                }
                
                // 检查插件的事件是否包含目标事件
                for (const pluginEvent of plugin.events) {
                    if (pluginEvent === event) {
                        return pluginName;
                    }
                }
            }
            
            return undefined;
        } catch (error) {
            // 如果查找过程出错，记录错误但不中断流程
            log.debug(`查找事件处理器所属插件时出错: ${String(error)}`);
            return undefined;
        }
    }

    /**
     * 优化对象池大小
     * 动态调整对象池容量，以平衡性能和内存使用
     * 
     * @param aggressive 是否执行更积极的缩减
     * @returns 从池中移除的对象数量
     */
    private optimizeObjectPools(aggressive: boolean = false): number {
        let totalRemoved = 0;
        
        try {
            // 获取当前内存使用情况，用于动态调整池大小
            const mem = process.memoryUsage();
            const heapUsed = mem.heapUsed;
            const heapTotal = mem.heapTotal;
            const heapUsageRatio = heapUsed / heapTotal;

            // 根据内存压力和模式动态计算目标池大小
            let retentionFactor = 0.75; // 默认保留75%

            if (aggressive) {
                // 积极模式固定为低保留率
                retentionFactor = 0.3;
            } else {
                // 根据堆使用率动态调整
                // 当堆使用率 >= 80% 时，保留率降至50%
                // 当堆使用率 < 50% 时，保留率提高至90%
                // 介于两者之间线性调整
                if (heapUsageRatio >= 0.8) {
                    retentionFactor = 0.5;
                } else if (heapUsageRatio < 0.5) {
                    retentionFactor = 0.9;
                } else {
                    // 线性插值 0.5-0.8 映射到 0.9-0.5
                    retentionFactor = 0.9 - (heapUsageRatio - 0.5) * (0.4 / 0.3);
                }
            }

            // 确保池至少保留一定数量的对象，以减少频繁创建
            const minPoolSize = aggressive ? 5 : 10;
            const targetPoolSize = Math.max(minPoolSize, Math.floor(this.POOL_SIZE * retentionFactor));

            if (aggressive || heapUsageRatio > 0.7) {
                log.debug(`对象池优化: 目标池大小=${targetPoolSize}，堆使用率=${(heapUsageRatio * 100).toFixed(1)}%`);
            }
        
        // 遍历所有对象池执行优化
        for (const poolName in this.objectPools) {
            const pool = this.objectPools[poolName as keyof typeof this.objectPools];
                const originalSize = pool.length;
            
            // 如果池大小超过目标值，缩减它
            if (pool.length > targetPoolSize) {
                const removeCount = pool.length - targetPoolSize;
                pool.length = targetPoolSize;
                totalRemoved += removeCount;

                    if (aggressive || removeCount > 10) {
                        log.debug(`优化对象池 '${poolName}': ${originalSize} → ${targetPoolSize} (-${removeCount})`);
                    }
            }
        }
        
        if (totalRemoved > 0) {
                log.debug(`优化对象池: 总共移除了 ${totalRemoved} 个对象` + (aggressive ? ' (积极模式)' : ''));
            }
        } catch (err) {
            // 出错时使用保守的固定缩减策略
            log.debug(`优化对象池时出错: ${String(err)}，使用保守缩减策略`);

            const safeTargetSize = aggressive ? 20 : 50;

            for (const poolName in this.objectPools) {
                const pool = this.objectPools[poolName as keyof typeof this.objectPools];
                if (pool.length > safeTargetSize) {
                    const removeCount = pool.length - safeTargetSize;
                    pool.length = safeTargetSize;
                    totalRemoved += removeCount;
                }
            }
        }
        
        return totalRemoved;
    }

    /**
     * 增强错误信息，添加详细的上下文信息
     * @param error 原始错误
     * @param context 上下文信息对象 
     * @returns 增强后的错误描述
     * @private
     */
    private enhanceErrorMessage(error: Error, context: {
        type?: string;                 // 错误发生的上下文类型
        pluginName?: string;           // 相关插件名称
        eventType?: string;            // 事件类型
        eventContext?: EventContext;   // 事件上下文
        additionalInfo?: string;       // 附加信息
    }): string {
        let enhancedMessage = context.type ? `${context.type}` : '错误';
        
        try {
            // 添加插件信息
            if (context.pluginName) {
                enhancedMessage += ` | 插件: ${context.pluginName}`;
            }
            
            // 添加事件类型
            if (context.eventType) {
                enhancedMessage += ` | 事件类型: ${context.eventType}`;
            }
            
            // 添加事件上下文信息
            if (context.eventContext) {
                const evtCtx = context.eventContext;
                
                // 添加用户和聊天信息
                let userId = 'unknown';
                if (evtCtx.type === 'message' || evtCtx.type === 'command') {
                    const msgCtx = evtCtx as MessageEventContext | CommandContext;
                    userId = String(msgCtx.message?.sender?.id || 'unknown');
                    
                    // 添加消息/命令信息
                    if (evtCtx.type === 'message') {
                        const text = (evtCtx as MessageEventContext).message?.text;
                        if (text) {
                            const preview = text.length > 30 ? `${text.substring(0, 30)}...` : text;
                            enhancedMessage += ` | 消息: ${preview}`;
                        }
                    } else {
                        const cmdCtx = evtCtx as CommandContext;
                        enhancedMessage += ` | 命令: /${cmdCtx.command} ${cmdCtx.args.join(' ')}`;
                    }
                } else if (evtCtx.type === 'callback') {
                    const cbCtx = evtCtx as CallbackEventContext;
                    userId = String(cbCtx.query?.user?.id || 'unknown');
                    
                    // 添加回调数据
                    if (cbCtx.data) {
                        enhancedMessage += ` | 回调数据: ${cbCtx.data}`;
                    }
                    
                    // 添加匹配信息
                    if (cbCtx.match) {
                        if (cbCtx.match._pluginName) {
                            enhancedMessage += ` | 匹配插件: ${cbCtx.match._pluginName}`;
                        }
                        if (cbCtx.match._actionType) {
                            enhancedMessage += ` | 匹配操作: ${cbCtx.match._actionType}`;
                        }
                    }
                }
                
                enhancedMessage += ` | 用户ID: ${userId}, 聊天ID: ${evtCtx.chatId || 'unknown'}`;
            }
            
            // 添加附加信息
            if (context.additionalInfo) {
                enhancedMessage += ` | ${context.additionalInfo}`;
            }
            
            // 针对特定错误类型提供建议
            if (error.message.includes('description must be')) {
                enhancedMessage += ` | 可能原因: 事件处理器使用了Object.defineProperty时description参数不是对象`;
            } else if (error.message.includes('Cannot read') || error.message.includes('undefined')) {
                enhancedMessage += ` | 可能原因: 尝试访问未定义的对象属性`;
            }
            
            // 提取错误位置信息
            if (error.stack) {
                // 从堆栈中提取第一个非Features类的调用位置
                const stackLines = error.stack.split('\n');
                const locationLine = stackLines.find(line => 
                    !line.includes('src/features.ts') && 
                    line.includes('src/plugins/')
                );
                
                if (locationLine) {
                    // 提取文件名和行号
                    const locationMatch = locationLine.match(/src\/plugins\/([^:]+):(\d+)/);
                    if (locationMatch) {
                        const [, file, line] = locationMatch;
                        enhancedMessage += ` | 位置: ${file}:${line}`;
                    }
                }
            }
        } catch (enhanceError) {
            // 如果增强过程出错，添加基本信息
            enhancedMessage += ` | 增强错误信息失败: ${String(enhanceError)}`;
        }
        
        return enhancedMessage;
    }

    /**
     * 分析内存使用情况，帮助诊断潜在的内存泄漏
     * 增强版：更全面的内存分析
     * @private
     */
    private analyzeMemoryUsage(): void {
        try {
            log.info("======== 内存使用情况分析 ========");

            // 分析插件数量
            const plugins = this.plugins.size;
            const activePlugins = Array.from(this.plugins.values()).filter(p => p.status === PluginStatus.ACTIVE).length;
            log.info(`插件: 总共 ${plugins} 个 (已激活: ${activePlugins})`);

            // 分析事件处理器
            let totalEventHandlers = 0;
            for (const [type, handlers] of this.eventHandlers.entries()) {
                const count = handlers.size;
                totalEventHandlers += count;
                log.info(`事件处理器 (${type}): ${count} 个`);
            }
            log.info(`事件处理器总数: ${totalEventHandlers}`);

            // 分析命令冷却时间数据结构
            const userCount = this.commandCooldowns.size;
            let totalCooldownEntries = 0;
            let maxEntriesPerUser = 0;
            let usersWithLargeCooldowns = 0;

            // 分析用户冷却时间分布
            type CooldownRange = "1-5" | "6-10" | "11-20" | "21-50" | "50+";
            const cooldownDistribution: Record<CooldownRange, number> = {
                "1-5": 0,
                "6-10": 0,
                "11-20": 0,
                "21-50": 0,
                "50+": 0
            };

            // 存储用户ID和Map对象的数组，用于查询可能泄漏的用户
            const userIdMapPairs: [number, Map<string, number>][] = [];

            // 收集用户ID和Map对象的映射
            for (const [userId, userCooldowns] of this.commandCooldowns.entries()) {
                userIdMapPairs.push([userId, userCooldowns]);

                const entryCount = userCooldowns.size;
                totalCooldownEntries += entryCount;

                if (entryCount > maxEntriesPerUser) {
                    maxEntriesPerUser = entryCount;
                }

                if (entryCount > 20) {
                    usersWithLargeCooldowns++;
                }

                // 更新分布统计
                if (entryCount <= 5) cooldownDistribution["1-5"]++;
                else if (entryCount <= 10) cooldownDistribution["6-10"]++;
                else if (entryCount <= 20) cooldownDistribution["11-20"]++;
                else if (entryCount <= 50) cooldownDistribution["21-50"]++;
                else cooldownDistribution["50+"]++;

                // 检查可能过期但未清理的记录
                const now = Date.now();
                let expiredCount = 0;

                for (const timestamp of userCooldowns.values()) {
                    // 假设最长冷却时间为24小时
                    if (now - timestamp > 24 * 60 * 60 * 1000) {
                        expiredCount++;
                    }
                }

                if (expiredCount > 0) {
                    log.warn(`发现可能过期但未清理的冷却记录: 用户 ${userId} 有 ${expiredCount} 条`);
                }
            }

            log.info(`命令冷却时间: ${userCount} 个用户, ${totalCooldownEntries} 条记录`);
            log.info(`冷却记录分布: 1-5条: ${cooldownDistribution["1-5"]}用户, 6-10条: ${cooldownDistribution["6-10"]}用户, 11-20条: ${cooldownDistribution["11-20"]}用户, 21-50条: ${cooldownDistribution["21-50"]}用户, 50+条: ${cooldownDistribution["50+"]}用户`);
            log.info(`每用户最大冷却记录数: ${maxEntriesPerUser}, 大量冷却记录用户数: ${usersWithLargeCooldowns}`);

            // 分析对象池使用情况
            let totalPoolObjects = 0;
            for (const [poolName, pool] of Object.entries(this.objectPools)) {
                const count = (pool as any[]).length;
                totalPoolObjects += count;
                log.info(`对象池 (${poolName}): ${count}/${this.POOL_SIZE} (${Math.round(count / this.POOL_SIZE * 100)}% 满)`);
            }
            log.info(`对象池总对象数: ${totalPoolObjects}`);

            // 查找可能的内存泄漏
            if (usersWithLargeCooldowns > 10) {
                log.warn(`可能存在内存泄漏: ${usersWithLargeCooldowns} 个用户有大量冷却记录`);
            }

            // 记录命令队列状态
            if (this.commandQueue.size > 0) {
                log.info(`命令队列中有 ${this.commandQueue.size} 个待处理命令`);

                // 检查长时间未处理的命令
                const now = Date.now();
                let longRunningCommands = 0;

                for (const [userId, promiseObj] of this.commandQueue.entries()) {
                    const anyPromise = promiseObj as any;
                    if (anyPromise.creationTime && (now - anyPromise.creationTime) > 60000) { // 1分钟
                        longRunningCommands++;
                        log.warn(`用户 ${userId} 的命令已运行 ${((now - anyPromise.creationTime) / 1000).toFixed(1)} 秒`);
                    }
                }

                if (longRunningCommands > 0) {
                    log.warn(`发现 ${longRunningCommands} 个长时间运行的命令`);
                }
            }

            log.info("======== 内存分析完成 ========");
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`内存分析出错: ${error.message}`);
        }
    }

    /**
     * 批量检查命令冷却时间
     * 一次性检查多个命令的冷却状态，适用于需要同时检查多个命令的场景
     * 这种批量检查方式比单独调用checkCommandCooldown更高效
     * 当前主要用于executeCommandLogic方法中优化多个命令处理器的冷却检查
     * 
     * @param userId 用户ID
     * @param commandCooldowns 命令名称及其冷却时间（秒）的映射
     * @returns 每个命令的冷却状态映射：true表示可执行，false表示在冷却中
     */
    private batchCheckCommandCooldown(userId: number, commandCooldowns: Map<string, number>): Map<string, boolean> {
        const results = new Map<string, boolean>();
        const now = Date.now();

        // 获取用户的所有冷却记录
        const userCooldowns = this.commandCooldowns.get(userId);
        if (!userCooldowns) {
            // 如果用户没有冷却记录，所有命令都可执行
            for (const command of commandCooldowns.keys()) {
                results.set(command, true);
            }
            return results;
        }

        // 用于标记过期的冷却记录
        const expiredCommands: string[] = [];

        // 检查每个命令的冷却状态
        for (const [command, cooldownSeconds] of commandCooldowns.entries()) {
            const lastTimestamp = userCooldowns.get(command);

            // 如果没有此命令的冷却记录，则可执行
            if (!lastTimestamp) {
                results.set(command, true);
                continue;
            }

            // 计算冷却是否已过期
            const elapsedMillis = now - lastTimestamp;
            const cooldownMillis = cooldownSeconds * 1000;

            if (elapsedMillis >= cooldownMillis) {
                // 冷却已过期
                results.set(command, true);
                expiredCommands.push(command);
            } else {
                // 仍在冷却中
                results.set(command, false);
            }
        }

        // 清理过期的冷却记录
        for (const command of expiredCommands) {
            userCooldowns.delete(command);
        }

        // 如果清理后用户没有冷却记录了，归还Map对象并删除用户条目
        if (expiredCommands.length > 0 && userCooldowns.size === 0) {
            this.returnToPool('cooldownMaps', userCooldowns);
            this.commandCooldowns.delete(userId);
        }

        return results;
    }

    /**
     * 检查用户命令频率限制
     * 多层滑动窗口实现，提供更精细的频率控制：
     * 1. 检查用户是否被临时封禁
     * 2. 分别检查短、中、长三个时间窗口的命令频率
     * 3. 更新可疑用户状态，实施累进惩罚机制
     * 
     * @param userId 用户ID
     * @returns 对象，包含是否允许执行命令，以及剩余冷却时间（毫秒）
     */
    private checkUserCommandRateLimit(userId: number): { allowed: boolean; remainingMs: number; reason?: string } {
        // 无效的用户ID直接允许（系统消息等）
        if (!userId) {
            return { allowed: true, remainingMs: 0 };
        }

        // 使用缓存的时间戳
        if (!this.currentTimestamp || Date.now() - this.currentTimestamp > 100) {
            this.currentTimestamp = Date.now();
        }
        const now = this.currentTimestamp;
        
        // 1. 检查用户是否在临时封禁列表中
        const banExpireTime = this.tempBannedUsers.get(userId);
        if (banExpireTime) {
            if (now < banExpireTime) {
                // 仍在封禁期内
                const remainingMs = banExpireTime - now;
                const remainingSecs = Math.ceil(remainingMs / 1000);
                const remainingMins = Math.ceil(remainingSecs / 60);
                
                return { 
                    allowed: false, 
                    remainingMs, 
                    reason: remainingMins > 1 
                        ? `您已被临时限制使用命令，${remainingMins}分钟后解除` 
                        : `您已被临时限制使用命令，${remainingSecs}秒后解除`
                };
            } else {
                // 封禁已过期，移除记录
                this.tempBannedUsers.delete(userId);
            }
        }
        
        // 获取用户命令历史
        let commandHistory = this.userCommandHistory.get(userId);
        if (!commandHistory) {
            // 使用预分配数组减少内存分配
            commandHistory = new Array(this.COMMAND_HISTORY_INITIAL_CAPACITY);
            commandHistory.length = 0; // 重置长度为0但保留容量
            this.userCommandHistory.set(userId, commandHistory);
        }
        
        // 计算各时间窗口的起始时间
        const shortWindowStart = now - this.SHORT_WINDOW_SIZE;
        const mediumWindowStart = now - this.MEDIUM_WINDOW_SIZE;
        const longWindowStart = now - this.LONG_WINDOW_SIZE;
        
        // 过滤并计算各窗口内的命令数量（从尾部开始，因为新命令添加在尾部）
        let shortWindowCommands = 0;
        let mediumWindowCommands = 0;
        let longWindowCommands = 0;
        let oldestRelevantCommand = longWindowStart;
        
        // 从最近的命令开始向前遍历，优化性能
        for (let i = commandHistory.length - 1; i >= 0; i--) {
            const timestamp = commandHistory[i];
            
            // 未定义检查
            if (timestamp === undefined) continue;
            
            if (timestamp >= shortWindowStart) {
                shortWindowCommands++;
            }
            
            if (timestamp >= mediumWindowStart) {
                mediumWindowCommands++;
            }
            
            if (timestamp >= longWindowStart) {
                longWindowCommands++;
            } else {
                // 一旦找到长窗口之外的命令，可以停止计数
                break;
            }
        }
        
        // 2. 检查各窗口的频率限制
        // 短窗口检查（严格限制）
        if (shortWindowCommands >= this.SHORT_WINDOW_MAX_COMMANDS) {
            this.markUserAsSuspicious(userId);
            
            // 计算需要等待时间
            const waitTime = this.calculateWaitTime(commandHistory, shortWindowStart, this.SHORT_WINDOW_MAX_COMMANDS);
            
            return {
                allowed: false,
                remainingMs: waitTime,
                reason: `⏱️ 命令发送过于频繁，${this.SHORT_WINDOW_SIZE/1000}秒内最多${this.SHORT_WINDOW_MAX_COMMANDS}个命令`
            };
        }
        
        // 中窗口检查
        if (mediumWindowCommands >= this.MEDIUM_WINDOW_MAX_COMMANDS) {
            this.markUserAsSuspicious(userId);
            
            // 计算需要等待时间
            const waitTime = this.calculateWaitTime(commandHistory, mediumWindowStart, this.MEDIUM_WINDOW_MAX_COMMANDS);
            
            return {
                allowed: false,
                remainingMs: waitTime,
                reason: `⚠️ 命令发送过于频繁，请适当放慢操作速度`
            };
        }
        
        // 长窗口检查
        if (longWindowCommands >= this.LONG_WINDOW_MAX_COMMANDS) {
            this.markUserAsSuspicious(userId);
            
            // 计算需要等待时间
            const waitTime = this.calculateWaitTime(commandHistory, longWindowStart, this.LONG_WINDOW_MAX_COMMANDS);
            
            return {
                allowed: false,
                remainingMs: waitTime,
                reason: `⚠️ 已达到命令频率限制，请稍后再试`
            };
        }
        
        // 更新命令历史（添加当前命令）
        // 仅在通过所有限制时才添加，以避免在拒绝时也计入历史
        commandHistory.push(now);
        
        // 优化：如果历史记录过长，删除旧记录
        if (commandHistory.length > this.LONG_WINDOW_MAX_COMMANDS * 2) {
            // 只保留长窗口内的记录
            commandHistory = commandHistory.filter(time => time >= longWindowStart);
            this.userCommandHistory.set(userId, commandHistory);
        }
        
        // 允许执行命令
        return { allowed: true, remainingMs: 0 };
    }
    
    /**
     * 将用户标记为可疑用户
     * 跟踪连续触发频率限制的用户，并在必要时实施临时封禁
     * 更精确的实现：使用触发计数而非简单的时间间隔
     * 
     * @param userId 用户ID
     */
    private markUserAsSuspicious(userId: number): void {
        const now = this.currentTimestamp || Date.now();
        
        // 检查是否已在可疑列表中
        if (!this.suspiciousUsers.has(userId)) {
            // 首次标记为可疑，初始化计数
            this.suspiciousUsers.set(userId, now);
            this.suspiciousTriggerCount.set(userId, 1);
            return;
        }
        
        // 获取首次标记时间
        const firstTime = this.suspiciousUsers.get(userId)!;
        
        // 如果是长时间前标记的，重置计时和计数
        if (now - firstTime > this.SUSPICIOUS_DECAY_TIME) {
            this.suspiciousUsers.set(userId, now);
            this.suspiciousTriggerCount.set(userId, 1);
            return;
        }
        
        // 短时间内多次触发，增加计数
        if (now - firstTime < this.MEDIUM_WINDOW_SIZE) {
            // 增加触发计数
            const currentCount = this.suspiciousTriggerCount.get(userId) || 1;
            const newCount = currentCount + 1;
            this.suspiciousTriggerCount.set(userId, newCount);
            
            // 记录最新触发时间，便于分析用户模式
            this.suspiciousUsers.set(userId, now);
            
            // 如果超过阈值，实施临时封禁
            if (newCount >= this.SUSPICIOUS_THRESHOLD) {
                log.warn(`用户 ${userId} 在短时间内触发限制 ${newCount} 次，超过阈值 ${this.SUSPICIOUS_THRESHOLD}，实施临时封禁`);
                
                // 实施临时封禁
                this.tempBanUser(userId);
                
                // 清除可疑标记和计数
                this.suspiciousUsers.delete(userId);
                this.suspiciousTriggerCount.delete(userId);
            } else {
                log.debug(`用户 ${userId} 可疑行为计数: ${newCount}/${this.SUSPICIOUS_THRESHOLD}`);
            }
        }
    }
    
    /**
     * 实施临时封禁
     * 使用累进惩罚机制，重复违规的用户将面临更长时间的封禁
     * 
     * @param userId 用户ID 
     */
    private tempBanUser(userId: number): void {
        const now = this.currentTimestamp || Date.now();
        
        // 获取用户历史封禁次数
        const banCount = this.userBanCount.get(userId) || 0;
        
        // 计算本次封禁时长（累进惩罚）
        const banDuration = this.TEMP_BAN_DURATION_BASE * Math.pow(this.BAN_MULTIPLIER, Math.min(banCount, 3));
        
        // 设置解除时间
        const banExpireTime = now + banDuration;
        this.tempBannedUsers.set(userId, banExpireTime);
        
        // 增加封禁计数
        this.userBanCount.set(userId, banCount + 1);
        
        // 清空命令历史
        this.userCommandHistory.set(userId, []);
        
        // 计算人类可读的封禁时长
        const banMinutes = Math.ceil(banDuration / 60000);
        log.warn(`用户 ${userId} 触发频率保护机制，临时限制使用命令 ${banMinutes} 分钟（第${banCount+1}次）`);
    }
    
    /**
     * 计算需要等待的时间
     * 根据窗口起始时间和最大命令数，计算用户需要等待多久才能发送下一个命令
     * 
     * @param commandHistory 命令历史时间戳数组
     * @param windowStart 窗口起始时间
     * @param maxCommands 窗口内最大命令数
     * @returns 需要等待的毫秒数
     */
    private calculateWaitTime(commandHistory: number[], windowStart: number, maxCommands: number): number {
        // 过滤出窗口内的命令
        const windowCommands = commandHistory.filter(time => time >= windowStart);
        
        // 如果命令数小于最大值，不需要等待
        if (windowCommands.length < maxCommands) {
            return 0;
        }
        
        // 否则，需要等待最早的一条命令过期
        // 对窗口内命令按时间排序
        windowCommands.sort((a, b) => a - b);
        
        // 找到第N个最早的命令（下一个可以执行的位置）
        const oldestCommand = windowCommands[windowCommands.length - maxCommands] || Date.now(); // 修复：添加默认值
        
        // 计算该命令过期需要的时间
        const now = this.currentTimestamp || Date.now();
        const waitTime = oldestCommand + (windowStart + this.SHORT_WINDOW_SIZE - now) - now;
        
        // 确保等待时间为正数，最小等待1秒
        return Math.max(waitTime, 1000);
    }
}

