import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './log';
import { managerIds } from './app';

// 文件路径处理
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 权限定义接口
export interface Permission {
    name: string;
    description: string;
    allowedUsers?: number[];
    isSystem?: boolean;
    parent?: string;
}

// 权限组定义接口
export interface PermissionGroup {
    name: string;
    description: string;
    permissions: string[];
    members: number[];
}

/**
 * 权限管理器类
 * 集中管理权限系统的所有功能，包括权限、权限组和用户权限分配
 */
export class PermissionManager {
    // 所有权限
    private permissions = new Map<string, Permission>();
    // 权限组
    private groups = new Map<string, PermissionGroup>();
    // 配置路径
    private configPath: string;

    /**
     * 创建权限管理器
     * @param configDir 配置文件目录
     */
    constructor(configDir: string = path.join(__dirname, './config/')) {
        this.configPath = path.join(configDir, 'permissions.json');
    }

    /**
     * 初始化权限管理器
     */
    async init(): Promise<void> {
        // 加载配置
        await this.loadConfig();

        // 集中注册所有系统基础权限
        // 这确保了权限在插件加载前已经定义，避免循环依赖问题
        this.registerSystemPermissions();

        log.info('Permission manager initialized');
    }

    /**
     * 注册系统基础权限
     * 所有核心权限都在这里集中定义，确保在插件加载前就已存在
     * 这避免了循环依赖的问题，因为插件可能会依赖这些权限
     */
    private registerSystemPermissions(): void {
        // 管理员权限（根权限）
        this.registerPermission({
            name: 'admin',
            description: 'Administrator permission',
            allowedUsers: [...managerIds],
            isSystem: true
        });

        // 插件管理权限
        this.registerPermission({
            name: 'plugin.manage',
            description: 'Plugin management permission',
            allowedUsers: [...managerIds],
            isSystem: true,
            parent: 'admin'
        });

        // 权限管理权限
        this.registerPermission({
            name: 'permissions.manage',
            description: 'Permission management',
            allowedUsers: [...managerIds],
            isSystem: true,
            parent: 'admin'
        });

        // 权限查看权限
        this.registerPermission({
            name: 'permissions.view',
            description: 'Permission to view permission information',
            isSystem: true,
            parent: 'permissions.manage'
        });

        // 创建管理员组
        this.createGroup({
            name: 'administrators',
            description: 'Administrator group',
            permissions: ['admin'],
            members: [...managerIds]
        });
    }

    /**
     * 注册权限
     * @param permission 权限定义
     * @returns 是否成功注册
     */
    registerPermission(permission: Permission): boolean {
        // 检查权限名是否合法
        if (!permission.name || permission.name.trim() === '') {
            log.warn('Cannot register permission with empty name');
            return false;
        }

        // 如果已存在系统权限，不覆盖
        const existing = this.permissions.get(permission.name);
        if (existing && existing.isSystem) {
            log.warn(`Cannot override system permission: ${permission.name}`);
            return false;
        }

        // 检查父权限
        if (permission.parent && !this.permissions.has(permission.parent)) {
            log.warn(`Permission ${permission.name} has nonexistent parent ${permission.parent}`);
        }

        // 注册权限
        this.permissions.set(permission.name, permission);
        return true;
    }

    /**
     * Update an existing permission
     * @param permission Updated permission definition
     * @returns Whether the update was successful
     */
    updatePermission(permission: Permission): boolean {
        // Check if permission exists
        if (!this.permissions.has(permission.name)) {
            log.warn(`Cannot update non-existent permission: ${permission.name}`);
            return false;
        }

        const existing = this.permissions.get(permission.name);
        
        // Don't allow changing isSystem flag
        if (existing?.isSystem && permission.isSystem === false) {
            log.warn(`Cannot change isSystem flag for system permission: ${permission.name}`);
            permission.isSystem = true;
        }

        // Check parent permission
        if (permission.parent && !this.permissions.has(permission.parent)) {
            log.warn(`Permission ${permission.name} has nonexistent parent ${permission.parent}`);
        }

        // Update permission
        this.permissions.set(permission.name, permission);
        return true;
    }

