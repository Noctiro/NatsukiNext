import type { BotPlugin, CommandContext } from '../features';
import { managerIds } from '../app';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { html } from '@mtcute/bun';

// 获取当前脚本的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');

/**
 * Bun更新插件
 */
const plugin: BotPlugin = {
    name: 'bunUpdater',
    description: '自动更新Bun并重启机器人',
    version: '1.0.0',

    // 权限声明
    permissions: [
        {
            name: 'bun.update',
            description: '更新Bun并重启机器人的权限',
            isSystem: true,
            parent: 'admin'
        }
    ],

    // 命令处理
    commands: [
        {
            name: 'bun',
            description: '管理Bun运行时',
            requiredPermission: 'bun.update', // 需要更新权限
            async handler(ctx: CommandContext) {
                const subCommand = ctx.args[0]?.toLowerCase() || 'version';

                switch (subCommand) {
                    case 'version':
                    case 'v':
                        // 查看当前Bun版本
                        const version = await getBunVersion();
                        await ctx.message.replyText(html`🏷️ 当前Bun版本: <b>${version}</b>`);
                        break;

                    case 'update':
                    case 'upgrade':
                        // 只有管理员才能更新
                        if (!managerIds.includes(ctx.message.sender.id)) {
                            await ctx.message.replyText('❌ 只有管理员才能执行更新操作');
                            return;
                        }

                        await ctx.message.replyText('⏳ 正在更新Bun并准备重启...');
                        const result = await updateBunAndRestart();
                        await ctx.message.replyText(html`${result}`);
                        break;

                    default:
                        // 显示帮助信息
                        const helpText = html`
🐰 <b>Bun管理工具</b><br>
<br>
可用命令:<br>
• /bun version - 查看当前Bun版本<br>
• /bun update - 更新Bun并重启机器人 (仅管理员可用)`;
                        await ctx.message.replyText(helpText);
                        break;
                }
            }
        }
    ]
};

/**
 * 获取当前Bun版本
 * @returns Bun版本号
 */
async function getBunVersion(): Promise<string> {
    try {
        const version = execSync('bun --version', { encoding: 'utf8' }).trim();
        return version;
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        plugin.logger?.error(`获取Bun版本失败: ${err.message}`);
        return '未知';
    }
}

/**
 * 更新Bun并重启机器人
 * @returns 更新结果消息
 */
async function updateBunAndRestart(): Promise<string> {
    try {
        const oldVersion = await getBunVersion();
        plugin.logger?.info(`开始更新Bun，当前版本: ${oldVersion}`, { remote: true });

        // 执行bun upgrade命令
        execSync('bun upgrade', { stdio: 'pipe', encoding: 'utf8' });

        // 获取更新后的版本
        const newVersion = await getBunVersion();

        // 判断是否需要重启
        if (oldVersion === newVersion) {
            return `Bun已是最新版本 (${newVersion})，无需更新。`;
        }

        plugin.logger?.info(`Bun已更新: ${oldVersion} -> ${newVersion}，即将重启机器人...`, { remote: true });

        // 设置延迟重启，以便消息能发送出去
        setTimeout(() => {
            // 使用spawn启动新进程
            const args = process.argv.slice(1); // 获取除了node/bun之外的所有参数
            const execPath = process.argv[0] || 'bun'; // 确保execPath为字符串

            try {
                const child = spawn(execPath, args, {
                    detached: true, // 从父进程分离
                    stdio: 'inherit', // 继承stdin/stdout/stderr
                    cwd: rootDir // 使用项目根目录
                });

                // 分离子进程
                child.unref();
            } catch (spawnError) {
                // 记录启动失败的错误但仍然退出
                plugin.logger?.error(`启动新进程失败: ${spawnError}`, { remote: true });
            }

            // 退出当前进程
            process.exit(0);
        }, 2000); // 2秒后重启

        return `✅ Bun已更新: ${oldVersion} -> ${newVersion}\n⏳ 机器人将在2秒后重启...`;
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        plugin.logger?.error(`更新Bun失败: ${err.message}`, { remote: true });
        return `❌ 更新Bun失败: ${err.message}`;
    }
}

export default plugin; 