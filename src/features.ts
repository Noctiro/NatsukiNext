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
import { CallbackDataBuilder } from './utils/callback';

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

// 命令执行冷却记录 - 不再需要接口，直接使用 Map 结构
// interface CommandCooldown {
//     userId: number;
//     command: string;
//     timestamp: number;
// }

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
 * 整个系统采用分层设计，确保代码结构清晰、易于维护，并提供高性能的事件和命令处理能力。
 */
export class Features {
    private plugins = new Map<string, BotPlugin>();
    private dispatcher: Dispatcher;
    private eventHandlers = new Map<string, Set<PluginEvent>>();
    // 权限管理器实例
    private permissionManager!: PermissionManager;
    // 命令冷却时间跟踪: Map<userId, Map<commandName, timestamp>>
    private commandCooldowns: Map<number, Map<string, number>> = new Map();
    // 插件配置缓存
    private pluginConfigs = new Map<string, any>();
    // 命令处理器缓存，加速命令查找
    private commandHandlersCache = new Map<string, { plugin: BotPlugin, cmd: PluginCommand }[]>();
    // 缓存上次更新时间，用于定期刷新缓存
    private commandCacheLastUpdated = 0;
    // 缓存过期时间（毫秒）
    private readonly COMMAND_CACHE_TTL = 30000; // 30秒
    // 命令请求队列，防止并发处理同一用户的多个命令
    private commandQueue = new Map<number, Promise<void>>();
    // 最近使用的命令缓存容量
    private readonly CACHE_MAX_SIZE = 50;
    // 最近使用的命令列表（按使用顺序存储，最新使用的在前面）
    private recentlyUsedCommands: string[] = [];
    // 命令执行超时时间（毫秒）
    private readonly COMMAND_TIMEOUT = 180000; // 3分钟
    // 内存清理间隔（毫秒）
    private readonly MEMORY_CLEANUP_INTERVAL = 600000; // 10分钟
    // 内存清理定时器
    private memoryCleanupTimer?: ReturnType<typeof setInterval>;
    // 内存泄漏检测 - 上次堆内存使用量
    private lastHeapUsed = 0;
    // 内存泄漏检测 - 连续增长次数
    private consecutiveIncreases = 0;

    /**
     * 创建功能管理器实例
     * @param client Telegram客户端实例
     * @param pluginsDir 插件目录路径
     * @param configDir 配置目录路径
     */
    constructor(
        private readonly client: TelegramClient,
        private readonly pluginsDir: string = path.join(__dirname, './plugins/'),
        private readonly configDir: string = path.join(__dirname, './config/')
    ) {
        this.dispatcher = Dispatcher.for(client);
        this.eventHandlers.set('message', new Set());
        this.eventHandlers.set('command', new Set());
        this.eventHandlers.set('callback', new Set());
    }

