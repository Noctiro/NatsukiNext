import type { BotPlugin, CommandContext, PluginCommand } from '../features';
import { PluginStatus } from '../features';
import { html } from '@mtcute/bun';
import { md } from '@mtcute/markdown-parser';
import { managerIds } from '../app';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { cleanHTML } from '../utils/HtmlHelper';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 转换exec为Promise形式
const execAsync = promisify(exec);

interface SystemInfo {
    uptime: string;
    botUptime: string;
    memory: {
        total: string;
        used: string;
        free: string;
        percentage: number;
    };
    cpu: {
        model: string;
        cores: number;
        load: number[];
        usage: string;
    };
    platform: string;
    nodeVersion: string;
    // 增加网络流量监控
    network?: {
        rx: string; // 接收
        tx: string; // 发送
    };
    // 增加进程信息
    process: {
        pid: number;
        memory: string;
        uptime: string;
    };
}

interface CpuTimes {
    idle: number;
    [key: string]: number;
}

// 记录启动时间
const startTime = Date.now();

// 上一次网络统计数据
let lastNetworkStats: { rx: number; tx: number; timestamp: number } | null = null;

function getCpuInfo() {
    try {
        const cpus = os.cpus();
        if (!cpus || cpus.length === 0) {
            return {
                model: '未知',
                cores: 0,
                usage: '未知'
            };
        }

        // 计算CPU使用率
        const totalIdle = cpus.reduce((acc, cpu) => acc + (cpu.times as CpuTimes).idle, 0);
        const totalTick = cpus.reduce((acc, cpu) =>
            acc + Object.values(cpu.times as CpuTimes).reduce((a, b) => a + b, 0), 0);
        const usage = ((1 - totalIdle / totalTick) * 100).toFixed(1);

        return {
            model: cpus[0]?.model?.trim() ?? '未知',
            cores: cpus.length,
            usage: `${usage}%`
        };
    } catch (err) {
        plugin.logger?.error('Failed to get CPU info:', err);
        return {
            model: '获取失败',
            cores: 0,
            usage: '未知'
        };
    }
}

// 获取网络流量信息
async function getNetworkInfo() {
    try {
        const statsPath = '/proc/net/dev';
        // 检查文件是否存在，某些系统可能没有这个文件
        try {
            await fs.access(statsPath);
        } catch {
            return null;
        }

        const data = await fs.readFile(statsPath, 'utf8');
        const lines = data.split('\n').filter(line => line.includes(':'));

        let rxBytes = 0;
        let txBytes = 0;

        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 10) {
                // 接收字节数通常是第2列
                rxBytes += parseInt(parts[1] || '0', 10) || 0;
                // 发送字节数通常是第10列
                txBytes += parseInt(parts[9] || '0', 10) || 0;
            }
        }

        const now = Date.now();
        let rxRate = '未知';
        let txRate = '未知';

        if (lastNetworkStats) {
            const timeDiff = (now - lastNetworkStats.timestamp) / 1000; // 秒
            if (timeDiff > 0) {
                const rxDiff = rxBytes - lastNetworkStats.rx;
                const txDiff = txBytes - lastNetworkStats.tx;

                rxRate = formatBytesPerSec(rxDiff / timeDiff);
                txRate = formatBytesPerSec(txDiff / timeDiff);
            }
        }

        lastNetworkStats = { rx: rxBytes, tx: txBytes, timestamp: now };

        return {
            rx: rxRate,
            tx: txRate
        };
    } catch (err) {
        plugin.logger?.error('Failed to get network info:', err);
        return null;
    }
}

function formatBytesPerSec(bytesPerSec: number): string {
    return `${formatBytes(bytesPerSec)}/s`;
}

// 获取进程信息
function getProcessInfo() {
    const memoryUsage = process.memoryUsage();
    return {
        pid: process.pid,
        memory: formatBytes(memoryUsage.rss),
        uptime: formatUptime(process.uptime())
    };
}