    /**
     * 创建权限组
     * @param group 权限组定义
     * @returns 是否成功创建
     */
    createGroup(group: PermissionGroup): boolean {
        // 检查组名是否合法
        if (!group.name || group.name.trim() === '') {
            log.warn('Cannot create group with empty name');
            return false;
        }

        // 如果组已存在则失败
        if (this.groups.has(group.name)) {
            log.warn(`Permission group already exists: ${group.name}`);
            return false;
        }

        // 验证所有权限是否存在
        for (const permName of group.permissions) {
            if (!this.permissions.has(permName)) {
                log.warn(`Permission group ${group.name} references nonexistent permission ${permName}`);
            }
        }

        // 创建组
        this.groups.set(group.name, group);
        return true;
    }

    /**
     * 更新权限组
     * @param group 权限组定义
     * @returns 是否成功更新
     */
    updateGroup(group: PermissionGroup): boolean {
        // 检查组是否存在
        if (!this.groups.has(group.name)) {
            log.warn(`Cannot update nonexistent group: ${group.name}`);
            return false;
        }

        // 验证所有权限是否存在
        for (const permName of group.permissions) {
            if (!this.permissions.has(permName)) {
                log.warn(`Permission group ${group.name} references nonexistent permission ${permName}`);
            }
        }

        // 更新组
        this.groups.set(group.name, group);
        return true;
    }

    /**
     * 删除权限组
     * @param groupName 权限组名称
     * @returns 是否成功删除
     */
    deleteGroup(groupName: string): boolean {
        return this.groups.delete(groupName);
    }

    /**
     * 获取所有权限
     * @returns 权限列表
     */
    getPermissions(): Permission[] {
        return Array.from(this.permissions.values());
    }

    /**
     * 获取指定权限
     * @param name 权限名称
     * @returns 权限定义或undefined
     */
    getPermission(name: string): Permission | undefined {
        return this.permissions.get(name);
    }

    /**
     * 获取所有权限组
     * @returns 权限组列表
     */
    getGroups(): PermissionGroup[] {
        return Array.from(this.groups.values());
    }

    /**
     * 获取指定权限组
     * @param name 权限组名称
     * @returns 权限组定义或undefined
     */
    getGroup(name: string): PermissionGroup | undefined {
        return this.groups.get(name);
    }

    /**
     * 检查用户是否有权限
     * @param userId 用户ID
     * @param permissionName 权限名称
     * @returns 是否有权限
     */
    hasPermission(userId: number, permissionName: string): boolean {
        // 管理员拥有所有权限
        if (managerIds.includes(userId)) return true;
        
        const permission = this.permissions.get(permissionName);
        if (!permission) return false;
        
        // 检查用户是否直接拥有权限
        if (permission.allowedUsers?.includes(userId)) return true;
        
        // 检查用户通过权限组获得的权限
        for (const group of this.groups.values()) {
            if (group.members.includes(userId) && group.permissions.includes(permissionName)) {
                return true;
            }
        }
        
        // 检查父权限
        if (permission.parent) {
            return this.hasPermission(userId, permission.parent);
        }
        
        return false;
    }

    /**
     * 获取用户所有权限
     * @param userId 用户ID
     * @returns 权限名称列表
     */
    getUserPermissions(userId: number): string[] {
        // 管理员拥有所有权限
        if (managerIds.includes(userId)) {
            return Array.from(this.permissions.keys());
        }
        
        const userPermissions: Set<string> = new Set();
        
        // 直接分配给用户的权限
        for (const [name, permission] of this.permissions.entries()) {
            if (permission.allowedUsers?.includes(userId)) {
                userPermissions.add(name);
            }
        }
        
        // 通过权限组分配的权限
        for (const group of this.groups.values()) {
            if (group.members.includes(userId)) {
                for (const permName of group.permissions) {
                    userPermissions.add(permName);
                }
            }
        }
        
        // 处理继承权限（通过父权限）
        const result = Array.from(userPermissions);
        const expandedPermissions: Set<string> = new Set(result);
        
        // 迭代检查是否有权限继承关系需要添加
        let changed = true;
        while (changed) {
            changed = false;
            for (const [name, permission] of this.permissions.entries()) {
                if (permission.parent && expandedPermissions.has(permission.parent) && !expandedPermissions.has(name)) {
                    expandedPermissions.add(name);
                    changed = true;
                }
            }
        }
        
        return Array.from(expandedPermissions);
    }

    /**
     * 获取用户所属的权限组
     * @param userId 用户ID
     * @returns 权限组名称列表
     */
    getUserGroups(userId: number): string[] {
        return Array.from(this.groups.values())
            .filter(group => group.members.includes(userId))
            .map(group => group.name);
    }

