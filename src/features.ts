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
    // 不再提供reply方法，请直接使用message对象上的具体方法如replyText、replyMedia等
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

    // ===== 配置系统相关 =====
    /** 插件配置缓存: 插件名称 -> 配置对象 */
    private pluginConfigs = new Map<string, any>();

    // ===== 内存管理相关 =====
    /** 内存清理间隔（毫秒） */
    private readonly MEMORY_CLEANUP_INTERVAL = 300000; // 5分钟（原为10分钟，减少以提高清理频率）
    /** 内存清理定时器 */
    private memoryCleanupTimer?: ReturnType<typeof setInterval>;
    /** 上次测量的堆内存使用量，用于内存泄漏检测 */
    private lastHeapUsed = 0;
    /** 内存使用量连续增长的次数，用于内存泄漏检测 */
    private consecutiveIncreases = 0;

    // ===== 对象池 =====
    /** 对象池：用于复用频繁创建的对象，减少GC压力 */
    private objectPools: {
        matchObjects: Array<Record<string, any>>;
        callbackContexts: Array<Partial<CallbackEventContext>>;
        commandHandlers: Array<{ plugin: BotPlugin, cmd: PluginCommand }>;
        eventTasks: Array<() => Promise<void>>;
    } = {
        matchObjects: [],
        callbackContexts: [],
        commandHandlers: [],
        eventTasks: []
    };
    /** 对象池最大容量 */
    private readonly POOL_SIZE = 100;

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
            this.objectPools.eventTasks.push(async () => {});
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
                return (async () => {}) as unknown as T;
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
            // 清空对象所有属性
            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    (obj as any)[key] = null;
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
            const sortedHandlers = Array.from(handlers)
                .sort((a, b) => (b.priority || 0) - (a.priority || 0));

            // 将相同优先级的处理器分组，以便并行执行
            // 优化：使用Map而不是对象，提高性能
            const priorityGroups = new Map<number, PluginEvent[]>();

            // 优化：仅对可能匹配的处理器进行分组
            for (const handler of sortedHandlers) {
                // 预过滤：如果是回调事件，只考虑可能匹配的处理器
                if (type === 'callback' && handler.name && callbackData && callbackData.length >= 2) {
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
                            if (type === 'callback' && context.type === 'callback' && callbackData && callbackData.length >= 2) {
                                const callbackContext = context as CallbackEventContext;

                                // 第一部分是插件名，第二部分是功能名
                                const pluginName = callbackData[0];
                                const actionType = callbackData[1];

                                // 解析参数（从第3个部分开始）
                                const paramParts = callbackData.slice(2);

                                // 从对象池获取match对象，避免频繁创建
                                const match = this.getFromPool<Record<string, any>>('matchObjects');
                                
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
                              
                              // 包装处理器执行为Promise
                              const handlerPromise = handler.handler(context);
                              
                              // 设置超时控制
                              const timeoutPromise = new Promise<void>((_, reject) => {
                                  setTimeout(() => {
                                      const pluginName = this.findPluginByEvent(handler);
                                      const handlerInfo = pluginName 
                                          ? `插件 ${pluginName} 的事件处理器` 
                                          : '未知插件的事件处理器';
                                      reject(new Error(`${handlerInfo}超时 (${type})`));
                                  }, HANDLER_TIMEOUT);
                              });

                              // 执行事件处理器（竞争超时）
                              await Promise.race([handlerPromise, timeoutPromise]);
                          } catch (err) {
                              const error = err instanceof Error ? err : new Error(String(err));

                              // 获取上下文信息以便更好地诊断
                              let userId = 'unknown';
                              if (context.type === 'message' || context.type === 'command') {
                                  userId = String((context as MessageEventContext | CommandContext).message.sender.id);
                              } else if (context.type === 'callback') {
                                  userId = String((context as CallbackEventContext).query.user.id);
                              }

                              const chatId = context.chatId;
                              const pluginName = this.findPluginByEvent(handler);
                              const eventDetails = pluginName ? `插件 ${pluginName} 的 ${type} 事件处理器` : `${type} 事件处理器`;

                              log.error(`${eventDetails}错误 (用户: ${userId}, 聊天: ${chatId}): ${error.message}`);
                              if (error.stack) {
                                  log.debug(`错误堆栈: ${error.stack}`);
                              }
                          } finally {
                              // 任务完成后归还到对象池
                              this.returnToPool('eventTasks', origTaskFn);
                          }
                    };
                    
                    // 替换原函数内容
                    Object.defineProperty(taskFn, 'prototype', Object.getOwnPropertyDescriptor(newTaskFn, 'prototype')!);
                    Object.setPrototypeOf(taskFn, Object.getPrototypeOf(newTaskFn));
                    
                    // 添加到任务列表
                    tasks.push(taskFn);
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
                    log.error(`优先级 ${priority} 的事件处理组执行错误: ${error.message}`);
                }
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`事件分发处理错误 (类型: ${type}): ${error.message}`);
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

        // 检查该用户是否有正在处理的命令
        if (this.commandQueue.has(userId)) {
            try {
                // 等待前一个命令处理完成
                await this.commandQueue.get(userId);
            } catch (err) {
                // 忽略前一个命令的错误，不影响当前命令处理
                log.debug(`前一个命令处理出错，继续处理新命令: ${err}`);
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
            // 设置命令处理超时
            const timeoutId = setTimeout(() => {
                const messageText = ctx.text || '未知消息';
                rejectFn(new Error(`用户 ${userId} 的命令处理超时: ${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}`));
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

            // 并行检查权限和冷却时间
            const checkResults = await Promise.all(
                commandHandlers.map(async ({ plugin, cmd }, index) => {
                    // 检查权限
                    if (cmd.requiredPermission && !context.hasPermission(cmd.requiredPermission)) {
                        return {
                            index,
                            canExecute: false,
                            reason: 'permission',
                            message: `用户 ${userId} 缺少权限执行命令 ${command}: ${cmd.requiredPermission}`
                        };
                    }

                    // 检查冷却时间
                    if (cmd.cooldown && userId) {
                        if (!this.checkCommandCooldown(userId, cmd.name, cmd.cooldown)) {
                            const remainingSecs = this.getRemainingCooldown(userId, cmd.name, cmd.cooldown);
                            return {
                                index,
                                canExecute: false,
                                reason: 'cooldown',
                                message: `命令 ${command} 冷却中，剩余时间: ${remainingSecs}s`,
                                remainingSecs
                            };
                        }
                    }

                    return { index, canExecute: true };
                })
            );

            // 找到第一个可以执行的命令
            const executableCommand = checkResults.find(result => result.canExecute);

            if (!executableCommand) {
                // 没有可执行的命令，检查原因并通知用户
                const permissionDenied = checkResults.find(r => r.reason === 'permission');
                if (permissionDenied) {
                    log.debug(permissionDenied.message);
                    await ctx.replyText('❌ 你没有执行此命令的权限').catch(() => { });
                    return;
                }

                const onCooldown = checkResults.find(r => r.reason === 'cooldown');
                if (onCooldown) {
                    log.debug(onCooldown.message);
                    await ctx.replyText(`⏱️ 命令冷却中，请等待 ${onCooldown.remainingSecs} 秒后再试`).catch(() => { });
                    return;
                }

                return;
            }

            // 执行命令（这里确保executableCommand存在）
            const handler = commandHandlers[executableCommand.index];
            if (!handler) {
                log.error(`命令处理器索引错误: ${executableCommand.index}`);
                return;
            }
            const plugin = handler.plugin;
            const cmd = handler.cmd;

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
     * 
     * @param command 命令名称（不含/前缀）
     * @returns 命令处理器数组，包含插件和命令信息
     */
    private findCommandHandlers(command: string): { plugin: BotPlugin, cmd: PluginCommand }[] {
        // 1. 检查缓存是否有效
        const now = Date.now();

        // 缓存命中情况
        if (
            this.commandHandlersCache.has(command) &&
            now - this.commandCacheLastUpdated < this.COMMAND_CACHE_TTL
        ) {
            // 更新LRU缓存（不生成新数组，而是操作原有数组）
            this.updateRecentlyUsedCommands(command);
            return this.commandHandlersCache.get(command) || [];
        }

        // 2. 缓存未命中或过期，重建缓存
        // 如果整个缓存过期，清空所有缓存（使用length=0更高效）
        if (now - this.commandCacheLastUpdated >= this.COMMAND_CACHE_TTL) {
            this.commandHandlersCache.clear();
            this.recentlyUsedCommands.length = 0;
            this.commandCacheLastUpdated = now;
        }

        // 3. 查找匹配命令
        // 预分配合理容量，避免频繁扩容
        const commandHandlers: { plugin: BotPlugin, cmd: PluginCommand }[] = [];

        // 构建活跃插件的快速映射，减少第二次遍历的查找开销
        const activePlugins: BotPlugin[] = [];
        for (const plugin of this.plugins.values()) {
            if (plugin.status === PluginStatus.ACTIVE && plugin.commands && plugin.commands.length > 0) {
                activePlugins.push(plugin);
            }
        }

        // 遍历活跃插件查找匹配命令
        for (const plugin of activePlugins) {
            for (const cmd of plugin.commands!) {
                try {
                    if (cmd.name === command || (cmd.aliases && cmd.aliases.includes(command))) {
                        commandHandlers.push({ plugin, cmd });
                    }
                } catch (err) {
                    // 捕获错误避免影响循环，记录错误但继续处理
                    const error = err instanceof Error ? err : new Error(String(err));
                    log.error(`查找命令处理器时出错 (插件: ${plugin.name}): ${error.message}`);
                }
            }
        }

        // 4. 缓存结果
        this.commandHandlersCache.set(command, commandHandlers);
        this.updateRecentlyUsedCommands(command);

        return commandHandlers;
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

            // 检查是否包含插件必要的功能
            const hasCommands = plugin.commands && Array.isArray(plugin.commands);
            const hasEvents = plugin.events && Array.isArray(plugin.events);
            const hasOnLoad = typeof plugin.onLoad === 'function';

            const hasPluginFeatures = hasCommands || hasEvents || hasOnLoad;

            if (!hasPluginFeatures) {
                log.debug(`文件 ${filePath} 的插件对象缺少必要功能属性(commands, events 或 onLoad)`);
                return false;
            }

            log.debug(`文件 ${filePath} 是有效的插件文件，名称: ${plugin.name}`);
            return true;
        } catch (err) {
            // 导入出错，不是有效插件
            if (err instanceof Error && err.message) {
                log.debug(`插件文件验证错误 (${filePath}): ${err.message}`);
                if (err.stack) {
                    log.debug(`错误堆栈: ${err.stack}`);
                }
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
     * 获取插件加载顺序（基于依赖关系图的拓扑排序）
     * @param dependencyGraph 依赖关系图
     */
    private getPluginLoadOrder(dependencyGraph: Map<string, Set<string>>): string[] {
        const visited = new Set<string>();
        const result: string[] = [];

        function visit(node: string) {
            if (visited.has(node)) return;
            visited.add(node);

            const dependencies = dependencyGraph.get(node) || new Set();
            for (const dep of dependencies) {
                if (dependencyGraph.has(dep)) {
                    visit(dep);
                }
            }

            result.push(node);
        }

        for (const node of dependencyGraph.keys()) {
            if (!visited.has(node)) {
                visit(node);
            }
        }

        return result;
    }

    /**
     * 将插件分组，以便并行加载
     * 同一组内的插件没有相互依赖关系，可以并行加载
     */
    private groupPluginsForLoad(loadOrder: string[], dependencyGraph: Map<string, Set<string>>): string[][] {
        const groups: string[][] = [];
        const processed = new Set<string>();

        for (const plugin of loadOrder) {
            if (processed.has(plugin)) continue;

            const currentGroup: string[] = [];

            // 检查loadOrder中的每个插件，如果它还未处理且没有未处理的依赖，加入当前组
            for (const candidate of loadOrder) {
                if (processed.has(candidate)) continue;

                const dependencies = dependencyGraph.get(candidate) || new Set();
                // 检查是否所有依赖都已经处理过
                const allDependenciesProcessed = Array.from(dependencies)
                    .every(dep => processed.has(dep) || !dependencyGraph.has(dep));

                if (allDependenciesProcessed) {
                    currentGroup.push(candidate);
                }
            }

            if (currentGroup.length > 0) {
                groups.push(currentGroup);
                for (const p of currentGroup) {
                    processed.add(p);
                }
            } else {
                // 如果没有可以加入组的插件，说明有循环依赖
                // 找一个有最少未处理依赖的插件
                let minUnprocessedDeps = Infinity;
                let candidateToAdd = '';

                for (const candidate of loadOrder) {
                    if (processed.has(candidate)) continue;

                    const dependencies = dependencyGraph.get(candidate) || new Set();
                    const unprocessedDeps = Array.from(dependencies)
                        .filter(dep => !processed.has(dep) && dependencyGraph.has(dep))
                        .length;

                    if (unprocessedDeps < minUnprocessedDeps) {
                        minUnprocessedDeps = unprocessedDeps;
                        candidateToAdd = candidate;
                    }
                }

                if (candidateToAdd) {
                    groups.push([candidateToAdd]);
                    processed.add(candidateToAdd);
                } else {
                    // 理论上不应该达到这里
                    break;
                }
            }
        }

        return groups;
    }

    /**
     * 将插件分组，以便并行启用
     * 每一组中的插件可以并行启用
     */
    private groupPluginsForEnable(sortedPlugins: string[]): string[][] {
        const groups: string[][] = [];
        const processed = new Set<string>();

        for (let i = 0; i < sortedPlugins.length; i++) {
            const pluginName = sortedPlugins[i];
            if (!pluginName || processed.has(pluginName)) continue;

            const currentGroup: string[] = [];

            for (let j = i; j < sortedPlugins.length; j++) {
                const plugin = sortedPlugins[j];
                if (!plugin || processed.has(plugin)) continue;

                const pluginObj = this.plugins.get(plugin);
                if (!pluginObj) continue;

                // 检查此插件的所有依赖是否已经处理
                const dependencies = pluginObj.dependencies || [];
                const allDependenciesProcessed = dependencies.every(dep =>
                    !this.plugins.has(dep) || processed.has(dep));

                if (allDependenciesProcessed) {
                    currentGroup.push(plugin);
                    processed.add(plugin);
                }
            }

            if (currentGroup.length > 0) {
                groups.push(currentGroup);
            }
        }

        return groups;
    }

    /**
     * 对插件进行拓扑排序，确保依赖在前，依赖者在后
     * @returns 排序后的插件名称数组
     * @private
     */
    private sortPluginsByDependencies(): string[] {
        const visited = new Set<string>();
        const temp = new Set<string>();
        const order: string[] = [];
        const missingDeps = new Set<string>();

        // 检测是否存在循环依赖
        const hasCycle = (pluginName: string, path: string[] = []): boolean => {
            if (!this.plugins.has(pluginName)) {
                missingDeps.add(pluginName);
                return false;
            }

            if (temp.has(pluginName)) {
                const cycle = [...path, pluginName].join(' -> ');
                log.error(`⚠️ 检测到循环依赖: ${cycle}`);
                return true;
            }

            if (visited.has(pluginName)) return false;

            const plugin = this.plugins.get(pluginName)!;
            if (!plugin.dependencies || plugin.dependencies.length === 0) return false;

            temp.add(pluginName);

            let hasCycleFound = false;
            for (const dep of plugin.dependencies) {
                if (hasCycle(dep, [...path, pluginName])) {
                    hasCycleFound = true;
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
                    if (!visited.has(dep)) {
                        if (temp.has(dep)) {
                            log.error(`⚠️ 循环依赖: ${pluginName} 和 ${dep}`);
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
            }

            temp.delete(pluginName);
            visited.add(pluginName);
            order.push(pluginName);
        };

        // 先检查循环依赖
        let cycleDetected = false;
        for (const [name] of this.plugins) {
            if (hasCycle(name)) {
                cycleDetected = true;
            }
        }

        if (cycleDetected) {
            log.warn('⚠️ 检测到循环依赖，插件可能无法正常加载');
        }

        // 对所有插件进行排序
        for (const [name] of this.plugins) {
            if (!visited.has(name)) {
                visit(name);
            }
        }

        // 输出排序后的插件加载顺序
        if (order.length > 0) {
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
     * 
     * @param userId 用户ID
     * @param command 命令名称
     * @param cooldownSeconds 冷却时间（秒）
     * @returns 如果可以执行则返回true，否则返回false
     */
    private checkCommandCooldown(userId: number, command: string, cooldownSeconds: number): boolean {
        const userCooldowns = this.commandCooldowns.get(userId);
        if (!userCooldowns) {
            return true; // No cooldowns recorded for this user
        }

        const lastTimestamp = userCooldowns.get(command);
        if (!lastTimestamp) {
            return true; // No cooldown recorded for this specific command
        }

        const now = Date.now();
        const elapsedMillis = now - lastTimestamp;
        const cooldownMillis = cooldownSeconds * 1000;

        // Clean up expired entry for this specific user/command if checked and expired
        if (elapsedMillis >= cooldownMillis) {
            userCooldowns.delete(command);
            if (userCooldowns.size === 0) {
                this.commandCooldowns.delete(userId); // Clean up user map if empty
            }
            return true;
        }

        return false; // Still in cooldown
    }

    /**
     * 获取命令剩余冷却时间（秒）
     * @param userId 用户ID
     * @param command 命令名称
     * @param cooldownSeconds 总冷却时间
     * @returns 剩余冷却秒数，如果不在冷却中则返回0
     */
    private getRemainingCooldown(userId: number, command: string, cooldownSeconds: number): number {
        const userCooldowns = this.commandCooldowns.get(userId);
        if (!userCooldowns) return 0;

        const lastTimestamp = userCooldowns.get(command);
        if (!lastTimestamp) return 0;

        const now = Date.now();
        const elapsedMillis = now - lastTimestamp;
        const cooldownMillis = cooldownSeconds * 1000;
        const remainingMillis = cooldownMillis - elapsedMillis;

        return remainingMillis > 0 ? Math.ceil(remainingMillis / 1000) : 0;
    }

    /**
     * 更新命令冷却时间
     * 记录用户执行命令的时间戳，用于冷却时间检查
     * 如果记录已存在则更新时间戳，否则添加新记录
     * 
     * @param userId 用户ID
     * @param command 命令名称
     */
    private updateCommandCooldown(userId: number, command: string): void {
        const now = Date.now();

        let userCooldowns = this.commandCooldowns.get(userId);
        if (!userCooldowns) {
            userCooldowns = new Map<string, number>();
            this.commandCooldowns.set(userId, userCooldowns);
        }
        userCooldowns.set(command, now);
    }

    /**
     * 启动内存管理系统
     * 定期清理过期的缓存和未使用的数据，优化内存使用
     */
    private startMemoryManagement(): void {
        // 清除可能存在的旧定时器
        if (this.memoryCleanupTimer) {
            clearInterval(this.memoryCleanupTimer);
        }

        // 设置新的定时清理任务
        this.memoryCleanupTimer = setInterval(() => {
            try {
                log.debug('执行内存优化清理...');
                this.cleanupMemory();

                // 进行内存使用检查
                this.checkMemoryUsage();
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                log.error(`内存清理过程发生错误: ${error.message}`);
            }
        }, this.MEMORY_CLEANUP_INTERVAL);

        // 添加一次立即清理
        this.cleanupMemory();
    }

    /**
     * 检查内存使用量并进行主动优化
     * 根据内存使用情况触发不同级别的内存清理和优化
     */
    private checkMemoryUsage(): void {
        try {
            // 获取内存使用指标
            const memoryUsage = process.memoryUsage();
            const heapUsed = memoryUsage.heapUsed;
            const heapTotal = memoryUsage.heapTotal;
            const rss = memoryUsage.rss;
            const external = memoryUsage.external || 0;

            // 定义内存使用阈值
            const HEAP_WARNING_THRESHOLD = 75; // 堆内存使用率警告阈值（75%）
            const HEAP_CRITICAL_THRESHOLD = 85; // 堆内存使用率严重阈值（85%）
            const HEAP_EMERGENCY_THRESHOLD = 95; // 堆内存使用率紧急阈值（95%）
            const RSS_WARNING_THRESHOLD = 512 * 1024 * 1024; // RSS警告阈值（512MB）
            const RSS_CRITICAL_THRESHOLD = 1024 * 1024 * 1024; // RSS严重阈值（1GB）

            // 计算使用百分比
            const heapUsagePercent = (heapUsed / heapTotal) * 100;

            // 内存使用日志级别
            let logLevel = 'debug';
            let actionTaken = false;

            // 堆内存使用情况处理
            if (heapUsagePercent > HEAP_EMERGENCY_THRESHOLD) {
                logLevel = 'error';
                log.error(`🚨 内存紧急: 堆使用率 ${heapUsagePercent.toFixed(1)}% (${(heapUsed / 1024 / 1024).toFixed(2)}MB/${(heapTotal / 1024 / 1024).toFixed(2)}MB)`);

                // 紧急措施 - 主动清理缓存和触发GC
                this.commandHandlersCache.clear();
                this.recentlyUsedCommands.length = 0;
                actionTaken = true;

                // 紧急运行垃圾回收（如果可用）
                if (global.gc) {
                    try {
                        log.warn('🧹 紧急清理: 强制执行垃圾回收');
                        global.gc();
                        const afterGC = process.memoryUsage();
                        const freedMemory = (heapUsed - afterGC.heapUsed) / 1024 / 1024;
                        log.info(`垃圾回收完成，释放了 ${freedMemory.toFixed(2)}MB 堆内存`);
                    } catch (err) {
                        // 忽略GC错误
                    }
                }
            }
            else if (heapUsagePercent > HEAP_CRITICAL_THRESHOLD) {
                logLevel = 'warn';
                log.warn(`⚠️ 内存严重: 堆使用率 ${heapUsagePercent.toFixed(1)}% (${(heapUsed / 1024 / 1024).toFixed(2)}MB/${(heapTotal / 1024 / 1024).toFixed(2)}MB)`);

                // 执行更积极的内存清理
                this.cleanupMemory();
                actionTaken = true;

                // 尝试垃圾回收
                if (global.gc) {
                    try {
                        global.gc();
                    } catch (err) {
                        // 忽略GC错误
                    }
                }
            }
            else if (heapUsagePercent > HEAP_WARNING_THRESHOLD) {
                logLevel = 'warn';
                log.warn(`⚠️ 内存警告: 堆使用率 ${heapUsagePercent.toFixed(1)}% (${(heapUsed / 1024 / 1024).toFixed(2)}MB/${(heapTotal / 1024 / 1024).toFixed(2)}MB)`);
            }

            // RSS内存使用情况处理
            if (rss > RSS_CRITICAL_THRESHOLD) {
                if (logLevel !== 'error') logLevel = 'warn';
                log.warn(`⚠️ RSS内存严重: ${(rss / 1024 / 1024).toFixed(2)}MB`);

                if (!actionTaken) {
                    this.cleanupMemory();
                    actionTaken = true;
                }
            }
            else if (rss > RSS_WARNING_THRESHOLD) {
                if (logLevel === 'debug') logLevel = 'info';
                log.info(`ℹ️ RSS内存警告: ${(rss / 1024 / 1024).toFixed(2)}MB`);
            }

            // 内存泄漏检测 - 检查堆内存持续增长
            if (heapUsed > this.lastHeapUsed * 1.1) { // 增长超过10%才计数
                this.consecutiveIncreases++;
                if (this.consecutiveIncreases >= 3) {
                    log.warn(`🚨 潜在内存泄漏: 堆内存持续增长 ${this.consecutiveIncreases} 次，增长率 ${((heapUsed - this.lastHeapUsed) / this.lastHeapUsed * 100).toFixed(1)}%`);

                    // 内存泄漏时执行额外清理
                    if (this.consecutiveIncreases >= 5 && !actionTaken) {
                        log.warn('执行额外内存清理以应对可能的内存泄漏');
                        this.cleanupMemory();
                        
                        // 额外优化对象池
                        this.optimizeObjectPools(this.consecutiveIncreases >= 7);

                        // 尝试垃圾回收
                        if (global.gc) {
                            try {
                                global.gc();
                            } catch (err) {
                                // 忽略GC错误
                            }
                        }
                    }
                }
            } else {
                // 重置计数器（如果内存不再增长）
                this.consecutiveIncreases = 0;
                
                // 如果内存使用率较低，可以适当扩大对象池以提高性能
                if (heapUsagePercent < 50 && this.consecutiveIncreases === 0) {
                    // 只在调试模式下记录这个信息
                    log.debug('内存使用率较低，保持当前对象池容量');
                }
            }

            // 更新内存使用记录
            this.lastHeapUsed = heapUsed;

            // 仅在调试级别记录详细的内存使用情况
            if (logLevel === 'debug') {
                log.debug(`内存使用情况 - 堆: ${(heapUsed / 1024 / 1024).toFixed(2)}/${(heapTotal / 1024 / 1024).toFixed(2)}MB (${heapUsagePercent.toFixed(1)}%), RSS: ${(rss / 1024 / 1024).toFixed(2)}MB, 外部: ${(external / 1024 / 1024).toFixed(2)}MB`);
            }
        } catch (err) {
            // 忽略内存检查错误
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

            // 5. 积极模式下执行额外清理
            if (aggressive) {
                // 5.1 清除所有命令缓存
                const cacheSize = this.commandHandlersCache.size;
                if (cacheSize > 0) {
                    this.commandHandlersCache.clear();
                    this.recentlyUsedCommands.length = 0;
                    this.commandCacheLastUpdated = Date.now();
                    log.debug(`积极清理: 清空所有命令处理器缓存 (${cacheSize} 个条目)`);
                }

                // 5.2 重置非关键状态计数器
                this.consecutiveIncreases = 0;

                // 5.3 清理对象池，减少最大占用内存
                const poolCleaned = this.optimizeObjectPools(true);
                if (poolCleaned > 0) {
                    log.debug(`积极清理: 优化了对象池，移除了 ${poolCleaned} 个对象`);
                }

                // 5.4 尝试运行垃圾回收（如果可用）
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
                queueEntriesRemoved + configEntriesRemoved;

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
     * @param prefix 日志前缀
     */
    private logMemoryUsage(prefix: string = '当前'): void {
        try {
            const memoryUsage = process.memoryUsage();
            const formatMemory = (bytes: number): string => {
                return (bytes / 1024 / 1024).toFixed(2) + ' MB';
            };

            // 计算各种指标
            const heapTotal = formatMemory(memoryUsage.heapTotal);
            const heapUsed = formatMemory(memoryUsage.heapUsed);
            const rss = formatMemory(memoryUsage.rss);
            const external = formatMemory(memoryUsage.external || 0);
            const heapUsage = ((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100).toFixed(1) + '%';

            // 记录内存统计
            log.info(`${prefix}内存使用情况 - 堆内存: ${heapUsed}/${heapTotal} (${heapUsage}), RSS: ${rss}, 外部: ${external}`);

            // Calculate total cooldown entries
            let totalCooldowns = 0;
            this.commandCooldowns.forEach(userMap => totalCooldowns += userMap.size);

            // 记录缓存和集合的大小统计
            const stats = {
                plugins: this.plugins.size,
                eventHandlers: Array.from(this.eventHandlers.values()).reduce((sum, set) => sum + set.size, 0),
                cooldowns: totalCooldowns, // Use calculated total
                configCache: this.pluginConfigs.size,
                commandCache: this.commandHandlersCache.size,
                commandQueue: this.commandQueue.size
            };

            log.debug(`缓存统计 - 插件: ${stats.plugins}, 事件处理器: ${stats.eventHandlers}, ` +
                `冷却记录: ${stats.cooldowns}, 命令缓存: ${stats.commandCache}, ` +
                `配置缓存: ${stats.configCache}, 命令队列: ${stats.commandQueue}`);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.warn(`获取内存使用情况失败: ${error.message}`);
        }
    }

    /**
     * 清理所有过期的命令冷却记录
     */
    private cleanupCommandCooldowns(): number {
        const now = Date.now();
        let removedCount = 0;

        // Find the maximum cooldown time across all active plugins
        let maxCooldownSeconds = 60; // Default to 60 seconds
        for (const plugin of this.plugins.values()) {
            if (plugin.status === PluginStatus.ACTIVE && plugin.commands) {
                for (const cmd of plugin.commands) {
                    if (cmd.cooldown && cmd.cooldown > maxCooldownSeconds) {
                        maxCooldownSeconds = cmd.cooldown;
                    }
                }
            }
        }
        const maxCooldownMillis = maxCooldownSeconds * 1000;

        // Iterate through users and their cooldowns
        for (const [userId, userCooldowns] of this.commandCooldowns.entries()) {
            for (const [command, timestamp] of userCooldowns.entries()) {
                // Check if the cooldown has expired based on the *maximum* possible cooldown
                // This avoids needing to know the specific cooldown for each command during cleanup
                if (now - timestamp >= maxCooldownMillis) {
                    userCooldowns.delete(command);
                    removedCount++;
                }
            }
            // If a user's map becomes empty, remove the user entry
            if (userCooldowns.size === 0) {
                this.commandCooldowns.delete(userId);
            }
        }

        if (removedCount > 0) {
            log.debug(`清理了 ${removedCount} 条过期命令冷却记录`);
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
        
        // 注入时间戳属性到队列项中
        // 这需要配合processCommand方法同步修改
        for (const [userId, promiseObj] of this.commandQueue.entries()) {
            // 使用反射检查promise对象是否有creationTime属性
            const anyPromise = promiseObj as any;
            
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

        log.info('功能管理器资源清理完成');
    }

    /**
     * 根据事件处理器查找对应的插件名称
     * @param event 事件处理器
     * @returns 插件名称，如果找不到则返回undefined
     * @private
     */
    private findPluginByEvent(event: PluginEvent): string | undefined {
        for (const [pluginName, plugin] of this.plugins.entries()) {
            if (plugin.events && plugin.events.includes(event)) {
                return pluginName;
            }
        }
        return undefined;
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
        
        // 根据内存压力确定目标池大小
        // 正常模式保留75%，积极模式保留50%
        const retentionFactor = aggressive ? 0.5 : 0.75;
        const targetPoolSize = Math.max(10, Math.floor(this.POOL_SIZE * retentionFactor));
        
        // 遍历所有对象池执行优化
        for (const poolName in this.objectPools) {
            const pool = this.objectPools[poolName as keyof typeof this.objectPools];
            
            // 如果池大小超过目标值，缩减它
            if (pool.length > targetPoolSize) {
                const removeCount = pool.length - targetPoolSize;
                pool.length = targetPoolSize;
                totalRemoved += removeCount;
            }
        }
        
        if (totalRemoved > 0) {
            log.debug(`优化对象池: 移除了 ${totalRemoved} 个对象` + (aggressive ? ' (积极模式)' : ''));
        }
        
        return totalRemoved;
    }
}
