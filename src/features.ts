import fs from 'fs/promises';
import path from 'path';
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
import { PermissionManager, type Permission, type PermissionGroup } from './permissions';

// 扩展 TelegramClient 类型，以便在整个应用中访问features实例
declare module '@mtcute/bun' {
    interface TelegramClient {
        features: Features;
    }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
}

// 事件上下文联合类型
export type EventContext = CommandContext | MessageEventContext | CallbackEventContext;

// 事件处理器类型
export type EventHandler<T extends EventContext = EventContext> = (context: T) => Promise<void>;

// 插件事件定义
export interface PluginEvent<T extends EventContext = EventContext> {
    type: T['type'];
    filter?: (ctx: EventContext) => boolean;
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
}

// 命令执行冷却记录
interface CommandCooldown {
    userId: number;
    command: string;
    timestamp: number;
}

/**
 * 功能管理器类
 * 负责插件加载、事件分发、权限管理等核心功能
 */
export class Features {
    private plugins = new Map<string, BotPlugin>();
    private dispatcher: Dispatcher;
    private eventHandlers = new Map<string, Set<PluginEvent>>();
    // 权限管理器实例
    private permissionManager!: PermissionManager;
    // 命令冷却时间跟踪
    private commandCooldowns: CommandCooldown[] = [];
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
    // 最近使用的命令
    private recentlyUsedCommands: string[] = [];

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
            await fs.mkdir(this.configDir, { recursive: true });
        } catch (err) {
            log.error('Failed to create config directory:', err);
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
                log.debug(`Plugin ${name} is already enabled`);
                return true;
            }

            log.info(`Enabling plugin: ${name}`);

            // 检查依赖
            if (plugin.dependencies && plugin.dependencies.length > 0) {
                for (const dependency of plugin.dependencies) {
                    let dep = this.plugins.get(dependency);

                    // 如果依赖不存在并且允许自动加载
                    if (!dep && autoLoadDependencies) {
                        log.info(`Auto-loading dependency plugin: ${dependency}`);
                        const loadSuccess = await this.loadPlugin(dependency, true);
                        if (loadSuccess) {
                            dep = this.plugins.get(dependency);
                        }
                    }

                    // 确认依赖存在并已启用
                    if (!dep) {
                        log.error(`Dependency ${dependency} not found for plugin ${name}`);
                        plugin.status = PluginStatus.ERROR;
                        plugin.error = `Dependency ${dependency} not found`;
                        return false;
                    }

                    if (dep.status !== PluginStatus.ACTIVE) {
                        // 递归启用依赖
                        const success = await this.enablePlugin(dependency, autoLoadDependencies);
                        if (!success) {
                            log.error(`Failed to enable dependency ${dependency} for plugin ${name}`);
                            plugin.status = PluginStatus.ERROR;
                            plugin.error = `Failed to enable dependency ${dependency}`;
                            return false;
                        }
                    }
                }
            }

            // 执行插件的onLoad方法
            try {
                if (plugin.onLoad) {
                    await plugin.onLoad(this.client);
                }

                // 注册插件事件处理器
                this.registerPluginEvents(plugin);

                // 如果有命令，注册命令处理器
                if (plugin.commands?.length) {
                    log.debug(`Registering ${plugin.commands.length} commands for plugin ${name}`);
                }

                // 设置插件状态为启用
                plugin.status = PluginStatus.ACTIVE;
                plugin.error = undefined;

                log.info(`Plugin ${name} successfully enabled`);
                return true;
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                log.error(`Failed to initialize plugin ${name}: ${error.message}`);
                if (error.stack) {
                    log.debug(`Error stack: ${error.stack}`);
                }

                plugin.status = PluginStatus.ERROR;
                plugin.error = error.message;
                return false;
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`Error enabling plugin ${name}: ${error.message}`);
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
                log.warn(`Plugin ${name} not found`);
                return false;
            }

            // 如果插件已经禁用，直接返回
            if (plugin.status === PluginStatus.DISABLED) {
                log.debug(`Plugin ${name} is already disabled`);
                return true;
            }

            log.info(`Disabling plugin: ${name}`);

            // 检查其他插件依赖
            for (const [otherName, otherPlugin] of this.plugins.entries()) {
                // 跳过禁用状态的插件
                if (otherPlugin.status !== PluginStatus.ACTIVE || otherName === name) {
                    continue;
                }

                // 如果另一个插件依赖此插件，无法禁用
                if (otherPlugin.dependencies?.includes(name)) {
                    log.warn(`Cannot disable plugin ${name}: plugin ${otherName} depends on it`);
                    return false;
                }
            }

            // 调用插件的卸载回调
            try {
                if (plugin.onUnload) {
                    await plugin.onUnload();
                }

                // 卸载事件处理器
                this.unregisterPluginEvents(plugin);

                // 更新插件状态
                plugin.status = PluginStatus.DISABLED;
                plugin.error = undefined;

                log.info(`Plugin ${name} successfully disabled`);
                return true;
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                log.error(`Error disabling plugin ${name}: ${error.message}`);
                if (error.stack) {
                    log.debug(`Error stack: ${error.stack}`);
                }

                // 更新插件状态为错误
                plugin.status = PluginStatus.ERROR;
                plugin.error = error.message;
                return false;
            }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`Error disabling plugin ${name}: ${error.message}`);
            return false;
        }
    }

    /**
     * 获取插件配置
     * @param pluginName 插件名称
     * @returns 插件配置对象
     */
    async getPluginConfig<T>(pluginName: string): Promise<T | null> {
        // 如果配置已缓存，直接返回
        if (this.pluginConfigs.has(pluginName)) {
            return this.pluginConfigs.get(pluginName) as T;
        }

        try {
            const configPath = path.join(this.configDir, `${pluginName}.json`);

            // 检查文件是否存在
            try {
                await fs.access(configPath);
            } catch (err) {
                // 文件不存在，返回null
                return null;
            }

            const content = await fs.readFile(configPath, 'utf-8');
            const config = JSON.parse(content) as T;

            // 缓存配置
            this.pluginConfigs.set(pluginName, config);

            return config;
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`读取插件 ${pluginName} 配置失败: ${error.message}`);
            return null;
        }
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

            // 更新缓存
            this.pluginConfigs.set(pluginName, config);

            log.debug(`插件 ${pluginName} 配置已保存`);
            return true;
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`保存插件 ${pluginName} 配置失败: ${error.message}`);
            return false;
        }
    }

    /**
     * 处理事件分发
     * @param type 事件类型
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
        this.dispatcher.onCallbackQuery(async (ctx: CallbackQueryContext) => {
            try {
                const data = ctx.data?.toString();
                if (!data) return;

                // 创建回调查询事件上下文
                const context: CallbackEventContext = {
                    type: 'callback',
                    client: this.client,
                    chatId: ctx.chat.id,
                    query: ctx,
                    data,
                    hasPermission: (permission) => this.hasPermission(ctx.chat.id, permission),
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
     * 处理命令消息
     * @param ctx 消息上下文
     */
    private async processCommand(ctx: MessageContext) {
        // 获取用户ID
        const userId = ctx.sender?.id;
        
        // 如果无法获取用户ID，直接处理
        if (!userId) {
            await this.executeCommand(ctx);
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
        let resolveFn: () => void = () => {};
        let rejectFn: (error: Error) => void = () => {};
        
        const commandPromise = new Promise<void>((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
        });
        
        this.commandQueue.set(userId, commandPromise);
        
        try {
            // 设置命令处理超时
            const timeoutId = setTimeout(() => {
                rejectFn(new Error('命令处理超时'));
            }, 30000); // 30秒超时
            
            // 执行命令
            await this.executeCommand(ctx);
            
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
     * 执行命令的实际逻辑
     * @param ctx 消息上下文
     */
    private async executeCommand(ctx: MessageContext) {
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
                            const lastCmd = this.commandCooldowns.find(
                                c => c.userId === userId && c.command === cmd.name
                            );

                            const remainingSecs = lastCmd
                                ? Math.ceil((cmd.cooldown - (Date.now() - lastCmd.timestamp) / 1000))
                                : cmd.cooldown;

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
                    }, 20000); // 20秒超时
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
     * @param command 命令名称
     * @returns 命令处理器数组
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
     * @param command 命令名称
     */
    private updateRecentlyUsedCommands(command: string): void {
        // 移除已存在的相同命令
        this.recentlyUsedCommands = this.recentlyUsedCommands.filter(cmd => cmd !== command);
        // 将命令添加到列表开头
        this.recentlyUsedCommands.unshift(command);
        
        // 如果列表超过最大容量，删除最旧的命令及其缓存
        if (this.recentlyUsedCommands.length > this.CACHE_MAX_SIZE) {
            const oldestCommand = this.recentlyUsedCommands.pop();
            if (oldestCommand) {
                this.commandHandlersCache.delete(oldestCommand);
            }
        }
    }

    /**
     * 注册插件事件处理器
     * @param plugin 插件对象
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
     * @param plugin 插件对象
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
     * @param pluginName 插件名称
     * @param autoEnable 是否自动启用
     * @returns 是否成功加载
     */
    async loadPlugin(pluginName: string, autoEnable: boolean = true): Promise<boolean> {
        try {
            log.info(`Loading plugin: ${pluginName}`);

            // 确定插件文件的扩展名
            const ext = pluginName.endsWith('.ts') || pluginName.endsWith('.js')
                ? ''
                : (await fs.access(path.join(this.pluginsDir, `${pluginName}.ts`))
                    .then(() => '.ts')
                    .catch(() => '.js'));

            const pluginPath = path.join(this.pluginsDir, `${pluginName}${ext}`);
            const actualName = path.basename(pluginName, ext);

            log.debug(`Plugin path: ${pluginPath}`);

            // 如果已加载，先禁用
            if (this.plugins.has(actualName)) {
                log.info(`Plugin ${actualName} already exists, disabling first`);
                await this.disablePlugin(actualName);
                this.plugins.delete(actualName);
            }

            // 清除缓存以确保获取最新版本
            try {
                const nodeRequire = typeof require !== 'undefined' ? require : null;
                if (nodeRequire) {
                    delete nodeRequire.cache[nodeRequire.resolve(pluginPath)];
                }
            } catch (e) {
                // 忽略未找到的模块
                log.debug(`Error clearing module cache: ${e}`);
            }

            // 添加时间戳以防止缓存
            const timestampedPath = `${pluginPath}?update=${Date.now()}`;

            // 加载插件
            const success = await this.loadSinglePlugin(actualName, timestampedPath, autoEnable);

            if (!success) {
                log.warn(`Failed to load plugin ${pluginName}`);
                return false;
            }

            return true;
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`Failed to load plugin ${pluginName}: ${error.message}`);
            if (error.stack) {
                log.debug(`Error stack: ${error.stack}`);
            }
            return false;
        }
    }

    /**
     * 加载单个插件
     * @param name 插件名称或文件名
     * @param pluginPath 插件路径
     * @param autoEnable 是否自动启用
     * @returns 是否成功加载
     */
    private async loadSinglePlugin(name: string, pluginPath: string, autoEnable: boolean = false): Promise<boolean> {
        try {
            log.info(`Loading plugin from: ${pluginPath}`);

            // 获取插件模块
            const module = await import(pluginPath);
            const plugin: BotPlugin = module.default;

            // 如果没有默认导出，或者不是合法的插件对象
            if (!plugin || !plugin.name) {
                log.error(`Invalid plugin module: ${name}, no valid plugin object exported`);
                return false;
            }

            // 使用插件自己的名称而不是文件名
            const actualName = plugin.name;

            // 检查插件名称是否已经存在
            if (this.plugins.has(actualName)) {
                log.warn(`Plugin ${actualName} is already loaded`);
                return false;
            }

            // 设置默认状态
            plugin.status = PluginStatus.DISABLED;

            // 注册插件
            this.plugins.set(actualName, plugin);
            log.info(`Loaded plugin: ${actualName} ${plugin.version || ''}`);

            // 注册插件的权限（如果有）
            if (plugin.permissions && plugin.permissions.length > 0) {
                try {
                    for (const permission of plugin.permissions) {
                        this.permissionManager.registerPermission(permission);
                    }
                    log.debug(`Registered ${plugin.permissions.length} permissions for plugin ${actualName}`);
                } catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    log.warn(`Failed to register permissions for plugin ${actualName}: ${error.message}`);
                }
            }

            // 自动启用插件(如果指定)
            if (autoEnable) {
                return await this.enablePlugin(actualName, true);
            }

            return true;
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`Failed to load plugin ${name}: ${error.message}`);
            if (error.stack) {
                log.debug(`Error stack: ${error.stack}`);
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
     * 加载所有插件
     * @private
     */
    private async loadPlugins(): Promise<void> {
        const startTime = Date.now();
        log.info('开始加载插件...');

        try {
            // 获取已安装的插件文件列表
            const pluginDir = this.pluginsDir;

            // 读取目录内容
            let files: string[] = [];
            try {
                files = await fs.readdir(pluginDir);
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                log.error(`读取插件目录失败: ${error.message}`);
                return;
            }

            // 过滤出.ts文件和.js文件
            const pluginFiles = files
                .filter((file: string) => file.endsWith('.ts') || file.endsWith('.js'))
                .map((file: string) => {
                    const fileName = path.basename(file);
                    const ext = path.extname(file);
                    const name = path.basename(fileName, ext);
                    const pluginPath = path.join(pluginDir, file);
                    return { name, path: pluginPath };
                });

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

            // 第二阶段：按依赖顺序并行启用插件
            log.info('阶段 2/2: 启用插件...');
            const enableStageStartTime = Date.now();
            
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
            
            const enableStageDuration = Date.now() - enableStageStartTime;
            log.info(`插件启用阶段完成，启用了 ${totalEnabled} 个插件，用时 ${enableStageDuration}ms`);

            // 统计加载的插件数量和状态
            const loadedPlugins = this.plugins.size;
            const activePlugins = Array.from(this.plugins.values()).filter(p => p && p.status === PluginStatus.ACTIVE).length;
            const errorPlugins = Array.from(this.plugins.values()).filter(p => p && p.status === PluginStatus.ERROR).length;
            const disabledPlugins = Array.from(this.plugins.values()).filter(p => p && p.status === PluginStatus.DISABLED).length;

            const totalDuration = Date.now() - startTime;
            log.info(`插件加载完成。共加载 ${loadedPlugins} 个插件，${activePlugins} 个启用，${errorPlugins} 个错误，${disabledPlugins} 个禁用。总用时: ${totalDuration}ms`);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`插件加载过程错误: ${error.message}`);
            if (error.stack) {
                log.debug(`错误堆栈: ${error.stack}`);
            }
        }
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
     * @param userId 用户ID
     * @param command 命令名称
     * @param cooldownSeconds 冷却时间（秒）
     * @returns 是否可以执行命令
     * @private
     */
    private checkCommandCooldown(userId: number, command: string, cooldownSeconds: number): boolean {
        const now = Date.now();

        // 清理过期的冷却记录
        this.commandCooldowns = this.commandCooldowns.filter(
            record => now - record.timestamp < (record.command === command ? cooldownSeconds * 1000 : 60000)
        );

        const cooldownRecord = this.commandCooldowns.find(
            record => record.userId === userId && record.command === command
        );

        if (!cooldownRecord) return true;

        const elapsedSeconds = (now - cooldownRecord.timestamp) / 1000;
        return elapsedSeconds >= cooldownSeconds;
    }

    /**
     * 更新命令冷却时间
     * @param userId 用户ID
     * @param command 命令名称
     * @private
     */
    private updateCommandCooldown(userId: number, command: string): void {
        const now = Date.now();

        const existingIndex = this.commandCooldowns.findIndex(
            record => record.userId === userId && record.command === command
        );

        if (existingIndex !== -1) {
            // 检查索引是否有效，防止潜在的未定义问题
            if (existingIndex < this.commandCooldowns.length) {
                const record = this.commandCooldowns[existingIndex];
                if (record) {
                    record.timestamp = now;
                }
            }
        } else {
            this.commandCooldowns.push({
                userId,
                command,
                timestamp: now
            });
        }
    }
}

/**
 * Plugin Development Guide
 * 
 * Below is a complete plugin example demonstrating all available features and configuration options
 * 
 * ```typescript
 * import type { BotPlugin, CommandContext, MessageEventContext, CallbackEventContext } from '../features';
 * import { log } from '../log';
 * import type { TelegramClient } from '@mtcute/bun';
 * 
 * // Plugin configuration interface
 * interface MyPluginConfig {
 *     enabled: boolean;
 *     apiKey?: string;
 *     responseTimeout: number;
 *     allowedUsers: number[];
 * }
 * 
 * // Default configuration
 * const defaultConfig: MyPluginConfig = {
 *     enabled: true,
 *     responseTimeout: 30,
 *     allowedUsers: []
 * };
 * 
 * // Plugin state
 * let config: MyPluginConfig = { ...defaultConfig };
 * 
 * // Plugin definition
 * const plugin: BotPlugin = {
 *     name: 'example',                      // Plugin name (required)
 *     description: 'Example plugin',        // Plugin description (optional)
 *     version: '1.0.0',                     // Plugin version (optional)
 *     dependencies: ['system'],             // Dependencies on other plugins (optional)
 *     
 *     // Declare permissions (new approach)
 *     permissions: [
 *         {
 *             name: 'example.use',
 *             description: 'Permission to use the example plugin',
 *             isSystem: false,
 *             allowedUsers: []  // This will be updated from config
 *         },
 *         {
 *             name: 'example.admin',
 *             description: 'Administrative permission for the example plugin',
 *             isSystem: true,
 *             parent: 'admin'
 *         }
 *     ],
 *     
 *     // Called when plugin is loaded
 *     async onLoad(client: TelegramClient): Promise<void> {
 *         // Load configuration
 *         const savedConfig = await client.features.getPluginConfig<MyPluginConfig>('example');
 *         if (savedConfig) {
 *             config = { ...defaultConfig, ...savedConfig };
 *         }
 *         
 *         // Update permission with allowed users from config
 *         const permManager = client.features.getPermissionManager();
 *         const permission = permManager.getPermission('example.use');
 *         if (permission) {
 *             permission.allowedUsers = config.allowedUsers;
 *             permManager.updatePermission(permission);
 *         }
 *         
 *         log.info('Example plugin loaded');
 *     },
 *     
 *     // Called when plugin is unloaded
 *     async onUnload(): Promise<void> {
 *         log.info('Example plugin unloaded');
 *     },
 *     
 *     // Command definitions
 *     commands: [
 *         {
 *             name: 'example',                  // Command name (required)
 *             description: 'Example command',   // Command description (optional)
 *             aliases: ['ex', 'sample'],        // Command aliases (optional)
 *             requiredPermission: 'example.use', // Required permission (optional)
 *             cooldown: 5,                      // Cooldown in seconds (optional)
 *             
 *             // Command handler function (required)
 *             async handler(ctx: CommandContext): Promise<void> {
 *                 // Example parameter processing
 *                 const subCommand = ctx.args[0]?.toLowerCase();
 *                 
 *                 if (!subCommand) {
 *                     await ctx.reply(`
 * 📚 **Example Plugin Help**
 * 
 * Available commands:
 * /example status - View status
 * /example set <key> <value> - Configure settings
 * /example reset - Reset configuration
 * `);
 *                     return;
 *                 }
 *                 
 *                 switch (subCommand) {
 *                     case 'status':
 *                         await ctx.reply(`
 * 📊 **Plugin Status**
 * 
 * Enabled: ${config.enabled ? '✅ Yes' : '❌ No'}
 * API Key: ${config.apiKey ? 'Set' : 'Not set'}
 * Response timeout: ${config.responseTimeout} seconds
 * Allowed users: ${config.allowedUsers.length}
 * `);
 *                         break;
 *                         
 *                     case 'set':
 *                         // Permission check example
 *                         if (!ctx.hasPermission('example.admin')) {
 *                             await ctx.reply('❌ Only administrators can modify configuration');
 *                             return;
 *                         }
 *                         
 *                         const key = ctx.args[1];
 *                         const value = ctx.args.slice(2).join(' ');
 *                         
 *                         if (!key || !value) {
 *                             await ctx.reply('❌ Please provide a valid key and value');
 *                             return;
 *                         }
 *                         
 *                         try {
 *                             // Update configuration based on key
 *                             switch (key) {
 *                                 case 'enabled':
 *                                     config.enabled = value.toLowerCase() === 'true';
 *                                     break;
 *                                 case 'apiKey':
 *                                     config.apiKey = value;
 *                                     break;
 *                                 case 'timeout':
 *                                     config.responseTimeout = parseInt(value) || 30;
 *                                     break;
 *                                 default:
 *                                     await ctx.reply(`❌ Unknown configuration item: ${key}`);
 *                                     return;
 *                             }
 *                             
 *                             // Save updated configuration
 *                             await ctx.client.features.savePluginConfig('example', config);
 *                             await ctx.reply(`✅ Configuration updated: ${key} = ${value}`);
 *                         } catch (err) {
 *                             await ctx.reply(`❌ Setting failed: ${err}`);
 *                         }
 *                         break;
 *                         
 *                     case 'reset':
 *                         // Permission check example
 *                         if (!ctx.hasPermission('example.admin')) {
 *                             await ctx.reply('❌ Only administrators can reset configuration');
 *                             return;
 *                         }
 *                         
 *                         config = { ...defaultConfig };
 *                         await ctx.client.features.savePluginConfig('example', config);
 *                         await ctx.reply('✅ Configuration has been reset to defaults');
 *                         break;
 *                         
 *                     default:
 *                         await ctx.reply(`❌ Unknown subcommand: ${subCommand}`);
 *                 }
 *             }
 *         }
 *     ],
 *     
 *     // Event handler definitions
 *     events: [
 *         {
 *             type: 'message',  // Message event
 *             priority: 10,     // Priority (optional, higher numbers = higher priority)
 *             
 *             // Filter (optional)
 *             filter: (ctx) => {
 *                 if (ctx.type !== 'message') return false;
 *                 
 *                 // Only process text messages
 *                 return !!ctx.message.text && config.enabled;
 *             },
 *             
 *             // Event handler function
 *             async handler(ctx: MessageEventContext): Promise<void> {
 *                 const text = ctx.message.text;
 *                 if (!text) return;
 *                 
 *                 // Process specific keywords
 *                 if (text.includes('hello')) {
 *                     await ctx.reply('Hello there! I am the example plugin 👋');
 *                 }
 *             }
 *         },
 *         {
 *             type: 'callback',  // Callback query event
 *             
 *             // Event handler function
 *             async handler(ctx: CallbackEventContext): Promise<void> {
 *                 // Process specific callback data
 *                 if (ctx.data.startsWith('example:')) {
 *                     const action = ctx.data.split(':')[1];
 *                     
 *                     switch (action) {
 *                         case 'info':
 *                             await ctx.reply('This is callback information from the example plugin');
 *                             break;
 *                     }
 *                 }
 *             }
 *         }
 *     ]
 * };
 * 
 * export default plugin;
 * ```
 */ 