async function getSystemInfo(): Promise<SystemInfo> {
    try {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memPercentage = (usedMem / totalMem) * 100;

        const cpuInfo = getCpuInfo();
        const networkInfo = await getNetworkInfo();
        const processInfo = getProcessInfo();

        return {
            uptime: formatUptime(os.uptime()),
            botUptime: formatUptime((Date.now() - startTime) / 1000),
            memory: {
                total: formatBytes(totalMem),
                used: formatBytes(usedMem),
                free: formatBytes(freeMem),
                percentage: Math.round(memPercentage)
            },
            cpu: {
                ...cpuInfo,
                load: os.loadavg()
            },
            network: networkInfo ?? undefined,
            platform: `${os.platform()} ${os.release()}`,
            nodeVersion: process.version,
            process: processInfo
        };
    } catch (err) {
        const error = err as Error;
        plugin.logger?.error('Failed to get system info:', error);
        throw new Error('获取系统信息失败');
    }
}

function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / (24 * 60 * 60));
    const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
    const minutes = Math.floor((seconds % (60 * 60)) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分钟`);
    if (secs > 0) parts.push(`${secs}秒`);

    return parts.join(' ');
}

function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

// 插件状态映射为中文
function formatPluginStatus(status?: PluginStatus): string {
    switch (status) {
        case 'active':
            return '✅ 已启用';
        case 'disabled':
            return '❌ 已禁用';
        case 'error':
            return '⚠️ 错误';
        default:
            return '❓ 未知';
    }
}

/**
 * 执行终端命令并返回结果
 * @param command 要执行的命令
 * @param timeout 超时时间（毫秒）
 * @returns 命令执行结果
 */
async function executeCommand(command: string, timeout: number = 30000): Promise<{ stdout: string; stderr: string; error?: string }> {
    try {
        // 设置超时选项
        const options = {
            timeout,
            maxBuffer: 1024 * 1024 * 2, // 2MB缓冲区
        };

        // 执行命令
        const { stdout, stderr } = await execAsync(command, options);
        return { stdout, stderr };
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        plugin.logger?.error(`命令执行错误: ${error.message}`);

        // 尽可能返回stdout和stderr
        const result: { stdout: string; stderr: string; error: string } = {
            stdout: '',
            stderr: '',
            error: error.message
        };

        if ('stdout' in error) result.stdout = String(error.stdout || '');
        if ('stderr' in error) result.stderr = String(error.stderr || '');

        return result;
    }
}

// 格式化获取进程内存信息的更详细版本
function getDetailedProcessMemory() {
    const mem = process.memoryUsage();
    return {
        rss: formatBytes(mem.rss), // 常驻集大小
        heapTotal: formatBytes(mem.heapTotal), // V8分配的堆内存总量
        heapUsed: formatBytes(mem.heapUsed), // V8当前使用的堆内存
        external: formatBytes(mem.external || 0), // V8管理的C++对象绑定的外部内存
        arrayBuffers: formatBytes(mem.arrayBuffers || 0), // 分配的ArrayBuffer和SharedArrayBuffer的内存
        usage: ((mem.heapUsed / mem.heapTotal) * 100).toFixed(1) + '%' // 堆内存使用率
    };
}

/**
 * 系统插件 - 提供基本系统功能和信息
 */
const plugin: BotPlugin = {
    name: 'system',
    description: '系统控制和信息命令',
    version: '1.2.0',

    // 新增: 插件权限声明，这将被Features类处理
    permissions: [
        {
            name: 'system.info',
            description: 'Permission to view system information',
            isSystem: true,
            parent: 'admin'
        },
        {
            name: 'system.stop',
            description: '停止机器人的权限',
            isSystem: true,
            parent: 'admin'
        },
        {
            name: 'system.admin',
            description: '系统管理员权限',
            isSystem: true,
            parent: 'admin'
        },
        {
            name: 'system.exec',
            description: '执行终端命令的权限',
            isSystem: true,
            parent: 'system.admin'
        }
    ],

    commands: [
        {
            name: 'start',
            description: '开始使用机器人',
            async handler(ctx: CommandContext) {
                const me = await ctx.client.getMe();
                const plugins = ctx.client.features.getPlugins();
                const activePlugins = plugins.filter(p => p.status === 'active');

                // 计算所有可用命令数量
                const totalCommands = activePlugins.reduce((sum, plugin) =>
                    sum + (plugin.commands?.length || 0), 0);

                ctx.message.replyText(html`
嗨嗨~ (｡>﹏<｡)ﾉﾞ✨ 我是全新的第三代 <a href="tg://user?id=${me.id}">${me.displayName}</a>！<br>
<br>
🤖 你的多功能小助手，目前已加载 ${activePlugins.length} 个插件，共有 ${totalCommands} 个指令！<br>
🎈 只要轻轻敲下指令，我就会立刻蹦出来帮忙！<br>
🌸 不知道从哪里开始？输入 /help 了解我的全部功能！<br>
<br>
开始探索吧！(｡･ω･｡)ﾉ♡
`);
            },
        },
        {
            name: 'system',
            description: '查看系统信息',
            aliases: ['sys', 'status'],
            async handler(ctx: CommandContext) {
                const memoryUsage = process.memoryUsage();
                const uptime = process.uptime();
                const osUptime = os.uptime();

                const formatBytes = (bytes: number) => {
                    if (bytes === 0) return '0 Bytes';
                    const k = 1024;
                    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
                    const i = Math.floor(Math.log(bytes) / Math.log(k));
                    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
                };

                const formatTime = (seconds: number) => {
                    const days = Math.floor(seconds / 86400);
                    seconds %= 86400;
                    const hours = Math.floor(seconds / 3600);
                    seconds %= 3600;
                    const minutes = Math.floor(seconds / 60);
                    seconds = Math.floor(seconds % 60);

                    if (days > 0) {
                        return `${days}天${hours}小时${minutes}分钟`;
                    } else if (hours > 0) {
                        return `${hours}小时${minutes}分钟${seconds}秒`;
                    } else {
                        return `${minutes}分钟${seconds}秒`;
                    }
                };

                const loadedPlugins = ctx.client.features.getPlugins();
                const activePlugins = loadedPlugins.filter(p => p.status === 'active');

                await ctx.message.replyText(md`
🖥️ **系统信息**

📊 **资源使用情况**
🧠 内存: ${formatBytes(memoryUsage.rss)} / ${formatBytes(os.totalmem())}
🔄 运行时间: ${formatTime(uptime)}
💻 系统运行时间: ${formatTime(osUptime)}
🏢 平台: ${os.platform()} ${os.release()}
🧵 CPU架构: ${os.arch()}
🔢 CPU核心: ${os.cpus().length}

🔌 **插件系统**
📦 已加载插件: ${loadedPlugins.length}
✅ 已启用插件: ${activePlugins.length}
❌ 禁用/错误插件: ${loadedPlugins.length - activePlugins.length}

❓ 使用 /help 查看帮助信息
💡 使用 /plugins 查看插件列表`);
            }
        },
        {
            name: 'help',
            description: 'Display help information',
            aliases: ['h'],
            async handler(ctx: CommandContext) {
                const plugins = ctx.client.features.getPlugins();

                // 分类存储命令
                const categories = new Map<string, {
                    plugin: BotPlugin,
                    commands: PluginCommand[]
                }>();

                // 按插件分类并过滤用户有权限的命令
                for (const plugin of plugins) {
                    if (!plugin.commands?.length) continue;
                    if (plugin.status !== PluginStatus.ACTIVE) continue; // 只显示已启用的插件命令

                    // 过滤出用户有权限的命令
                    const availableCommands = plugin.commands.filter(cmd => {
                        // 如果命令没有权限要求，或用户有该权限，则可显示
                        return !cmd.requiredPermission || ctx.hasPermission(cmd.requiredPermission);
                    });

                    // 如果没有可用命令，跳过此插件
                    if (availableCommands.length === 0) continue;

                    // 记录此插件的可用命令
                    categories.set(plugin.name, {
                        plugin,
                        commands: availableCommands
                    });
                }

                // 预定义常用的表情符号
                const emoji = {
                    // 分类图标
                    system: '⚙️',
                    tools: '🔧',
                    info: 'ℹ️',
                    media: '🎬',
                    fun: '🎮',
                    admin: '👑',
                    search: '🔍',
                    translate: '🌐',
                    folder: '📂',
                    // 状态图标
                    success: '✅',
                    warning: '⚠️',
                    error: '❌',
                    // 常用图标
                    command: '🔸',
                    permission: '🔒',
                    cooldown: '⏱️',
                    star: '✨',
                    dot: '•',
                    info_circle: 'ℹ️',
                    help: '❓'
                };

                // 获取插件的表情符号
                const getPluginEmoji = (name: string): string => {
                    const lowerName = name.toLowerCase();
                    if (lowerName === 'system') return emoji.system;
                    if (lowerName === 'tools' || lowerName.includes('tool')) return emoji.tools;
                    if (lowerName.includes('media')) return emoji.media;
                    if (lowerName.includes('fun') || lowerName.includes('game')) return emoji.fun;
                    if (lowerName.includes('admin')) return emoji.admin;
                    if (lowerName.includes('search')) return emoji.search;
                    if (lowerName.includes('translator') || lowerName.includes('translate')) return emoji.translate;
                    return emoji.folder;
                };

                // 生成美化的帮助信息
                let message = `${emoji.star} <b>命令帮助中心</b> ${emoji.star}<br><br>`;

                // 对插件按名称排序
                const sortedCategories = Array.from(categories.entries())
                    .sort(([nameA], [nameB]) => nameA.localeCompare(nameB));

                // 如果没有可用命令
                if (sortedCategories.length === 0) {
                    message = `${emoji.warning} <b>无可用命令</b><br><br>您目前没有权限使用任何命令。`;
                } else {
                    // 首先添加可用命令总数统计
                    const totalCommands = sortedCategories.reduce(
                        (sum, [_, { commands }]) => sum + commands.length, 0
                    );
                    message += `${emoji.success} 您可以使用 <b>${totalCommands}</b> 个命令，分布在 <b>${sortedCategories.length}</b> 个插件中。<br><br><blockquote collapsible>`;

                    const categoryCount = sortedCategories.length;

                    // 遍历所有分类
                    sortedCategories.forEach(([name, { plugin, commands }], categoryIndex) => {
                        const isLastCategory = categoryIndex === categoryCount - 1;

                        // 添加插件标题和描述
                        const pluginEmoji = getPluginEmoji(name);
                        const categoryPrefix = '├──';
                        message += `${categoryPrefix} ${pluginEmoji} <b>${name}</b>`;
                        if (plugin.version) {
                            message += ` <i>(v${plugin.version})</i>`;
                        }
                        message += `<br>`;

                        // 插件内容缩进前缀 - 为最后一个插件使用空格，否则使用垂直线
                        const pluginPrefix = '│　';

                        if (plugin.description) {
                            message += `${pluginPrefix}${emoji.info_circle} ${plugin.description}<br>`;
                        }

                        // 对命令按名称排序
                        const sortedCommands = [...commands].sort((a, b) => a.name.localeCompare(b.name));

                        // 添加命令和插件描述之间的间隔
                        if (sortedCommands.length > 0) {
                            message += `${pluginPrefix}<br>`;
                        }

                        // 添加命令列表
                        sortedCommands.forEach((cmd, cmdIndex) => {
                            const isLastCmd = cmdIndex === sortedCommands.length - 1;
                            const cmdPrefix = pluginPrefix + (isLastCmd ? '└──' : '├──');

                            const aliases = cmd.aliases?.length
                                ? ` <i>(别名: ${cmd.aliases.join(', ')})</i>`
                                : '';

                            // 添加命令名称和别名
                            message += `${cmdPrefix} ${emoji.command} <b>/${cmd.name}</b>${aliases}<br>`;

                            // 命令内容的前缀
                            const contentPrefix = pluginPrefix + (isLastCmd ? '　　' : '│　');

                            // 添加命令描述
                            if (cmd.description) {
                                message += `${contentPrefix}${emoji.dot} ${cmd.description.replace(/\n/g, `<br>${contentPrefix}${emoji.dot} `)}<br>`;
                            }

                            // 显示附加信息（权限、冷却时间）
                            const cmdInfo = [];

                            // 显示权限要求（如果有）
                            if (cmd.requiredPermission) {
                                cmdInfo.push(`${emoji.permission} 需要权限: <i>${cmd.requiredPermission}</i>`);
                            }

                            // 显示冷却时间（如果有）
                            if (cmd.cooldown) {
                                cmdInfo.push(`${emoji.cooldown} 冷却时间: <i>${cmd.cooldown}秒</i>`);
                            }

                            if (cmdInfo.length > 0) {
                                message += `${contentPrefix}${cmdInfo.join(' | ')}<br>`;
                            }

                            // 添加命令之间的间隔（保持树形结构）
                            if (!isLastCmd) {
                                message += `${pluginPrefix}│<br>`;
                            }
                        });

                        // 添加插件间的空行，注意最后一个插件不需要垂直连接线
                        if (!isLastCategory) {
                            message += `│<br>`;
                        }
                    });

                    // 清理消息末尾的多余空行
                    message = message.replace(/(<br>\s*)+$/g, '');

                    message += `</blockquote>`;
                }

                await ctx.message.replyText(html(message));
            }
        },
        {
            name: 'stop',
            description: '停止机器人服务\n仅管理员可用',
            async handler(ctx: CommandContext) {
                if (!managerIds.includes(ctx.message.sender.id)) {
                    await ctx.message.replyText('❌ 只有管理员才能执行此命令');
                    return;
                }

                plugin.logger?.info(`管理员 ${ctx.message.sender.displayName}(${ctx.message.sender.id}) 触发了机器人停止命令`, { remote: true });
                await ctx.message.replyText('🛑 即将停止机器人...');
                plugin.logger?.info('正在停止机器人...', { remote: true });

                setTimeout(() => {
                    process.exit(0);
                }, 1000);
            }
        },
        {
            name: 'plugins',
            description: 'Display all plugin information',
            aliases: ['plugin', 'pl'],
            requiredPermission: 'plugin.manage',
            async handler(ctx: CommandContext) {
                const subCommand = ctx.args[0]?.toLowerCase() || '';
                const plugins = ctx.client.features.getPlugins();

                // 处理子命令
                if (subCommand) {
                    if (subCommand === 'enable' || subCommand === 'disable') {
                        const pluginName = ctx.args[1];
                        if (!pluginName) {
                            await ctx.message.replyText(`❌ 请指定要${subCommand === 'enable' ? '启用' : '禁用'}的插件名称`);
                            return;
                        }

                        // 不允许禁用系统插件
                        if (subCommand === 'disable' && pluginName === 'system') {
                            await ctx.message.replyText(`⛔ 不能禁用系统插件`);
                            return;
                        }

                        const result = subCommand === 'enable'
                            ? await ctx.client.features.enablePlugin(pluginName, true)
                            : await ctx.client.features.disablePlugin(pluginName);

                        if (result) {
                            await ctx.message.replyText(`✅ 插件 ${pluginName} 已${subCommand === 'enable' ? '启用' : '禁用'}`);
                        } else {
                            const plugin = ctx.client.features.getPlugin(pluginName);
                            if (plugin && plugin.error) {
                                await ctx.message.replyText(`❌ ${subCommand === 'enable' ? '启用' : '禁用'}插件 ${pluginName} 失败: ${plugin.error}`);
                            } else {
                                await ctx.message.replyText(`❌ ${subCommand === 'enable' ? '启用' : '禁用'}插件 ${pluginName} 失败，插件可能不存在${subCommand === 'disable' ? '或有其他插件依赖于它' : ''}`);
                            }
                        }
                        return;
                    } else if (subCommand === 'reload') {
                        const pluginName = ctx.args[1];
                        if (!pluginName) {
                            await ctx.message.replyText(`⏳ 正在重新加载所有插件...`);
                            const result = await ctx.client.features.reload();
                            if (result) {
                                await ctx.message.replyText(`✅ 所有插件已成功重新加载`);
                            } else {
                                await ctx.message.replyText(`❌ 部分或全部插件重新加载失败`);
                            }
                        } else {
                            await ctx.message.replyText(html`⏳ 正在重新加载插件 <b>${pluginName}</b>...`);
                            // @ts-ignore - 我们知道此方法存在
                            const result = await ctx.client.features.loadPlugin(pluginName);
                            if (result) {
                                await ctx.message.replyText(html`✅ 插件 <b>${pluginName}</b> 已成功重新加载`);
                            } else {
                                await ctx.message.replyText(`❌ 插件重新加载失败`);
                            }
                        }
                        return;
                    }

                    const pluginName = subCommand;
                    const plugin = ctx.client.features.getPlugin(pluginName);

                    if (!plugin) {
                        await ctx.message.replyText(`❌ Plugin '${pluginName}' not found`);
                        return;
                    }

                    // 显示特定插件的详细信息
                    let message = `📂 **插件详情: ${plugin.name}**\n\n`;
                    message += `**状态**: ${formatPluginStatus(plugin.status)}\n`;
                    message += `**版本**: ${plugin.version || '未指定'}\n`;
                    message += `**描述**: ${plugin.description || '无描述'}\n\n`;

                    if (plugin.error) {
                        message += `**错误**: ${plugin.error}\n\n`;
                    }

                    if (plugin.dependencies?.length) {
                        message += `**依赖项**: ${plugin.dependencies.join(', ')}\n\n`;
                    }

                    // 显示命令信息
                    if (plugin.commands?.length) {
                        message += `**命令 (${plugin.commands.length})**:\n`;
                        for (const cmd of plugin.commands) {
                            const aliases = cmd.aliases?.length
                                ? ` (别名: ${cmd.aliases.join(', ')})`
                                : '';
                            message += `• /${cmd.name}${aliases}\n`;
                            if (cmd.description) {
                                message += `  ${cmd.description}\n`;
                            }
                            if (cmd.requiredPermission) {
                                message += `  所需权限: ${cmd.requiredPermission}\n`;
                            }
                        }
                        message += '\n';
                    }

                    // 显示事件处理器信息
                    if (plugin.events?.length) {
                        message += `**事件处理器 (${plugin.events.length})**:\n`;
                        const eventTypes = plugin.events.map(e => e.type);
                        const eventCounts: Record<string, number> = {};

                        for (const type of eventTypes) {
                            eventCounts[type] = (eventCounts[type] || 0) + 1;
                        }

                        for (const [type, count] of Object.entries(eventCounts)) {
                            message += `• ${type}: ${count} 个处理器\n`;
                        }
                        message += '\n';
                    }

                    // 显示权限信息
                    if (plugin.permissions?.length) {
                        message += `**权限 (${plugin.permissions.length})**:\n`;
                        for (const perm of plugin.permissions) {
                            message += `• ${perm.name}: ${perm.description}\n`;
                            if (perm.parent) {
                                message += `  父权限: ${perm.parent}\n`;
                            }
                            if (perm.isSystem) {
                                message += `  系统权限\n`;
                            }
                        }
                    }

                    await ctx.message.replyText(md(message));
                    return;
                }

                // 显示所有插件的概览信息
                const activePlugins = plugins.filter(p => p.status === PluginStatus.ACTIVE);
                const disabledPlugins = plugins.filter(p => p.status === PluginStatus.DISABLED);
                const errorPlugins = plugins.filter(p => p.status === PluginStatus.ERROR);

                let message = `📂 **插件列表 (${plugins.length})**\n\n`;
                message += `✅ 已启用: ${activePlugins.length}\n`;
                message += `⏸️ 已禁用: ${disabledPlugins.length}\n`;
                message += `❌ 错误: ${errorPlugins.length}\n\n`;

                // 对插件按名称排序
                const sortedPlugins = [...plugins].sort((a, b) => a.name.localeCompare(b.name));

                for (const plugin of sortedPlugins) {
                    const status = formatPluginStatus(plugin.status);
                    message += `${status} **${plugin.name}** ${plugin.version ? `v${plugin.version}` : ''}\n`;
                    if (plugin.description) {
                        message += `  ${plugin.description}\n`;
                    }
                    if (plugin.error) {
                        message += `  ⚠️ 错误: ${plugin.error}\n`;
                    }

                    // 显示依赖和命令数
                    const details = [];
                    if (plugin.dependencies?.length) {
                        details.push(`依赖项: ${plugin.dependencies.length}`);
                    }
                    if (plugin.commands?.length) {
                        details.push(`命令: ${plugin.commands.length}`);
                    }
                    if (plugin.events?.length) {
                        details.push(`事件处理器: ${plugin.events.length}`);
                    }
                    if (plugin.permissions?.length) {
                        details.push(`权限: ${plugin.permissions.length}`);
                    }

                    if (details.length > 0) {
                        message += `  [${details.join(' | ')}]\n`;
                    }

                    message += '\n';
                }

                message += `使用 /plugins <名称> 查看特定插件的详细信息。\n`;
                message += `其他命令: /plugins enable <名称> 启用插件, /plugins disable <名称> 禁用插件, /plugins reload [名称] 重载插件`;

                await ctx.message.replyText(md(message));
            }
        },
        {
            name: 'exec',
            description: '执行终端命令并返回结果（仅管理员可用）',
            requiredPermission: 'system.exec', // 使用system.exec权限
            async handler(ctx: CommandContext) {
                // 只允许管理员执行
                if (!managerIds.includes(ctx.message.sender.id)) {
                    await ctx.message.replyText('❌ 只有管理员才能执行此命令');
                    return;
                }

                const command = ctx.content.trim();

                if (!command) {
                    await ctx.message.replyText('请指定要执行的命令，例如：/exec ls -la');
                    return;
                }

                await ctx.message.replyText(`⏳ 正在执行命令: ${command}`);

                try {
                    // 执行命令，设置10秒超时
                    const { stdout, stderr, error } = await executeCommand(command, 10000);

                    // 准备结果消息
                    let resultMessage = '🖥️ <b>命令执行结果</b><br><br>';

                    if (error) {
                        resultMessage += `❌ <b>错误</b>: ${error.replace(/\r\n/g, '<br>').replace(/\r/g, '<br>')}<br><br>`;
                    }

                    if (stdout) {
                        // 如果输出太长，截断它
                        const truncatedStdout = stdout.length > 2500
                            ? stdout.substring(0, 2500) + '...(输出被截断)'
                            : stdout;

                        resultMessage += `📤 <b>标准输出</b>:<br><blockquote collapsible>${truncatedStdout.replace(/\r\n/g, '<br>').replace(/\r/g, '<br>')}</blockquote>`;
                    }

                    if (stderr) {
                        // 如果错误输出太长，截断它
                        const truncatedStderr = stderr.length > 1000
                            ? stderr.substring(0, 1000) + '...(错误输出被截断)'
                            : stderr;

                        resultMessage += `⚠️ <b>标准错误</b>:<br><blockquote collapsible>${truncatedStderr.replace(/\r\n/g, '<br>').replace(/\r/g, '<br>')}</blockquote>`;
                    }

                    if (!stdout && !stderr && !error) {
                        resultMessage = '✅ 命令执行成功，没有输出';
                    }

                    await ctx.message.replyText(html(cleanHTML(resultMessage, { escapeUnknownTags: true })));
                } catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    plugin.logger?.error(`执行命令时出错: ${error.message}`);
                    await ctx.message.replyText(`❌ 执行命令时出错: ${error.message}`);
                }
            }
        },
        {
            name: 'memory',
            description: '显示当前内存使用情况',
            aliases: ['mem'],
            handler: async (ctx: CommandContext) => {
                // 只允许管理员执行
                if (!managerIds.includes(ctx.message.sender.id)) {
                    await ctx.message.replyText('❌ 只有管理员才能执行此命令');
                    return;
                }

                try {
                    // 获取进程内存信息
                    const memInfo = getDetailedProcessMemory();

                    // 获取系统内存信息
                    const sysInfo = await getSystemInfo();

                    let message = '📊 <b>内存使用情况</b>\n\n';

                    message += '<b>Bun 进程内存:</b>\n' +
                        `- RSS (常驻集大小): ${memInfo.rss}\n` +
                        `- 堆内存总量: ${memInfo.heapTotal}\n` +
                        `- 堆内存使用: ${memInfo.heapUsed} (${memInfo.usage})\n` +
                        `- 外部内存: ${memInfo.external}\n` +
                        `- ArrayBuffer: ${memInfo.arrayBuffers}\n\n`;

                    message += '<b>系统内存:</b>\n' +
                        `- 总内存: ${sysInfo.memory.total}\n` +
                        `- 已使用: ${sysInfo.memory.used} (${sysInfo.memory.percentage}%)\n` +
                        `- 可用: ${sysInfo.memory.free}\n\n`;

                    // 获取机器人实例中缓存的计数
                    const features = ctx.client.features;

                    // 构建缓存统计报告
                    const cacheStats = {
                        plugins: features.getPlugins().length,
                        activePlugins: features.getPlugins().filter(p => p.status === PluginStatus.ACTIVE).length,
                        commandsCached: 0,
                        configsCached: 0,
                        cooldowns: 0
                    };

                    message += '<b>缓存统计:</b>\n' +
                        `- 已加载插件: ${cacheStats.plugins} (${cacheStats.activePlugins} 个活跃)\n` +
                        `- 运行时间: ${sysInfo.botUptime}\n\n`;

                    message += '<i>提示: 使用 /clearmem 命令清理内存</i>';

                    await ctx.message.replyText(html(cleanHTML(message.replace(/\n/g, '<br>'), { escapeUnknownTags: true })));
                } catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    plugin.logger?.error(`获取内存信息时出错: ${error.message}`);
                    await ctx.message.replyText(`❌ 获取内存信息失败: ${error.message}`);
                }
            }
        },
        {
            name: 'clearmem',
            description: '清理内存和缓存',
            handler: async (ctx: CommandContext) => {
                // 只允许管理员执行
                if (!managerIds.includes(ctx.message.sender.id)) {
                    await ctx.message.replyText('❌ 只有管理员才能执行此命令');
                    return;
                }

                try {
                    // 获取清理前的内存信息
                    const beforeInfo = getDetailedProcessMemory();
                    await ctx.message.replyText('🧹 正在清理内存和缓存...');

                    // 执行内存清理
                    const startTime = Date.now();
                    ctx.client.features.cleanupMemory();

                    // 手动触发垃圾回收
                    if (global.gc) {
                        try {
                            global.gc();
                        } catch (e) {
                            // 忽略可能的错误
                        }
                    }

                    // 获取清理后的内存信息
                    const afterInfo = getDetailedProcessMemory();
                    const duration = Date.now() - startTime;

                    // 计算释放的内存
                    const heapDiff = parseInt(beforeInfo.heapUsed) - parseInt(afterInfo.heapUsed);
                    const rssDiff = parseInt(beforeInfo.rss) - parseInt(afterInfo.rss);

                    // 构建报告
                    let message = '✅ <b>内存清理完成</b>\n\n';

                    message += `<b>耗时:</b> ${duration}ms\n\n`;

                    message += '<b>清理前:</b>\n' +
                        `- 堆内存: ${beforeInfo.heapUsed} (${beforeInfo.usage})\n` +
                        `- RSS: ${beforeInfo.rss}\n\n`;

                    message += '<b>清理后:</b>\n' +
                        `- 堆内存: ${afterInfo.heapUsed} (${afterInfo.usage})\n` +
                        `- RSS: ${afterInfo.rss}\n\n`;

                    const formatDiff = (bytes: number): string => {
                        const sign = bytes > 0 ? '-' : '+';
                        return `${sign}${formatBytes(Math.abs(bytes))}`;
                    };

                    message += '<b>内存变化:</b>\n' +
                        `- 堆内存: ${formatDiff(heapDiff)}\n` +
                        `- RSS: ${formatDiff(rssDiff)}\n\n`;

                    await ctx.message.replyText(html(cleanHTML(message.replace(/\n/g, '<br>'), { escapeUnknownTags: true })));
                } catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    plugin.logger?.error(`清理内存时出错: ${error.message}`);
                    await ctx.message.replyText(`❌ 内存清理失败: ${error.message}`);
                }
            }
        }
    ],
};

export default plugin; 