    /**
     * 确保配置目录存在
     * @private
     */
    private async ensureConfigDir() {
        try {
            await pathUtils.ensureDir(this.configDir);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`创建配置目录失败: ${error.message}`);
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
     * @param name 插件名称
     * @returns 是否成功禁用
     */
    async disablePlugin(name: string): Promise<boolean> {
        try {
            const plugin = this.plugins.get(name);
            if (!plugin) {
                log.warn(`插件 ${name} 未找到`);
                return false;
            }

            // 如果插件已经禁用，直接返回
            if (plugin.status === PluginStatus.DISABLED) {
                plugin.logger?.debug(`插件已处于禁用状态`);
                return true;
            }

            plugin.logger?.info(`正在禁用插件...`);

            // 检查其他插件依赖
            for (const [otherName, otherPlugin] of this.plugins.entries()) {
                // 跳过禁用状态的插件
                if (otherPlugin.status !== PluginStatus.ACTIVE || otherName === name) {
                    continue;
                }

                // 如果另一个插件依赖此插件，无法禁用
                if (otherPlugin.dependencies?.includes(name)) {
                    plugin.logger?.warn(`无法禁用: 插件 ${otherName} 依赖于此插件`);
                    return false;
                }
            }

            // 调用插件的卸载回调
            try {
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
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`禁用插件 ${name} 时出错: ${error.message}`);
            return false;
        }
    }

    /**
     * 获取插件配置。
     * 会合并传入的默认配置、插件定义的默认配置（如果未传入）以及用户保存的配置。
     * 优先级：用户保存配置 > 传入的默认配置 > 插件定义的默认配置 > 空对象。
     * @param pluginName 插件名称
     * @param providedDefaultConfig (可选) 调用时传入的默认配置对象。
     * @returns 合并后的插件配置对象。如果无法读取或解析配置，会尽量返回基于默认值的配置。
     */
    async getPluginConfig<T extends Record<string, any>>(
        pluginName: string,
        providedDefaultConfig?: Partial<T> // 添加可选的默认配置参数
    ): Promise<T> { // 返回值改为 T，因为总会返回一个配置（至少是默认的）
        // 如果配置已缓存，直接返回
        if (this.pluginConfigs.has(pluginName)) {
            // 确保缓存的类型是正确的，虽然理论上应该是
            return this.pluginConfigs.get(pluginName) as T;
        }

        // 确定基础默认配置：优先使用传入的，否则为空对象
        const baseDefaultConfig = providedDefaultConfig ?? {};

        let savedConfig: Partial<T> = {};

        try {
            const configPath = path.join(this.configDir, `${pluginName}.json`);

            // 检查文件是否存在
            if (await pathUtils.fileExists(configPath)) {
                const content = await fs.readFile(configPath, 'utf-8');
                try {
                    savedConfig = JSON.parse(content) as Partial<T>;
                } catch (parseError) {
                    const pError = parseError instanceof Error ? parseError : new Error(String(parseError));
                    log.warn(`解析插件 ${pluginName} 配置文件失败: ${pError.message}。将使用默认配置。`);
                    // 如果解析失败，savedConfig 保持为空对象，后续会使用 defaultConfig
                }
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`读取插件 ${pluginName} 配置文件时出错: ${error.message}`);
            // 出错时，savedConfig 保持为空对象，后续合并时会基于 baseDefaultConfig
        }

        // 合并默认配置和保存的配置 (保存的配置覆盖默认配置)
        // 使用 structuredClone 来确保深拷贝，避免意外修改默认配置源对象
        const finalConfig = { ...structuredClone(baseDefaultConfig), ...savedConfig } as T;

        // 缓存最终配置
        this.pluginConfigs.set(pluginName, finalConfig);

        // 保证总能返回一个配置对象
        return finalConfig;
    }

    /**
     * 保存插件配置
     * @param pluginName 插件名称
     * @param config 配置对象
     * @returns 是否保存成功
     */
    async savePluginConfig(pluginName: string, config: any): Promise<boolean> {
        try {
            // 确保配置目录存在
            await this.ensureConfigDir();

            const configPath = path.join(this.configDir, `${pluginName}.json`);
            const configJson = JSON.stringify(config, null, 2);

            await fs.writeFile(configPath, configJson, 'utf-8');

            // 更新缓存为当前保存的完整配置
            this.pluginConfigs.set(pluginName, config);

            log.info(`插件 ${pluginName} 配置已保存`);
            return true;
        } catch (err) {
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
            // 按优先级排序事件处理器（优先级高的先执行）
            const sortedHandlers = Array.from(handlers)
                .sort((a, b) => (b.priority || 0) - (a.priority || 0));

            // 将相同优先级的处理器分组，以便并行执行
            const priorityGroups: Map<number, PluginEvent[]> = new Map();

            for (const handler of sortedHandlers) {
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

                // 创建处理器的执行任务数组
                const tasks = handlersInPriority.map(handler => async () => {
                    try {
                        // 首先快速检查过滤器
                        if (handler.filter && !handler.filter(context)) {
                            return;
                        }
                        
                        // 检查回调事件的name匹配
                        if (type === 'callback' && handler.name && context.type === 'callback') {
                            const callbackContext = context as CallbackEventContext;
                            if (!callbackContext.data) return;
                            
                            const parts = callbackContext.data.split(':');
                            
                            // 至少需要两部分 - 插件名:功能名
                            if (parts.length < 2) return;
                            
                            // 第一部分是插件名，第二部分是功能名
                            // 如果功能名不匹配，则跳过
                            if (parts[1] !== handler.name) return;
                            
                            // 如果匹配，为context添加match属性
                            // 从第3个部分开始解析参数
                            const pluginName = parts[0];
                            const actionType = parts[1];
                            const paramParts = parts.slice(2);
                            
                            // 创建match对象，包含基础元数据
                            (callbackContext as any).match = {
                                _pluginName: pluginName,
                                _actionType: actionType
                            };
                            
                            // 解析参数
                            for (let i = 0; i < paramParts.length; i++) {
                                const value = paramParts[i];
                                if (!value) continue; // 跳过空值
                                
                                // 按参数位置添加到match对象
                                if (value === 'true') {
                                    // 布尔值 - true
                                    (callbackContext as any).match[`_param${i}`] = true;
                                } else if (value === 'false') {
                                    // 布尔值 - false
                                    (callbackContext as any).match[`_param${i}`] = false;
                                } else if (/^\d+$/.test(value)) {
                                    // 数字
                                    (callbackContext as any).match[`_param${i}`] = parseInt(value, 10);
                                } else {
                                    // 字符串
                                    (callbackContext as any).match[`_param${i}`] = value;
                                }
                            }
                        }

                        // 使用超时保护，防止事件处理器无限阻塞
                        const timeoutPromise = new Promise<void>((_, reject) => {
                            setTimeout(() => {
                                reject(new Error(`事件处理器超时 (${type})`));
                            }, 10000); // 10秒超时
                        });

                        // 执行事件处理器
                        await Promise.race([
                            handler.handler(context),
                            timeoutPromise
                        ]);
                    } catch (err) {
                        const error = err instanceof Error ? err : new Error(String(err));
                        log.error(`事件处理器错误 (${type}): ${error.message}`);
                        if (error.stack) {
                            log.debug(`错误堆栈: ${error.stack}`);
                        }
                    }
                });

                // 使用Promise.all执行所有任务，但包装在try-catch中以避免单个任务失败导致整批失败
                try {
                    await Promise.all(tasks.map(task => task()));
                } catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    log.error(`优先级${priority}的事件处理组执行错误: ${error.message}`);
                }
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`事件分发处理错误 (${type}): ${error.message}`);
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
                    log.error(`消息处理错误: ${error.message}`);
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
                    log.error(`回调查询处理错误: ${error.message}`);
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

        this.commandQueue.set(userId, commandPromise);

        try {
            // 设置命令处理超时
            const timeoutId = setTimeout(() => {
                rejectFn(new Error('命令处理超时'));
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
                        reject(new Error('命令执行超时'));
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
                log.error(`命令 ${command} 执行出错 (插件: ${plugin.name}): ${error.message}`);
                if (error.stack) {
                    log.debug(`错误堆栈: ${error.stack}`);
                }

                await ctx.replyText(`❌ 命令执行出错: ${error.message}`).catch(() => { });
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`命令处理错误: ${error.message}`);
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
        // 检查缓存是否有效
        const now = Date.now();
        if (
            this.commandHandlersCache.has(command) &&
            now - this.commandCacheLastUpdated < this.COMMAND_CACHE_TTL
        ) {
            // 更新最近使用命令列表（LRU缓存策略）
            this.updateRecentlyUsedCommands(command);
            return this.commandHandlersCache.get(command) || [];
        }

        // 如果距离上次更新超过缓存过期时间，清空整个缓存
        if (now - this.commandCacheLastUpdated >= this.COMMAND_CACHE_TTL) {
            this.commandHandlersCache.clear();
            this.recentlyUsedCommands = [];
            this.commandCacheLastUpdated = now;
        }

        const commandHandlers: { plugin: BotPlugin, cmd: PluginCommand }[] = [];

        // 从所有活跃插件中查找匹配的命令
        for (const plugin of this.plugins.values()) {
            if (plugin.status !== PluginStatus.ACTIVE || !plugin.commands) continue;

            for (const cmd of plugin.commands) {
                try {
                    if (cmd.name === command || (cmd.aliases && cmd.aliases.includes(command))) {
                        commandHandlers.push({ plugin, cmd });
                    }
                } catch (err) {
                    // 捕获错误避免影响循环
                    const error = err instanceof Error ? err : new Error(String(err));
                    log.error(`查找命令处理器时出错: ${error.message}`);
                    continue;
                }
            }
        }

        // 缓存结果
        this.commandHandlersCache.set(command, commandHandlers);
        this.updateRecentlyUsedCommands(command);

        return commandHandlers;
    }

    /**
     * 更新最近使用的命令列表（LRU缓存策略）
     * 该方法实现了Least Recently Used（最近最少使用）缓存淘汰策略
     * 最近使用的命令会被移到列表开头，当列表超过最大容量时，
     * 最少使用的命令及其缓存会被移除
     * 
     * @param command 命令名称
     */
    private updateRecentlyUsedCommands(command: string): void {
        // 移除已存在的相同命令（如果存在）
        this.recentlyUsedCommands = this.recentlyUsedCommands.filter(cmd => cmd !== command);

        // 将命令添加到列表开头，表示最近使用
        this.recentlyUsedCommands.unshift(command);

        // 如果列表超过最大容量，删除最旧的命令及其缓存
        if (this.recentlyUsedCommands.length > this.CACHE_MAX_SIZE) {
            const oldestCommand = this.recentlyUsedCommands.pop();
            if (oldestCommand) {
                // 同时从缓存中删除该命令的处理器
                this.commandHandlersCache.delete(oldestCommand);
            }
        }
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

            // 确定实际插件名称（无扩展名）
            let actualName = normalizedName;
            if (actualName.endsWith('.ts') || actualName.endsWith('.js')) {
                actualName = actualName.replace(/\.(ts|js)$/, '');
            }

            // 查找插件文件路径
            let pluginPath = '';

            // 尝试确定文件扩展名
            if (!normalizedName.endsWith('.ts') && !normalizedName.endsWith('.js')) {
                // 定义可能的扩展名列表，优先尝试.ts
                const possibleExts = ['.ts', '.js'];
                let found = false;

                for (const ext of possibleExts) {
                    const testPath = path.join(this.pluginsDir, `${normalizedName}${ext}`);
                    if (await pathUtils.fileExists(testPath)) {
                        pluginPath = testPath;
                        found = true;
                        break;
                    }
                }

                if (!found) {
                    log.warn(`找不到插件文件: ${normalizedName}`);
                    return false;
                }
            } else {
                // 已经有扩展名，直接使用
                pluginPath = path.join(this.pluginsDir, normalizedName);
                if (!await pathUtils.fileExists(pluginPath)) {
                    log.warn(`找不到插件文件: ${pluginPath}`);
                    return false;
                }
            }

            // 标准化最终路径（确保在所有平台上都使用正斜杠）
            pluginPath = pathUtils.normalize(pluginPath);
            log.debug(`插件路径: ${pluginPath}`);

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
            this.recentlyUsedCommands = [];
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
                return false;
            }

            // Use dynamic import with a timestamp to bypass cache for checking
            const importPathWithCacheBust = `${filePath}?check=${Date.now()}`;

            // 尝试导入文件
            const module = await import(importPathWithCacheBust);

            // 检查是否有默认导出和必要属性
            const plugin = module.default;
            if (!plugin ||
                typeof plugin !== 'object' ||
                !plugin.name) {
                return false;
            }

            // 检查是否包含插件必要的功能
            const hasPluginFeatures =
                (plugin.commands && Array.isArray(plugin.commands)) ||
                (plugin.events && Array.isArray(plugin.events)) ||
                typeof plugin.onLoad === 'function';

            return hasPluginFeatures;
        } catch (err) {
            // 导入出错，不是有效插件
            if (err instanceof Error && err.message) {
                log.debug(`插件文件验证错误 (${filePath}): ${err.message}`);
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

            // 并行处理所有文件和子目录，提高性能
            const processPromises = files.map(async (file) => {
                const fullPath = path.join(dir, file);

                try {
                    // 检查是否是目录
                    if (await pathUtils.dirExists(fullPath)) {
                        // 递归扫描子目录
                        const subDirPlugins = await this.scanPluginsDir(fullPath);
                        return subDirPlugins; // 返回子目录的结果
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

                            log.debug(`发现有效插件: ${pluginName}`);
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
     * 检查内存使用量并发出警告
     * 当内存使用超过某些阈值时记录警告
     */
    private checkMemoryUsage(): void {
        try {
            const memoryUsage = process.memoryUsage();
            const heapUsed = memoryUsage.heapUsed;
            const heapTotal = memoryUsage.heapTotal;
            const rss = memoryUsage.rss;

            // 计算使用百分比
            const heapUsagePercent = (heapUsed / heapTotal) * 100;

            // 一些合理的阈值（可以根据实际需求调整）
            const HEAP_WARNING_THRESHOLD = 80; // 堆内存使用率警告阈值（80%）
            const RSS_WARNING_THRESHOLD = 1024 * 1024 * 1024; // RSS警告阈值（1GB）

            // 检查并记录警告
            if (heapUsagePercent > HEAP_WARNING_THRESHOLD) {
                log.warn(`⚠️ 高堆内存使用: ${heapUsagePercent.toFixed(1)}% (${(heapUsed / 1024 / 1024).toFixed(2)}MB/${(heapTotal / 1024 / 1024).toFixed(2)}MB)`);

                // 如果堆使用率超过90%，尝试主动触发GC
                if (heapUsagePercent > 90 && global.gc) {
                    log.warn('🧹 堆内存使用率超过90%，尝试执行紧急垃圾回收');
                    try {
                        global.gc();

                        // 检查GC后的内存使用情况
                        const afterGC = process.memoryUsage();
                        const freedMemory = (heapUsed - afterGC.heapUsed) / 1024 / 1024;
                        log.info(`垃圾回收完成，释放了 ${freedMemory.toFixed(2)}MB 堆内存`);
                    } catch (err) {
                        log.debug('手动垃圾回收失败，忽略');
                    }
                }
            }

            if (rss > RSS_WARNING_THRESHOLD) {
                log.warn(`⚠️ 高RSS内存使用: ${(rss / 1024 / 1024).toFixed(2)}MB`);
            }

            // 添加潜在内存泄漏检测
            // 如果堆内存使用持续增长，可能存在内存泄漏
            if (heapUsed > this.lastHeapUsed) {
                this.consecutiveIncreases++;
                if (this.consecutiveIncreases >= 5) {
                    log.warn(`🚨 检测到潜在内存泄漏：堆内存持续增长 ${this.consecutiveIncreases} 次`);
                }
            } else {
                this.consecutiveIncreases = 0;
            }

            this.lastHeapUsed = heapUsed;
        } catch (err) {
            // 忽略错误
        }
    }

    /**
     * 全面内存清理方法
     * 清理各种缓存和未使用的数据结构
     */
    public cleanupMemory(): void {
        const startTime = Date.now();

        // 1. 清理命令冷却记录
        this.cleanupCommandCooldowns();

        // 2. 清理命令处理器缓存
        this.cleanupCommandCache();

        // 3. 清理命令队列中悬挂的请求
        this.cleanupCommandQueue();

        // 4. 清理插件配置缓存
        this.cleanupPluginConfigCache();

        // 记录内存使用情况
        this.logMemoryUsage();

        // 记录执行时间，用于性能监控
        const duration = Date.now() - startTime;
        log.debug(`内存清理完成，耗时 ${duration}ms`);

        // 主动触发垃圾回收（仅建议，实际效果取决于JavaScript引擎）
        if (global.gc) {
            try {
                global.gc();
                log.debug('手动触发垃圾回收');

                // 再次记录内存使用情况，用于对比
                this.logMemoryUsage('GC后');
            } catch (err) {
                log.debug('手动垃圾回收失败，忽略');
            }
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
    private cleanupCommandCooldowns(): void {
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
    }

    /**
     * 清理命令处理器缓存
     */
    private cleanupCommandCache(): void {
        const now = Date.now();

        // 如果缓存已经过期，完全清空
        if (now - this.commandCacheLastUpdated >= this.COMMAND_CACHE_TTL) {
            const size = this.commandHandlersCache.size;
            this.commandHandlersCache.clear();
            this.recentlyUsedCommands = [];
            this.commandCacheLastUpdated = now;

            if (size > 0) {
                log.debug(`清空了 ${size} 个命令处理器缓存条目`);
            }
        }
        // 否则只清理超出容量的部分
        else if (this.commandHandlersCache.size > this.CACHE_MAX_SIZE) {
            // 获取需要保留的命令列表
            const keepCommands = new Set(this.recentlyUsedCommands.slice(0, this.CACHE_MAX_SIZE));

            // 计算要删除的命令数量
            let deletedCount = 0;

            // 遍历并删除不在保留列表中的缓存
            for (const cmd of this.commandHandlersCache.keys()) {
                if (!keepCommands.has(cmd)) {
                    this.commandHandlersCache.delete(cmd);
                    deletedCount++;
                }
            }

            if (deletedCount > 0) {
                log.debug(`清理了 ${deletedCount} 个过期命令处理器缓存条目`);
            }

            // 更新最近使用命令列表，只保留在keepCommands中的命令
            this.recentlyUsedCommands = this.recentlyUsedCommands.filter(cmd => keepCommands.has(cmd));
        }
    }

    /**
     * 清理挂起的命令队列
     */
    private cleanupCommandQueue(): void {
        // Note: Checking promise state externally is unreliable.
        // A better approach might involve timeouts or explicit state tracking
        // within the promise handling logic itself.
        // For now, this cleanup is minimal.
        // Consider adding a timestamp to queue entries and cleaning old ones.
        let cleanedCount = 0;
        // Example: If promises had a 'creationTime' property
        // const now = Date.now();
        // const MAX_QUEUE_AGE = this.COMMAND_TIMEOUT * 2; // e.g., 6 minutes
        // for (const [userId, promiseInfo] of this.commandQueue.entries()) {
        //     if (now - promiseInfo.creationTime > MAX_QUEUE_AGE) {
        //         this.commandQueue.delete(userId);
        //         cleanedCount++;
        //         log.warn(`清理了可能悬挂的命令队列项 (用户: ${userId})`);
        //     }
        // }
        if (cleanedCount > 0) {
            log.debug(`清理了 ${cleanedCount} 个可能悬挂的命令队列项`);
        }
    }

    /**
     * 清理插件配置缓存
     * 只保留活跃插件的配置
     */
    private cleanupPluginConfigCache(): void {
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
}
