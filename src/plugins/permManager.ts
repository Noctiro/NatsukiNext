import type { BotPlugin, CommandContext } from '../features';
import { md } from '@mtcute/bun';
import type { Permission, PermissionGroup } from '../permissions';

/**
 * 权限管理插件 - 提供丰富的权限管理界面和功能
 */
const plugin: BotPlugin = {
    name: 'permManager',
    description: '高级权限管理器',
    version: '1.2.0',
    dependencies: ['system'],

    // 新增: 插件权限声明，这将被Features类处理
    permissions: [
        {
            name: 'permManager.view',
            description: 'Access to advanced permission manager',
            isSystem: true,
            parent: 'permissions.view'
        },
        {
            name: 'permManager.edit',
            description: 'Edit permissions with advanced permission manager',
            isSystem: true,
            parent: 'permissions.manage'
        }
    ],

    commands: [
        {
            name: 'perm',
            description: '权限管理中心',
            aliases: ['权限', 'perms', 'pm'],
            requiredPermission: 'permManager.view',
            async handler(ctx: CommandContext) {
                const subCommand = ctx.args[0]?.toLowerCase() || '';
                const permManager = ctx.client.features.getPermissionManager();

                if (!subCommand) {
                    // 显示权限系统概览
                    const permissions = permManager.getPermissions();
                    const groups = permManager.getGroups();

                    await ctx.message.replyText(md`
🔐 **权限管理中心**

当前系统共有 ${permissions.length} 个权限，${groups.length} 个权限组。

📋 **基本命令**:
/perm list - 查看所有权限
/perm group - 查看所有权限组
/perm user <用户ID> - 查看用户权限

✨ **权限操作**:
/perm grant <用户ID> <权限名> - 授予用户权限
/perm revoke <用户ID> <权限名> - 撤销用户权限

👥 **权限组管理**:
/perm group_add <用户ID> <组名> - 将用户添加到权限组
/perm group_remove <用户ID> <组名> - 将用户从权限组移除
/perm create_group <组名> <描述> - 创建权限组
/perm delete_group <组名> - 删除权限组
/perm add_perm <权限名> <组名> - 添加权限到组
/perm remove_perm <权限名> <组名> - 从组中移除权限

🔍 **高级功能**:
/perm tree <权限名> - 显示权限继承树
/perm analyze <用户ID> - 分析用户权限来源
/perm save - 保存权限配置

`);
                    return;
                }

                // 使用switch case处理子命令，确保非管理功能可以被具有查看权限的用户使用
                switch (subCommand) {
                    case 'list':
                        // 查看权限列表只需要查看权限即可
                        if (!ctx.hasPermission('permissions.view')) {
                            await ctx.message.replyText('❌ 你没有查看权限的权限');
                            return;
                        }

                        // 显示所有权限
                        const permissions = permManager.getPermissions();
                        let message = '🔑 **系统权限列表**\n\n';

                        if (permissions.length === 0) {
                            await ctx.message.replyText('系统中没有定义任何权限。');
                            return;
                        }

                        // 按照系统权限和自定义权限分组
                        const systemPerms = permissions.filter((p: Permission) => p.isSystem);
                        const customPerms = permissions.filter((p: Permission) => !p.isSystem);

                        if (systemPerms.length > 0) {
                            message += '🔒 **系统权限**\n';
                            for (const perm of systemPerms) {
                                const userCount = perm.allowedUsers?.length || 0;
                                message += `• **${perm.name}** - ${perm.description}\n`;
                                message += `  ${userCount} 个用户`;
                                if (perm.parent) {
                                    message += `，继承自 ${perm.parent}`;
                                }
                                message += '\n';
                            }
                            message += '\n';
                        }

                        if (customPerms.length > 0) {
                            message += '🔓 **自定义权限**\n';
                            for (const perm of customPerms) {
                                const userCount = perm.allowedUsers?.length || 0;
                                message += `• **${perm.name}** - ${perm.description}\n`;
                                message += `  ${userCount} 个用户`;
                                if (perm.parent) {
                                    message += `，继承自 ${perm.parent}`;
                                }
                                message += '\n';
                            }
                        }

                        await ctx.message.replyText(md(message));
                        break;

                    case 'group':
                        // 查看权限组也只需要查看权限
                        if (!ctx.hasPermission('permissions.view')) {
                            await ctx.message.replyText('❌ 你没有查看权限的权限');
                            return;
                        }

                        // 显示所有权限组
                        const groups = permManager.getGroups();
                        let groupMessage = '👥 **权限组列表**\n\n';

                        if (groups.length === 0) {
                            await ctx.message.replyText('系统中没有定义任何权限组。');
                            return;
                        }

                        for (const group of groups) {
                            groupMessage += `• **${group.name}** - ${group.description}\n`;
                            groupMessage += `  成员: ${group.members.length} 人\n`;
                            groupMessage += `  权限: ${group.permissions.length > 0 ? group.permissions.join(', ') : '无'}\n\n`;
                        }

                        await ctx.message.replyText(md(groupMessage));
                        break;

                    case 'user':
                        // 查看用户权限也只需要查看权限
                        if (!ctx.hasPermission('permissions.view')) {
                            await ctx.message.replyText('❌ 你没有查看权限的权限');
                            return;
                        }

                        // 查看用户权限
                        const userIdStr = ctx.args[1] || '';
                        if (!userIdStr) {
                            await ctx.message.replyText('❌ 请提供用户ID');
                            return;
                        }

                        const userId = parseInt(userIdStr);
                        if (isNaN(userId)) {
                            await ctx.message.replyText('❌ 无效的用户ID');
                            return;
                        }

                        // 获取用户所有权限
                        const userPermissions = permManager.getUserPermissions(userId);

                        // 获取用户所在权限组
                        const userGroups = permManager.getGroups()
                            .filter(group => group.members.includes(userId))
                            .map(group => group.name);

                        let userMessage = `👤 **用户 ${userId} 的权限信息**\n\n`;
                        userMessage += `**权限数量**: ${userPermissions.length}\n`;
                        userMessage += `**所在权限组**: ${userGroups.length > 0 ? userGroups.join(', ') : '无'}\n\n`;

                        userMessage += '**拥有的权限**:\n';
                        for (const permName of userPermissions) {
                            const perm = permManager.getPermission(permName);
                            if (perm) {
                                userMessage += `• ${permName} - ${perm.description}\n`;
                            } else {
                                userMessage += `• ${permName}\n`;
                            }
                        }

                        await ctx.message.replyText(md(userMessage));
                        break;

                    // 以下操作需要管理权限
                    case 'grant':
                    case 'revoke':
                    case 'group_add':
                    case 'group_remove':
                    case 'create_group':
                    case 'delete_group':
                    case 'add_perm':
                    case 'remove_perm':
                    case 'save':
                        // 检查管理权限
                        if (!ctx.hasPermission('permissions.manage')) {
                            await ctx.message.replyText('❌ 你没有管理权限的权限');
                            return;
                        }

                        // 根据子命令处理具体操作
                        if (subCommand === 'grant') {
                            if (ctx.args.length < 3) {
                                await ctx.message.replyText('❌ 请使用格式: /perm grant <用户ID> <权限名>');
                                return;
                            }

                            const grantUserId = parseInt(ctx.args[1] || '0');
                            const permName = ctx.args[2] || '';

                            if (isNaN(grantUserId) || grantUserId === 0) {
                                await ctx.message.replyText('❌ 无效的用户ID');
                                return;
                            }

                            const result = permManager.grantPermission(grantUserId, permName);
                            if (result) {
                                await ctx.message.replyText(`✅ 已授予用户 ${grantUserId} "${permName}" 权限`);
                            } else {
                                await ctx.message.replyText(`❌ 授权失败，权限 "${permName}" 可能不存在`);
                            }
                        }
                        else if (subCommand === 'revoke') {
                            if (ctx.args.length < 3) {
                                await ctx.message.replyText('❌ 请使用格式: /perm revoke <用户ID> <权限名>');
                                return;
                            }

                            const revokeUserId = parseInt(ctx.args[1] || '0');
                            const revokePerm = ctx.args[2] || '';

                            if (isNaN(revokeUserId) || revokeUserId === 0) {
                                await ctx.message.replyText('❌ 无效的用户ID');
                                return;
                            }

                            const revokeResult = permManager.revokePermission(revokeUserId, revokePerm);
                            if (revokeResult) {
                                await ctx.message.replyText(`✅ 已撤销用户 ${revokeUserId} 的 "${revokePerm}" 权限`);
                            } else {
                                await ctx.message.replyText(`❌ 撤销失败，权限可能不存在或用户没有此权限`);
                            }
                        }
                        else if (subCommand === 'group_add') {
                            if (ctx.args.length < 3) {
                                await ctx.message.replyText('❌ 请使用格式: /perm group_add <用户ID> <组名>');
                                return;
                            }

                            const addUserId = parseInt(ctx.args[1] || '0');
                            const groupName = ctx.args[2] || '';

                            if (isNaN(addUserId) || addUserId === 0) {
                                await ctx.message.replyText('❌ 无效的用户ID');
                                return;
                            }

                            const addResult = permManager.addUserToGroup(addUserId, groupName);
                            if (addResult) {
                                await ctx.message.replyText(`✅ 已将用户 ${addUserId} 添加到 "${groupName}" 权限组`);
                            } else {
                                await ctx.message.replyText(`❌ 添加失败，权限组 "${groupName}" 可能不存在`);
                            }
                        }
                        else if (subCommand === 'group_remove') {
                            if (ctx.args.length < 3) {
                                await ctx.message.replyText('❌ 请使用格式: /perm group_remove <用户ID> <组名>');
                                return;
                            }

                            const removeUserId = parseInt(ctx.args[1] || '0');
                            const removeGroup = ctx.args[2] || '';

                            if (isNaN(removeUserId) || removeUserId === 0) {
                                await ctx.message.replyText('❌ 无效的用户ID');
                                return;
                            }

                            const removeResult = permManager.removeUserFromGroup(removeUserId, removeGroup);
                            if (removeResult) {
                                await ctx.message.replyText(`✅ 已将用户 ${removeUserId} 从 "${removeGroup}" 权限组中移除`);
                            } else {
                                await ctx.message.replyText(`❌ 移除失败，权限组可能不存在或用户不在此组`);
                            }
                        }
                        else if (subCommand === 'create_group') {
                            if (ctx.args.length < 3) {
                                await ctx.message.replyText('❌ 请使用格式: /perm create_group <组名> <描述>');
                                return;
                            }

                            const newGroupName = ctx.args[1] || '';
                            const groupDesc = ctx.args.slice(2).join(' ');

                            // 创建新权限组
                            const createResult = permManager.createGroup({
                                name: newGroupName,
                                description: groupDesc,
                                permissions: [],
                                members: []
                            });

                            if (createResult) {
                                await ctx.message.replyText(`✅ 已创建权限组 "${newGroupName}"\n描述: ${groupDesc}`);
                            } else {
                                await ctx.message.replyText(`❌ 创建权限组失败，组名 "${newGroupName}" 可能已存在`);
                            }
                        }
                        else if (subCommand === 'save') {
                            const saveResult = await permManager.saveConfig();
                            if (saveResult) {
                                await ctx.message.replyText('✅ 权限配置已保存');
                            } else {
                                await ctx.message.replyText('❌ 保存权限配置失败');
                            }
                        }
                        else {
                            await ctx.message.replyText(`❌ 未实现的管理命令: ${subCommand}`);
                        }
                        break;

                    // 高级功能
                    case 'tree':
                    case 'analyze':
                        // 高级分析功能需要特定权限
                        if (!ctx.hasPermission('permissions.view')) {
                            await ctx.message.replyText('❌ 你没有查看权限的权限');
                            return;
                        }

                        if (subCommand === 'tree') {
                            if (ctx.args.length < 2) {
                                await ctx.message.replyText('❌ 请使用格式: /perm tree <权限名>');
                                return;
                            }

                            const rootPermName = ctx.args[1] || '';
                            const rootPerm = permManager.getPermission(rootPermName);

                            if (!rootPerm) {
                                await ctx.message.replyText(`❌ 权限 "${rootPermName}" 不存在`);
                                return;
                            }

                            // 构建继承树
                            let treeMessage = `🌳 **权限继承树 - ${rootPermName}**\n\n`;

                            // 检查父权限
                            const parentChain: string[] = [];
                            let currentParent = rootPerm.parent;

                            while (currentParent) {
                                parentChain.unshift(currentParent); // 添加到链的开头
                                const parentPerm = permManager.getPermission(currentParent);
                                if (!parentPerm || parentChain.includes(parentPerm.name)) {
                                    // 检测循环依赖
                                    break;
                                }
                                currentParent = parentPerm.parent;
                            }

                            // 显示父权限链
                            if (parentChain.length > 0) {
                                treeMessage += '⬆️ **父权限链**:\n';

                                for (let i = 0; i < parentChain.length; i++) {
                                    const indent = '  '.repeat(i);
                                    const parentName = parentChain[i];

                                    if (typeof parentName === 'string') {
                                        const parentPerm = permManager.getPermission(parentName);
                                        if (parentPerm) {
                                            treeMessage += `${indent}↑ ${parentName} - ${parentPerm.description}\n`;
                                        }
                                    }
                                }

                                // 当前权限
                                treeMessage += `${'  '.repeat(parentChain.length)}• ${rootPermName} - ${rootPerm.description}\n\n`;
                            } else {
                                // 没有父权限
                                treeMessage += `• ${rootPermName} - ${rootPerm.description}\n\n`;
                            }

                            // 查找子权限
                            const childPerms = permManager.getPermissions().filter((p: Permission) => p.parent === rootPermName);

                            await ctx.message.replyText(md(treeMessage));
                        }
                        else if (subCommand === 'analyze') {
                            if (ctx.args.length < 2) {
                                await ctx.message.replyText('❌ 请使用格式: /perm analyze <用户ID>');
                                return;
                            }

                            const analyzeUserId = parseInt(ctx.args[1] || '0');

                            if (isNaN(analyzeUserId) || analyzeUserId === 0) {
                                await ctx.message.replyText('❌ 无效的用户ID');
                                return;
                            }

                            // 获取用户权限
                            const analyzePerms = permManager.getUserPermissions(analyzeUserId);

                            if (analyzePerms.length === 0) {
                                await ctx.message.replyText(`👤 用户 ${analyzeUserId} 没有任何权限。`);
                                return;
                            }

                            // 分析每个权限的来源
                            let analyzeMessage = `👤 **用户 ${analyzeUserId} 的权限分析**\n\n`;

                            // 获取用户所在的所有组
                            const userInGroups = permManager.getGroups()
                                .filter((g: PermissionGroup) => g.members.includes(analyzeUserId));

                            for (const permName of analyzePerms) {
                                const perm = permManager.getPermission(permName);
                                if (!perm) continue;

                                analyzeMessage += `• **${permName}** - ${perm.description}\n`;

                                // 检查直接授权
                                const directGrant = perm.allowedUsers?.includes(analyzeUserId);
                                if (directGrant) {
                                    analyzeMessage += `  ↳ 直接授权\n`;
                                }

                                // 检查通过组获得的权限
                                const groupGrants = userInGroups.filter((g: PermissionGroup) => g.permissions.includes(permName));
                                if (groupGrants.length > 0) {
                                    analyzeMessage += `  ↳ 通过以下权限组: ${groupGrants.map((g: PermissionGroup) => g.name).join(', ')}\n`;
                                }

                                // 检查通过继承获得的权限
                                if (perm.parent && analyzePerms.includes(perm.parent)) {
                                    analyzeMessage += `  ↳ 从父权限 "${perm.parent}" 继承\n`;
                                }
                            }

                            await ctx.message.replyText(md(analyzeMessage));
                        }
                        break;

                    default:
                        await ctx.message.replyText(`❌ 未知子命令: ${subCommand}\n使用 /perm 查看可用命令`);
                }
            }
        }
    ],
};

export default plugin; 