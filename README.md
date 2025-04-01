# NatsukiMiyu Next

## Plugin

```typescript
import type { BotPlugin, CommandContext, MessageEventContext, CallbackEventContext } from '../features';
import { log } from '../log';
import type { TelegramClient } from '@mtcute/bun';

// Plugin configuration interface
interface MyPluginConfig {
    enabled: boolean;
    apiKey?: string;
    responseTimeout: number;
    allowedUsers: number[];
}

// Default configuration
const defaultConfig: MyPluginConfig = {
    enabled: true,
    responseTimeout: 30,
    allowedUsers: []
};

// Plugin state
let config: MyPluginConfig = { ...defaultConfig };

// Plugin definition
const plugin: BotPlugin = {
    name: 'example',                      // Plugin name (required)
    description: 'Example plugin',        // Plugin description (optional)
    version: '1.0.0',                     // Plugin version (optional)
    dependencies: ['system'],             // Dependencies on other plugins (optional)
    
    // Declare permissions (new approach)
    permissions: [
        {
            name: 'example.use',
            description: 'Permission to use the example plugin',
            isSystem: false,
            allowedUsers: []  // This will be updated from config
        },
        {
            name: 'example.admin',
            description: 'Administrative permission for the example plugin',
            isSystem: true,
            parent: 'admin'
        }
    ],
    
    // Called when plugin is loaded
    async onLoad(client: TelegramClient): Promise<void> {
        // Load configuration
        const savedConfig = await client.features.getPluginConfig<MyPluginConfig>('example');
        if (savedConfig) {
            config = { ...defaultConfig, ...savedConfig };
        }
        
        // Update permission with allowed users from config
        const permManager = client.features.getPermissionManager();
        const permission = permManager.getPermission('example.use');
        if (permission) {
            permission.allowedUsers = config.allowedUsers;
            permManager.updatePermission(permission);
        }
        
        log.info('Example plugin loaded');
    },
    
    // Called when plugin is unloaded
    async onUnload(): Promise<void> {
        log.info('Example plugin unloaded');
    },
    
    // Command definitions
    commands: [
        {
            name: 'example',                  // Command name (required)
            description: 'Example command',   // Command description (optional)
            aliases: ['ex', 'sample'],        // Command aliases (optional)
            requiredPermission: 'example.use', // Required permission (optional)
            cooldown: 5,                      // Cooldown in seconds (optional)
            
            // Command handler function (required)
            async handler(ctx: CommandContext): Promise<void> {
                // Example parameter processing
                const subCommand = ctx.args[0]?.toLowerCase();
                
                if (!subCommand) {
                    await ctx.reply(`
📚 **Example Plugin Help**

Available commands:
/example status - View status
/example set <key> <value> - Configure settings
/example reset - Reset configuration
`);
                    return;
                }
                
                switch (subCommand) {
                    case 'status':
                        await ctx.reply(`
📊 **Plugin Status**

Enabled: ${config.enabled ? '✅ Yes' : '❌ No'}
API Key: ${config.apiKey ? 'Set' : 'Not set'}
Response timeout: ${config.responseTimeout} seconds
Allowed users: ${config.allowedUsers.length}
`);
                        break;
                        
                    case 'set':
                        // Permission check example
                        if (!ctx.hasPermission('example.admin')) {
                            await ctx.reply('❌ Only administrators can modify configuration');
                            return;
                        }
                        
                        const key = ctx.args[1];
                        const value = ctx.args.slice(2).join(' ');
                        
                        if (!key || !value) {
                            await ctx.reply('❌ Please provide a valid key and value');
                            return;
                        }
                        
                        try {
                            // Update configuration based on key
                            switch (key) {
                                case 'enabled':
                                    config.enabled = value.toLowerCase() === 'true';
                                    break;
                                case 'apiKey':
                                    config.apiKey = value;
                                    break;
                                case 'timeout':
                                    config.responseTimeout = parseInt(value) || 30;
                                    break;
                                default:
                                    await ctx.reply(`❌ Unknown configuration item: ${key}`);
                                    return;
                            }
                            
                            // Save updated configuration
                            await ctx.client.features.savePluginConfig('example', config);
                            await ctx.reply(`✅ Configuration updated: ${key} = ${value}`);
                        } catch (err) {
                            await ctx.reply(`❌ Setting failed: ${err}`);
                        }
                        break;
                        
                    case 'reset':
                        // Permission check example
                        if (!ctx.hasPermission('example.admin')) {
                            await ctx.reply('❌ Only administrators can reset configuration');
                            return;
                        }
                        
                        config = { ...defaultConfig };
                        await ctx.client.features.savePluginConfig('example', config);
                        await ctx.reply('✅ Configuration has been reset to defaults');
                        break;
                        
                    default:
                        await ctx.reply(`❌ Unknown subcommand: ${subCommand}`);
                }
            }
        }
    ],
    
    // Event handler definitions
    events: [
        {
            type: 'message',  // Message event
            priority: 10,     // Priority (optional, higher numbers = higher priority)
            
            // Filter (optional)
            filter: (ctx) => {
                if (ctx.type !== 'message') return false;
                
                // Only process text messages
                return !!ctx.message.text && config.enabled;
            },
            
            // Event handler function
            async handler(ctx: MessageEventContext): Promise<void> {
                const text = ctx.message.text;
                if (!text) return;
                
                // Process specific keywords
                if (text.includes('hello')) {
                    await ctx.reply('Hello there! I am the example plugin 👋');
                }
            }
        },
        {
            type: 'callback',  // Callback query event
            
            // Event handler function
            async handler(ctx: CallbackEventContext): Promise<void> {
                // Process specific callback data
                if (ctx.data.startsWith('example:')) {
                    const action = ctx.data.split(':')[1];
                    
                    switch (action) {
                        case 'info':
                            await ctx.reply('This is callback information from the example plugin');
                            break;
                    }
                }
            }
        }
    ]
};

export default plugin;
```