    /**
     * 授予用户权限
     * @param userId 用户ID
     * @param permissionName 权限名称
     * @returns 是否成功授权
     */
    grantPermission(userId: number, permissionName: string): boolean {
        const permission = this.permissions.get(permissionName);
        if (!permission) return false;
        
        if (!permission.allowedUsers) {
            permission.allowedUsers = [];
        }
        
        if (!permission.allowedUsers.includes(userId)) {
            permission.allowedUsers.push(userId);
        }
        
        return true;
    }

    /**
     * 撤销用户权限
     * @param userId 用户ID
     * @param permissionName 权限名称
     * @returns 是否成功撤销
     */
    revokePermission(userId: number, permissionName: string): boolean {
        const permission = this.permissions.get(permissionName);
        if (!permission || !permission.allowedUsers) return false;
        
        const index = permission.allowedUsers.indexOf(userId);
        if (index === -1) return false;
        
        permission.allowedUsers.splice(index, 1);
        return true;
    }

    /**
     * 将用户添加到权限组
     * @param userId 用户ID
     * @param groupName 权限组名称
     * @returns 是否成功添加
     */
    addUserToGroup(userId: number, groupName: string): boolean {
        const group = this.groups.get(groupName);
        if (!group) return false;
        
        if (!group.members.includes(userId)) {
            group.members.push(userId);
        }
        
        return true;
    }

    /**
     * 将用户从权限组中移除
     * @param userId 用户ID
     * @param groupName 权限组名称
     * @returns 是否成功移除
     */
    removeUserFromGroup(userId: number, groupName: string): boolean {
        const group = this.groups.get(groupName);
        if (!group) return false;
        
        const index = group.members.indexOf(userId);
        if (index === -1) return false;
        
        group.members.splice(index, 1);
        return true;
    }

    /**
     * 添加权限到权限组
     * @param permissionName 权限名称
     * @param groupName 权限组名称
     * @returns 是否成功添加
     */
    addPermissionToGroup(permissionName: string, groupName: string): boolean {
        const group = this.groups.get(groupName);
        if (!group) return false;
        
        if (!this.permissions.has(permissionName)) return false;
        
        if (!group.permissions.includes(permissionName)) {
            group.permissions.push(permissionName);
        }
        
        return true;
    }

    /**
     * 从权限组中移除权限
     * @param permissionName 权限名称
     * @param groupName 权限组名称
     * @returns 是否成功移除
     */
    removePermissionFromGroup(permissionName: string, groupName: string): boolean {
        const group = this.groups.get(groupName);
        if (!group) return false;
        
        const index = group.permissions.indexOf(permissionName);
        if (index === -1) return false;
        
        group.permissions.splice(index, 1);
        return true;
    }

    /**
     * 保存权限配置到文件
     */
    async saveConfig(): Promise<boolean> {
        try {
            const config = {
                permissions: Array.from(this.permissions.values())
                    .filter(perm => !perm.isSystem), // 不保存系统权限
                groups: Array.from(this.groups.values())
            };

            await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
            log.info('Permission config saved');
            return true;
        } catch (err) {
            log.error('Failed to save permission config:', err);
            return false;
        }
    }

    /**
     * 从文件加载权限配置
     */
    async loadConfig(): Promise<boolean> {
        try {
            // 确保目录存在
            await fs.mkdir(path.dirname(this.configPath), { recursive: true });

            // 检查文件是否存在
            try {
                await fs.access(this.configPath);
            } catch (err) {
                // 文件不存在，不是错误
                return false;
            }

            const content = await fs.readFile(this.configPath, 'utf-8');
            const config = JSON.parse(content);
            
            // 加载权限（不会覆盖系统权限）
            if (config.permissions && Array.isArray(config.permissions)) {
                for (const permission of config.permissions) {
                    const existingPerm = this.permissions.get(permission.name);
                    if (!existingPerm || !existingPerm.isSystem) {
                        this.permissions.set(permission.name, permission);
                    }
                }
            }
            
            // 加载权限组
            if (config.groups && Array.isArray(config.groups)) {
                for (const group of config.groups) {
                    this.groups.set(group.name, group);
                }
            }
            
            log.info('Permission config loaded');
            return true;
        } catch (err) {
            log.error('Failed to load permission config:', err);
            return false;
        }
    }
} 